#!/usr/bin/env bash
# 构建并推送天枢镜像到 Docker Hub(需先 docker login)
#   lordofstars/tianshu          应用镜像: 代码+依赖+环境一体,docker run 直接跑
#   lordofstars/tianshu-sandbox  沙箱镜像: 仅依赖,供 Agent 命令沙箱复用
# 用法: bash scripts/build_sandbox_image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APP_IMAGE="${TIANSHU_IMAGE:-lordofstars/tianshu}"
SANDBOX_IMAGE="${TIANSHU_SANDBOX_IMAGE:-lordofstars/tianshu-sandbox}"

echo "==> 1/2 构建应用镜像: $APP_IMAGE(仓库根 Dockerfile)"
docker build -t "$APP_IMAGE" -f Dockerfile .
echo "==> 推送应用镜像"
docker push "$APP_IMAGE"

# 沙箱镜像: 仅依赖
echo "==> 2/2 构建沙箱镜像: $SANDBOX_IMAGE"
docker build -t "$SANDBOX_IMAGE" -f <(python3 - <<'PYEOF'
from tianshu.core.sandbox.docker import DOCKERFILE
print(DOCKERFILE)
PYEOF
) .

echo "==> 推送沙箱镜像"
docker push "$SANDBOX_IMAGE"

echo "==> 完成。"
echo "    用户一键启动(含代码+依赖):"
echo "      docker pull $APP_IMAGE"
echo "      docker run -p 8000:8000 $APP_IMAGE"
echo "    沙箱镜像(Agent 命令隔离): $SANDBOX_IMAGE"
