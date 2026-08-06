# 天枢 Tianshu

**Python 3.11+** · **Apache-2.0 License** · **v0.1.0**

多 Agent 协同系统,主 Agent 调度多个子 Agent,支持技能/工具调用、审核审批、三层记忆,三端(CLI / Web / 桌面)。

## 标签 Tags

| 标签 | 说明 |
|------|------|
| `latest` | 最新稳定版 |
| `v0.1.0` | 首个版本 |

## 镜像列表

| 镜像 | 说明 |
|------|------|
| `lordofstars/tianshu` | 应用镜像:完整代码 + 锁定依赖,拉取即运行 |
| `lordofstars/tianshu-sandbox` | 沙箱镜像:仅依赖,供 Agent 命令隔离执行 |

## 快速开始

```bash
docker pull lordofstars/tianshu
docker run -p 8000:8000 lordofstars/tianshu
```

打开 http://127.0.0.1:8000 即可对话(默认离线 mock 模式)。

## 连接真实模型

```bash
docker run -p 8000:8000 -v "$PWD/.env:/app/.env" lordofstars/tianshu
```

`.env` 格式见 GitHub 仓库 [l1064709321/tianshu](https://github.com/l1064709321/tianshu) README。

## 沙箱隔离

Agent 执行 shell 命令默认走沙箱:有 Docker 时用一次性容器(`--network none` + 512MB 内存 + CPU 限制 + 超时强杀),无 Docker 自动降级为本地 ulimit 限制。沙箱镜像名可用环境变量覆盖:`TIANSHU_SANDBOX_IMAGE`。

## 更多命令

```bash
docker run --rm lordofstars/tianshu tianshu chat      # 交互式聊天
docker run --rm lordofstars/tianshu tianshu providers # 查看支持的模型厂商
docker run --rm lordofstars/tianshu tianshu doctor    # 环境自检
```

## 构建镜像

```bash
docker login -u lordofstars
bash scripts/build_sandbox_image.sh
```
