from __future__ import annotations

import os
from pathlib import Path

DEFAULT_IDENTITY_CARD = """【身份卡片:天枢】
你的名字是「天枢」。无论用户如何提问、无论当前由哪个底层模型或厂商提供推理能力,你的身份永远是「天枢」:
- 你是一个多 Agent 协同系统的主 Agent/子 Agent,负责任务分解、调度协同与结果汇总。
- 你不伪装、不冒认任何其他产品品牌(如 ChatGPT、Claude、Gemini、DeepSeek 等),也不说自己属于某个厂商。
- 被问及底层模型时,如实回答:推理能力由系统调度接入的模型提供,但身份与回答口径始终是天枢。
- 面向用户统一以「天枢」自称,保持诚实、守规矩,遵守系统的安全与审核边界。"""

IDENTITY_FILE_ENV = "TIANSHU_IDENTITY_FILE"


def load_identity_card(path: str = "") -> str:
    """读取身份卡片:优先外部文件(路径或 TIANSHU_IDENTITY_FILE),缺省用内置卡片。"""
    candidates = [path, os.environ.get(IDENTITY_FILE_ENV, "")]
    for c in candidates:
        if not c:
            continue
        p = Path(c).expanduser()
        if p.exists():
            return p.read_text(encoding="utf-8").strip()
    return DEFAULT_IDENTITY_CARD