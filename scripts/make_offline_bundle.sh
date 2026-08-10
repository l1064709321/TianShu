#!/usr/bin/env bash
# 构建离线 wheel bundle:预下载全部依赖,装依赖零网络、100% 确定
# 用法: bash scripts/make_offline_bundle.sh [平台]   # 默认当前平台;可选 linux/macos/windows
# 产物: wheels/{platform}/ 目录,start.sh 检测到后自动离线安装
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
PY=.venv/bin/python

PLATFORM="${1:-}"
DEST="wheels/${PLATFORM:-current}"
mkdir -p "$DEST"

$PY -m pip download --only-binary=:all: -r requirements.lock.txt -d "$DEST" \
  -i https://pypi.tuna.tsinghua.edu.cn/simple || \
  $PY -m pip download --only-binary=:all: -r requirements.lock.txt -d "$DEST" \
  -i https://mirrors.aliyun.com/pypi/simple/

echo "==> 离线包已生成: $DEST ($(ls "$DEST" | wc -l) 个 wheel,零网络安装)"
