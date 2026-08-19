import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "ts-cfg-"));

test("writeEnvFile 写入并保留现有行", async () => {
  const envFile = path.join(tmp, "a.env");
  fs.writeFileSync(envFile, "TIANKUI_DEFAULT_PROVIDER=mock\n# 注释\n");
  process.env.TIANKUI_ENV = envFile;
  const { writeEnvFile } = await import("../src/config.js");
  writeEnvFile([
    ["TIANKUI_DEFAULT_PROVIDER", "deepseek"],
    ["TIANKUI_DEFAULT_PROVIDER_BASE_URL", "https://api.deepseek.com/v1"],
  ]);
  const content = fs.readFileSync(envFile, "utf-8");
  assert.ok(content.includes("TIANKUI_DEFAULT_PROVIDER=deepseek"));
  assert.ok(content.includes("TIANKUI_DEFAULT_PROVIDER_BASE_URL=https://api.deepseek.com/v1"));
  assert.ok(content.includes("# 注释"));
});

test("writeEnvFile 追加新键", async () => {
  const envFile = path.join(tmp, "a.env");
  process.env.TIANKUI_ENV = envFile;
  const { writeEnvFile } = await import("../src/config.js");
  writeEnvFile([["TIANKUI_DEFAULT_PROVIDER_API_KEY", "sk-secret-1234567890"]]);
  const content = fs.readFileSync(envFile, "utf-8");
  assert.ok(content.includes("TIANKUI_DEFAULT_PROVIDER_API_KEY=sk-secret-1234567890"));
  assert.ok(content.includes("TIANKUI_DEFAULT_PROVIDER=deepseek"));
});
