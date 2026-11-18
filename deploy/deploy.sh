#!/bin/sh
# 在本机（Windows 的 Git Bash）把当前提交的代码部署出去：只传 git 里的文件，不动数据、.env、问财登录状态。
# 用法: sh deploy/deploy.sh [aliyun|router|all]（默认 all）
#   aliyun：阿里云服务器（兜底，systemd 定时器 22:30）
#   router：家里软路由（做主，Docker 容器 stock-replay 里跑，cron 21:00；首次要先跑 deploy/router-setup.sh）
set -e
cd "$(dirname "$0")/.."
TARGET="${1:-all}"
KEY="-i /c/Users/admin/.ssh/id_ed25519 -o UserKnownHostsFile=/c/Users/admin/.ssh/known_hosts -o BatchMode=yes -o ConnectTimeout=40"
ALIYUN="ssh $KEY root@47.117.105.254"
# 软路由经阿里云 frp 跳转（frpc 把软路由 22 端口映射到阿里云 127.0.0.1:6000，公网不开放）；主机密钥按软路由的 Tailscale 地址校验
router_ssh() { ssh $KEY -o ServerAliveInterval=15 -o HostKeyAlias=100.117.121.112 -o "ProxyCommand=ssh $KEY -W 127.0.0.1:6000 root@47.117.105.254" root@router "$@"; }
ROUTER_DIR=/mnt/sata2-4/stock_replay

if [ "$TARGET" = aliyun ] || [ "$TARGET" = all ]; then
  git -c core.autocrlf=false archive --format=tar HEAD | gzip | $ALIYUN 'cd /root/stock_replay && tar xzf - && npm ci --no-audit --no-fund --silent && cp deploy/stock-replay-daily.service deploy/stock-replay-daily.timer /etc/systemd/system/ && systemctl daemon-reload && echo 阿里云部署完成'
fi
if [ "$TARGET" = router ] || [ "$TARGET" = all ]; then
  git -c core.autocrlf=false archive --format=tar HEAD | gzip | router_ssh "mkdir -p $ROUTER_DIR && cd $ROUTER_DIR && tar xzf - && docker exec stock-replay npm ci --no-audit --no-fund --silent --registry=https://registry.npmmirror.com && echo 软路由部署完成"
fi
