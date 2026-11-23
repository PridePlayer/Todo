#!/usr/bin/env bash
# 每日备份。宝塔「计划任务」→ Shell 脚本，每天 02:00 执行：
#   bash /www/wwwroot/todo/deploy/backup.sh
#
# 保留策略：本机 7 日 + 每周日另存一份 weekly（留 4 份），再 rclone 到对象存储。
# 数据库驱动按 .env 的 DB_URL 自动判断：mysql → mysqldump，sqlite → VACUUM INTO 快照。
set -euo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/todo}"
BACKUP_DIR="${BACKUP_DIR:-/www/backup/grid}"
KEEP_DAYS=7
STAMP="$(date +%F_%H%M)"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# shellcheck disable=SC1091
set -a; source "$APP_DIR/.env"; set +a

if [[ "${DB_URL:-}" == sqlite:* ]]; then
  SPEC="${DB_URL#sqlite:}"
  [[ "$SPEC" = /* ]] || SPEC="$APP_DIR/$SPEC"
  OUT="$BACKUP_DIR/daily/grid_${STAMP}.db"
  echo "[backup] sqlite 快照 → $OUT"
  DB_PATH="$SPEC" OUT_PATH="$OUT" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.DB_PATH);
    // VACUUM INTO 产出的是一致性快照，不需要停服务
    db.exec("VACUUM INTO \x27" + process.env.OUT_PATH.replace(/\x27/g, "\x27\x27") + "\x27");
    db.close();
  '
  gzip -9 "$OUT"
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
  [[ "$DB_PORT" == "$DB_HOSTPORT" || -z "$DB_PORT" ]] && DB_PORT=3306

  OUT="$BACKUP_DIR/daily/grid_${STAMP}.sql.gz"
  echo "[backup] mysqldump → $OUT"
  MYSQL_PWD="$DB_PASS" mysqldump \
    -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" \
    --single-transaction --quick --routines --triggers --set-gtid-purged=OFF \
    "$DB_NAME" | gzip -9 > "$OUT"
fi

# 周日额外留一份周备份
if [[ "$(date +%u)" == "7" ]]; then
  cp "$BACKUP_DIR"/daily/grid_${STAMP}.* "$BACKUP_DIR/weekly/" 2>/dev/null || true
fi

# 清理过期
find "$BACKUP_DIR/daily" -type f -mtime +$KEEP_DAYS -delete
ls -1t "$BACKUP_DIR"/weekly/* 2>/dev/null | tail -n +5 | xargs -r rm -f

# 异地：对象存储（先 rclone config 配好 oss: 或 cos:）
if command -v rclone >/dev/null 2>&1 && rclone listremotes | grep -q '^oss:'; then
  rclone copy "$BACKUP_DIR/daily/" oss:grid-backup/daily/ --bwlimit 2M --include "grid_${STAMP}*"
  echo "[backup] 已同步到 oss:grid-backup/daily/"
else
  echo "[backup] 跳过异地同步（rclone 未配置 oss:）"
fi

echo "[backup] 完成：$(ls -lh "$BACKUP_DIR"/daily | tail -1)"
