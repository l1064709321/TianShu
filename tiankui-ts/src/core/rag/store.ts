import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { WORKSPACE_DIR } from "../../config.js";

export const RAG_DIR = process.env.TIANKUI_RAG_DIR
  ? path.resolve(process.env.TIANKUI_RAG_DIR)
  : path.join(WORKSPACE_DIR, ".ts-rag");
export const INDEX_FILE = path.join(RAG_DIR, "index.json");
export const CHUNK_SIZE = 500;
export const CHUNK_OVERLAP = 60;

export interface Chunk {
  text: string;
  doc_id: string;
  version: number;
  seq: number;
}

export interface DocVersion {
  version: number;
  ts: string;
  source: string;
  chunks: string[];
  superseded: boolean;
}

export interface Doc {
  id: string;
  title: string;
  versions: DocVersion[];
}

function ensure(): void {
  fs.mkdirSync(RAG_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(INDEX_FILE, "{}", "utf-8");
  }
}

function load(): Record<string, unknown> {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(data: Record<string, unknown>): void {
  ensure();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(data, null, 1), "utf-8");
}

export function splitChunks(text: string): string[] {
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let buf = "";
  for (const para of paragraphs) {
    if (buf.length + para.length + 2 <= CHUNK_SIZE) {
      buf = buf ? `${buf}\n\n${para}`.trim() : para;
      continue;
    }
    if (buf) chunks.push(buf);
    if (para.length > CHUNK_SIZE) {
      const words = para.match(/\S+/g) ?? [];
      let cur = "";
      for (const w of words) {
        if (cur.length + w.length + 1 > CHUNK_SIZE) {
          chunks.push(cur);
          const tail = CHUNK_OVERLAP ? cur.split(" ").slice(-CHUNK_OVERLAP).join(" ") : "";
          cur = `${tail} ${w}`.trim();
        } else {
          cur = `${cur} ${w}`.trim();
        }
      }
      if (cur) chunks.push(cur);
    } else {
      buf = para;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function ingestText(text: string, source: string, docId = "", title = ""): string {
  const data = load();
  let docs = data["docs"] as Record<string, unknown>;
  if (!docs) {
    docs = {};
    data["docs"] = docs;
  }
  if (!docId) docId = randomUUID().replace(/-/g, "").slice(0, 12);
  let doc = docs[docId] as Record<string, unknown>;
  if (!doc) {
    doc = { id: docId, title: title || source, versions: [] };
    docs[docId] = doc;
  }
  if (title && !doc["title"]) doc["title"] = title;
  const versions = (doc["versions"] as Record<string, unknown>[]) ?? [];
  for (const v of versions) v["superseded"] = true;
  const version = versions.length + 1;
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  versions.push({
    version,
    ts,
    source,
    chunks: splitChunks(text),
    superseded: false,
  });
  doc["versions"] = versions;
  save(data);
  return `${docId} v${version}`;
}

function latestChunks(doc: Record<string, unknown>): Chunk[] {
  const out: Chunk[] = [];
  for (const v of (doc["versions"] as Record<string, unknown>[]) ?? []) {
    if (v["superseded"]) continue;
    const chunks = (v["chunks"] as string[]) ?? [];
    chunks.forEach((text, i) => {
      out.push({ text, doc_id: String(doc["id"]), version: Number(v["version"] ?? 1), seq: i });
    });
  }
  return out;
}

export function allChunks(): Chunk[] {
  const data = load();
  const out: Chunk[] = [];
  for (const doc of Object.values((data["docs"] as Record<string, unknown>) ?? {})) {
    out.push(...latestChunks(doc as Record<string, unknown>));
  }
  return out;
}

export function getDoc(docId: string): Doc | null {
  const data = load();
  const docs = (data["docs"] as Record<string, unknown>) ?? {};
  const raw = docs[docId] as Record<string, unknown> | undefined;
  if (!raw) return null;
  const versions: DocVersion[] = ((raw["versions"] as Record<string, unknown>[]) ?? []).map((v) => ({
    version: Number(v["version"] ?? 1),
    ts: String(v["ts"] ?? ""),
    source: String(v["source"] ?? ""),
    chunks: (v["chunks"] as string[]) ?? [],
    superseded: Boolean(v["superseded"]),
  }));
  return { id: docId, title: String(raw["title"] ?? docId), versions };
}

export function listDocs(): string {
  const data = load();
  const docs = (data["docs"] as Record<string, unknown>) ?? {};
  const rows = Object.values(docs).map((doc) => {
    const d = doc as Record<string, unknown>;
    const versions = (d["versions"] as Record<string, unknown>[]) ?? [];
    const latest = versions.reduce((m, v) => Math.max(m, Number(v["version"] ?? 1)), 0);
    return `${d["id"]}  ${d["title"] ?? ""}  (v${latest})`;
  });
  return rows.length ? rows.join("\n") : "(文档库为空)";
}
