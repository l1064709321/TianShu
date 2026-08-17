import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, decomposeToolSchema, parsePlan } from "../src/core/orchestrator/service.js";
import { Agent, MessageBus } from "../src/core/agent/runtime.js";
import type { LLMMessage, LLMResult, ToolCall } from "../src/core/llm/types.js";

test("parse_plan 从 tool_calls 提取", () => {
  const plan = parsePlan("大任务", {
    content: null,
    tool_calls: [
      {
        name: "produce_plan",
        arguments: { subtasks: [{ worker: "coder", goal: "写代码" }, { worker: "crawler", goal: "查资料" }] },
      },
    ],
  });
  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.subtasks[0].worker, "coder");
  assert.equal(plan.subtasks[1].id, "st_1");
});

test("parse_plan 从 JSON 文本提取", () => {
  const plan = parsePlan("大任务", {
    content: '好的,计划如下:\n{"subtasks": [{"worker": "assistant", "goal": "问答"}]}',
    tool_calls: null,
  });
  assert.equal(plan.subtasks.length, 1);
  assert.equal(plan.subtasks[0].worker, "assistant");
});

test("decompose_tool_schema 结构", () => {
  const schema = decomposeToolSchema();
  const fn = schema.function as Record<string, unknown>;
  assert.equal(fn.name, "produce_plan");
});

test("编排器:空计划走直接问答", async () => {
  const bus = new MessageBus();
  const main = new Agent({ name: "main", system_prompt: "s", provider_name: "mock", bus });
  main.provider = {
    async chat(): Promise<LLMResult> {
      return { content: "直接回答" };
    },
  } as never;
  bus.register(main);
  const orch = new Orchestrator(main, bus, true, null, 3, async () => {});
  const plan = await orch.run("简单问题");
  assert.equal(plan.subtasks.length, 0);
  assert.equal(plan.summary, "直接回答");
});

test("编排器:并行子任务执行", async () => {
  const bus = new MessageBus();
  const main = new Agent({ name: "main", system_prompt: "s", provider_name: "mock", bus });
  main.provider = {
    async chat(messages: LLMMessage[]): Promise<LLMResult> {
      const last = messages[messages.length - 1].content ?? "";
      if (last.includes("汇总")) return { content: "总结果" };
      const plan: ToolCall = {
        id: "p1",
        name: "produce_plan",
        arguments: {
          subtasks: [
            { worker: "w1", goal: "任务一" },
            { worker: "w2", goal: "任务二" },
          ],
        },
      };
      return { content: null, tool_calls: [plan] };
    },
  } as never;
  const w1 = new Agent({ name: "w1", system_prompt: "s", provider_name: "mock", bus });
  w1.provider = { async chat(): Promise<LLMResult> { return { content: "结果一" }; } } as never;
  const w2 = new Agent({ name: "w2", system_prompt: "s", provider_name: "mock", bus });
  w2.provider = { async chat(): Promise<LLMResult> { return { content: "结果二" }; } } as never;
  for (const a of [main, w1, w2]) bus.register(a);

  const orch = new Orchestrator(main, bus, true, 2, 3, async () => {});
  const plan = await orch.run("大任务");
  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.summary, "总结果");
  assert.equal(plan.subtasks[0].status, "done");
  assert.equal(plan.subtasks[1].result?.content, "结果二");
});

test("编排器:worker 不存在标失败", async () => {
  const bus = new MessageBus();
  const main = new Agent({ name: "main", system_prompt: "s", provider_name: "mock", bus });
  main.provider = {
    async chat(): Promise<LLMResult> {
      const tc: ToolCall = {
        id: "p1",
        name: "produce_plan",
        arguments: { subtasks: [{ worker: "ghost", goal: "任务" }] },
      };
      return { content: null, tool_calls: [tc] };
    },
  } as never;
  bus.register(main);
  const orch = new Orchestrator(main, bus, true, null, 3, async () => {});
  const plan = await orch.run("任务");
  assert.equal(plan.subtasks[0].status, "failed");
  assert.ok(plan.subtasks[0].error?.includes("Worker 不存在"));
});
