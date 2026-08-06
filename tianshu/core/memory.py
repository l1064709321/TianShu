from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

from tianshu.config import WORKSPACE_DIR


def approx_tokens(text: str) -> int:
    cjk = sum(1 for ch in text if ord(ch) > 0x2E7F)
    ascii_words = len(re.findall(r"\b[a-z0-9]+\b", text.lower()))
    return cjk + ascii_words


def extract_words(text: str) -> list[str]:
    """中文按连续 CJK 滑窗口二元组切词,英文按单词。"""
    t = text.lower()
    words = [w for w in re.findall(r"\b[a-z0-9]+\b", t) if len(w) > 1]
    cjk = re.findall(r"[\u4e00-\u9fff]", t)
    words += [cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1)]
    return words


STOPWORDS = {
    "实现", "使用", "进行", "系统", "任务", "一个", "需要", "怎么",
    "如何", "哪些", "开发", "做好", "工作", "部署", "就是", "这个",
}

# 高频实词,命中时降权(避免泛词霸榜)
GENERIC = {"实现", "使用", "系统", "任务", "开发"}


def _relevance(entry: str, words: list[str], weights: dict[str, float]) -> float:
    e = entry.lower()
    score = 0.0
    matched = set()
    for w in words:
        if w in e:
            matched.add(w)
            score += weights.get(w, 1.0)
    # 按匹配词种类数 + 总权重,惩罚被高权重泛词主导的贡献
    diversity = len(matched)
    return score + diversity * 0.5


@dataclass
class MemoryBlock:
    key: str
    title: str
    entries: list[str]


def _parse_memory(text: str) -> list[MemoryBlock]:
    blocks: list[MemoryBlock] = []
    cur: MemoryBlock | None = None
    for line in text.splitlines():
        m = re.match(r"^##\s*\[\s*(\w+)\s*\]\s*(.*)$", line)
        if m:
            if cur:
                blocks.append(cur)
            cur = MemoryBlock(key=m.group(1).lower(), title=m.group(2), entries=[])
            continue
        s = line.strip()
        if cur and s.startswith("-"):
            cur.entries.append(s[1:].strip())
    if cur:
        blocks.append(cur)
    return blocks


def build_memory_text(blocks: list[MemoryBlock]) -> str:
    lines = ["# 天枢项目记忆(Auto-maintained)", ""]
    for b in blocks:
        lines.append(f"## [{b.key}] {b.title}")
        if not b.entries:
            lines.append("- (空)")
        for e in b.entries:
            lines.append(f"- {e}")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


DEFAULT_BLOCKS = [
    MemoryBlock("goals", "目标", []),
    MemoryBlock("progress", "进度", []),
    MemoryBlock("decisions", "决策", []),
    MemoryBlock("blockers", "阻塞", []),
    MemoryBlock("facts", "事实/约定", []),
]


class ProjectMemory:
    """PROJECT_MEMORY.md 结构化长期记忆文件。

    读写分块,注入时按相关性与 token 预算选择性取块。
    """

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else WORKSPACE_DIR / "PROJECT_MEMORY.md"
        self._blocks: list[MemoryBlock] | None = None

    def load(self) -> list[MemoryBlock]:
        if self._blocks is None:
            if self.path.exists():
                text = self.path.read_text(encoding="utf-8")
                self._blocks = _parse_memory(text) or list(DEFAULT_BLOCKS)
            else:
                self._blocks = [MemoryBlock(b.key, b.title, list(b.entries)) for b in DEFAULT_BLOCKS]
        return self._blocks

    def _ensure(self) -> list[MemoryBlock]:
        blocks = self.load()
        keys = {b.key for b in blocks}
        for b in DEFAULT_BLOCKS:
            if b.key not in keys:
                blocks.append(MemoryBlock(b.key, b.title, []))
        return blocks

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(build_memory_text(self._blocks), encoding="utf-8")

    def block_summary(self) -> dict[str, int]:
        blocks = self.load()
        return {b.key: len(b.entries) for b in blocks}

    def add_entry(self, key: str, entry: str, max_per_block: int = 200) -> None:
        blocks = self._ensure()
        for b in blocks:
            if b.key == key:
                if entry in b.entries:
                    b.entries.remove(entry)
                b.entries.insert(0, entry)
                if len(b.entries) > max_per_block:
                    b.entries = b.entries[:max_per_block]
                break
        self.save()

    def update_from_result(self, plan, extra: dict | None = None) -> dict[str, bool]:
        """ask 结束后调用,把本次任务沉淀进记忆。"""
        self._ensure()
        ts = time.strftime("%m-%d %H:%M")
        task = (plan.task or "").strip()
        if not task:
            return {"memorized": False}
        changed = False
        if plan.summary and len(plan.summary) < 20000:
            self.add_entry("progress", f"[{ts}] {task[:120]} -> {plan.summary[:200]}")
            changed = True
        if plan.subtasks and any(getattr(st, "error", None) for st in plan.subtasks):
            block = "; ".join(f"{st.worker}:{st.error}" for st in plan.subtasks if getattr(st, "error", None))
            self.add_entry("blockers", f"[{ts}] {task[:80]} 失败: {block[:300]}")
        return {"memorized": changed}

    def select(self, task: str, budget: int = 1500) -> str:
        """相关性选择注入,受 token 预算约束。条目级筛选保证命中率。

        命中率机制:
        - 停用词过滤:泛词(实现/使用/系统)不计权重,只作弱匹配;
        - 评分按"匹配词种类数+加权和",具体词权重大于泛词;
        - 非核心块按分数从高到低注入,分数过低(仅泛词命中)不注入;
        - CORE 块(goals/blockers)始终注入(短小、项目方向)。
        """
        blocks = self.load()
        if not any(b.entries for b in blocks):
            return ""
        words = extract_words(task or "")
        weights = {w: 1.0 for w in words}
        for w in words:
            if w in STOPWORDS or w in GENERIC:
                weights[w] = 0.3
        CORE = {"goals", "blockers"}
        selected: list[str] = []
        used = 0
        for b in blocks:
            if not b.entries:
                continue
            is_core = b.key in CORE
            scored = sorted(
                ((_relevance(e, words, weights), e) for e in b.entries),
                key=lambda x: x[0],
                reverse=True,
            )
            if is_core:
                if words:
                    relevant = [e for s, e in scored if s >= 1.0] or ([scored[0][1]] if scored else [])
                else:
                    relevant = [e for _, e in scored]
            else:
                relevant = [e for s, e in scored if s >= 1.5]
            if not relevant:
                continue
            block_text = f"[{b.key}] {b.title}:\n" + "\n".join(f"- {e}" for e in relevant)
            cost = approx_tokens(block_text)
            if used + cost > budget and selected:
                continue
            selected.append(block_text)
            used += cost
        if not selected:
            return ""
        return "项目记忆(长期,请结合当前任务使用):\n" + "\n\n".join(selected)


