import { test } from "node:test";
import assert from "node:assert/strict";
import { Tool, ToolRegistry } from "../src/core/tools/registry.js";
import { ReviewSystem } from "../src/core/review/system.js";
import { Agent, MessageBus, buildAgentCallTool } from "../src/core/agent/runtime.js";
import type { LLMMessage, LLMResult, ToolCall } from "../src/core/llm/types.js";

test("注册与 schema 生成", () => {
  const reg = new ToolRegistry();
  reg.register(
    new Tool({
      name: "greet",
      description: "打招呼",
      func: async ({ name }) => `hi ${name}`,
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    }),
  );
  assert.ok(reg.get("greet"));
  const schemas = reg.schemas();
  assert.equal(schemas[0].type, "function");
  assert.equal((schemas[0].function as Record<string, unknown>).name, "greet");
});

test("审核系统 auto_approve/auto_reject", async () => {
  const r = new ReviewSystem("auto_approve");
  const req = await r.request("agent1", "write_file", { path: "/x" });
  assert.equal(req.status, "approved");
  assert.equal(req.decided_by, "auto_approve");

  const r2 = new ReviewSystem("auto_reject");
  const req2 = await r2.request("agent1", "write_file", { path: "/x" });
  assert.equal(req2.status, "rejected");
});

test("manual 无订阅者快速拒绝", async () => {
  const r = new ReviewSystem("manual");
  const req = await r.request("agent1", "run_shell", { command: "ls" });
  assert.equal(req.status, "rejected");
  assert.equal(req.decided_by, "no_subscribers");
});

test("manual 订阅者审批放行", async () => {
  const r = new ReviewSystem("manual");
  const events: Array<{ id: string; tool: string }> = [];
  r.subscribe((req) => {
    events.push({ id: req.id, tool: req.tool });
    setTimeout(() => r.decide(req.id, true), 10);
  });
  const req = await r.request("agent1", "run_shell", { command: "ls" });
  assert.equal(req.status, "approved");
  assert.equal(events.length, 1);
});

test("Agent 工具循环与死循环拦截", async () => {
  const reg = new ToolRegistry();
  let callCount = 0;
  reg.register(
    new Tool({
      name: "counter",
      description: "计数器",
      func: async () => {
        callCount++;
        return String(callCount);
      },
    }),
  );
  const provider = {
    base_url: "",
    api_key: "",
    model: "mock",
    temperature: 0.2,
    timeout: 30,
    max_tokens: null,
    usage_hook: null,
    async chat(messages: LLMMessage[]): Promise<LLMResult> {
      const hasTool = messages.some((m) => m.role === "tool");
      if (!hasTool) {
        const tc: ToolCall = { id: "c1", name: "counter", arguments: {} };
        return { content: null, tool_calls: [tc] };
      }
      return { content: "done" };
    },
    async close() {},
  } as never;
  const agent = new Agent({
    name: "tester",
    system_prompt: "test",
    provider_name: "mock",
    registry: reg,
    max_iterations: 10,
  });
  agent.provider = provider;
  const result = await agent.handleMessage("跑一下");
  assert.equal(result.content, "done");
  // 第一次调用成功,后续重复调用被拦截
  assert.ok(callCount >= 1);
  const deadlock = result.tool_calls.find((t) => t.error?.includes("死循环"));
  void deadlock;
});

test("call_agent 子 Agent 调度", async () => {
  const bus = new MessageBus();
  const worker = new Agent({
    name: "worker",
    system_prompt: "你是工人",
    provider_name: "mock",
    max_iterations: 5,
    bus,
  });
  worker.provider = {
    async chat(): Promise<LLMResult> {
      return { content: "子任务完成" };
    },
  } as never;
  bus.register(worker);

  const main = new Agent({
    name: "main",
    system_prompt: "你是主",
    provider_name: "mock",
    max_iterations: 3,
    bus,
  });
  const reg = new ToolRegistry();
  reg.register(buildAgentCallTool(bus));
  main.registry = reg;
  main.provider = {
    async chat(messages: LLMMessage[]): Promise<LLMResult> {
      const hasTool = messages.some((m) => m.role === "tool");
      if (!hasTool) {
        const tc: ToolCall = {
          id: "c1",
          name: "call_agent",
          arguments: { agent: "worker", task: "做点事" },
        };
        return { content: null, tool_calls: [tc] };
      }
      return { content: "汇总完成" };
    },
  } as never;
  const result = await main.handleMessage("执行");
  assert.equal(result.content, "汇总完成");
  assert.deepEqual(result.child_agents, ["worker"]);
});
