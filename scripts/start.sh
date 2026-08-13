#!/usr/bin/env bash
# 天枢一键启动:自动安装依赖 -> 配置环境 -> 启动 Web 服务(默认 mock 离线模式)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/4 准备 Python 虚拟环境"
if [ ! -d .venv ]; then
  if ! python3 -m venv .venv 2>/dev/null; then
    echo "    venv 创建失败,尝试安装 python3-venv..."
    if command -v apt >/dev/null 2>&1; then
      PY_VER=$(python3 -c 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")')
      sudo apt-get update -qq && sudo apt-get install -y -qq "python${PY_VER}-venv" || true
    elif command -v yum >/dev/null 2>&1; then
      sudo yum install -y python3-virtualenv || true
    fi
    python3 -m venv .venv
  fi
fi
if [ ! -f .env ]; then
  echo "==> 2/4 未发现 .env,生成 mock 离线配置(想接真实模型请编辑 .env)"
  cat > .env <<'EOF'
TIANSHU_DEFAULT_PROVIDER=mock
TIANSHU_PROVIDERS=[{"name":"mock","base_url":"http://localhost:9100/v1","api_key":"","model":"mock-model","timeout":30}]
EOF
else
  echo "==> 2/4 .env 已存在,保留"
fi

echo "==> 3/4 安装依赖(优先国外源,国内源5分钟超时切换)"
PY=.venv/bin/python
PIP_TIMEOUT=300
install_deps() {
  if [ -f requirements.lock.txt ]; then
    $PY -m pip install --timeout "$PIP_TIMEOUT" -r requirements.lock.txt -i "$1" -q || return 1
  fi
  $PY -m pip install --timeout "$PIP_TIMEOUT" -e ".[dev]" -i "$1" -q || return 1
}
install_offline() {
  local dir="$1"
  if [ -f requirements.lock.txt ]; then
    $PY -m pip install --no-index --find-links "$dir" -r requirements.lock.txt -q || return 1
  fi
  $PY -m pip install --no-index --find-links "$dir" -e ".[dev]" -q || return 1
}
WHEELS="wheels/$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/darwin/macos/;s/mingw.*/windows/' || echo current)"
if [ -d "$WHEELS" ]; then
  echo "    检测到离线包 $WHEELS,离线安装(零网络)"
  if ! install_offline "$WHEELS"; then
    echo "    离线安装失败,回退在线源"
  fi
elif [ -d wheels/current ]; then
  echo "    检测到离线包 wheels/current,离线安装(零网络)"
  if ! install_offline wheels/current; then
    echo "    离线安装失败,回退在线源"
  fi
else
  # 优先国外源
  echo "    尝试 PyPI 官方源..."
  if install_deps https://pypi.org/simple; then
    echo "    ✅ PyPI 官方源成功"
  else
    echo "    PyPI 失败,依次尝试国内镜像(各5分钟超时)..."
    # 国内源依次尝试:清华→阿里→华为→腾讯云
    declare -a CN_SOURCES=(
      "https://pypi.tuna.tsinghua.edu.cn/simple"
      "https://mirrors.aliyun.com/pypi/simple/"
      "https://mirrors.huaweicloud.com/repository/pypi/simple"
      "https://pypi.tuna.tsinghua.edu.cn/simple"
      "https://pypi.tuna.tsinghua.edu.cn/simple/"
      "https://mirrors.aliyun.com/pypi/simple"
    )
    INSTALLED=0
    for src in "${CN_SOURCES[@]}"; do
      echo "    尝试 ${src}..."
      if install_deps "$src"; then
        echo "    ✅ 国内源成功:${src}"
        INSTALLED=1
        break
      else
        echo "    ❌ ${src} 失败,切换下一个..."
      fi
    done
    if [ "$INSTALLED" -eq 0 ]; then
      echo "    ⚠️ 所有源均失败,请检查网络或手动安装依赖"
      exit 1
    fi
  fi
fi

# 脚本启动时自动选择空闲端口(8000-9000)
pick_port() {
  for p in $(seq 8000 9000); do
    if ! python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(('', $p))
    s.close()
    exit(0)
except:
    exit(1)
" 2>/dev/null; then
      continue
    fi
    echo "$p"
    return 0
  done
  echo "8000"
}
PORT=$(pick_port)

echo "==> 4/4 启动(浏览器打开 http://127.0.0.1:$PORT,Ctrl+C 停止)"
if [ "$(grep -c 'mock' .env || true)" -gt 0 ]; then
  (setsid .venv/bin/tianshu mockllm --port 9100 >/tmp/ts-mock.log 2>&1 &)
fi
.venv/bin/tianshu serve --host 127.0.0.1 --port $PORT