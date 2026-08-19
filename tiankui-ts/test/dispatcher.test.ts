import { test } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher, RoutingStrategy, createDispatcherFromProviders } from "../src/core/llm/dispatcher.js";
import { LLMError } from "../src/core/llm/types.js";
import type { BaseProvider, LLMMessage, LLMResult } from "../src/core/llm/types.js";

interface DispatchConfig {
  routing_strategy: RoutingStrategy;
  num_retries: number;
  retry_delay: number;
  timeout: number;
  max_tokens: number | null;
  temperature: number;
  enable_cooldowns: boolean;
  cooldown_time: number;
  allowed_fails: number;
  max_fallbacks: number;
  enable_weighted_failover: boolean;
  fallbacks: Record<string, string[]>;
  context_window_fallbacks: Record<string, string[]>;
  content_policy_fallbacks: Record<string, string[]>;
}

const defaultConfig = (): DispatchConfig => ({
  routing_strategy: RoutingStrategy.SIMPLE_SHUFFLE,
  num_retries: 2,
  retry_delay: 1.0,
  timeout: 120.0,
  max_tokens: null,
  temperature: 0.2,
  enable_cooldowns: true,
  cooldown_time: 60.0,
  allowed_fails: 1,
  max_fallbacks: 5,
  enable_weighted_failover: true,
  fallbacks: {},
  context_window_fallbacks: {},
  content_policy_fallbacks: {},
});

function mockProvider(results: Array<{ ok?: boolean; content?: string }>): BaseProvider {
  let idx = 0;
  return {
    base_url: "http://mock/v1",
    api_key: "",
    model: "m",
    temperature: 0.2,
    timeout: 30,
    max_tokens: null,
    usage_hook: null,
    async chat(): Promise<LLMResult> {
      const r = results[Math.min(idx++, results.length - 1)];
      if (r.ok === false) throw new LLMError("boom");
      return { content: r.content ?? "ok" };
    },
    async close() {},
  } as BaseProvider;
}

test("加权故障转移:首个部署失败后选第二个", async () => {
  const dispatcher = new Dispatcher({
    ...defaultConfig(),
    enable_weighted_failover: true,
    num_retries: 0,
  });
  dispatcher.addDeployment("g1", "p1", "http://host1/v1", "m1");
  dispatcher.addDeployment("g1", "p2", "http://host2/v1", "m2");
  let calls = 0;
  const factory = (): BaseProvider => {
    calls++;
    return mockProvider([{ ok: calls === 1 ? false : true, content: `from_p${calls}` }]);
  };
  dispatcher.providerFactory = factory;
  const result = await dispatcher.chat([{ role: "user", content: "hi" } as LLMMessage]);
  assert.equal(calls, 2);
  assert.equal(result.content, "from_p2");
});

test("组内所有部署失败 -> 组错误", async () => {
  const dispatcher = new Dispatcher({ ...defaultConfig(), num_retries: 0 });
  dispatcher.addDeployment("g1", "p1", "http://fail1/v1", "m1");
  dispatcher.providerFactory = () => mockProvider([{ ok: false }]);
  await assert.rejects(
    () => dispatcher.chat([{ role: "user", content: "hi" } as LLMMessage]),
    (e: unknown) => e instanceof LLMError,
  );
});

test("无模型组时报错", async () => {
  const dispatcher = new Dispatcher(defaultConfig());
  await assert.rejects(
    () => dispatcher.chat([{ role: "user", content: "hi" } as LLMMessage]),
    /无可用模型组/,
  );
});

test("fallback 组链:g1 全挂走 g2", async () => {
  const dispatcher = new Dispatcher({ ...defaultConfig(), num_retries: 0 });
  dispatcher.addDeployment("g1", "p1", "http://fail1/v1", "m1");
  dispatcher.addDeployment("g2", "p2", "http://ok/v1", "m2");
  dispatcher.addFallback("g1", ["g2"]);
  const group = { current: "g1" };
  dispatcher.providerFactory = (name: string) => {
    if (name === "p1") return mockProvider([{ ok: false }]);
    void group;
    return mockProvider([{ content: "from_g2" }]);
  };
  const result = await dispatcher.chat([{ role: "user", content: "hi" } as LLMMessage]);
  assert.equal(result.content, "from_g2");
});

test("createDispatcherFromProviders 注册部署", () => {
  const d = createDispatcherFromProviders([
    { name: "a", group: "g1", base_url: "http://x/v1", model: "m", weight: 2 },
    { name: "b", group: "g1", base_url: "http://y/v1", model: "m2" },
  ]);
  assert.equal(d.listDeployments().length, 2);
  const stats = d.getStats() as { groups: Record<string, number> };
  assert.equal(stats.groups["g1"], 2);
});

test("冷却与恢复", async () => {
  const dispatcher = new Dispatcher({ ...defaultConfig(), num_retries: 0 });
  dispatcher.addDeployment("g1", "p1", "http://fail1/v1", "m1");
  dispatcher.providerFactory = () => mockProvider([{ ok: false }]);
  await assert.rejects(() => dispatcher.chat([{ role: "user", content: "hi" } as LLMMessage]));
  const stats = dispatcher.getStats() as { cooldowns: Record<string, { cooldown: boolean }> };
  assert.equal(stats.cooldowns["p1"].cooldown, true);
});
