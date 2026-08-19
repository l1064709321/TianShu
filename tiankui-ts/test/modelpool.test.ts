import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { KeySelectorProvider, isAuthError, maskKey } from "../src/core/modelpool/service.js";
import { LLMError } from "../src/core/llm/types.js";
import type { BaseProvider, LLMMessage, LLMResult } from "../src/core/llm/types.js";

function makeProvider(results: Array<"ok" | "auth" | "fail">): BaseProvider {
  let i = 0;
  return {
    base_url: "http://x/v1",
    api_key: "",
    model: "m",
    temperature: 0.2,
    timeout: 30,
    max_tokens: null,
    usage_hook: null,
    async chat(): Promise<LLMResult> {
      const r = results[Math.min(i++, results.length - 1)];
      if (r === "auth") throw new LLMError("HTTP 401");
      if (r === "fail") throw new LLMError("connection refused");
      return { content: "ok" };
    },
  } as BaseProvider;
}

test("mask_key 掩码", () => {
  assert.equal(maskKey("sk-abcdefgh12345678"), "sk-a****5678");
  assert.equal(maskKey("short"), "****");
  assert.equal(maskKey(""), "");
});

test("isAuthError 识别 401/403", () => {
  assert.ok(isAuthError("HTTP 401: invalid"));
  assert.ok(isAuthError("403 forbidden"));
  assert.ok(isAuthError("invalid_api_key"));
  assert.ok(isAuthError("authentication failed"));
  assert.ok(!isAuthError("connection refused"));
});

test("Key 轮换:首选 401 后切第二个 Key", async () => {
  const sel = new KeySelectorProvider("deepseek", "http://d/v1", "m1", [
    { id: "k1", value: "key1" },
    { id: "k2", value: "key2" },
  ], "k2");
  const touched: string[] = [];
  sel.bindStore((vendor, keyId, status) => {
    void vendor;
    touched.push(`${keyId}:${status}`);
  });
  const calls: string[] = [];
  let n = 0;
  sel["_providerFor"] = (key) => {
    calls.push(key.id);
    return makeProvider(n++ === 0 ? ["auth"] : ["ok"]);
  };
  const result = await sel.chat([{ role: "user", content: "hi" } as LLMMessage]);
  assert.equal(result.content, "ok");
  assert.deepEqual(calls, ["k2", "k1"]);
  assert.deepEqual(touched, ["k2:expired", "k1:ok"]);
});

test("所有 Key 401 时抛厂商错误", async () => {
  const sel = new KeySelectorProvider("x", "http://x/v1", "m", [
    { id: "k1", value: "k1" },
    { id: "k2", value: "k2" },
  ]);
  sel["_providerFor"] = () => makeProvider(["auth"]);
  await assert.rejects(
    () => sel.chat([{ role: "user", content: "hi" } as LLMMessage]),
    /所有 Key 均失败/,
  );
});

test("非 401 错误不轮换直接抛", async () => {
  const sel = new KeySelectorProvider("x", "http://x/v1", "m", [
    { id: "k1", value: "k1" },
    { id: "k2", value: "k2" },
  ]);
  const calls: string[] = [];
  sel["_providerFor"] = (key) => {
    calls.push(key.id);
    return makeProvider(["fail"]);
  };
  await assert.rejects(() => sel.chat([{ role: "user", content: "hi" } as LLMMessage]));
  assert.equal(calls.length, 1);
});

test("无 Key 报错", async () => {
  const sel = new KeySelectorProvider("x", "http://x/v1", "m", []);
  await assert.rejects(
    () => sel.chat([{ role: "user", content: "hi" } as LLMMessage]),
    /没有可用 Key/,
  );
});