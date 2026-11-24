#!/usr/bin/env bash
# 探活。给宝塔「网站监控」或 Uptime Kuma 的「HTTP 关键词」用，也可 cron 每 5 分钟跑：
#   bash /www/wwwroot/todo/deploy/healthcheck.sh
# 退出码：0 正常，1 服务异常，2 服务正常但备份出问题
#
# 之所以把备份也塞进探活：备份脚本挂掉是**完全静默**的。
# cron 不给你发邮件，status.txt 没人看，等到真要用备份那天才发现
# 最近一份是三个月前的——这是自建服务最常见的翻车方式。
set -uo pipefail

URL="${1:-http://127.0.0.1:3000/api/healthz}"
BACKUP_STATUS="${BACKUP_STATUS:-/www/backup/grid/status.txt}"
# 每 6 小时备份一次，容错两次没跑就算异常
BACKUP_MAX_HOURS="${BACKUP_MAX_HOURS:-14}"

body="$(curl -fsS --max-time 5 "$URL" 2>/dev/null)" || {
  echo "FAIL 无法访问 $URL"
  exit 1
}

echo "$body"

echo "$body" | grep -q '"ok":true' || {
  echo "FAIL healthz 返回 ok != true"
  exit 1
}

# rssMB 超过 300 说明内存开始失控（见 docs/02 §9.3 升配触发条件），只告警不算失败
rss="$(echo "$body" | grep -o '"rssMB":[0-9]*' | cut -d: -f2)"
if [[ -n "${rss:-}" && "$rss" -gt 300 ]]; then
  echo "WARN rssMB=$rss 已超过 300，检查是否有泄漏"
fi

# ── 备份新鲜度 ────────────────────────────────────────────────
if [[ ! -f "$BACKUP_STATUS" ]]; then
  echo "WARN 还没有任何备份记录（$BACKUP_STATUS 不存在）：backup.sh 可能从没跑过"
  exit 0
fi

read -r state ts rest < "$BACKUP_STATUS"

if [[ "$state" == "FAILED" ]]; then
  echo "FAIL 最近一次备份失败：$rest"
  exit 2
fi

if ! [[ "$ts" =~ ^[0-9]+$ ]]; then
  echo "FAIL 备份状态文件格式不认识：$(cat "$BACKUP_STATUS")"
  exit 2
fi

age_s=$(( $(date +%s) - ts ))
age_h=$(( age_s / 3600 ))
if (( age_s > BACKUP_MAX_HOURS * 3600 )); then
  echo "FAIL 最近一次成功备份是 ${age_h} 小时前（阈值 ${BACKUP_MAX_HOURS}h）：$rest"
  exit 2
fi

echo "OK 备份 ${age_h}h 前：$rest"
exit 0
