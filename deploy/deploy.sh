#!/usr/bin/env bash
# 一键部署。在服务器上执行：
#   cd /www/wwwroot/todo && bash deploy/deploy.sh
#
# 前提（只需做一次）：
#   1. Node ≥ 22.12（推荐 24 LTS）：宝塔「Node 版本管理器」或 nvm
#      低于这个版本会在 pnpm install 阶段被 engines 拦下
#   2. pnpm：corepack enable && corepack prepare pnpm@latest --activate
#   3. .env 已按 deploy/env.example 填好，库里已建 grid 与 grid_rw
set -euo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/todo}"
cd "$APP_DIR"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "1/5 拉代码"
git pull --ff-only

step "2/5 安装依赖"
# 迁移脚本用 tsx 跑，所以不能加 --prod，否则 db:migrate 会找不到 tsx
pnpm install --frozen-lockfile

step "3/5 执行迁移（幂等）"
pnpm --filter @grid/server db:migrate

step "4/5 构建"
pnpm --filter @grid/web build
pnpm --filter @grid/server build

step "5/5 重启并探活"
install -d /www/log/grid
systemctl restart grid
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:3000/api/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

curl -fsS "http://127.0.0.1:3000/api/healthz"
echo
printf '\n部署完成。若上面 rssMB 明显偏高或 db 不为 up，先看 /www/log/grid/api.log\n'
