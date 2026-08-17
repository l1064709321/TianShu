import type { Chunk } from "./store.js";
import { allChunks } from "./store.js";

const STOP = new Set([
  "的", "了", "和", "是", "在", "有", "我", "你", "他", "她", "它", "这", "那",
  "与", "及", "或", "一个", "我们", "你们", "们", "也", "就", "都", "而", "但",
  "the", "a", "an", "is", "are", "was", "to", "of", "in", "for", "on", "and",
]);

function tokens(text: string): string[] {
  const t = text.toLowerCase();
  const words = t.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  return words.filter((w) => !STOP.has(w) && (w.length > 1 || (w >= "\u4e00" && w <= "\u9fff")));
}

function bm25Score(
  queryTokens: string[],
  docTokens: Map<string, number>,
  df: Map<string, number>,
  nDocs: number,
  avgLen: number,
  docLen: number,
): number {
  const k1 = 1.5;
  const b = 0.75;
  let score = 0.0;
  for (const t of new Set(queryTokens)) {
    const tf = docTokens.get(t) ?? 0;
    if (tf === 0) continue;
    const docFreq = df.get(t) ?? 0;
    const idf = Math.log(1 + (nDocs - docFreq + 0.5) / (docFreq + 0.5));
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / Math.max(avgLen, 1))));
  }
  return score;
}

export interface Hit {
  chunk: Chunk;
  score: number;
  exact: boolean;
}

export class RagRetriever {
  chunks: Chunk[];
  private _tokenized: Array<Map<string, number>> = [];
  df = new Map<string, number>();
  nDocs: number;
  avgLen: number;

  constructor(chunks: Chunk[] | null = null) {
    this.chunks = chunks ?? allChunks();
    let totalLen = 1;
    for (const c of this.chunks) {
      const toks = new Map<string, number>();
      for (const t of tokens(c.text)) {
        toks.set(t, (toks.get(t) ?? 0) + 1);
      }
      this._tokenized.push(toks);
      for (const t of toks.keys()) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
      totalLen += c.text.length;
    }
    this.nDocs = Math.max(this.chunks.length, 1);
    this.avgLen = totalLen / this.nDocs;
  }

  search(query: string, topK = 5): Hit[] {
    const qTokens = tokens(query);
    if (!qTokens.length || !this.chunks.length) return [];
    const scored: Hit[] = [];
    this.chunks.forEach((c, i) => {
      const toks = this._tokenized[i];
      const score = bm25Score(qTokens, toks, this.df, this.nDocs, this.avgLen, c.text.length);
      if (score > 0) {
        const exact = qTokens.every((t) => (toks.get(t) ?? 0) > 0);
        scored.push({ chunk: c, score, exact });
      }
    });
    scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
    return scored.slice(0, topK);
  }
}
