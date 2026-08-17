from __future__ import annotations

from typing import Any

from tianshu.core.llm.base import BaseProvider, LLMMessage
from tianshu.core.rag.retrieve import Hit, RagRetriever, all_chunks
from tianshu.core.rag.store import get_doc, ingest_text, list_docs

_PROVIDER: BaseProvider | None = None


def set_provider(p: BaseProvider | None) -> None:
    global _PROVIDER
    _PROVIDER = p


def provider() -> BaseProvider | None:
    return _PROVIDER


async def _chat_text(p: BaseProvider, prompt: str) -> str:
    result = await p.chat([LLMMessage(role="user", content=prompt)])
    return (result.content or "").strip()


async def _llm_optional(prompt: str, fallback: str) -> str:
    if _PROVIDER is None:
        return fallback
    try:
        return await _chat_text(_PROVIDER, prompt) or fallback
    except Exception:  # noqa: BLE001
        return fallback


async def rewrite_queries(query: str) -> list[str]:
    rewritten = await _llm_optional(
        "你是检索查询改写器。将下面用户查询改写为 1~3 个更利于全文检索的查询,每行一个,只输出查询内容,不要编号。\n查询:" + query,
        query,
    )
    lines = [ln.strip() for ln in rewritten.splitlines() if ln.strip()]
    unique = [query]
    for ln in lines:
        if ln not in unique:
            unique.append(ln)
    return unique[:3]


async def hyde_docs(query: str) -> list[str]:
    fake = await _llm_optional(
        "为下面查询写一段 50 词的假设性标准答案短文,直接输出内容。\n查询:" + query,
        "",
    )
    if not fake:
        return []
    return [fake] if _PROVIDER is not None else []


async def _titles(doc_ids: list[str]) -> str:
    parts = []
    for did in dict.fromkeys(doc_ids):
        doc = get_doc(did)
        if doc and doc.latest:
            parts.append(f"- {doc.title} (v{doc.latest.version}, {doc.latest.ts})")
    return "\n".join(parts)


async def build_answer(query: str, hits: list[Hit], with_hyde: bool = False) -> str:
    contexts = [f"[引用 {i + 1}][doc:{h.chunk.doc_id} v{h.chunk.version}] {h.chunk.text}" for i, h in enumerate(hits)]
    if with_hyde and _PROVIDER is not None:
        hyde = await hyde_docs(query)
        contexts = hyde + contexts
    doc_ids = [h.chunk.doc_id for h in hits]
    refs = await _titles(doc_ids)
    prompt = (
        "你是知识库问答引擎。仅依据下方引用资料回答用户问题;若资料不足,明确说明缺失信息,不得编造。"
        "回答中用 [引用 N] 标注依据的引用编号。\n\n引用资料:\n"
        + "\n\n".join(contexts)
        + f"\n\n问题:{query}\n\n答案:"
    )
    answer = await _llm_optional(prompt, "参考以上资料生成回答")
    return f"{answer}\n\n参考版本:\n{refs}" if refs else answer


async def rag_query(query: str, top_k: int = 5, use_hyde: bool = False) -> dict[str, Any]:
    queries = await rewrite_queries(query)
    retriever = RagRetriever(all_chunks())
    merged: dict[str, Hit] = {}
    for q in queries:
        for hit in retriever.search(q, top_k=top_k):
            key = hit.chunk.doc_id
            if key not in merged or hit.score > merged[key].score:
                merged[key] = hit
    hits = sorted(merged.values(), key=lambda h: h.score, reverse=True)[:top_k]
    answer = "" if hits else "文档库中没有相关内容,请先通过 document_ingest 导入资料。"
    if hits:
        answer = await build_answer(query, hits, with_hyde=use_hyde)
    return {
        "query": query,
        "rewrites": queries,
        "hits": [{"doc": h.chunk.doc_id, "version": h.chunk.version, "excerpt": h.chunk.text[:200], "score": round(h.score, 4)} for h in hits],
        "answer": answer,
    }


async def ingest_file(path: str, doc_id: str = "", title: str = "") -> str:
    from pathlib import Path

    p = Path(path).expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(f"文件不存在: {path}")
    text = p.read_text(encoding="utf-8", errors="ignore")
    result = ingest_text(text, str(p), doc_id=doc_id, title=title or p.name)
    return f"已入库 {p.name} → {result}({len(text)} 字符)"



def rag_docs_list() -> str:
    return list_docs()