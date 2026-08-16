from __future__ import annotations

import json
import threading
from pathlib import Path

from tianshu.config import PROJECT_ROOT

ACCESS_FILE = PROJECT_ROOT / "config" / "access_roots.json"
_lock = threading.Lock()


def _load() -> list[str]:
    if not ACCESS_FILE.exists():
        return []
    try:
        data = json.loads(ACCESS_FILE.read_text(encoding="utf-8"))
        return [r for r in data.get("roots", []) if isinstance(r, str) and r]
    except (ValueError, OSError):
        return []


def _save(roots: list[str]) -> None:
    ACCESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACCESS_FILE.write_text(json.dumps({"roots": roots}, ensure_ascii=False, indent=2), encoding="utf-8")


def access_roots() -> list[str]:
    with _lock:
        return _load()


def is_granted(p: Path) -> bool:
    resolved = p.resolve()
    for r in access_roots():
        root = Path(r).expanduser().resolve()
        if resolved == root or root in resolved.parents:
            return True
    return False


def add_root(path: str) -> str:
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"目录不存在: {path}")
    with _lock:
        roots = [Path(r).expanduser().resolve() for r in _load()]
        if root in roots:
            raise ValueError(f"已授权: {root}")
        roots.append(root)
        _save([str(r) for r in roots])
    return f"已授权访问: {root}"


def remove_root(path: str) -> str:
    target = Path(path).expanduser().resolve()
    with _lock:
        roots = [Path(r).expanduser().resolve() for r in _load()]
        if target not in roots:
            raise ValueError(f"未找到授权: {path}")
        roots = [r for r in roots if r != target]
        _save([str(r) for r in roots])
    return f"已撤销授权: {target}"


def list_roots() -> list[str]:
    return [str(Path(r).expanduser().resolve()) for r in access_roots()]