import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { PROJECT_ROOT, WORKSPACE_DIR } from "../config.js";
import { audit } from "./audit.js";

export const BACKUP_ROOT = path.join(WORKSPACE_DIR, ".ts-backups");
const MAX_BACKUPS = 7;
const ALLOWED = ["models.json", ".env", "tiankui.db", "identity-card"];

export function backupEntries(): Record<string, string> {
  const entries: Record<string, string> = {
    "models.json": path.join(PROJECT_ROOT, "config", "models.json"),
    ".env": path.join(PROJECT_ROOT, ".env"),
    "tiankui.db": path.join(PROJECT_ROOT, "tiankui.db"),
  };
  const idf = process.env.TIANKUI_IDENTITY_FILE ?? "";
  if (idf) {
    const p = path.resolve(idf);
    if (fs.existsSync(p)) entries["identity-card"] = p;
  }
  return entries;
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9\-_.]/g, "_").slice(0, 40);
}

function tarGz(files: Record<string, string>): Buffer {
  const header = Buffer.alloc(512);
  const out: Buffer[] = [];
  for (const [arcName, srcPath] of Object.entries(files)) {
    const content = fs.readFileSync(srcPath);
    const name = Buffer.from(arcName, "utf-8");
    header.fill(0);
    name.copy(header, 0);
    const mode = "0000644";
    Buffer.from(mode).copy(header, 100);
    const size = content.length.toString(8).padStart(11, "0");
    Buffer.from(size).copy(header, 124);
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0");
    Buffer.from(mtime).copy(header, 136);
    header[156] = 0x30;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
    out.push(header, content);
    const pad = 512 - (content.length % 512);
    if (pad !== 512) out.push(Buffer.alloc(pad));
  }
  out.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(out));
}

function extractTarGz(buf: Buffer, memberName: string): Buffer | null {
  const tar = zlib.gunzipSync(buf);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "").trim(), 8) || 0;
    offset += 512;
    const content = tar.subarray(offset, offset + size);
    if (name === memberName) return Buffer.from(content);
    offset += Math.ceil(size / 512) * 512;
  }
  return null;
}

export function createBackup(label = "manual"): string {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/Z$/, "");
  const name = `backup-${stamp}-${safeLabel(label)}`;
  const entries = backupEntries();
  const present: Record<string, string> = {};
  for (const [arc, src] of Object.entries(entries)) {
    if (fs.existsSync(src)) present[arc] = src;
  }
  const data = tarGz(present);
  fs.writeFileSync(path.join(BACKUP_ROOT, `${name}.tar.gz`), data);
  const backups = fs
    .readdirSync(BACKUP_ROOT)
    .filter((n) => n.startsWith("backup-") && n.endsWith(".tar.gz"))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
    fs.rmSync(path.join(BACKUP_ROOT, old), { force: true });
  }
  audit("backup.create", `file=${name}.tar.gz`);
  return name;
}

export function listBackups(): string {
  let items: string[];
  try {
    items = fs
      .readdirSync(BACKUP_ROOT)
      .filter((n) => n.startsWith("backup-") && n.endsWith(".tar.gz"))
      .sort()
      .reverse();
  } catch {
    return "(暂无备份)";
  }
  if (!items.length) return "(暂无备份)";
  return items
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUP_ROOT, name));
      let members: string[] = ["(损坏)"];
      try {
        members = [...extractTarGzList(fs.readFileSync(path.join(BACKUP_ROOT, name)))];
      } catch {
        members = ["(损坏)"];
      }
      return `${name.replace(/\.tar\.gz$/, "")}  |  ${stat.size} B  |  ${members.join(",")}`;
    })
    .join("\n");
}

function extractTarGzList(buf: Buffer): string[] {
  const tar = zlib.gunzipSync(buf);
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "").trim(), 8) || 0;
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

export function restoreBackup(backup: string, target: string): string {
  if (!ALLOWED.includes(target)) {
    throw new Error(`仅允许恢复: ${ALLOWED.join("、")}`);
  }
  const dest = backupEntries()[target];
  if (!dest) throw new Error(`备份中不含 ${target}(当前环境未启用该文件)`);
  const b = backup.endsWith(".tar.gz") ? backup : `${backup}.tar.gz`;
  const bPath = path.join(BACKUP_ROOT, b);
  if (!fs.existsSync(bPath)) throw new Error(`备份不存在: ${b}`);
  if (!fs.existsSync(dest)) throw new Error(`当前不存在可恢复的目标文件: ${target}`);

  let content: Buffer | null;
  try {
    content = extractTarGz(fs.readFileSync(bPath), target);
  } catch {
    throw new Error(`备份文件损坏: ${b}`);
  }
  if (content === null) throw new Error(`备份中无 ${target}`);
  if (path.isAbsolute(target) || target.includes("..")) {
    throw new Error("备份成员路径不合法,已拒绝");
  }
  createBackup("pre-restore");
  fs.writeFileSync(dest, content);
  audit("backup.restore", `file=${b} target=${target}`);
  return `已从 ${b} 恢复 ${target}(恢复前已自动建 pre-restore 备份,重启服务后生效)`;
}