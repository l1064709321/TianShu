from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

from tianshu.core.rag.store import Chunk, all_chunks

_STOP = {
    "的", "了", "和", "是", "在", "有", "我", "你", "他", "她", "它", "这", "那",
    "与", "及", "或", "一个", "我们", "你们", "们", "也", "就", "都", "而", "但",
    "the", "a", "an", "is", "are", "was", "to", "of", "in", "for", "on", "and",
}


def _tokens(text: str) -> list[str]:
    text = text.lower()
    words = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", text)
    return [w for w in words if w not in _STOP and (len(w) > 1 or "\u4e00" <= w <= "\u9fff")]


def _bm25_score(query_tokens: list[str], doc_tokens: Counter, df: dict[str, int], n_docs: int, avg_len: float, doc_len: int) -> float:
    k1, b = 1.5, 0.75
    score = 0.0
    for t in set(query_tokens):
        tf = doc_tokens.get(t, 0)
        if tf == 0:
            continue
        idf = math.log(1 + (n_docs - df.get(t, 0) + 0.5) / (df.get(t, 0) + 0.5))
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc_len / max(avg_len, 1)))
    return score


@dataclass
class Hit:
    chunk: Chunk
    score: float
    exact: bool


class RagRetriever:
    def __init__(self, chunks: list[Chunk] | None = None) -> None:
        self.chunks = chunks if chunks is not None else all_chunks()
        self._tokenized: list[Counter] = []
        self.df: Counter = Counter()
        total_len = 1
        for c in self.chunks:
            toks = Counter(_tokens(c.text))
            self._tokenized.append(toks)
            for t in toks:
                self.df[t] += 1
            total_len += len(c.text)
        self.n_docs = max(len(self.chunks), 1)
        self.avg_len = total_len / self.n_docs

    def search(self, query: str, top_k: int = 5) -> list[Hit]:
        tokens = _tokens(query)
        if not tokens or not self.chunks:
            return []
        scored = []
        for c, toks in zip(self.chunks, self._tokenized):
            score = _bm25_score(tokens, toks, self.df, self.n_docs, self.avg_len, len(c.text))
            if score > 0:
                exact = all(t in toks for t in tokens)
                scored.append(Hit(c, score, exact))
        scored.sort(key=lambda h: (h.exact, h.score), reverse=True)
        return scored[:top_k]