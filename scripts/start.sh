#!/usr/bin/env bash
# 天枢一键启动:自动安装依赖 -> 配置环境 -> 启动 Web 服务(默认 mock 离线模式)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/4 准备 Python 虚拟环境"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
if [ ! -f .env ]; then
  echo "==> 2/4 未发现 .env,生成 mock 离线配置(想接真实模型请编辑 .env)"
  cat > .env <<'EOF'
TIANSHU_DEFAULT_PROVIDER=mock
TIANSHU_PROVIDERS=[{"name":"mock","base_url":"http://127.0.0.1:9100/v1","api_key":"","model":"mock-model","timeout":30}]
EOF
else
  echo "==> 2/4 .env 已存在,保留"
fi

echo "==> 3/4 安装依赖(国内源加速,失败自动换源重试)"
PY=.venv/bin/python
install_deps() {
  $PY -m pip install -e ".[dev]" -i "$1" -q || return 1
}
if ! install_deps https://pypi.tuna.tsinghua.edu.cn/simple; then
  echo "清华源失败,切换阿里源重试..."
  install_deps https://mirrors.aliyun.com/pypi/simple/
fi

echo "==> 4/4 启动(浏览器打开 http://127.0.0.1:8000,Ctrl+C 停止)"
if [ "$(grep -c 'mock' .env || true)" -gt 0 ]; then
  (setsid .venv/bin/tianshu mockllm >/tmp/ts-mock.log 2>&1 &) 
fi
.venv/bin/tianshu serve --port 8000