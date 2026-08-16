from __future__ import annotations

import contextvars
import json
import threading
from pathlib import Path

from tianshu.config import PROJECT_ROOT

ACCESS_FILE = PROJECT_ROOT / "config" / "access_roots.json"
_lock = threading.Lock()

_current_session: contextvars.ContextVar[str] = contextvars.ContextVar("ts_access_session", default="")


class RootEntry:
    __slots__ = ("path", "scope")

    def __init__(self, path: str, scope: str = "global") -> None:
        self.path = path
        self.scope = scope


def set_current_session(session_id: str) -> None:
    _current_session.set(session_id or "")


def current_session() -> str:
    return _current_session.get()


def _load() -> list[RootEntry]:
    if not ACCESS_FILE.exists():
        return []
    try:
        data = json.loads(ACCESS_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    entries = []
    for item in data.get("roots", []):
        if isinstance(item, str):
            entries.append(RootEntry(item))
        elif isinstance(item, dict) and isinstance(item.get("path"), str):
            entries.append(RootEntry(item["path"], item.get("scope", "global")))
    return entries


def _save(entries: list[RootEntry]) -> None:
    ACCESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"roots": [{"path": e.path, "scope": e.scope} for e in entries]}
    ACCESS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _entry_visible(entry: RootEntry, session: str, global_only: bool) -> bool:
    if entry.scope == "global":
        return True
    if global_only:
        return False
    return bool(session) and entry.scope == f"session:{session}"


def access_roots(global_only: bool = False) -> list[RootEntry]:
    session = _current_session.get()
    with _lock:
        return [e for e in _load() if _entry_visible(e, session, global_only)]


def is_granted(p: Path) -> bool:
    resolved = p.resolve()
    for e in access_roots():
        root = Path(e.path).expanduser().resolve()
        if resolved == root or root in resolved.parents:
            return True
    return False


def _valid_scope(scope: str) -> bool:
    return scope == "global" or (scope.startswith("session:") and bool(scope[len("session:"):]))


def add_root(path: str, scope: str = "global") -> str:
    if not _valid_scope(scope):
        raise ValueError('作用域仅支持 "global" 或 "session:<会话ID>"')
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"目录不存在: {path}")
    with _lock:
        entries = _load()
        for e in entries:
            if e.scope == scope and Path(e.path).expanduser().resolve() == root:
                raise ValueError(f"已授权: {root}(作用域 {scope})")
        entries.append(RootEntry(str(root), scope))
        _save(entries)
    from tianshu.core.audit import audit

    audit("access.grant", f"dir={root} scope={scope}", actor="web")
    return f"已授权访问: {root}(作用域 {scope})"


def remove_root(path: str, scope: str) -> str:
    target = Path(path).expanduser().resolve()
    with _lock:
        entries = [e for e in _load() if not (e.scope == scope and Path(e.path).expanduser().resolve() == target)]
        if len(entries) == len(_load()):
            raise ValueError(f"未找到授权: {path}(作用域 {scope})")
        _save(entries)
    from tianshu.core.audit import audit

    audit("access.revoke", f"dir={target} scope={scope}", actor="web")
    return f"已撤销授权: {target}(作用域 {scope})"


def list_roots() -> list[dict]:
    with _lock:
        return [{"path": str(Path(e.path).expanduser().resolve()), "scope": e.scope} for e in _load()]