def load_conversation_context(messages: list[dict], max_msgs: int = 8, max_tokens: int = 1200) -> str:
    if not messages:
        return ""
    recent = [m for m in messages if m.get("role") in ("user", "assistant", "orchestrator")][-max_msgs:]
    if not recent:
        return ""
    parts = []
    used = 0
    for m in reversed(recent):
        role = "用户" if m.get("role") == "user" else "助手"
        line = f"{role}: {str(m.get('content', ''))[:400]}"
        cost = approx_tokens(line)
        if used + cost > max_tokens:
            break
        parts.append(line)
        used += cost
    if not parts:
        return ""
    return "近期对话(短期记忆):\n" + "\n".join(reversed(parts))


def build_summarize_prompt(old_summary: str, batch: list[dict]) -> list[dict]:
    lines = []
    for m in batch:
        role = "用户" if m.get("role") == "user" else "助手"
        content = str(m.get("content", ""))[:400]
        if content:
            lines.append(f"{role}: {content}")
    text = "\n".join(lines)
    prev = f"已有摘要:\n{old_summary}\n\n" if old_summary else ""
    return [
        {
            "role": "system",
            "content": "你是记忆压缩器。把对话压缩成简明中文摘要,保留:用户意图、关键决策、已完成工作、阻塞点、约定。输出 5-12 条要点,每条一行,以 '- ' 开头,总长度不超过 800 字。",
        },
        {"role": "user", "content": f"{prev}新增对话:\n{text}"},
    ]


class CacheMonitor:
    """实时监测每次 LLM 调用的 prompt 缓存命中情况。

    usage 缓存字段兼容两种格式:
    - OpenAI: usage.prompt_tokens_details.cached_tokens
    - DeepSeek: usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
    """

    def __init__(self, max_history: int = 100) -> None:
        self.requests = 0
        self.prompt_tokens = 0
        self.prompt_hit = 0
        self.prompt_miss = 0
        self.history: list[dict] = []
        self.max_history = max_history

    def record(self, model: str, usage: dict) -> None:
        details = usage.get("prompt_tokens_details") or {}
        hit = details.get("cached_tokens", 0) or 0
        if not hit:
            hit = usage.get("prompt_cache_hit_tokens", 0) or 0
        miss = usage.get("prompt_cache_miss_tokens")
        prompt = usage.get("prompt_tokens", 0) or 0
        if miss is None:
            miss = max(0, prompt - hit)
        self.requests += 1
        self.prompt_tokens += prompt
        self.prompt_hit += hit
        self.prompt_miss += miss
        self.history.append(
            {
                "model": model,
                "prompt_tokens": prompt,
                "hit": hit,
                "miss": miss,
                "rate": round(hit / (hit + miss), 4) if (hit + miss) else 0.0,
            }
        )
        if len(self.history) > self.max_history:
            self.history = self.history[-self.max_history:]

    def summary(self) -> dict:
        total = self.prompt_hit + self.prompt_miss
        return {
            "requests": self.requests,
            "prompt_tokens": self.prompt_tokens,
            "hit_tokens": self.prompt_hit,
            "miss_tokens": self.prompt_miss,
            "hit_rate": round(self.prompt_hit / total, 4) if total else 0.0,
            "recent": self.history[-20:],
        }