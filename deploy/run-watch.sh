#!/bin/sh
# 盘中盯自选（watch-alerts.js）：软路由 cron 交易日 9:14 在容器里启动，15:01 自己退出；已经在跑就不再起第二个。
cd "$(dirname "$0")/.." || exit 1
LOCK=/tmp/watch-alerts.pid
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then exit 0; fi
echo $$ > "$LOCK"
LOG="reports/watch-$(date +%Y%m%d).log"
node watch-alerts.js "$@" >> "$LOG" 2>&1
code=$?
rm -f "$LOCK"
exit $code
