from __future__ import annotations

import time
import uuid
from pathlib import Path

import aiosqlite

from tianshu.config import PROJECT_ROOT


class SessionStore:
    """SQLite 会话持久化:会话、消息、编排结果。"""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT,
        provider    TEXT,
        model       TEXT,
        created_at  REAL,
        updated_at  REAL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT,
        created_at   REAL
    );
    CREATE TABLE IF NOT EXISTS orchestrations (
        session_id  TEXT PRIMARY KEY,
        task        TEXT,
        subtasks    TEXT,
        status      TEXT,
        created_at  REAL
    );
    CREATE TABLE IF NOT EXISTS conversation_summaries (
        session_id  TEXT PRIMARY KEY,
        summary     TEXT,
        covered     INTEGER DEFAULT 0,
        updated_at  REAL
    );
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = str(db_path or (PROJECT_ROOT / "tianshu.db"))
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(self.SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("SessionStore 未连接,先调用 connect()")
        return self._conn

    async def create_session(self, title: str, provider: str, model: str) -> str:
        sid = uuid.uuid4().hex[:12]
        now = time.time()
        await self.conn.execute(
            "INSERT INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (sid, title, provider, model, now, now),
        )
        await self.conn.commit()
        return sid

    async def list_sessions(self, limit: int = 50) -> list[dict]:
        cur = await self.conn.execute(
            "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", (limit,)
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_session(self, session_id: str) -> dict | None:
        cur = await self.conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return dict(row) if row else None

    async def touch(self, session_id: str) -> None:
        await self.conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (time.time(), session_id))
        await self.conn.commit()

    async def add_message(self, session_id: str, role: str, content: str) -> None:
        mid = uuid.uuid4().hex[:12]
        await self.conn.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (mid, session_id, role, content, time.time()),
        )
        await self.conn.commit()

    async def list_messages(self, session_id: str) -> list[dict]:
        cur = await self.conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC", (session_id,)
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def save_orchestration(
        self,
        session_id: str,
        task: str,
        summary: str,
        subtasks: list,
        status: str = "done",
    ) -> None:
        import json

        await self.conn.execute(
            "INSERT OR REPLACE INTO orchestrations (session_id, task, subtasks, status, created_at) VALUES (?, ?, ?, ?, ?)",
            (session_id, task, json.dumps(subtasks, ensure_ascii=False), status, time.time()),
        )
        await self.conn.commit()
        if summary:
            await self.add_message(session_id, "orchestrator", summary)

    async def get_summary(self, session_id: str) -> dict | None:
        cur = await self.conn.execute(
            "SELECT * FROM conversation_summaries WHERE session_id = ?", (session_id,)
        )
        row = await cur.fetchone()
        return dict(row) if row else None

    async def save_summary(self, session_id: str, summary: str, covered: int) -> None:
        await self.conn.execute(
            "INSERT OR REPLACE INTO conversation_summaries (session_id, summary, covered, updated_at) VALUES (?, ?, ?, ?)",
            (session_id, summary, covered, time.time()),
        )
        await self.conn.commit()