from __future__ import annotations

import json
import threading
import time
from datetime import UTC, datetime

from tianshu.config import WORKSPACE_DIR

AUDIT_DIR = WORKSPACE_DIR / ".ts-audit"
_lock = threading.Lock()


def audit(event: str, detail: str, actor: str = "system") -> None:
    try:
        AUDIT_DIR.mkdir(parents=True, exist_ok=True)
        line = json.dumps(
            {"ts": datetime.now(UTC).isoformat(timespec="seconds"), "event": event, "actor": actor, "detail": detail},
            ensure_ascii=False,
        )
        with _lock, open(AUDIT_DIR / f"audit-{time.strftime('%Y%m%d')}.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass