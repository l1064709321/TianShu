import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

const ws = fs.mkdtempSync(path.join(tmpdir(), "ts-ws-"));
process.env.TIANKUI_WORKSPACE = ws;

const rollback = await import("../src/core/rollback.js");
const backup = await import("../src/core/backup.js");
const audit = await import("../src/core/audit.js");
const { autoSnapshot, snapshotAll, listSnapshots, restoreSnapshot } = rollback;
const { createBackup, listBackups, restoreBackup, BACKUP_ROOT } = backup;
const { audit: auditFn, AUDIT_DIR } = audit;

const TARGET = path.join(ws, "hello.txt");

test("快照:自动快照与恢复", () => {
  fs.writeFileSync(TARGET, "hello", "utf-8");
  const snap = autoSnapshot(TARGET);
  assert.ok(snap);
  assert.ok(snap!.startsWith("snap-"));
  const listed = listSnapshots(5);
  assert.ok(listed.includes("snap-"));
});

test("快照:恢复文件内容", () => {
  fs.writeFileSync(TARGET, "v1 content", "utf-8");
  const snap = autoSnapshot(TARGET);
  fs.writeFileSync(TARGET, "modified content", "utf-8");
  const msg = restoreSnapshot(snap!, "hello.txt");
  assert.ok(msg.includes("已从"));
  assert.equal(fs.readFileSync(TARGET, "utf-8"), "v1 content");
});

test("快照:全量快照与列表", () => {
  fs.mkdirSync(path.join(ws, "sub"), { recursive: true });
  fs.writeFileSync(path.join(ws, "sub", "a.txt"), "x", "utf-8");
  const out = snapshotAll("manual");
  assert.ok(out.includes("个文件"));
});

test("快照:不存在的快照报错", () => {
  assert.throws(() => restoreSnapshot("snap-not-exist", "hello.txt"), /快照不存在/);
});

test("快照:目标越界拒绝", () => {
  fs.writeFileSync(TARGET, "x", "utf-8");
  const snap = autoSnapshot(TARGET);
  assert.throws(() => restoreSnapshot(snap!, "/etc/passwd"), /必须在工作区内/);
});

test("快照:工作区外文件不自动快照", () => {
  const outside = path.join(tmpdir(), "outside-file.txt");
  fs.writeFileSync(outside, "x", "utf-8");
  assert.equal(autoSnapshot(outside), null);
});

test("备份:创建与列出", () => {
  const name = createBackup("t1");
  assert.ok(name.startsWith("backup-"));
  const listed = listBackups();
  assert.ok(listed.includes(name));
});

test("恢复:非法目标拒绝", () => {
  assert.throws(() => restoreBackup("backup-x", "/etc/passwd"), /仅允许恢复/);
  assert.throws(() => restoreBackup("backup-x", "secret.txt"), /仅允许恢复/);
});

test("恢复:不存在的备份报错", () => {
  assert.throws(() => restoreBackup("backup-not-exist", "models.json"), /备份不存在/);
});

test("审计落盘 JSONL", () => {
  auditFn("test.event", "detail=1", "tester");
  const files = fs.readdirSync(AUDIT_DIR).filter((f) => f.startsWith("audit-"));
  assert.ok(files.length > 0);
  const latest = fs.readFileSync(path.join(AUDIT_DIR, files[files.length - 1]), "utf-8");
  assert.ok(latest.includes("test.event"));
  assert.ok(latest.includes("tester"));
});