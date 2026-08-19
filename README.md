# 天枢 (TianShu)

[![语言](https://img.shields.io/badge/language-TypeScript-blue)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/l1064709321/tianshu/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/l1064709321/tianshu/node.js.yml?label=CI&logo=githubactions)](https://github.com/l1064709321/tianshu/actions)
[![测试](https://img.shields.io/badge/tests-72%20passing-brightgreen)](https://github.com/l1064709321/tianshu/tree/main/tianshu-ts/test)
[![零依赖](https://img.shields.io/badge/runtime-Node%20builtin%20only-2b6cb0)](https://nodejs.org)
[![Stars](https://img.shields.io/github/stars/l1064709321/tianshu?style=social)](https://github.com/l1064709321/tianshu)

> **天枢**——北斗七星之首,指引方向的第一颗星。

一个**多 Agent 协同系统**,能力目标对标 opencode:由一个主 Agent(Orchestrator)理解任务、拆解子任务、调度多个子 Agent(Worker)并行执行,再汇总结果。Agent 之间可相互调用,可携带技能(Skills)、工具(Tools)、知识库(RAG),所有高危操作经过审核系统把关,全部运行在沙箱中,并留存审计日志。

## 特性

- **Orchestrator-Worker 协同**:主 Agent 自动拆解任务、调度子 Agent、汇总输出
- **技能体系**:Agent 按需加载技能(skills),内置 `chat` / `judge` / `web-crawler` / `write-code` 等技能
- **工具调用**:内置工具注册表 + 自定义工具,Agent 通过函数调用驱动
- **RAG 知识库**:本地文档入库、向量化检索,给 Agent 注入领域知识
- **模型池 + 多厂商 LLM**:兼容 OpenAI 兼容接口、本地 Ollama、DeepSeek 等多厂商(除 Claude)
- **高危操作审核**:CLI 终端内联审批(y 批准 / a 会话记忆 / n 拒绝 / d 拒绝会话)、Web 审批卡片、`--review auto_approve` 自动模式
- **沙箱隔离**:优先 Docker(无网络 + 资源限制),无 Docker 时自动降级到本地 `unshare` 命名空间 + `nobody` 降权(四级降级链)
- **安全护栏**:工作区授权白名单(`access_roots`)、写文件前自动快照可回滚、审计日志
- **三端形态**:CLI(commander)、Web 面板(node:http)、桌面端启动器
- **零框架依赖**:后端只用 Node 内置 `node:http` / `node:sqlite`,不引入 Express 等框架

## 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 | TypeScript 5.6(严格模式) |
| 运行时 | Node.js ≥ 22.5(`node:http`、`node:sqlite`) |
| CLI | commander |
| 数据校验 | zod |
| 数据库 | SQLite(Node 内置 `node:sqlite`) |
| LLM 接入 | OpenAI 兼容协议 / Ollama / 多厂商(除 Claude) |
| 沙箱 | Docker(优先)→ `unshare` + `runuser nobody`(降级) |
| 测试 | `node --test`(零测试框架依赖) |
| 前端 | 纯 HTML/CSS/JS 单文件(无构建工具) |

## 架构

```
┌─────────────────────────────────────────────────────────┐
│           CLI (commander) / Web 面板 / 桌面启动器         │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              Orchestrator(主 Agent)                     │
│          任务理解 → 拆解 → 调度 → 汇总                     │
└───┬───────────────┬───────────────┬───────────────────┬─┘
    │               │               │                   │
    ▼               ▼               ▼                   ▼
┌─────────┐   ┌─────────┐    ┌──────────┐        ┌──────────┐
│ Worker  │   │ Agent   │    │ RAG 检索  │        │ 模型池    │
│ (子Agent)│   │ 相互调用 │    │ (知识库)  │        │ 多厂商LLM │
└────┬────┘   └─────────┘    └──────────┘        └──────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  工具(Tools) │ 技能(Skills) │ 审核(Review) │ 沙箱(Sandbox)│
│  授权(access) │ 审计(audit) │ 快照回滚(rollback) │ 会话/记忆 │
└─────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
cd tianshu-ts
npm install
npm run web        # 启动 Web 面板(自动拉起本地 mock LLM,离线可用)
```

浏览器打开 `http://localhost:8000`(自动探测 8000-8999 可用端口,默认免登录)即可对话。

接入真实模型:

```bash
cd tianshu-ts
npx tsx src/cli/main.ts config --provider deepseek \
  --base-url https://api.deepseek.com/v1 \
  --api-key sk-xxx \
  --model deepseek-chat
```

或手动编辑 `.env`(参考 `.env.example`):

```ini
DEFAULT_PROVIDER=deepseek
DEFAULT_PROVIDER_BASE_URL=https://api.deepseek.com/v1
DEFAULT_PROVIDER_API_KEY=sk-xxx
DEFAULT_MODEL=deepseek-chat
```

## CLI

```bash
cd tianshu-ts
npx tsx src/cli/main.ts ask "用三句话介绍你自己"      # 单轮问答
npx tsx src/cli/main.ts chat                        # 交互模式(终端内联审批 y/a/n/d)
npx tsx src/cli/main.ts config                      # 查看当前模型配置(密钥掩码)
npx tsx src/cli/main.ts config --provider ... --api-key ...   # 配置模型(.env 持久化)
npx tsx src/cli/main.ts start                       # 启动 Web 面板(--token 开启认证)
npx tsx src/cli/main.ts doctor                      # 环境体检(模型连通性/沙箱可用性)
npx tsx src/cli/main.ts mockllm                     # 手动启动本地 mock LLM
npx tsx src/cli/main.ts desktop                     # 启动桌面端启动器
```

高危操作(写文件、执行命令等)默认需人工审批:

- **CLI 聊天**:终端内联审批,`y` 批准一次、`a` 记住本次会话、`n` 拒绝、`d` 拒绝本会话
- **Web 面板**:审批卡片(有实时连接才放行,无客户端时直接拒绝防止挂起)
- **自动模式**:`--review auto_approve` 跳过人工确认

## Web 面板

- 三栏布局:左侧会话列表 / 中间对话 / 右侧模型配置 + 运行监控
- 模型配置视图:在线查看/配置厂商、模型、API 地址与密钥
- 监控视图:缓存、记忆、后台状态一览
- 默认免登录;`tianshu start --token <token>` 启用访问认证

## 安全模型

1. **沙箱隔离**:Docker(无网络 + 资源限制)优先;无 Docker 时自动降级为
   `unshare --mount --net --pid` 命名空间 + `runuser -u nobody` 降权执行,
   探测失败逐级降级(完整隔离 → 网络隔离 → 降权 → 常规执行),并带瞬态失败重试
2. **授权白名单**:仅允许在工作区(workspace,受 `access_roots.json` 约束)内读写
3. **审核系统**:所有高危操作先过 review 系统,人工/自动审批后才执行
4. **快照回滚**:写文件前自动快照(`.ts-snapshots/`),支持回滚
5. **审计日志**:身份、操作、审核结果全程留痕
6. **密钥不入库**:`models.json`、`.env`、`access_roots.json`、`.ts-*` 运行时目录均被 `.gitignore` 排除

## 目录结构

```
tianshu-ts/
├── src/
│   ├── cli/                 # CLI(commander,纯终端)
│   ├── core/
│   │   ├── agent/           # Agent 运行时
│   │   ├── orchestrator/    # 主 Agent(任务拆解/调度/汇总)
│   │   ├── llm/             # 模型分发(OpenAI 兼容 / Ollama / 多厂商)
│   │   ├── modelpool/       # 模型池(目录、存储)
│   │   ├── rag/             # RAG 知识检索
│   │   ├── review/          # 高危操作审核系统
│   │   ├── sandbox/         # 沙箱(docker / local 四级降级链)
│   │   ├── skills/          # 技能仓库与工具化
│   │   ├── tools/           # 内置工具注册表
│   │   └── access.ts audit.ts backup.ts identity.ts memory.ts
│   │       rollback.ts session.ts config.ts
│   ├── interfaces/
│   │   ├── web/             # Web 面板 + WebSocket + mock LLM
│   │   └── desktop/         # 桌面端启动器
│   └── index.ts
├── static/                  # 前端单文件(HTML/CSS/JS 内联)
├── skills/                  # 内置技能(chat/judge/web-crawler/write-code)
├── test/                    # 测试(node --test,70+ 项)
└── package.json
```

## 测试

```bash
cd tianshu-ts
npx tsc --noEmit          # 类型检查
npm test                  # 运行全部测试(node --test)
```

## 路线图

- [x] TypeScript 全量实现(替换早期 Python 原型)
- [x] Web 面板三栏布局 + 模型配置/监控视图
- [x] 沙箱本地降级链(unshare + nobody)
- [x] 终端内联审批(Codex 风格)
- [ ] 桌面端完善
- [ ] 多 Agent 复杂任务编排深化
- [ ] 超算平台部署支持

## License

[Apache License 2.0](LICENSE)
