#!/usr/bin/env bash
# 定时备份。宝塔「计划任务」→ Shell 脚本，**每 6 小时**执行：
#   bash /www/wwwroot/todo/deploy/backup.sh
# 对应 cron 表达式：0 */6 * * *
#
# 策略：
#   · 本机 daily 留 14 天（每 6 小时一份 = 最多 56 份）
#   · 每周日另存一份 weekly，留 8 份（约两个月）
#   · 配了 rclone 远端就自动上云；没配就只留本机（异地靠你自己的电脑拉取）
#   · 每份都做完整性校验，mysqldump 中途死掉不会留下"看起来正常"的半个文件
#   · 结果写进 status.txt，healthcheck.sh 靠它发现"备份已经三天没跑了"
#
# 为什么是 6 小时而不是每天一次：每天 02:00 备份，如果下午误删数据，
# 到 02:00 时删除状态已经被写进库里了，回滚只能回到"已经被删掉"的那一刻。
# 6 小时粒度最坏丢半天，而成本只是多占几 MB。
set -euo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/todo}"
BACKUP_DIR="${BACKUP_DIR:-/www/backup/grid}"
KEEP_DAYS=14
KEEP_WEEKS=8
# 低于这个字节数基本可以断定 dump 是空的（一个只有 8 张业务表的库也要几十 KB）
MIN_BYTES=4096

STAMP="$(date +%F_%H%M)"
STATE_FILE="$BACKUP_DIR/status.txt"

