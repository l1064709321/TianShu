from __future__ import annotations

import pytest

from tianshu.core.rag.retrieve import RagRetriever
from tianshu.core.rag.service import rag_query
from tianshu.core.rag.store import Chunk, get_doc, ingest_text


@pytest.fixture
def lib(tmp_path, monkeypatch):
    monkeypatch.setattr("tianshu.core.rag.store.RAG_DIR", tmp_path)
    monkeypatch.setattr("tianshu.core.rag.store.INDEX_FILE", tmp_path / "index.json")
    return tmp_path


def test_ingest_and_versioning(lib):
    first = ingest_text("天枢支持多Agent协同。", "a.md", doc_id="doc1", title="协同手册")
    assert first == "doc1 v1"
    second = ingest_text("天枢支持模型池与RAG知识库。", "a.md", doc_id="doc1")
    assert second == "doc1 v2"
    doc = get_doc("doc1")
    assert doc.latest.version == 2
    assert doc.versions[0].superseded and not doc.latest.superseded
    chunks = [c for c in RagRetriever([Chunk("天枢支持模型池。", "doc1", 1, 0)]).chunks]
    assert chunks


def test_retriever_bm25_rank(tmp_path, monkeypatch):
    monkeypatch.setattr("tianshu.core.rag.store.RAG_DIR", tmp_path)
    monkeypatch.setattr("tianshu.core.rag.store.INDEX_FILE", tmp_path / "index.json")
    ingest_text("天枢支持模型池与多厂商模型路由。", "m.md", doc_id="m")
    ingest_text("今天天气晴朗适合爬山。", "w.md", doc_id="w")
    retriever = RagRetriever()
    hits = retriever.search("模型池路由", top_k=2)
    assert hits and hits[0].chunk.doc_id == "m"


def test_superseded_version_not_retrieved(tmp_path, monkeypatch):
    monkeypatch.setattr("tianshu.core.rag.store.RAG_DIR", tmp_path)
    monkeypatch.setattr("tianshu.core.rag.store.INDEX_FILE", tmp_path / "index.json")
    ingest_text("旧版:苹果是蓝色。", "f.md", doc_id="f")
    ingest_text("新版:苹果是红色。", "f.md", doc_id="f")
    retriever = RagRetriever()
    hits = retriever.search("苹果颜色", top_k=3)
    texts = [h.chunk.text for h in hits]
    assert any("红色" in t for t in texts)
    assert not any("蓝色" in t for t in texts)


@pytest.mark.asyncio
async def test_rag_query_offline(tmp_path, monkeypatch):
    monkeypatch.setattr("tianshu.core.rag.store.RAG_DIR", tmp_path)
    monkeypatch.setattr("tianshu.core.rag.store.INDEX_FILE", tmp_path / "index.json")
    ingest_text("天枢的审计日志记录授权与审核动作。", "aud.md", doc_id="a")
    result = await rag_query("审计日志记录了什么", top_k=3)
    assert result["hits"]
    assert "doc:a" in str(result["answer"]) or "文档库" not in result["answer"]
    assert "参考版本" in result["answer"]


@pytest.mark.asyncio
async def test_tools_registered_and_ingest(tmp_path, monkeypatch):
    from tianshu.core.tools.builtin import register_builtin_tools
    from tianshu.core.tools.registry import ToolRegistry

    monkeypatch.setattr("tianshu.core.rag.store.RAG_DIR", tmp_path)
    monkeypatch.setattr("tianshu.core.rag.store.INDEX_FILE", tmp_path / "index.json")
    f = tmp_path / "guide.md"
    f.write_text("部署天枢需要配置模型池与访问令牌。", encoding="utf-8")
    registry = ToolRegistry()
    register_builtin_tools(registry)
    assert registry.get("document_ingest") and registry.get("document_search") and registry.get("list_documents")
    out = await registry.get("document_ingest").func(path=str(f), title="部署指南")
    assert "已入库" in out and "v1" in out
    listing = await registry.get("list_documents").func()
    assert "部署指南" in listing and "v1" in listing