import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { audit } from "./audit.js";

const ACCESS_FILE = path.join(PROJECT_ROOT, "config", "access_roots.json");

interface RootEntry {
  path: string;
  scope: string;
}

let _currentSession = "";

export function setCurrentSession(sessionId: string): void {
  _currentSession = sessionId || "";
}

export function currentSession(): string {
  return _currentSession;
}

function load(): RootEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf-8"));
    const entries: RootEntry[] = [];
    for (const item of data.roots ?? []) {
      if (typeof item === "string") entries.push({ path: item, scope: "global" });
      else if (item && typeof item.path === "string") {
        entries.push({ path: item.path, scope: item.scope ?? "global" });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function save(entries: RootEntry[]): void {
  fs.mkdirSync(path.dirname(ACCESS_FILE), { recursive: true });
  fs.writeFileSync(ACCESS_FILE, JSON.stringify({ roots: entries }, null, 2), "utf-8");
}

function entryVisible(entry: RootEntry, session: string, globalOnly: boolean): boolean {
  if (entry.scope === "global") return true;
  if (globalOnly) return false;
  return Boolean(session) && entry.scope === `session:${session}`;
}

export function accessRoots(globalOnly = false): RootEntry[] {
  return load().filter((e) => entryVisible(e, _currentSession, globalOnly));
}

export function isGranted(p: string): boolean {
  const resolved = path.resolve(p);
  for (const e of accessRoots()) {
    const root = path.resolve(e.path);
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

export function listRoots(): Array<{ path: string; scope: string }> {
  return load().map((e) => ({ path: path.resolve(e.path), scope: e.scope }));
}

function validScope(scope: string): boolean {
  if (scope === "global") return true;
  return /^session:[A-Za-z0-9-]+$/.test(scope);
}

export function addRoot(p: string, scope = "global"): string {
  if (!validScope(scope)) {
    throw new Error('作用域仅支持 "global" 或 "session:<会话ID>"');
  }
  const root = path.resolve(p);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`目录不存在: ${p}`);
  }
  const entries = load();
  for (const e of entries) {
    if (e.scope === scope && path.resolve(e.path) === root) {
      throw new Error(`已授权: ${root}(作用域 ${scope})`);
    }
  }
  entries.push({ path: root, scope });
  save(entries);
  audit("access.grant", `dir=${root} scope=${scope}`, "web");
  return `已授权访问: ${root}(作用域 ${scope})`;
}

export function removeRoot(p: string, scope: string): string {
  const target = path.resolve(p);
  const entries = load();
  const filtered = entries.filter((e) => !(e.scope === scope && path.resolve(e.path) === target));
  if (filtered.length === entries.length) {
    throw new Error(`未找到授权: ${p}(作用域 ${scope})`);
  }
  save(filtered);
  audit("access.revoke", `dir=${target} scope=${scope}`, "web");
  return `已撤销授权: ${target}(作用域 ${scope})`;
}
