import * as fs from "node:fs";
import * as path from "node:path";
import { SENSITIVE_DIR, WORKSPACE_DIR } from "../config.js";
import { audit } from "./audit.js";

const SNAP_ROOT = path.join(WORKSPACE_DIR, ".ts-snapshots");
const MAX_SNAPSHOTS = 20;
const SKIP_DIRS = new Set([".ts-snapshots", ".ts-secrets", ".git"]);

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9\-_.]/g, "_").slice(0, 40);
}

function newSnapDir(label = ""): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, (ch) => (ch === "T" ? "-" : ch)).replace(/-/g, "");
  let base = `snap-${stamp}`;
  if (label) base = `${base}-${safeLabel(label)}`;
  fs.mkdirSync(SNAP_ROOT, { recursive: true });
  let d = path.join(SNAP_ROOT, base);
  let n = 2;
  while (fs.existsSync(d)) {
    d = path.join(SNAP_ROOT, `${base}-${n}`);
    n++;
  }
  fs.mkdirSync(d);
  return d;
}

function prune(): void {
  let snaps: string[];
  try {
    snaps = fs.readdirSync(SNAP_ROOT).filter((n) => n.startsWith("snap-")).sort();
  } catch {
    return;
  }
  for (const old of snaps.slice(0, Math.max(0, snaps.length - MAX_SNAPSHOTS))) {
    fs.rmSync(path.join(SNAP_ROOT, old), { recursive: true, force: true });
  }
}

export function autoSnapshot(filePath: string): string | null {
  const p = path.resolve(filePath);
  const wp = path.resolve(WORKSPACE_DIR);
  if (!p.startsWith(wp + path.sep)) return null;
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  const snap = newSnapDir("auto");
  const rel = path.relative(wp, p);
  const dst = path.join(snap, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(p, dst);
  prune();
  return path.basename(snap);
}

export function snapshotAll(label = "manual"): string {
  const wp = path.resolve(WORKSPACE_DIR);
  const snap = newSnapDir(label);
  let n = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else {
        const rel = path.relative(wp, full);
        const dst = path.join(snap, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(full, dst);
        n++;
      }
    }
  };
  walk(wp);
  prune();
  return `${path.basename(snap)}(${n} 个文件)`;
}

export function listSnapshots(limit = 10): string {
  let snaps: string[];
  try {
    snaps = fs.readdirSync(SNAP_ROOT).filter((n) => n.startsWith("snap-")).sort().reverse();
  } catch {
    return "(暂无快照)";
  }
  if (!snaps.length) return "(暂无快照)";
  const lines = snaps.slice(0, limit).map((name) => {
    let count = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else count++;
      }
    };
    walk(path.join(SNAP_ROOT, name));
    return `${name}  |  ${count} 个文件`;
  });
  return lines.join("\n");
}

export function restoreSnapshot(snapshot: string, target: string): string {
  const wp = path.resolve(WORKSPACE_DIR);
  const snap = path.join(SNAP_ROOT, snapshot);
  if (!fs.existsSync(snap) || !fs.statSync(snap).isDirectory()) {
    throw new Error(`快照不存在: ${snapshot}`);
  }
  const t = path.isAbsolute(target) ? path.resolve(target) : path.resolve(wp, target);
  if (!t.startsWith(wp + path.sep)) {
    throw new Error(`目标必须在工作区内: ${target}`);
  }
  const rel = path.relative(wp, t);
  const src = path.join(snap, rel);
  if (!fs.existsSync(src)) {
    throw new Error(`快照中没有该路径: ${rel}`);
  }
  autoSnapshot(t);
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(t, { recursive: true });
    fs.cpSync(src, t, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.copyFileSync(src, t);
  }
  audit("rollback.restore", `snapshot=${snap} target=${rel}`);
  return `已从 ${snapshot} 恢复 ${rel}(恢复前版本已自动备份)`;
}