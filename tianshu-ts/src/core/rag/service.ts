import * as fs from "node:fs";
import * as path from "node:path";
import type { BaseProvider } from "../llm/types.js";
import type { Hit } from "./retrieve.js";
import { RagRetriever } from "./retrieve.js";
import { allChunks, getDoc, ingestText, listDocs } from "./store.js";

let _provider: BaseProvider | null = null;

export function setProvider(p: BaseProvider | null): void {
  _provider = p;
}

export function ragProvider(): BaseProvider | null {
  return _provider;
}

async function chatText(p: BaseProvider, prompt: string): Promise<string> {
  const result = await p.chat([{ role: "user", content: prompt }]);
  return (result.content ?? "").trim();
}

async function llmOptional(prompt: string, fallback: string): Promise<string> {
  if (!_provider) return fallback;
  try {
    return (await chatText(_provider, prompt)) || fallback;
  } catch {
    return fallback;
  }
}

export async function rewriteQueries(query: string): Promise<string[]> {
  const rewritten = await llmOptional(
    "你是检索查询改写器。将下面用户查询改写为 1~3 个更利于全文检索的查询,每行一个,只输出查询内容,不要编号。\n查询:" + query,
    query,
  );
  const lines = rewritten.split("\n").map((ln) => ln.trim()).filter(Boolean);
  const unique = [query];
  for (const ln of lines) {
    if (!unique.includes(ln)) unique.push(ln);
  }
  return unique.slice(0, 3);
}

export async function hydeDocs(query: string): Promise<string[]> {
  const fake = await llmOptional(
    "为下面查询写一段 50 词的假设性标准答案短文,直接输出内容。\n查询:" + query,
    "",
  );
  if (!fake || !_provider) return [];
  return [fake];
}

async function titles(docIds: string[]): Promise<string> {
  const parts: string[] = [];
  for (const did of [...new Set(docIds)]) {
    const doc = getDoc(did);
    if (doc && doc.versions.length) {
      const latest = doc.versions[doc.versions.length - 1];
      parts.push(`- ${doc.title} (v${latest.version}, ${latest.ts})`);
    }
  }
  return parts.join("\n");
}

export async function buildAnswer(query: string, hits: Hit[], withHyde = false): Promise<string> {
  const contexts = hits.map(
    (h, i) => `[引用 ${i + 1}][doc:${h.chunk.doc_id} v${h.chunk.version}] ${h.chunk.text}`,
  );
  if (withHyde && _provider) {
    const hyde = await hydeDocs(query);
    contexts.unshift(...hyde);
  }
  const refs = await titles(hits.map((h) => h.chunk.doc_id));
  const prompt =
    "你是知识库问答引擎。仅依据下方引用资料回答用户问题;若资料不足,明确说明缺失信息,不得编造。" +
    "回答中用 [引用 N] 标注依据的引用编号。\n\n引用资料:\n" +
    contexts.join("\n\n") +
    `\n\n问题:${query}\n\n答案:`;
  const answer = await llmOptional(prompt, "参考以上资料生成回答");
  return refs ? `${answer}\n\n参考版本:\n${refs}` : answer;
}

export interface RagQueryResult {
  query: string;
  rewrites: string[];
  hits: Array<{ doc: string; version: number; excerpt: string; score: number }>;
  answer: string;
}

export async function ragQuery(query: string, topK = 5, useHyde = false): Promise<RagQueryResult> {
  const queries = await rewriteQueries(query);
  const retriever = new RagRetriever(allChunks());
  const merged = new Map<string, Hit>();
  for (const q of queries) {
    for (const hit of retriever.search(q, topK)) {
      const key = hit.chunk.doc_id;
      const existing = merged.get(key);
      if (!existing || hit.score > existing.score) merged.set(key, hit);
    }
  }
  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  let answer = "";
  if (hits.length) {
    answer = await buildAnswer(query, hits, useHyde);
  } else {
    answer = "文档库中没有相关内容,请先通过 document_ingest 导入资料。";
  }
  return {
    query,
    rewrites: queries,
    hits: hits.map((h) => ({
      doc: h.chunk.doc_id,
      version: h.chunk.version,
      excerpt: h.chunk.text.slice(0, 200),
      score: Math.round(h.score * 10000) / 10000,
    })),
    answer,
  };
}

export function ingestFile(filePath: string, docId = "", title = ""): string {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const text = fs.readFileSync(p, "utf-8");
  const result = ingestText(text, p, docId, title || path.basename(p));
  return `已入库 ${path.basename(p)} → ${result}(${text.length} 字符)`;
}

export function ragDocsList(): string {
  return listDocs();
}
