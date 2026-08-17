import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/core/session.js";
import { registerBuiltinTools, runShellGuarded, fetchUrlGuarded } from "../src/core/tools/builtin.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { isGranted } from "../src/core/access.js";
import { loadIdentityCard } from "../src/core/identity.js";
import { SkillRepository, parseFrontmatter } from "../src/core/skills/repository.js";

test("会话 CRUD 往返", () => {
  const db = path.join(fs.mkdtempSync(path.join(tmpdir(), "ts-sess-")), "s.db");
  const store = new SessionStore(db);
  const sid = store.createSession("测试", "mock", "m1");
  assert.ok(sid.length === 12);
  store.addMessage(sid, "user", "你好");
  store.saveOrchestration(sid, "任务", "结果", [{ worker: "w", goal: "g" }]);
  const msgs = store.listMessages(sid);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "orchestrator");
  store.saveSummary(sid, "摘要", 5);
  const summary = store.getSummary(sid);
  assert.equal(summary?.summary, "摘要");
  assert.equal(summary?.covered, 5);
  store.close();
});

test("工具注册与内置工具白名单", async () => {
  const reg = new ToolRegistry();
  registerBuiltinTools(reg);
  const names = reg.list().map((t) => t.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("write_file"));
  assert.ok(names.includes("run_shell"));
  assert.ok(names.includes("fetch_url"));
  const shell = reg.get("run_shell")!;
  assert.equal(shell.requires_review, true);
});

test("run_shell_guarded 白名单拒绝", async () => {
  await assert.rejects(() => runShellGuarded("rm -rf /"), /危险语法/);
  await assert.rejects(() => runShellGuarded("curl http://x.com"), /禁止的命令/);
  const out = await runShellGuarded("echo hello", 10);
  assert.ok(out.includes("hello"));
});

test("run_shell_guarded 路径越界拒绝", async () => {
  await assert.rejects(() => runShellGuarded("cat /etc/passwd"), /禁止访问工作区外的路径/);
});

test("fetch_url_guarded 拦截内网", async () => {
  await assert.rejects(() => fetchUrlGuarded("http://127.0.0.1:9000/x"), /禁止访问内网地址/);
  await assert.rejects(() => fetchUrlGuarded("file:///etc/passwd"), /仅允许 http\/https/);
});

test("access.is_granted 基础授权", () => {
  assert.equal(isGranted("/nonexistent/dir/xyz"), false);
});

test("身份卡片加载", () => {
  const card = loadIdentityCard();
  assert.ok(card.includes("天枢"));
});

test("技能 frontmatter 解析", () => {
  const text = "---\nname: test\n---\n正文";
  const { meta, body } = parseFrontmatter(text);
  assert.equal(meta.name, "test");
  assert.equal(body, "正文");
});

test("技能仓库扫描", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ts-skill-"));
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "demo", "SKILL.md"), "---\nname: demo\ndescription: 演示\n---\n指令内容");
  const repo = new SkillRepository(dir);
  repo.scan();
  const skill = repo.get("demo");
  assert.equal(skill?.description, "演示");
  assert.ok(skill?.instructions.includes("指令内容"));
});
