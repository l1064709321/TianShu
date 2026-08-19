import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../config.js";

export class SessionStore {
  private db: DatabaseSync;
  dbPath: string;

  constructor(dbPath: string | null = null) {
    this.dbPath = dbPath ?? path.join(PROJECT_ROOT, "tiankui.db");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
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
    `);
  }

  close(): void {
    this.db.close();
  }

  createSession(title: string, provider: string, model: string): string {
    const sid = randomUUID().replace(/-/g, "").slice(0, 12);
    const now = Date.now() / 1000;
    this.db
      .prepare("INSERT INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sid, title, provider, model, now, now);
    return sid;
  }

  listSessions(limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
  }

  getSession(sessionId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row ?? null;
  }

  touch(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() / 1000, sessionId);
  }

  addMessage(sessionId: string, role: string, content: string): void {
    const mid = randomUUID().replace(/-/g, "").slice(0, 12);
    this.db
      .prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(mid, sessionId, role, content, Date.now() / 1000);
  }

  listMessages(sessionId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  saveOrchestration(
    sessionId: string,
    task: string,
    summary: string,
    subtasks: unknown[],
    status = "done",
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO orchestrations (session_id, task, subtasks, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionId, task, JSON.stringify(subtasks), status, Date.now() / 1000);
    if (summary) {
      this.addMessage(sessionId, "orchestrator", summary);
    }
  }

  getSummary(sessionId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT * FROM conversation_summaries WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  saveSummary(sessionId: string, summary: string, covered: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO conversation_summaries (session_id, summary, covered, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, summary, covered, Date.now() / 1000);
  }
}
