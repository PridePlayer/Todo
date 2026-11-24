#!/usr/bin/env bash
# 从备份恢复。在服务器上执行：
#   bash /www/wwwroot/todo/deploy/restore.sh /www/backup/grid/daily/grid_2026-11-24_0200.sql.gz
#
# 它会做三件事，顺序不能反：
#   1. 把「现在的库」再导一份到 pre-restore/ —— 恢复错文件时你还能回去
#   2. 停服务、灌数据、起服务
#   3. 探活，确认服务真的能读回来
#
# 为什么要停服务：mysqldump 的 --single-transaction 让备份不用锁表，
# 但**恢复**是另一回事——一边有业务在写、一边 DROP TABLE 重建，
# 结果是一半旧数据一半新数据，而且不会报错。
set -euo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/todo}"
BACKUP_DIR="${BACKUP_DIR:-/www/backup/grid}"

FILE="${1:-}"
[[ -n "$FILE" ]] || {
  echo "用法：bash $0 <备份文件路径>"
  echo
  echo "可用备份（最新的在前）："
  ls -1t "$BACKUP_DIR"/daily/* 2>/dev/null | head -10 || echo "  （没有找到任何备份）"
  exit 1
}
[[ -f "$FILE" ]] || {
  echo "文件不存在：$FILE"
  exit 1
}

# 读 .env 里的单个变量，不 source。
# source 会在 MS_SCOPES=offline_access User.Read ... 这种没加引号的值上
# 把 `User.Read` 当命令执行，脚本直接以 127 退出——恢复的时候踩到这个，
# 人会以为备份文件坏了。
read_env() {
  local key="$1" line
  [[ -f "$APP_DIR/.env" ]] || return 0
  line="$(grep -m1 -E "^[[:space:]]*${key}=" "$APP_DIR/.env" 2>/dev/null || true)"
  [[ -z "$line" ]] && return 0
  line="${line#*=}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  if [[ "$line" == \"*\" && ${#line} -ge 2 ]]; then
    line="${line:1:${#line}-2}"
  elif [[ "$line" == \'*\' && ${#line} -ge 2 ]]; then
    line="${line:1:${#line}-2}"
  fi
  printf '%s' "$line"
}

DB_URL="${DB_URL:-$(read_env DB_URL)}"
[[ -n "${DB_URL:-}" ]] || {
  echo "读不到 DB_URL，检查 $APP_DIR/.env"
  exit 1
}

echo "备份文件：$FILE"
echo "大小：$(du -h "$FILE" | cut -f1)"
echo "修改时间：$(date -r "$FILE" '+%F %T')"
echo

# 把「要覆盖到哪」解析成绝对的、不含猜测的描述。
# 只说 `$DB_URL 指向的文件`不够：演练时 APP_DIR 指错、或者 .env 里是相对路径，
# 人一眼看不出自己正在覆盖的是哪个库，而这一步是不可撤销的。
if [[ "$DB_URL" == sqlite:* ]]; then
  _spec="${DB_URL#sqlite:}"
  [[ "$_spec" = /* ]] || _spec="$APP_DIR/$_spec"
  echo "恢复目标（sqlite 文件）：$_spec"
  if [[ -f "$_spec" ]]; then
    echo "  当前大小 $(du -h "$_spec" | cut -f1)，最后修改 $(date -r "$_spec" '+%F %T')"
  else
    echo "  （目标文件还不存在，恢复会新建）"
  fi
else
  _rest="${DB_URL#mysql://}"
  _hostpart="${_rest#*@}"
  echo "恢复目标（MySQL）：${_hostpart%%/*} 的库 ${_hostpart#*/}"
fi
echo

if [[ "$FILE" == *.sql.gz || "$FILE" == *.sql ]]; then
  echo "文件内容预览（前几行注释里通常有主机名和 dump 时间）："
  if [[ "$FILE" == *.gz ]]; then
    gzip -dc "$FILE" | head -8
  else
    head -8 "$FILE"
  fi
fi
echo

cat <<'WARN'
--------------------------------------------------------------------------
这一步会【覆盖当前数据库】。恢复期间服务会停掉，正在用的人会看到连接失败。
--------------------------------------------------------------------------
WARN

read -r -p "确认继续？输入 yes 执行，其它任何输入都取消：" CONFIRM
[[ "$CONFIRM" == "yes" ]] || {
  echo "已取消，什么都没做。"
  exit 0
}

mkdir -p "$BACKUP_DIR/pre-restore"

# ── 1) 先给"现在的库"留一条退路 ────────────────────────────────
PRE_STAMP="$(date +%F_%H%M%S)"
log() { printf '[restore %s] %s\n' "$(date '+%F %T')" "$*"; }

# 服务控制走一层包装：这套脚本也用于本地演练（sqlite + 直接 node 起的服务），
# 那里没有 systemd。硬编码 systemctl 会让演练在一个和恢复本身无关的地方失败。
SERVICE="${SERVICE:-grid}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/healthz}"
svc() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl "$@" "$SERVICE"
  else
    log "没有 systemctl，跳过 $* $SERVICE"
    return 0
  fi
}

