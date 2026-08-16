from __future__ import annotations

import json

import pytest

import tianshu.core.audit as au
import tianshu.core.backup as bk


@pytest.fixture
def audit_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(au, "AUDIT_DIR", tmp_path / "audit")
    return au.AUDIT_DIR


def test_audit_appends_json_lines(audit_dir):
    au.audit("test.event", "detail a", actor="tester")
    au.audit("test.event2", "detail b", actor="tester")
    files = list(audit_dir.glob("audit-*.log"))
    assert len(files) == 1
    lines = files[0].read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["event"] == "test.event" and first["actor"] == "tester" and first["detail"] == "detail a"


def test_access_grant_revoke_audited(audit_dir, tmp_path, monkeypatch):
    import tianshu.core.access as acc

    monkeypatch.setattr(acc, "ACCESS_FILE", tmp_path / "access_roots.json")
    d = tmp_path / "aud"
    d.mkdir()
    acc.add_root(str(d))
    acc.remove_root(str(d), scope="global")
    log = next(audit_dir.glob("audit-*.log")).read_text(encoding="utf-8")
    assert "access.grant" in log and "access.revoke" in log


def test_backup_restore_audited(audit_dir, tmp_path, monkeypatch):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "config").mkdir()
    (root / "config" / "models.json").write_text("{}")
    (root / ".env").write_text("x")
    (root / "tianshu.db").write_bytes(b"x")
    monkeypatch.setattr(bk, "PROJECT_ROOT", root)
    monkeypatch.setattr(bk, "BACKUP_ROOT", tmp_path / "bk")
    name = bk.create_backup("t")
    bk.restore_backup(name, "models.json")
    log = next(audit_dir.glob("audit-*.log")).read_text(encoding="utf-8")
    assert "backup.create" in log and "backup.restore" in log