import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../config.js";

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
