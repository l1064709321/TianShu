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

echo "==> 3/4 安装依赖(逐源快速探测,失败自动切换;单源最长 ${SOURCE_TIMEOUT:-90}s)"
PY=.venv/bin/python
PIP_OPTS="--timeout 15 --retries 1"
SOURCE_TIMEOUT="${SOURCE_TIMEOUT:-90}"
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$SOURCE_TIMEOUT" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$SOURCE_TIMEOUT" "$@"
  else
    "$@"
  fi
}
probe() {
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS --connect-timeout 5 --max-time 8 -o /dev/null "$1" 2>/dev/null
}
install_deps() {
  if ! probe "$1"; then
    echo "      ❌ ${1} 不可达,跳过"
    return 1
  fi
  if [ -f requirements.lock.txt ]; then
    if run_with_timeout $PY -m pip install $PIP_OPTS -r requirements.lock.txt -i "$1" -q; then
      echo "      ✅ requirements.lock.txt 锁定版本安装成功"
    else
      echo "      ⚠️ 锁文件部分版本在当前源不可用,改用 pyproject.toml 宽松版本重试..."
      run_with_timeout $PY -m pip install $PIP_OPTS -e ".[dev]" -i "$1" -q || return 1
      return 0
    fi
  fi
  run_with_timeout $PY -m pip install $PIP_OPTS -e ".[dev]" -i "$1" -q || return 1
}
install_offline() {
  local dir="$1"
  if [ -f requirements.lock.txt ]; then
    $PY -m pip install --no-index --find-links "$dir" -r requirements.lock.txt -q || return 1
  fi
  $PY -m pip install --no-index --find-links "$dir" -e ".[dev]" -q || return 1
}
WHEELS="wheels/$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/darwin/macos/;s/mingw.*/windows/' || echo current)"
OFFLINE_OK=0
if [ -d "$WHEELS" ]; then
  echo "    检测到离线包 $WHEELS,离线安装(零网络)"
  if install_offline "$WHEELS"; then OFFLINE_OK=1; else echo "    ❌ 离线安装失败,回退在线源"; fi
elif [ -d wheels/current ]; then
  echo "    检测到离线包 wheels/current,离线安装(零网络)"
  if install_offline wheels/current; then OFFLINE_OK=1; else echo "    ❌ 离线安装失败,回退在线源"; fi
fi
if [ "$OFFLINE_OK" -eq 0 ]; then
  SOURCES=()
  if [ -n "${TIANSHU_PIP_MIRROR:-}" ]; then
    SOURCES+=("$TIANSHU_PIP_MIRROR")
  fi
  SOURCES+=(
    "https://pypi.org/simple"
    "https://pypi.tuna.tsinghua.edu.cn/simple"
    "https://mirrors.aliyun.com/pypi/simple/"
    "https://mirrors.huaweicloud.com/repository/pypi/simple"
    "https://mirrors.cloud.tencent.com/pypi/simple"
  )
  INSTALLED=0
  for src in "${SOURCES[@]}"; do
    echo "    尝试 ${src} ($(date +%H:%M:%S))..."
    if install_deps "$src"; then
      echo "    ✅ 依赖安装成功:${src}"
      INSTALLED=1
      break
    else
      echo "    ❌ ${src} 失败/超时,立即切换下一个源"
    fi
  done
  if [ "$INSTALLED" -eq 0 ]; then
    echo "    ⚠️ 所有源均失败,请检查网络或手动安装依赖"
    exit 1
  fi
fi

# 脚本启动时自动选择空闲端口:8000-9000 内随机探测,被占用就切换下一个
pick_port() {
  python3 - "$@" <<'EOF'
import random
import socket
import sys

start, end = 8000, 9000
if len(sys.argv) > 2:
    start, end = int(sys.argv[1]), int(sys.argv[2])
ports = list(range(start, end + 1))
random.shuffle(ports)
for p in ports:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("", p))
        print(p)
        sys.exit(0)
    except OSError:
        continue
print(start)
EOF
}
PORT=$(pick_port)

echo "==> 4/4 启动(浏览器打开 http://127.0.0.1:$PORT,Ctrl+C 停止)"
if [ "$(grep -c 'mock' .env || true)" -gt 0 ]; then
  (setsid .venv/bin/tianshu mockllm --port 9100 >/tmp/ts-mock.log 2>&1 &)
fi
.venv/bin/tianshu serve --host 127.0.0.1 --port $PORT