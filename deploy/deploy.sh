#!/bin/sh
# 在本机（Windows 的 Git Bash）把当前提交的代码部署到阿里云服务器：只传 git 里的文件，不动服务器上的数据、.env、登录状态。
# 用法: sh deploy/deploy.sh
set -e
cd "$(dirname "$0")/.."
SSH="ssh -i /c/Users/admin/.ssh/id_ed25519 -o UserKnownHostsFile=/c/Users/admin/.ssh/known_hosts -o BatchMode=yes root@47.117.105.254"
git archive --format=tar HEAD | gzip | $SSH 'cd /root/stock_replay && tar xzf - && npm ci --no-audit --no-fund --silent && cp deploy/stock-replay-daily.service deploy/stock-replay-daily.timer /etc/systemd/system/ && systemctl daemon-reload && echo 部署完成'
