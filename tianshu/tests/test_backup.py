from __future__ import annotations

import tarfile

import pytest

import tianshu.core.backup as bk


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    (root / "config").mkdir()
    (root / "config" / "models.json").write_text('{"keys": "sk-xxx"}')
    (root / ".env").write_text("TIANSHU_DEBUG=1")
    (root / "tianshu.db").write_bytes(b"db-bytes")
    idf = tmp_path / "identity.md"
    idf.write_text("【身份卡片:测试】")
    monkeypatch.setattr(bk, "PROJECT_ROOT", root)
    monkeypatch.setattr(bk, "BACKUP_ROOT", tmp_path / "backups")
    monkeypatch.setenv(bk.IDENTITY_FILE_ENV, str(idf))
    return root


def test_create_backup_packs_entries(env):
    name = bk.create_backup("init")
    path = bk.BACKUP_ROOT / f"{name}.tar.gz"
    assert path.is_file()
    with tarfile.open(path, "r:gz") as t:
        members = set(t.getnames())
    assert members == {"models.json", ".env", "tianshu.db", "identity-card"}


def test_list_backups_shows_members(env):
    bk.create_backup("init")
    out = bk.list_backups()
    assert "backup-" in out and "models.json" in out and ".env" in out


def test_restore_backup_roundtrip(env):
    bk.create_backup("good")
    (env / "config" / "models.json").write_text('{"broken": true}')
    bk.create_backup("pre-restore-1")
    name = bk.list_backups().splitlines()[1].split("|")[0].strip()
    out = bk.restore_backup(name, "models.json")
    assert '"sk-xxx"' in (env / "config" / "models.json").read_text()
    assert "pre-restore" in out
    assert any("pre-restore" in p.stem for p in bk.BACKUP_ROOT.glob("backup-*.tar.gz"))


def test_restore_backup_rejects_outside_target(env):
    bk.create_backup("x")
    name = bk.list_backups().splitlines()[0].split("|")[0].strip()
    with pytest.raises(PermissionError):
        bk.restore_backup(name, "../../etc/passwd")
    with pytest.raises(PermissionError):
        bk.restore_backup(name, "unknown-file")


@pytest.mark.asyncio
async def test_agent_can_backup_and_restore(env, monkeypatch):
    from tianshu.core.tools.builtin import register_builtin_tools
    from tianshu.core.tools.registry import ToolRegistry

    registry = ToolRegistry()
    register_builtin_tools(registry)
    assert registry.get("create_backup") and registry.get("list_backups") and registry.get("restore_backup")
    out = await registry.get("create_backup").func(label="agent-test")
    assert out.startswith("backup-")
    (env / ".env").write_text("TIANSHU_DEBUG=0")
    name = await registry.get("list_backups").func()
    snap = name.splitlines()[0].split("|")[0].strip()
    await registry.get("restore_backup").func(backup=snap, target=".env")
    assert "TIANSHU_DEBUG=1" in (env / ".env").read_text()