#!/usr/bin/env bash
# 一条本地命令完成初始化并启动：./run.sh [port]
set -euo pipefail
cd "$(dirname "$0")"

export PYTHONUNBUFFERED=1
PORT="${1:-8000}"

echo "正在初始化（SQLite 建表 + 预置占位素材，幂等可重复执行）……"
echo "------------------------------------------------------------"
echo " 自助证件照系统  http://127.0.0.1:${PORT}"
echo " 叫号屏 /screen/call   拍摄 /screen/capture   选片 /screen/select"
echo " 规格预览 /screen/preview  修正 /screen/retouch  冲印 /screen/print"
echo " 取件 /screen/pickup   退款 /screen/refund"
echo "------------------------------------------------------------"

exec python3 -m app.main --host 0.0.0.0 --port "${PORT}"
