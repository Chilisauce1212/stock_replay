#!/bin/sh
# 每日更新入口（阿里云 systemd / 软路由 cron 都调这个）：经 run-coordinator.js 抢 R2 运行标记、同步共享状态后再跑 daily-update.js。
# STOCK_REPLAY_ROLE=primary|fallback（默认 primary）；STOCK_REPLAY_HOST 给标记里的机器名（默认 hostname）。
cd "$(dirname "$0")/.." || exit 1
LOG="reports/daily-update-$(date +%Y%m%d).log"
echo "===== $(date '+%F %T') 开始（${STOCK_REPLAY_ROLE:-primary}）=====" >> "$LOG"
node run-coordinator.js --role "${STOCK_REPLAY_ROLE:-primary}" >> "$LOG" 2>&1
code=$?
echo "__DONE__ 退出码 $code" >> "$LOG"
exit $code
