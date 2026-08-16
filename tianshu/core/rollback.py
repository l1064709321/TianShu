from __future__ import annotations

import shutil
import time
from pathlib import Path

from tianshu.config import SENSITIVE_DIR as SN_DIR
from tianshu.config import WORKSPACE_DIR as WS_DIR

SNAP_ROOT = WS_DIR / ".ts-snapshots"
MAX_SNAPSHOTS = 20

_SKIP_DIRS = {SNAP_ROOT.name, SN_DIR.name, ".git"}


def _safe_label(label: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in label)[:40]


def _new_snap_dir(label: str = "") -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    SNAP_ROOT.mkdir(parents=True, exist_ok=True)
    base = f"snap-{stamp}"
    if label:
        base = f"{base}-{_safe_label(label)}"
    d = SNAP_ROOT / base
    n = 2
    while d.exists():
        d = SNAP_ROOT / f"{base}-{n}"
        n += 1
    d.mkdir()
    return d


def _prune() -> None:
    snaps = sorted(SNAP_ROOT.glob("snap-*"), key=lambda p: p.name)
    for old in snaps[:-MAX_SNAPSHOTS]:
        shutil.rmtree(old, ignore_errors=True)


def auto_snapshot(path: str | Path) -> str | None:
    p = Path(path).resolve()
    wp = WS_DIR.resolve()
    try:
        rel = p.relative_to(wp)
    except ValueError:
        return None
    if not p.is_file():
        return None
    snap = _new_snap_dir("auto")
    dst = snap / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, dst)
    _prune()
    return snap.name


def snapshot_all(label: str = "manual") -> str:
    wp = WS_DIR.resolve()
    snap = _new_snap_dir(label)
    n = 0
    for p in wp.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(wp)
        if any(part in _SKIP_DIRS for part in rel.parts):
            continue
        dst = snap / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
        n += 1
    _prune()
    return f"{snap.name}({n} 个文件)"


def list_snapshots(limit: int = 10) -> str:
    snaps = sorted(SNAP_ROOT.glob("snap-*"), key=lambda p: p.name, reverse=True)
    if not snaps:
        return "(暂无快照)"
    lines = []
    for d in snaps[:limit]:
        count = sum(1 for f in d.rglob("*") if f.is_file())
        lines.append(f"{d.name}  |  {count} 个文件")
    return "\n".join(lines)


def restore_snapshot(snapshot: str, target: str) -> str:
    wp = WS_DIR.resolve()
    snap = SNAP_ROOT / snapshot
    if not snap.is_dir():
        raise FileNotFoundError(f"快照不存在: {snapshot}")
    t = Path(target)
    if not t.is_absolute():
        t = wp / t
    t = t.resolve()
    try:
        rel = t.relative_to(wp)
    except ValueError:
        raise PermissionError(f"目标必须在工作区内: {target}")
    src = snap / rel
    if not src.exists():
        raise FileNotFoundError(f"快照中没有该路径: {rel}")
    auto_snapshot(t)
    t.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, t, dirs_exist_ok=True)
        return f"已从 {snap.name} 恢复目录 {rel}(恢复前版本已自动备份)"
    shutil.copy2(src, t)
    return f"已从 {snap.name} 恢复文件 {rel}(恢复前版本已自动备份)"