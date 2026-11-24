#!/bin/sh
# 家里软路由（iStoreOS / OpenWrt，2026-11-19）首次初始化：OpenWrt 跑不了 Playwright 的 Chromium，所以在 Docker 容器里跑。
# 在软路由上执行：sh /mnt/sata2-4/stock_replay/deploy/router-setup.sh （代码先用 deploy.sh router 传上来；deploy.sh 里的 npm ci 失败没关系，这里会装）
#   - 容器 stock-replay：Debian bookworm + Node 20，项目目录挂在 /app，Playwright 浏览器装在 /app/.pw-browsers（重建容器不用重下）
#   - 最多用 3 个核、3 GB 内存，给软路由自己（OpenClash、Jellyfin 等）留余量
#   - cron：周一到周五 21:00 做主跑每日更新（阿里云 22:30 兜底）
set -e
DIR=/mnt/sata2-4/stock_replay
IMAGE=docker.m.daocloud.io/library/node:20-bookworm-slim
docker pull "$IMAGE"
docker rm -f stock-replay 2>/dev/null || true
docker run -d --name stock-replay --restart unless-stopped --cpus 3 --memory 3g \
  -e TZ=Asia/Shanghai -e PLAYWRIGHT_BROWSERS_PATH=/app/.pw-browsers \
  -e STOCK_REPLAY_ROLE=primary -e STOCK_REPLAY_HOST=router \
  -e NODE_OPTIONS=--max-old-space-size=2048 \
  -v "$DIR":/app -w /app "$IMAGE" sleep infinity
docker exec stock-replay sh -c '
  set -e
  sed -i "s#deb.debian.org#mirrors.aliyun.com#g" /etc/apt/sources.list.d/debian.sources
  apt-get update -qq && apt-get install -y -qq tzdata >/dev/null
  npm ci --no-audit --no-fund --silent --registry=https://registry.npmmirror.com
  PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install --with-deps chromium-headless-shell
'
# 容器重建后 apt 装的系统依赖会丢：开机/重建后由 cron 前的检查补装（见下面 ensure 行）
LINE='0 21 * * 1-5 docker exec stock-replay sh /app/deploy/run-daily.sh'
# 自选同步：9:14 启动、15:01 自己退出，每分钟把同花顺自选送到阿里云 ai-bark（2026-11-24 起盯盘和推送由 ai-bark 做）。
# 不要再装 run-watch.sh：那样软路由和 ai-bark 会各推一遍。要退回软路由自己盯盘，把这行换回 run-watch.sh
WATCH='14 9 * * 1-5 docker exec stock-replay sh /app/deploy/run-watch-sync.sh'
# 同花顺登录（盯盘读自选用）：8:30 检查，剩不到 2 天或读不到自选就把二维码推到手机扫（扫码登录 30 天有效）
THS_LOGIN='30 8 * * 1-5 docker exec stock-replay sh -c "node /app/ths-qr-login.js --if-needed >> /app/reports/ths-login.log 2>&1"'
ENSURE='50 20 * * 1-5 docker exec stock-replay sh -c "ldd /app/.pw-browsers/chromium_headless_shell-*/chrome-*/headless_shell 2>/dev/null | grep -q \"not found\" && PLAYWRIGHT_BROWSERS_PATH=/app/.pw-browsers npx playwright install-deps chromium-headless-shell >/dev/null 2>&1; true"'
touch /etc/crontabs/root
grep -v 'stock-replay' /etc/crontabs/root > /tmp/crontab.new || true
echo "$ENSURE" >> /tmp/crontab.new
echo "$LINE" >> /tmp/crontab.new
echo "$WATCH" >> /tmp/crontab.new
echo "$THS_LOGIN" >> /tmp/crontab.new
cp /tmp/crontab.new /etc/crontabs/root && rm /tmp/crontab.new
/etc/init.d/cron enable >/dev/null 2>&1 || true
/etc/init.d/cron restart
echo "软路由初始化完成：$(docker exec stock-replay node -v)，cron："
grep stock-replay /etc/crontabs/root
