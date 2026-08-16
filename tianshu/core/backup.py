from __future__ import annotations

import os
import tarfile
import time
from pathlib import Path

from tianshu.config import PROJECT_ROOT, WORKSPACE_DIR
from tianshu.core.identity import IDENTITY_FILE_ENV

BACKUP_ROOT = WORKSPACE_DIR / ".ts-backups"
MAX_BACKUPS = 7

_ALLOWED = ("models.json", ".env", "tianshu.db", "identity-card")


def backup_entries() -> dict[str, Path]:
    entries: dict[str, Path] = {
        "models.json": PROJECT_ROOT / "config" / "models.json",
        ".env": PROJECT_ROOT / ".env",
        "tianshu.db": PROJECT_ROOT / "tianshu.db",
    }
    idf = os.environ.get(IDENTITY_FILE_ENV, "")
    if idf:
        p = Path(idf).expanduser()
        if p.exists():
            entries["identity-card"] = p
    return entries


def _file_size(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0


def create_backup(label: str = "manual") -> str:
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in label)[:40]
    name = f"backup-{stamp}-{safe}"
    path = BACKUP_ROOT / f"{name}.tar.gz"
    with tarfile.open(path, "w:gz") as t:
        for arc, src in backup_entries().items():
            if src.exists():
                t.add(src, arcname=arc)
    keep = sorted(BACKUP_ROOT.glob("backup-*.tar.gz"), key=lambda p: p.name)
    for old in keep[:-MAX_BACKUPS]:
        old.unlink(missing_ok=True)
    from tianshu.core.audit import audit

    audit("backup.create", f"file={path.name}", actor="web")
    return name


def list_backups() -> str:
    items = sorted(BACKUP_ROOT.glob("backup-*.tar.gz"), key=lambda p: p.name, reverse=True)
    if not items:
        return "(暂无备份)"
    lines = []
    for it in items:
        members = ["(损坏)"]
        try:
            with tarfile.open(it, "r:gz") as t:
                members = t.getnames()
        except tarfile.TarError:
            pass
        lines.append(f"{it.name.removesuffix('.tar.gz')}  |  {it.stat().st_size} B  |  {','.join(members)}")
    return "\n".join(lines)


def restore_backup(backup: str, target: str) -> str:
    if target not in _ALLOWED:
        raise PermissionError(f"仅允许恢复: {'、'.join(_ALLOWED)}")
    dest = backup_entries().get(target)
    if dest is None:
        raise FileNotFoundError(f"备份中不含 {target}(当前环境未启用该文件)")
    b = BACKUP_ROOT / f"{backup}" if backup.endswith(".tar.gz") else BACKUP_ROOT / f"{backup}.tar.gz"
    if not b.is_file():
        raise FileNotFoundError(f"备份不存在: {b.name}")
    with tarfile.open(b, "r:gz") as t:
        names = t.getnames()
        if target not in names:
            raise FileNotFoundError(f"备份中无 {target}")
        m = t.getmember(target)
        clean = Path(m.name)
        if clean.is_absolute() or ".." in clean.parts:
            raise PermissionError("备份成员路径不合法,已拒绝")
        if dest.exists():
            recovered = t.extractfile(m)
            if recovered is None:
                raise PermissionError(f"备份成员异常: {target}")
            create_backup("pre-restore")
            dest.write_bytes(recovered.read())
        else:
            raise FileNotFoundError(f"当前不存在可恢复的目标文件: {target}")
    from tianshu.core.audit import audit

    audit("backup.restore", f"file={b.name} target={target}", actor="web")
    return f"已从 {b.name} 恢复 {target}(恢复前已自动建 pre-restore 备份,重启服务后生效)"