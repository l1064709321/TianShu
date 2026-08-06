#!/usr/bin/env bash
# 构建并推送沙箱镜像到 Docker Hub(需先 docker login)
# 用法: bash scripts/build_sandbox_image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${TIANSHU_SANDBOX_IMAGE:-lordofstars/tianshu-sandbox}"
echo "==> 构建镜像: $IMAGE"
docker build -t "$IMAGE" -f <(python3 - <<'PYEOF'
from tianshu.core.sandbox.docker import DOCKERFILE
print(DOCKERFILE)
PYEOF
) .

echo "==> 推送镜像"
docker push "$IMAGE"

echo "==> 完成。用户端拉取: docker pull $IMAGE"
echo "==> 天枢运行时可设 TIANSHU_SANDBOX_IMAGE=$IMAGE 直接使用"
