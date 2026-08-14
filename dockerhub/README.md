# 天枢 Tianshu

[![语言](https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-Python_3.11%2B-blue)](https://www.python.org)
[![许可](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-Apache_2.0-blue)](https://github.com/l1064709321/tianshu/blob/main/LICENSE)
[![下载量](https://img.shields.io/docker/pulls/lordofstars/tianshu?label=%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://hub.docker.com/r/lordofstars/tianshu)
[![镜像版本](https://img.shields.io/docker/v/lordofstars/tianshu?sort=semver&label=%E9%95%9C%E5%83%8F%E7%89%88%E6%9C%AC)](https://hub.docker.com/r/lordofstars/tianshu)
[![镜像体积](https://img.shields.io/docker/image-size/lordofstars/tianshu?label=%E9%95%9C%E5%83%8F%E4%BD%93%E7%A7%AF)](https://hub.docker.com/r/lordofstars/tianshu)
[![星标](https://img.shields.io/github/stars/l1064709321/tianshu?label=%E6%98%9F%E6%A0%87)](https://github.com/l1064709321/tianshu)

多 Agent 协同系统,主 Agent 调度多个子 Agent,支持技能/工具调用、审核审批、三层记忆,三端(CLI / Web / 桌面)。

## 标签 Tags

| 标签 | 说明 |
|------|------|
| `latest` | 最新稳定版 |
| `v0.0.0.0.0.1` | 首个版本 |

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

打开 http://localhost:8000 即可对话(默认离线 mock 模式;端口映射固定 8000,可用 `-p 宿主机端口:8000` 修改)。

多模型接入后内置 LiteLLM 风格智能调度器:五种路由策略(加权随机/最少占用/配额/延迟/成本)、加权故障转移、熔断冷却、上下文超长与内容策略专用降级链。

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
