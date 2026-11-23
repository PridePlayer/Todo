#!/usr/bin/env bash
# 探活。给宝塔「网站监控」或 Uptime Kuma 的「HTTP 关键词」用，也可 cron 每 5 分钟跑：
#   bash /www/wwwroot/todo/deploy/healthcheck.sh
# 退出码：0 正常，1 异常（可直接被监控系统识别）
set -uo pipefail

URL="${1:-http://127.0.0.1:3000/api/healthz}"

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

exit 0