log() { printf '[backup %s] %s\n' "$(date '+%F %T')" "$*"; }

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# 读 .env 里的单个变量。
#
# 刻意**不用** `source` / `.`：.env 是配置文件，不是 shell 脚本。
# 真实例子：MS_SCOPES 的值是空格分隔的一串权限名、没有加引号，
# source 时 shell 会试图把第二个词当成命令执行，报 command not found
# 并让整个脚本以 127 退出。症状是「备份从来没成功过，但也没人发现」，
# 直到真的要用备份那天。
read_env() {
  local key="$1" line
  [[ -f "$APP_DIR/.env" ]] || return 0
  line="$(grep -m1 -E "^[[:space:]]*${key}=" "$APP_DIR/.env" 2>/dev/null || true)"
  [[ -z "$line" ]] && return 0
  line="${line#*=}"
  # 去掉首尾空白
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  # 去掉成对引号
  if [[ "$line" == \"*\" && ${#line} -ge 2 ]]; then
    line="${line:1:${#line}-2}"
  elif [[ "$line" == \'*\' && ${#line} -ge 2 ]]; then
    line="${line:1:${#line}-2}"
  fi
  printf '%s' "$line"
}

# 外部环境变量优先（便于临时覆盖 / 演练时指向别的库）
DB_URL="${DB_URL:-$(read_env DB_URL)}"
BACKUP_WEBHOOK_URL="${BACKUP_WEBHOOK_URL:-$(read_env BACKUP_WEBHOOK_URL)}"

# 通用 webhook：钉钉/飞书/Server酱/自建都发同一种 JSON。没配就静默跳过，
# 不让"没配告警"本身变成一个错误。
notify() {
  local text="$1"
  local url="${BACKUP_WEBHOOK_URL:-}"
  [[ -z "$url" ]] && return 0
  # mysqldump 的错误信息里经常带双引号，不转义会把 JSON 拼坏，
  # 结果是 webhook 静默失败——而告警静默失败等于没有告警。
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  curl -fsS -m 10 -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"GRID 备份：${text}\"}}" >/dev/null 2>&1 || true
}

fail() {
  log "ERROR: $*"
  printf 'FAILED %s %s\n' "$(date +%s)" "$*" > "$STATE_FILE"
  notify "失败 - $*"
  exit 1
}

# 宝塔的 cron 环境 PATH 极简（通常只有 /usr/bin:/bin），MySQL 装在 /www/server/mysql/bin
# 时 `mysqldump` 根本找不到。症状是"计划任务日志里 command not found"，
# 但白天手动敲一遍又是好的——因为交互式 shell 的 PATH 里有它。
find_bin() {
  local name="$1"
  shift
  local candidate
  for candidate in "$(command -v "$name" 2>/dev/null || true)" "$@"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

[[ -n "${DB_URL:-}" ]] || fail "读不到 DB_URL，检查 $APP_DIR/.env"

if [[ "$DB_URL" == sqlite:* ]]; then
  SPEC="${DB_URL#sqlite:}"
  [[ "$SPEC" = /* ]] || SPEC="$APP_DIR/$SPEC"
  [[ -f "$SPEC" ]] || fail "sqlite 文件不存在：$SPEC"

  RAW="$BACKUP_DIR/daily/grid_${STAMP}.db"
  log "sqlite 快照 → $RAW"
  DB_PATH="$SPEC" OUT_PATH="$RAW" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.DB_PATH);
    // VACUUM INTO 产出的是一致性快照，不需要停服务
    db.exec("VACUUM INTO \x27" + process.env.OUT_PATH.replace(/\x27/g, "\x27\x27") + "\x27");
    db.close();
  ' || fail "VACUUM INTO 失败"
  gzip -9 "$RAW" || fail "gzip 失败"
  TARGET="$RAW.gz"
  gzip -t "$TARGET" 2>/dev/null || fail "gzip 完整性校验失败：$TARGET"
else
  # mysql://user:pass@host:port/db
  REST="${DB_URL#mysql://}"
  CRED="${REST%%@*}"
  HOSTPART="${REST#*@}"
  DB_USER="${CRED%%:*}"
  DB_PASS="${CRED#*:}"
  HOSTPORT="${HOSTPART%%/*}"
  DB_NAME="${HOSTPART#*/}"
  DB_HOST="${HOSTPORT%%:*}"
  DB_PORT="${HOSTPORT#*:}"
  # URL 里没写端口时，`${HOSTPORT#*:}` 找不到冒号会原样返回主机名，
  # 这时候才该退到 3306。用 if 而不是 `[[ ]] &&`：后者在 set -u 下
  # 一旦手滑写错变量名，报的是 "unbound variable" 而不是"端口取错了"，
  # 排查成本差很远。
  if [[ -z "$DB_PORT" || "$DB_PORT" == "$HOSTPORT" ]]; then
    DB_PORT=3306
  fi
  # URL 编码过的密码要还原，否则含 @ / # 的密码连不上（而报错是"Access denied"，
  # 看起来像密码错了，实际是没解码）
  DB_USER="$(printf '%b' "${DB_USER//%/\\x}")"
  DB_PASS="$(printf '%b' "${DB_PASS//%/\\x}")"

  MYSQLDUMP="$(find_bin mysqldump /www/server/mysql/bin/mysqldump /usr/local/mysql/bin/mysqldump /usr/bin/mysqldump)" \
    || fail "找不到 mysqldump（宝塔的 MySQL 一般在 /www/server/mysql/bin）"

  TARGET="$BACKUP_DIR/daily/grid_${STAMP}.sql.gz"
  log "mysqldump → $TARGET"
  # --no-tablespaces：MySQL 8 下没有 PROCESS 权限时，不加这个参数 mysqldump 直接报
  #   "Access denied; you need (at least one of) the PROCESS privilege"
  #   而这个权限通常只给 root。这是最容易被误判成"数据库坏了"的一个坑。
  # --single-transaction：InnoDB 下拿一致性快照，不锁表，备份期间站点照常可用。
  STDERR_FILE="/tmp/grid-backup-stderr.$$"
  if ! MYSQL_PWD="$DB_PASS" "$MYSQLDUMP" \
    -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" \
    --single-transaction --quick --routines --triggers \
    --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 \
    "$DB_NAME" 2>"$STDERR_FILE" | gzip -9 > "$TARGET"; then
    err="$(tail -3 "$STDERR_FILE" 2>/dev/null | tr '\n' ' ')"
    rm -f "$STDERR_FILE" "$TARGET"
    fail "mysqldump 失败：${err:-未知错误}"
  fi
  rm -f "$STDERR_FILE"

  gzip -t "$TARGET" 2>/dev/null || fail "gzip 完整性校验失败：$TARGET"
  # mysqldump 正常结束时一定会在末尾写 "-- Dump completed"。
  # 只看文件大小不够：连接中途被断，前面几十 MB 照样落了盘，
  # 而恢复时会停在半截，还以为是恢复脚本的错。
  gzip -dc "$TARGET" 2>/dev/null | tail -5 | grep -q "Dump completed" \
    || fail "dump 没有结束标记（可能中途断开）：$TARGET"
fi

# 体积按**解压后**算，不按 .gz 算。
# dump 的压缩率跟内容重复度强相关：一个刚建好、只有几条数据的库，
# gzip 后可能只有几百字节，按压缩后判断会把完全正常的备份判成"不完整"，
# 而这种误报的代价很高——人会开始不信备份脚本。
if [[ "$TARGET" == *.gz ]]; then
  RAW_BYTES=$(gzip -dc "$TARGET" | wc -c)
else
  RAW_BYTES=$(stat -c %s "$TARGET")
fi
SIZE=$(stat -c %s "$TARGET")
[[ "$RAW_BYTES" -ge "$MIN_BYTES" ]] \
  || fail "备份解压后只有 ${RAW_BYTES} 字节（压缩后 ${SIZE}），明显不完整：$TARGET"

# 周日额外留一份周备份
if [[ "$(date +%u)" == "7" ]]; then
  cp "$TARGET" "$BACKUP_DIR/weekly/" || log "WARN 复制到 weekly 失败（不影响本次备份）"
fi

# 清理过期：daily 按天数，weekly 按份数
find "$BACKUP_DIR/daily" -type f -mtime +$KEEP_DAYS -delete
# 不能写成 `ls weekly/* 2>/dev/null | ...`：目录为空时 ls 返回 2，
# 在 pipefail 下整个脚本会以 2 退出——第一次运行时必然踩到，而且报错里没有一行是线索。
if compgen -G "$BACKUP_DIR/weekly/*" >/dev/null; then
  ls -1t "$BACKUP_DIR"/weekly/* | tail -n +$((KEEP_WEEKS + 1)) | xargs -r rm -f
fi

# 异地同步：配了 rclone 的 oss: 远端就传；没配就只留本机。
# 注意——本机备份和数据库在同一块盘上。ECS 磁盘挂了、或者哪天重装系统
# 覆盖了 /www，两边会一起没。真正的异地是 tools/pull-backup.ps1
# 在你电脑上定时拉取，别指望着这一条。
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^oss:'; then
  if rclone copy "$BACKUP_DIR/daily/" oss:grid-backup/daily/ --bwlimit 2M --include "grid_${STAMP}*"; then
    log "已同步到 oss:grid-backup/daily/"
  else
    log "WARN rclone 同步失败（本机备份已完成）"
  fi
else
  log "跳过云同步（未配置 rclone 的 oss: 远端）"
fi

# 人话体积。不用 numfmt：最小化的 CentOS/宝塔环境里它可能不存在，
# 而且它对小于 1K 的值不输出单位，日志里出现一个光秃秃的 "411" 等于没说。
human_size() {
  awk -v b="$1" 'BEGIN {
    split("B KB MB GB TB", u, " "); i = 1;
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf (i == 1 ? "%d%s" : "%.1f%s"), b, u[i];
  }'
}

printf 'OK %s %s %s\n' "$(date +%s)" "$(basename "$TARGET")" "$SIZE" > "$STATE_FILE"
log "完成：$(basename "$TARGET")　解压后 $(human_size "$RAW_BYTES") / 落盘 $(human_size "$SIZE")，本机共 $(ls -1 "$BACKUP_DIR/daily" | wc -l) 份"
notify "成功 - $(basename "$TARGET") $(human_size "$RAW_BYTES")"
