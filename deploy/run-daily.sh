#!/bin/sh
# 服务器上每日更新的入口（systemd 定时器调用）：日志追加到 reports/daily-update-YYYYMMDD.log，最后写 __DONE__ 和退出码
cd /root/stock_replay || exit 1
LOG="reports/daily-update-$(date +%Y%m%d).log"
echo "===== $(date '+%F %T') 开始 =====" >> "$LOG"
node daily-update.js --yes >> "$LOG" 2>&1
code=$?
echo "__DONE__ 退出码 $code" >> "$LOG"
exit $code
