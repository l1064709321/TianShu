import * as fs from "node:fs";
import * as path from "node:path";
import { WORKSPACE_DIR } from "../config.js";

export function approxTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x2e7f) cjk++;
  }
  const asciiWords = text.toLowerCase().match(/[a-z0-9]+/g)?.length ?? 0;
  return cjk + asciiWords;
}

export function extractWords(text: string): string[] {
  const t = text.toLowerCase();
  const words = (t.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1);
  const cjk = t.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) {
    words.push(cjk[i] + cjk[i + 1]);
  }
  return words;
}

const STOPWORDS = new Set([
  "实现", "使用", "进行", "系统", "任务", "一个", "需要", "怎么",
  "如何", "哪些", "开发", "做好", "工作", "部署", "就是", "这个",
]);

const GENERIC = new Set(["实现", "使用", "系统", "任务", "开发"]);

function relevance(entry: string, words: string[], weights: Map<string, number>): number {
  const e = entry.toLowerCase();
  let score = 0.0;
  const matched = new Set<string>();
  for (const w of words) {
    if (e.includes(w)) {
      matched.add(w);
      score += weights.get(w) ?? 1.0;
    }
  }
  return score + matched.size * 0.5;
}

export interface MemoryBlock {
  key: string;
  title: string;
  entries: string[];
}

function parseMemory(text: string): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  let cur: MemoryBlock | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^##\s*\[\s*(\w+)\s*\]\s*(.*)$/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { key: m[1].toLowerCase(), title: m[2], entries: [] };
      continue;
    }
    const s = line.trim();
    if (cur && s.startsWith("-")) {
      cur.entries.push(s.slice(1).trim());
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

export function buildMemoryText(blocks: MemoryBlock[]): string {
  const lines = ["# 天枢项目记忆(Auto-maintained)", ""];
  for (const b of blocks) {
    lines.push(`## [${b.key}] ${b.title}`);
    if (!b.entries.length) lines.push("- (空)");
    for (const e of b.entries) lines.push(`- ${e}`);
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

const DEFAULT_BLOCKS: MemoryBlock[] = [
  { key: "goals", title: "目标", entries: [] },
  { key: "progress", title: "进度", entries: [] },
  { key: "decisions", title: "决策", entries: [] },
  { key: "blockers", title: "阻塞", entries: [] },
  { key: "facts", title: "事实/约定", entries: [] },
];

export class ProjectMemory {
  path: string;
  private _blocks: MemoryBlock[] | null = null;

  constructor(filePath: string | null = null) {
    this.path = filePath ?? path.join(WORKSPACE_DIR, "PROJECT_MEMORY.md");
  }

  load(): MemoryBlock[] {
    if (this._blocks === null) {
      let parsed: MemoryBlock[] = [];
      try {
        parsed = parseMemory(fs.readFileSync(this.path, "utf-8"));
      } catch {
        parsed = [];
      }
      if (parsed.length) {
        this._blocks = parsed;
      } else {
        this._blocks = DEFAULT_BLOCKS.map((b) => ({ ...b, entries: [...b.entries] }));
      }
    }
    return this._blocks;
  }

  private _ensure(): MemoryBlock[] {
    const blocks = this.load();
    const keys = new Set(blocks.map((b) => b.key));
    for (const b of DEFAULT_BLOCKS) {
      if (!keys.has(b.key)) blocks.push({ ...b, entries: [] });
    }
    return blocks;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, buildMemoryText(this._blocks!), "utf-8");
  }

  blockSummary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of this.load()) out[b.key] = b.entries.length;
    return out;
  }

  addEntry(key: string, entry: string, maxPerBlock = 200): void {
    const blocks = this._ensure();
    for (const b of blocks) {
      if (b.key === key) {
        const idx = b.entries.indexOf(entry);
        if (idx >= 0) b.entries.splice(idx, 1);
        b.entries.unshift(entry);
        if (b.entries.length > maxPerBlock) b.entries = b.entries.slice(0, maxPerBlock);
        break;
      }
    }
    this.save();
  }

  updateFromResult(plan: Record<string, unknown>): Record<string, boolean> {
    this._ensure();
    const ts = new Date().toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const task = String(plan.task ?? "").trim();
    if (!task) return { memorized: false };
    let changed = false;
    const summary = String(plan.summary ?? "");
    if (summary && summary.length < 20000) {
      this.addEntry("progress", `[${ts}] ${task.slice(0, 120)} -> ${summary.slice(0, 200)}`);
      changed = true;
    }
    const subtasks = (plan.subtasks ?? []) as Array<{ worker?: string; error?: string | null }>;
    const errors = subtasks.filter((st) => st.error);
    if (errors.length) {
      const block = errors.map((st) => `${st.worker}:${st.error}`).join("; ");
      this.addEntry("blockers", `[${ts}] ${task.slice(0, 80)} 失败: ${block.slice(0, 300)}`);
    }
    return { memorized: changed };
  }

  select(task: string, budget = 1500): string {
    const blocks = this.load();
    if (!blocks.some((b) => b.entries.length)) return "";
    const words = extractWords(task ?? "");
    const weights = new Map<string, number>();
    for (const w of words) weights.set(w, 1.0);
    for (const w of words) {
      if (STOPWORDS.has(w) || GENERIC.has(w)) weights.set(w, 0.3);
    }
    const CORE = new Set(["goals", "blockers"]);
    const selected: string[] = [];
    let used = 0;
    for (const b of blocks) {
      if (!b.entries.length) continue;
      const isCore = CORE.has(b.key);
      const scored = b.entries
        .map((e) => ({ score: relevance(e, words, weights), entry: e }))
        .sort((a, c) => c.score - a.score);
      let relevant: string[];
      if (isCore) {
        if (words.length) {
          relevant = scored.filter((s) => s.score >= 1.0).map((s) => s.entry);
          if (!relevant.length && scored.length) relevant = [scored[0].entry];
        } else {
          relevant = scored.map((s) => s.entry);
        }
      } else {
        relevant = scored.filter((s) => s.score >= 1.5).map((s) => s.entry);
      }
      if (!relevant.length) continue;
      const blockText = `[${b.key}] ${b.title}:\n` + relevant.map((e) => `- ${e}`).join("\n");
      const cost = approxTokens(blockText);
      if (used + cost > budget && selected.length) continue;
      selected.push(blockText);
      used += cost;
    }
    if (!selected.length) return "";
    return "项目记忆(长期,请结合当前任务使用):\n\n" + selected.join("\n\n");
  }
}

