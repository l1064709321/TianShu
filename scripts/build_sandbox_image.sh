#!/usr/bin/env bash
# 构建并推送天枢镜像(需先 docker login)
#   lordofstars/tianshu          应用镜像: 代码+依赖+环境一体,docker run 直接跑
#   lordofstars/tianshu-sandbox  沙箱镜像: 仅依赖,供 Agent 命令沙箱复用
# 国内镜像仓库双推(可选): 设置以下环境变量后自动双推,国内拉取走阿里云秒级
#   TIANSHU_ACR_REGISTRY=registry.cn-hangzhou.aliyuncs.com   # 阿里云 ACR 实例域名
#   TIANSHU_ACR_NAMESPACE=lordofstars                         # 命名空间
# 用法: bash scripts/build_sandbox_image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APP_IMAGE="${TIANSHU_IMAGE:-lordofstars/tianshu}"
SANDBOX_IMAGE="${TIANSHU_SANDBOX_IMAGE:-lordofstars/tianshu-sandbox}"
ACR_REGISTRY="${TIANSHU_ACR_REGISTRY:-}"
ACR_NAMESPACE="${TIANSHU_ACR_NAMESPACE:-lordofstars}"

echo "==> 1/2 构建应用镜像: $APP_IMAGE(仓库根 Dockerfile)"
docker build -t "$APP_IMAGE" -f Dockerfile .
echo "==> 推送应用镜像"
docker push "$APP_IMAGE"

# 沙箱镜像: 仅依赖(静态 Dockerfile,无 python 依赖)
echo "==> 2/2 构建沙箱镜像: $SANDBOX_IMAGE"
docker build -t "$SANDBOX_IMAGE" -f tianshu/core/sandbox/Dockerfile tianshu/core/sandbox

echo "==> 推送沙箱镜像"
docker push "$SANDBOX_IMAGE"

# 国内镜像仓库双推(阿里云 ACR):国内用户 docker pull 免翻墙
if [ -n "$ACR_REGISTRY" ]; then
  echo "==> 双推到国内镜像仓库: $ACR_REGISTRY"
  for img in "$APP_IMAGE" "$SANDBOX_IMAGE"; do
    repo="${img#*/}"
    acr_img="$ACR_REGISTRY/$ACR_NAMESPACE/$repo"
    docker tag "$img" "$acr_img"
    docker push "$acr_img"
    echo "    已推送: $acr_img"
  done
else
  echo "==> 跳过国内双推(未设置 TIANSHU_ACR_REGISTRY)"
fi

echo "==> 完成。"
echo "    用户一键启动(含代码+依赖):"
echo "      docker pull $APP_IMAGE"
echo "      docker run -p 8000:8000 $APP_IMAGE"
if [ -n "$ACR_REGISTRY" ]; then
  echo "    国内用户(秒级拉取):"
  echo "      docker pull $ACR_REGISTRY/$ACR_NAMESPACE/tianshu"
fi
echo "    沙箱镜像(Agent 命令隔离): $SANDBOX_IMAGE"
