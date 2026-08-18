# 项目:天枢

多 Agent 协同系统,目标对标 opencode。需求详见 README.md。

## 技术约定

- 后端:TypeScript / Node 22 / `node:http` + `node:sqlite`(工程在 tianshu-ts/)
- CLI:commander(纯终端,无框架)
- LLM:兼容 OpenAI 兼容接口、本地 Ollama、多厂商(除 Claude)
- 代码中不添加注释,除非用户要求
- 测试框架:`node --test`(tianshu-ts/test)

## 核心设计

- Orchestrator-Worker 模式:主 Agent 分解任务、调度子 Agent、汇总结果
- Agent 可调用技能(skills)与工具(tools),Agent 之间可相互调用
- 高危操作经审核(review)系统审批后执行(CLI 内联审批 / Web 面板 / auto 模式)
- 三端:CLI / Web / 桌面端

## 铁律

- 改代码后必须 `npx tsc --noEmit` + `npm test` 全绿才 commit
- 不测不推;密钥/私有配置(models.json、.env、access_roots.json、.ts-* 目录)绝不入库