if [[ "$DB_URL" == sqlite:* ]]; then
  SPEC="${DB_URL#sqlite:}"
  [[ "$SPEC" = /* ]] || SPEC="$APP_DIR/$SPEC"
  if [[ -f "$SPEC" ]]; then
    # 用 VACUUM INTO，不是 cp。
    # 本项目开的是 WAL 模式：新写入先落在 grid.db-wal 里，checkpoint 之后才并回主文件。
    # 直接 cp 那个 .db，会拿到一份"最近若干次写入都没了"的旧快照，
    # 而且它看起来完全正常——这正是最坏的一类备份失误。
    DB_PATH="$SPEC" OUT_PATH="$BACKUP_DIR/pre-restore/pre_${PRE_STAMP}.db" node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.env.DB_PATH);
      db.exec("VACUUM INTO \x27" + process.env.OUT_PATH.replace(/\x27/g, "\x27\x27") + "\x27");
      db.close();
    ' || {
      echo "无法保存当前库的快照，中止（此时数据库还没被改动）"
      exit 1
    }
    log "已保存当前库 → pre-restore/pre_${PRE_STAMP}.db"
  fi
else
  REST="${DB_URL#mysql://}"
  CRED="${REST%%@*}"
  HOSTPART="${REST#*@}"
  DB_USER="${CRED%%:*}"
  DB_PASS="${CRED#*:}"
  HOSTPORT="${HOSTPART%%/*}"
  DB_NAME="${HOSTPART#*/}"
  DB_HOST="${HOSTPORT%%:*}"
  DB_PORT="${HOSTPORT#*:}"
  # URL 没写端口时 `${HOSTPORT#*:}` 找不到冒号会原样返回主机名，这时才退到 3306。
  if [[ -z "$DB_PORT" || "$DB_PORT" == "$HOSTPORT" ]]; then
    DB_PORT=3306
  fi
  DB_USER="$(printf '%b' "${DB_USER//%/\\x}")"
  DB_PASS="$(printf '%b' "${DB_PASS//%/\\x}")"

  MYSQLDUMP=""
  for candidate in "$(command -v mysqldump 2>/dev/null || true)" \
    /www/server/mysql/bin/mysqldump /usr/local/mysql/bin/mysqldump /usr/bin/mysqldump; do
    [[ -n "$candidate" && -x "$candidate" ]] && {
      MYSQLDUMP="$candidate"
      break
    }
  done
  [[ -n "$MYSQLDUMP" ]] || {
    echo "找不到 mysqldump，中止"
    exit 1
  }

  MYSQL_PWD="$DB_PASS" "$MYSQLDUMP" \
    -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" \
    --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF \
    "$DB_NAME" | gzip -9 > "$BACKUP_DIR/pre-restore/pre_${PRE_STAMP}.sql.gz" || {
    echo "保存当前库失败，中止（此时数据库还没被改动）"
    exit 1
  }
  log "已保存当前库 → pre-restore/pre_${PRE_STAMP}.sql.gz"
fi

# ── 2) 停服务 → 灌数据 → 起服务 ────────────────────────────────
log "停止 $SERVICE"
svc stop || log "WARN 停止失败（可能本来就没在跑），继续"

cleanup_and_abort() {
  log "恢复失败。数据库可能处于半截状态。"
  log "可以用刚保存的 pre-restore/pre_${PRE_STAMP}.* 回滚。"
  svc start || true
  exit 1
}
trap cleanup_and_abort ERR

if [[ "$DB_URL" == sqlite:* ]]; then
  SPEC="${DB_URL#sqlite:}"
  [[ "$SPEC" = /* ]] || SPEC="$APP_DIR/$SPEC"
  [[ "$FILE" == *.gz ]] && gzip -t "$FILE"
  # 先解到同目录的临时文件再原子替换：中途失败时原库还在
  TMP="${SPEC}.restoring"
  if [[ "$FILE" == *.gz ]]; then
    gzip -dc "$FILE" > "$TMP"
  else
    cp "$FILE" "$TMP"
  fi
  mv "$TMP" "$SPEC"
  # 旧的 -wal / -shm 必须删掉。WAL 文件属于"某一个具体的库文件"，
  # 把它们留在原地，SQLite 下次打开时会拿旧 WAL 去重放新库的页——
  # 结果要么直接报 corrupt，要么读到一堆对不上的旧行。
  rm -f "${SPEC}-wal" "${SPEC}-shm"
  chown www:www "$SPEC" 2>/dev/null || true
  log "sqlite 已恢复 → $SPEC"
else
  MYSQL=""
  for candidate in "$(command -v mysql 2>/dev/null || true)" \
    /www/server/mysql/bin/mysql /usr/local/mysql/bin/mysql /usr/bin/mysql; do
    [[ -n "$candidate" && -x "$candidate" ]] && {
      MYSQL="$candidate"
      break
    }
  done
  [[ -n "$MYSQL" ]] || {
    log "找不到 mysql 客户端"
    false
  }

  if [[ "$FILE" == *.gz ]]; then
    gzip -dc "$FILE" | MYSQL_PWD="$DB_PASS" "$MYSQL" \
      -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME"
  else
    MYSQL_PWD="$DB_PASS" "$MYSQL" -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" < "$FILE"
  fi
  log "mysql 已恢复 → $DB_NAME"
fi

trap - ERR

log "启动 $SERVICE"
svc start

for _ in $(seq 1 15); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if curl -fsS "$HEALTH_URL"; then
  echo
  log "恢复完成，服务在线。"
  log "回滚用：$BACKUP_DIR/pre-restore/pre_${PRE_STAMP}.*"
else
  log "服务没起来。看日志：journalctl -u $SERVICE -n 50 --no-pager"
  exit 1
fi
