# 天枢

[![语言](https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-TypeScript_Node_22-blue)](https://nodejs.org)
[![许可](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-Apache_2.0-blue)](https://github.com/l1064709321/tianshu/blob/main/LICENSE)

项目名称:天枢(北斗第一星)

一个多 Agent 协同系统,目标能力对标 opencode。

## 技术栈

- 后端:TypeScript / Node 22 / `node:http` + `node:sqlite`(零框架依赖)
- 入口:`tianshu-ts/`(完整 TS 实现:核心引擎、RAG、模型池、沙箱、Web/mock/桌面三端、CLI)
- LLM:兼容 OpenAI 兼容接口、本地 Ollama、多厂商(除 Claude)
- 测试:`node --test`(tianshu-ts/test)

## 一键启动

```bash
cd tianshu-ts
npm install
npm run web        # 启动 Web 面板(自动拉起本地 mock LLM,离线可用)
```

浏览器打开 `http://localhost:8000` 即可对话。连接真实模型:编辑 `.env` 的 `DEFAULT_PROVIDER` / `DEFAULT_PROVIDER_BASE_URL` / `DEFAULT_PROVIDER_API_KEY`,重启即可。

## CLI

```bash
cd tianshu-ts
npx tsx src/cli/main.ts ask "用三句话介绍你自己"
npx tsx src/cli/main.ts chat        # 交互模式,支持终端内联审批(y/a/n/d)
npx tsx src/cli/main.ts config      # 查看当前模型配置(密钥掩码)
npx tsx src/cli/main.ts config --provider deepseek --base-url https://api.deepseek.com/v1 --api-key sk-xxx --model deepseek-chat   # 配置模型(.env 持久化)
npx tsx src/cli/main.ts doctor      # 环境体检
npx tsx src/cli/main.ts mockllm     # 手动启动本地 mock LLM
npx tsx src/cli/main.ts desktop     # 启动桌面端启动器
```

高危操作(写文件、执行命令等)默认需人工审批:CLI 聊天中内联审批,Web 面板审批卡片,或 `--review auto_approve`。

## 安全模型

- 沙箱:docker 优先(无网络 + 资源限制),无 docker 时本地降级为 `unshare` 命名空间 + nobody 降权执行
- 授权:工作区(workspace)白名单,高危操作一律先过审核系统
- 快照回滚:写文件前自动快照,可回滚

## 目录

- `tianshu-ts/src/core/` 核心引擎(Orchestrator/Agent/工具/审核/RAG/模型池/沙箱/技能)
- `tianshu-ts/src/interfaces/` Web 面板、mock LLM、桌面启动器
- `tianshu-ts/src/cli/` CLI
- `tianshu-ts/test/` 测试(70+ 项)
