import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { registerSkillTools } from "../src/core/skills/tools.js";
import { SkillRepository } from "../src/core/skills/repository.js";
import { setSandboxBackend } from "../src/core/sandbox/manager.js";
import { runShellGuarded } from "../src/core/tools/builtin.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "ts-skills-"));
const skillDir = path.join(tmp, "skills", "chat");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, "SKILL.md"),
  "---\nname: chat\ndescription: 通用对话技能\n---\n\n# 聊天指令\n\n这里是指令正文",
  "utf-8",
);

test("load_skill 返回说明与指令", async () => {
  const repo = new SkillRepository(path.join(tmp, "skills"));
  repo.scan();
  const registry = new ToolRegistry();
  registerSkillTools(registry, repo);
  const tool = registry.get("load_skill");
  assert.ok(tool);
  const out = await tool.func({ name: "chat" }, "assistant");
  assert.ok(out.includes("chat"));
  assert.ok(out.includes("指令正文"));
  await assert.rejects(() => tool.func({ name: "不存在" }, "assistant"), /技能不存在/);
});

test("list_skills 列出技能", async () => {
  const repo = new SkillRepository(path.join(tmp, "skills"));
  repo.scan();
  const registry = new ToolRegistry();
  registerSkillTools(registry, repo);
  const out = await registry.get("list_skills")!.func({}, "assistant");
  assert.ok(out.includes("chat"));
});

test("run_shell 沙箱:docker 不可用自动降级 local", async () => {
  setSandboxBackend("local");
  const out = await runShellGuarded("echo hello-sandbox", 10, tmp);
  assert.ok(out.includes("hello-sandbox"));
  await assert.rejects(() => runShellGuarded("rm -rf /", 10, tmp), /禁止/);
  await assert.rejects(() => runShellGuarded("curl http://x", 10, tmp), /禁止的命令/);
});