export function loadConversationContext(messages: Array<Record<string, unknown>>, maxMsgs = 8, maxTokens = 1200): string {
  if (!messages.length) return "";
  const recent = messages
    .filter((m) => ["user", "assistant", "orchestrator"].includes(String(m.role)))
    .slice(-maxMsgs);
  if (!recent.length) return "";
  const parts: string[] = [];
  let used = 0;
  for (const m of [...recent].reverse()) {
    const role = m.role === "user" ? "用户" : "助手";
    const line = `${role}: ${String(m.content ?? "").slice(0, 400)}`;
    const cost = approxTokens(line);
    if (used + cost > maxTokens) break;
    parts.push(line);
    used += cost;
  }
  if (!parts.length) return "";
  return "近期对话(短期记忆):\n" + parts.reverse().join("\n");
}

export function buildSummarizePrompt(oldSummary: string, batch: Array<Record<string, unknown>>): Array<{ role: string; content: string }> {
  const lines: string[] = [];
  for (const m of batch) {
    const role = m.role === "user" ? "用户" : "助手";
    const content = String(m.content ?? "").slice(0, 400);
    if (content) lines.push(`${role}: ${content}`);
  }
  const text = lines.join("\n");
  const prev = oldSummary ? `已有摘要:\n${oldSummary}\n\n` : "";
  return [
    {
      role: "system",
      content: "你是记忆压缩器。把对话压缩成简明中文摘要,保留:用户意图、关键决策、已完成工作、阻塞点、约定。输出 5-12 条要点,每条一行,以 '- ' 开头,总长度不超过 800 字。",
    },
    { role: "user", content: `${prev}新增对话:\n${text}` },
  ];
}

export class CacheMonitor {
  requests = 0;
  promptTokens = 0;
  promptHit = 0;
  promptMiss = 0;
  history: Array<Record<string, unknown>> = [];
  maxHistory: number;

  constructor(maxHistory = 100) {
    this.maxHistory = maxHistory;
  }

  record(model: string, usage: Record<string, number>): void {
    const u = usage as Record<string, unknown>;
    const details = (u.prompt_tokens_details as Record<string, number> | undefined) ?? {};
    let hit = details.cached_tokens ?? 0;
    if (!hit) hit = (u.prompt_cache_hit_tokens as number) ?? 0;
    let miss = u.prompt_cache_miss_tokens as number | undefined;
    const prompt = (u.prompt_tokens as number) ?? 0;
    if (miss === undefined || miss === null) miss = Math.max(0, prompt - hit);
    this.requests += 1;
    this.promptTokens += prompt;
    this.promptHit += hit;
    this.promptMiss += miss;
    this.history.push({
      model,
      prompt_tokens: prompt,
      hit,
      miss,
      rate: hit + miss ? Math.round((hit / (hit + miss)) * 10000) / 10000 : 0.0,
    });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  summary(): Record<string, unknown> {
    const total = this.promptHit + this.promptMiss;
    return {
      requests: this.requests,
      prompt_tokens: this.promptTokens,
      hit_tokens: this.promptHit,
      miss_tokens: this.promptMiss,
      hit_rate: total ? Math.round((this.promptHit / total) * 10000) / 10000 : 0.0,
      recent: this.history.slice(-20),
    };
  }
}
