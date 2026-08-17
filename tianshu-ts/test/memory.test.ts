import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemory, approxTokens, buildMemoryText, extractWords, loadConversationContext } from "../src/core/memory.js";

function makeMemory(dir: string): ProjectMemory {
  return new ProjectMemory(path.join(dir, "PROJECT_MEMORY.md"));
}

test("approx_tokens 中文按字符数", () => {
  assert.equal(approxTokens("你好世界"), 4);
  assert.ok(approxTokens("hello world 你好") > approxTokens("hello world"));
});

test("extract_words 中文二元组+英文单词", () => {
  const words = extractWords("实现前端页面");
  assert.ok(words.includes("实现"));
  assert.ok(words.includes("前端"));
  assert.ok(words.includes("端页"));
  assert.ok(words.includes("页面"));
});

test("parse 分块与 max_per_block", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ts-mem-"));
  const m = makeMemory(dir);
  for (let i = 0; i < 15; i++) m.addEntry("progress", `进度条目 ${i}`, 10);
  const blocks = m.load();
  const prog = blocks.find((b) => b.key === "progress")!;
  assert.equal(prog.entries.length, 10);
  assert.equal(prog.entries[0], "进度条目 14");
});

test("select 核心块恒注入,相关块按分数", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ts-mem-"));
  const m = makeMemory(dir);
  m.addEntry("goals", "构建天枢系统");
  m.addEntry("progress", "实现了 Web 前端实时活动可视化");
  m.addEntry("progress", "修复了会话竞态 bug");
  const out = m.select("前端页面怎么做的", 5000);
  assert.ok(out.includes("[goals]"));
  assert.ok(out.includes("前端"));
  assert.ok(!out.includes("会话竞态"));
});

test("select 空任务注入核心块", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ts-mem-"));
  const m = makeMemory(dir);
  m.addEntry("goals", "目标块");
  const out = m.select("");
  assert.ok(out.includes("目标块"));
});

test("update_from_result 记忆进度", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ts-mem-"));
  const m = makeMemory(dir);
  const ok = m.updateFromResult({ task: "修复前端 bug", summary: "修好了复制按钮", subtasks: [] });
  assert.equal(ok.memorized, true);
  const prog = m.load().find((b) => b.key === "progress")!;
  assert.ok(prog.entries[0].includes("修复前端 bug"));
});

test("update_from_result 阻塞块", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ts-mem-"));
  const m = makeMemory(dir);
  m.updateFromResult({
    task: "部署服务",
    summary: "",
    subtasks: [{ worker: "ops", error: "端口占用" }],
  });
  const blk = m.load().find((b) => b.key === "blockers")!;
  assert.ok(blk.entries[0].includes("端口占用"));
});

test("build_memory_text 与解析往返", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ts-mem-"));
  const m = makeMemory(dir);
  m.addEntry("facts", "先测后推");
  m.save();
  const m2 = makeMemory(dir);
  const facts = m2.load().find((b) => b.key === "facts")!;
  assert.ok(facts.entries.includes("先测后推"));
  const text = buildMemoryText(m2.load());
  assert.ok(text.includes("## [facts]"));
});

test("load_conversation_context 取最近对话", () => {
  const msgs = [
    { role: "user", content: "第一条" },
    { role: "assistant", content: "回复" },
    { role: "user", content: "第二条" },
  ];
  const out = loadConversationContext(msgs as never, 8, 1200);
  assert.ok(out.includes("第二条"));
  assert.ok(!out.includes("第一条") || out.includes("第一条"));
});
