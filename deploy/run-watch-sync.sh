#!/bin/sh
# 自选同步（watch-sync.js）：软路由 cron 交易日 9:14 在容器里启动，15:01 自己退出；已经在跑就不再起第二个。
# 它取代了 run-watch.sh：盯盘和推送改由阿里云上的 ai-bark 做，这里只把同花顺自选送过去。
cd "$(dirname "$0")/.." || exit 1
LOCK=/tmp/watch-sync.pid
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then exit 0; fi
echo $$ > "$LOCK"
LOG="reports/watch-sync-$(date +%Y%m%d).log"
node watch-sync.js "$@" >> "$LOG" 2>&1
code=$?
rm -f "$LOCK"
exit $code
