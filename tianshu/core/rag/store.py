from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field

from tianshu.config import WORKSPACE_DIR

RAG_DIR = WORKSPACE_DIR / ".ts-rag"
INDEX_FILE = RAG_DIR / "index.json"
CHUNK_SIZE = 500
CHUNK_OVERLAP = 60
_lock = threading.Lock()


@dataclass
class Chunk:
    text: str
    doc_id: str
    version: int
    seq: int


@dataclass
class DocumentVersion:
    version: int
    ts: str
    source: str
    chunks: list[str] = field(default_factory=list)
    superseded: bool = False


@dataclass
class Document:
    id: str
    title: str
    versions: list[DocumentVersion] = field(default_factory=list)

    @property
    def latest(self) -> DocumentVersion | None:
        return self.versions[-1] if self.versions else None


def _ensure() -> None:
    RAG_DIR.mkdir(parents=True, exist_ok=True)
    if not INDEX_FILE.exists():
        INDEX_FILE.write_text("{}", encoding="utf-8")


def _load() -> dict:
    _ensure()
    try:
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}


def _save(data: dict) -> None:
    _ensure()
    INDEX_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def _split_chunks(text: str) -> list[str]:
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return []
    paragraphs = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) + 2 <= CHUNK_SIZE:
            buf = f"{buf}\n\n{para}".strip() if buf else para
            continue
        if buf:
            chunks.append(buf)
        if len(para) > CHUNK_SIZE:
            words = re.findall(r"\S+", para)
            cur = ""
            for w in words:
                if len(cur) + len(w) + 1 > CHUNK_SIZE:
                    chunks.append(cur)
                    tail = " ".join(cur.split()[-CHUNK_OVERLAP:]) if CHUNK_OVERLAP else ""
                    cur = f"{tail} {w}".strip()
                else:
                    cur = f"{cur} {w}".strip()
            if cur:
                chunks.append(cur)
        else:
            buf = para
    if buf:
        chunks.append(buf)
    return chunks


def ingest_text(text: str, source: str, doc_id: str = "", title: str = "") -> str:
    with _lock:
        data = _load()
        if not doc_id:
            doc_id = uuid.uuid4().hex[:12]
        doc = data.setdefault("docs", {}).setdefault(doc_id, {"id": doc_id, "title": title or source, "versions": []})
        if title and not doc.get("title"):
            doc["title"] = title
        for v in doc["versions"]:
            v["superseded"] = True
        version = len(doc["versions"]) + 1
        entry: dict = {
            "version": version,
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source": source,
            "chunks": _split_chunks(text),
            "superseded": False,
        }
        doc["versions"].append(entry)
        _save(data)
    return f"{doc_id} v{version}"



def _latest_chunks(doc: dict) -> list[Chunk]:
    out: list[Chunk] = []
    for v in doc.get("versions", []):
        if v.get("superseded"):
            continue
        for i, text in enumerate(v.get("chunks", [])):
            out.append(Chunk(text=text, doc_id=doc["id"], version=v.get("version", 1), seq=i))
    return out


def all_chunks() -> list[Chunk]:
    data = _load()
    out: list[Chunk] = []
    for doc in data.get("docs", {}).values():
        out.extend(_latest_chunks(doc))
    return out


def get_doc(doc_id: str) -> Document | None:
    data = _load()
    raw = data.get("docs", {}).get(doc_id)
    if not raw:
        return None
    versions = [
        DocumentVersion(
            version=v.get("version", 1),
            ts=v.get("ts", ""),
            source=v.get("source", ""),
            chunks=v.get("chunks", []),
            superseded=bool(v.get("superseded")),
        )
        for v in raw.get("versions", [])
    ]
    return Document(id=doc_id, title=raw.get("title", doc_id), versions=versions)


def list_docs() -> str:
    data = _load()
    rows = []
    for doc in data.get("docs", {}).values():
        latest = max((v.get("version", 1) for v in doc.get("versions", [])), default=0)
        rows.append(f"{doc['id']}  {doc.get('title','')}  (v{latest})")
    return "\n".join(rows) if rows else "(文档库为空)"