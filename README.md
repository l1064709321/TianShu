# 天枢

[![语言](https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-Python_3.11%2B-blue)](https://www.python.org)
[![许可](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-Apache_2.0-blue)](https://github.com/l1064709321/tianshu/blob/main/LICENSE)
[![下载量](https://img.shields.io/docker/pulls/lordofstars/tianshu?label=%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://hub.docker.com/r/lordofstars/tianshu)
[![镜像版本](https://img.shields.io/docker/v/lordofstars/tianshu?sort=semver&label=%E9%95%9C%E5%83%8F%E7%89%88%E6%9C%AC)](https://hub.docker.com/r/lordofstars/tianshu)
[![镜像体积](https://img.shields.io/docker/image-size/lordofstars/tianshu?label=%E9%95%9C%E5%83%8F%E4%BD%93%E7%A7%AF)](https://hub.docker.com/r/lordofstars/tianshu)

项目名称:天枢(北斗第一星)

一个多 Agent 协同系统,目标能力对标 opencode。

## 一键克隆 + 启动

```bash
git clone https://github.com/l1064709321/tianshu.git
cd tianshu
bash scripts/start.sh        # 自动装依赖、生成配置、启动 Web(离线 mock 模式)
```

浏览器打开脚本输出提示的地址即可对话(端口在 8000-9000 间自动挑选空闲端口,默认 `http://localhost:8000`)。连接真实模型:编辑 `.env` 填入你的厂商配置(见下方"配置模型"),重启 `bash scripts/start.sh`。

## 一键 Docker 运行(无需装 Python/依赖)

```bash
docker pull lordofstars/tianshu
docker run -p 8000:8000 lordofstars/tianshu
```

镜像内含完整代码 + 锁定依赖,拉取即得可运行环境。浏览器打开 http://localhost:8000(Docker 映射固定 8000,可用 `-p 宿主机端口:8000` 改);连接真实模型挂载 .env:

```bash
docker run -p 8000:8000 -v "$PWD/.env:/app/.env" lordofstars/tianshu
```

构建/推送镜像(需 `docker login -u 你的账号` 并配好 DOCKER_HUB_TOKEN):

```bash
bash scripts/build_sandbox_image.sh
# 产物: lordofstars/tianshu(应用) + lordofstars/tianshu-sandbox(沙箱)
```

国内镜像仓库双推(可选,国内拉取秒级):

```bash
TIANSHU_ACR_REGISTRY=registry.cn-hangzhou.aliyuncs.com \
TIANSHU_ACR_NAMESPACE=lordofstars \
bash scripts/build_sandbox_image.sh
```

镜像名可用环境变量覆盖:`TIANSHU_IMAGE` / `TIANSHU_SANDBOX_IMAGE`。

### 完全离线安装(零网络)

```bash
bash scripts/make_offline_bundle.sh    # 预下载全部依赖 wheel 到 wheels/{平台}/
bash scripts/start.sh                  # 检测到离线包后 --no-index 零网络安装
```

离线包可拷贝到无网机器,安装 100% 成功,不碰任何网络。

## 项目目标

- **多 Agent 协同**:一个主 Agent(Orchestrator)调度多个子 Agent(Worker),子 Agent 之间可相互调用,主 Agent 负责任务分解与结果汇总。
- **技能系统**:Agent 可根据技能执行任务——写代码、自然语言对话、抓取网页等。
- **工具系统**:Agent 可调用任意注册工具(文件操作、shell、HTTP 等),命令执行默认走沙箱(Docker 容器隔离,无 Docker 自动降级为本地资源限制)。
- **审核系统**:高危操作执行前需经过审批。
- **记忆系统**:三层记忆(短期对话/中期摘要/长期 PROJECT_MEMORY.md),实时命中率监测。
- **多端界面**:CLI、Web、桌面端三端。
- **模型池**:内置国内外主流厂商目录(OpenAI/Claude/Grok/Gemini/DeepSeek/Qwen/GLM/Kimi/Ollama/Agnes 等),Web 端可视化接入、多 Key 管理与在线刷新模型列表。
- **多模型支持**:兼容除 Claude 外的所有主流 LLM(OpenAI 兼容接口、本地 Ollama、多家厂商),可通过配置切换。
- **可部署**:以服务方式部署运行。

## 技术栈

- 后端核心:Python 3.11+ / asyncio / FastAPI
- 配置与校验:pydantic
- CLI:typer + rich
- Web:FastAPI + WebSocket + 原生 JS 单页(模型池面板)
- 桌面端:pywebview 壳

## 架构

```
tianshu/
├── core/
│   ├── agent/          # Agent 运行时与消息总线
│   ├── orchestrator/   # 主 Agent 调度与汇总
│   ├── tools/          # 工具注册表与内置工具(含沙箱)
│   ├── sandbox/        # 沙箱执行器(Docker 优先,local 降级)
│   ├── skills/         # 技能系统与内置技能
│   ├── llm/            # 模型 Provider 适配层 + 智能调度器(dispatcher)
│   ├── modelpool/      # 模型池:内置厂商目录 + 多 Key 存储 + 在线刷新
│   ├── memory.py       # 三层记忆 + 缓存命中监测
│   ├── review/         # 审核/审批系统
│   ├── session.py      # 会话持久化
│   └── config.py       # 全局配置
├── config/             # 模型池持久化(models.json,多 Key 掩码存储)
├── interfaces/
│   ├── cli/            # 终端交互
│   ├── web/            # Web API + WS 事件流 + 前端
│   └── desktop/        # 桌面端
├── scripts/            # 一键启动等脚本
└── tests/              # 92 项测试
```

## 快速开始(手动)

```bash
git clone https://github.com/l1064709321/tianshu.git
cd tianshu
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]" -i https://pypi.tuna.tsinghua.edu.cn/simple

# 配置模型(OpenAI 兼容 / Ollama 本地等,见下方示例)
cat > .env <<'EOF'
TIANSHU_DEFAULT_PROVIDER=ollama
TIANSHU_PROVIDERS=[{"name":"ollama","base_url":"http://localhost:11434/v1","api_key":"","model":"qwen2.5"}]
EOF
```

### 模型池(Web 端可视化接入)

`tianshu serve` 启动后,点击页头「模型池」按钮:

- **内置厂商目录**:国外(OpenAI/GPT、Anthropic Claude、xAI Grok、Google Gemini、Sapiens Agnes)、国内(DeepSeek、通义 Qwen、智谱 GLM、Kimi、文心、混元、豆包、MiniMax、讯飞星火)、本地(Ollama)。
- **接入**:粘贴厂商 API Key → 「测试连接」验证 → 「接入」自动写入 `config/models.json` 并热切换(不重启、不丢会话)。
- **多 Key**:同厂商可配多个 Key,输入栏可选择首选 Key;发送时若首选 Key 返回 401/403 判定过期,调度器自动切换下一个有效 Key,全部失效才报错。
- **在线刷新**:已接入厂商点击「刷新模型列表」,调官方 `/v1/models` 拉取最新模型。
- Claude 因非 OpenAI 协议不可被天枢调用,但可在池中保存配置供外部项目使用(标记「仅外部配置」)。

### 使用

```bash
.venv/bin/tianshu chat          # 交互式聊天(主 Agent 调度)
.venv/bin/tianshu ask "帮我抓取 https://example.com 并总结"
.venv/bin/tianshu serve         # Web 界面(默认 8000;start.sh 启动则自动选空闲端口)
.venv/bin/tianshu desktop       # 桌面端(原生窗口,自动回退浏览器)
.venv/bin/tianshu providers     # 查看支持的 LLM 厂商
```

### 内置技能

- `chat`: 自然语言对话
- `write-code`: 阅读/编写/修改代码
- `web-crawler`: 抓取网页并整理

### 审核模式

高危操作(写文件、执行 shell)默认需人工审批;`--review auto_approve` 或 `auto_reject` 可切换。

### 无 key 离线端到端验证

```bash
bash scripts/e2e_mock.sh   # 启动本地 mock LLM,验证主Agent拆解→调度→汇总全流程
.venv/bin/tianshu doctor   # 检查 .env 配置与真实模型连接
.venv/bin/python -m pytest tests/ -q   # 83 项测试
```

### 沙箱说明

Agent 执行 shell 命令默认走沙箱执行器:`tianshu/core/sandbox/`。有 Docker 时用一次性容器(`--network none` + 512MB 内存 + 预装依赖镜像,一键复用);无 Docker 自动降级为本地 `ulimit` 资源限制。均含超时强杀与进程数/内存上限。

**安全边界**:shell 白名单仅允许无副作用的读取命令(`ls/cat/grep/find/echo` 等,解释器与包管理器一律禁止);`fetch_url` 逐跳校验重定向、DNS 解析后二次拦截内网;文件工具限定工作区内。Web 服务仅监听本机,无认证,请勿暴露到公网。

**敏感临时区 `workspace/.ts-secrets/`**:Agent 可读写该区存放密钥/凭据(工具 `save_secret`/`clear_secrets`,或直接读写该路径)。该区已被 .gitignore 与 .dockerignore 排除,**不提交、不打包、不进镜像**,仅存于本机;用完可用 `clear_secrets` 清空。区内文件同样受命令白名单与路径钳制约束。

## LLM 智能调度(tianshu/core/llm/dispatcher.py)

多模型接入后,调度器按 LiteLLM 官方设计自动路由与容灾:

- **五种路由策略**:`simple-shuffle`(默认,按权重/配额加权随机)、`least-busy`(最少活跃请求)、`usage-based-routing`(按 RPM/TPM 利用率)、`latency-based-routing`(滑动窗口最低延迟)、`cost-based-routing`(最低成本)。
- **加权故障转移**:同组部署失败后排除并重新按权选择,组内全部耗尽才跨组 fallback(上限 `max_fallbacks`)。
- **熔断冷却**:部署连续失败达 `allowed_fails` 次进入 `cooldown_time` 冷却,期间不接流量,到期自动恢复。
- **三层分类 fallback**:普通错误 / 上下文超长(`context_window_fallbacks`,自动识别 ContextWindowExceeded)/ 内容策略拒绝(`content_policy_fallbacks`),分别走不同降级链。
- **统计可观测**:每次调用记录延迟滑动窗口与成败计数,`get_stats()` 可查。

`.env` 中配置多个 provider 后,调度器按组注册;示例见上文"配置模型"。