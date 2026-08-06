# 天枢

项目名称:天枢(北斗第一星)

一个多 Agent 协同系统,目标能力对标 opencode。

## 一键克隆 + 启动

```bash
git clone https://github.com/l1064709321/tianshu.git
cd tianshu
bash scripts/start.sh        # 自动装依赖、生成配置、启动 Web(离线 mock 模式)
```

浏览器打开 http://127.0.0.1:8000 即可对话。连接真实模型:编辑 `.env` 填入你的厂商配置(见下方"配置模型"),重启 `bash scripts/start.sh`。

## 项目目标

- **多 Agent 协同**:一个主 Agent(Orchestrator)调度多个子 Agent(Worker),子 Agent 之间可相互调用,主 Agent 负责任务分解与结果汇总。
- **技能系统**:Agent 可根据技能执行任务——写代码、自然语言聊天、抓取网页等。
- **工具系统**:Agent 可调用任意注册工具(文件操作、shell、HTTP 等),命令执行默认走沙箱(Docker 容器隔离,无 Docker 自动降级为本地资源限制)。
- **审核系统**:高危操作执行前需经过审批。
- **记忆系统**:三层记忆(短期对话/中期摘要/长期 PROJECT_MEMORY.md),实时命中率监测。
- **多端界面**:CLI、Web、桌面端三端。
- **多模型支持**:兼容除 Claude 外的所有主流 LLM(OpenAI 兼容接口、本地 Ollama、多家厂商),可通过配置切换。
- **可部署**:以服务方式部署运行。

## 技术栈

- 后端核心:Python 3.11+ / asyncio / FastAPI
- 配置与校验:pydantic
- CLI:typer + rich
- Web:FastAPI + WebSocket + 前端框架(待定)
- 桌面端:待定(Tauri / Electron)

## 架构

```
tianshu/
├── core/
│   ├── agent/          # Agent 运行时与消息总线
│   ├── orchestrator/   # 主 Agent 调度与汇总
│   ├── tools/          # 工具注册表与内置工具(含沙箱)
│   ├── sandbox/        # 沙箱执行器(Docker 优先,local 降级)
│   ├── skills/         # 技能系统与内置技能
│   ├── llm/            # 模型 Provider 适配层
│   ├── memory.py       # 三层记忆 + 缓存命中监测
│   ├── review/         # 审核/审批系统
│   ├── session.py      # 会话持久化
│   └── config.py       # 全局配置
├── interfaces/
│   ├── cli/            # 终端交互
│   ├── web/            # Web API + WS 事件流 + 前端
│   └── desktop/        # 桌面端
├── scripts/            # 一键启动等脚本
└── tests/              # 51 项测试
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

### 使用

```bash
.venv/bin/tianshu chat          # 交互式聊天(主 Agent 调度)
.venv/bin/tianshu ask "帮我抓取 https://example.com 并总结"
.venv/bin/tianshu serve         # Web 界面: http://127.0.0.1:8000
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
.venv/bin/python -m pytest tests/ -q   # 51 项测试
```

### 沙箱说明

Agent 执行 shell 命令默认走沙箱执行器:`tianshu/core/sandbox/`。有 Docker 时用一次性容器(`--network none` + 512MB 内存 + 预装依赖镜像,一键复用);无 Docker 自动降级为本地 `ulimit` 资源限制。均含超时强杀与进程数/内存上限。