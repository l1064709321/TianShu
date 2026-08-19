import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

process.env.TIANKUI_RAG_DIR = path.join(fs.mkdtempSync(path.join(tmpdir(), "ts-rag-")), "rag");
const { ingestText, splitChunks, listDocs, getDoc, allChunks } = await import("../src/core/rag/store.js");
const { RagRetriever } = await import("../src/core/rag/retrieve.js");
const { ragQuery, setProvider } = await import("../src/core/rag/service.js");

test("分块:短文单块,长文按 500 切", () => {
  const chunks = splitChunks("第一段\n\n第二段");
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes("第一段"));
  const long = "词 ".repeat(500);
  const many = splitChunks(long);
  assert.ok(many.length > 1);
  assert.ok(many.every((c) => c.length <= 520));
});

test("入库版本化:同名升级,旧版不再参与检索", () => {
  const id = ingestText("北京是中国的首都,人口两千多万", "doc.txt", "d1", "北京介绍");
  assert.ok(id.startsWith("d1 v1"));
  ingestText("上海是中国最大的城市,金融中心", "doc.txt", "d1", "北京介绍");
  const doc = getDoc("d1")!;
  assert.equal(doc.versions.length, 2);
  assert.equal(doc.versions[0].superseded, true);
  assert.equal(doc.versions[1].superseded, false);
  const chunks = allChunks();
  const texts = chunks.map((c) => c.text).join(" ");
  assert.ok(texts.includes("上海"));
  assert.ok(!texts.includes("北京是中国的首都"));
});

test("BM25 检索命中相关 chunk", () => {
  ingestText("天魁系统使用 TypeScript 重写核心引擎", "a.txt", "a1");
  ingestText("今天天气不错适合出门", "b.txt", "b1");
  const retriever = new RagRetriever(allChunks());
  const hits = retriever.search("TypeScript 引擎", 2);
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].chunk.text.includes("TypeScript"));
});

test("rag_query 无 LLM 时走 fallback 回答", async () => {
  setProvider(null);
  ingestText("天魁系统使用 TypeScript 重写核心引擎,支持多 Agent 协同", "a.txt", "a2");
  const result = await ragQuery("多 Agent 协同", 3);
  assert.ok(result.hits.length >= 1);
  assert.ok(result.answer.length > 0);
  assert.ok(result.hits[0].doc === "a2");
});

test("rag_query 无命中给引导文案", async () => {
  setProvider(null);
  const result = await ragQuery("完全无关的话题xyzzy", 3);
  assert.equal(result.hits.length, 0);
  assert.ok(result.answer.includes("document_ingest"));
});

test("list_docs 展示版本", () => {
  ingestText("测试文档内容", "t.txt", "t1", "测试");
  const out = listDocs();
  assert.ok(out.includes("t1"));
  assert.ok(out.includes("v1"));
});