from __future__ import annotations

import pytest

import tianshu.core.access as acc
from tianshu.core.tools.builtin import _inside_allowed, run_shell_guarded


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setattr("tianshu.core.access.ACCESS_FILE", tmp_path / "access_roots.json")
    monkeypatch.setattr("tianshu.core.tools.builtin.WORKSPACE_DIR", ws)
    monkeypatch.setattr("tianshu.core.tools.builtin.SENSITIVE_DIR", ws / ".ts-secrets")
    return ws


def test_default_deny_outside_workspace(sandbox, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    assert _inside_allowed(sandbox / "a.txt")
    assert _inside_allowed(sandbox / ".ts-secrets" / "k")
    assert not _inside_allowed(outside / "a.txt")
    assert not _inside_allowed(tmp_path)


def test_grant_then_check(sandbox, tmp_path):
    outside = tmp_path / "granted"
    outside.mkdir()
    acc.add_root(str(outside))
    assert _inside_allowed(outside)
    assert _inside_allowed(outside / "deep" / "file.txt")
    inside = tmp_path / "other"
    inside.mkdir()
    assert not _inside_allowed(inside / "f")


def test_add_requires_existing_dir(sandbox, tmp_path):
    with pytest.raises(ValueError):
        acc.add_root(str(tmp_path / "missing"))
    f = tmp_path / "afile"
    f.write_text("x")
    with pytest.raises(ValueError):
        acc.add_root(str(f))


def test_dup_add_and_remove(sandbox, tmp_path):
    d = tmp_path / "d"
    d.mkdir()
    acc.add_root(str(d))
    with pytest.raises(ValueError):
        acc.add_root(str(d))
    acc.remove_root(str(d), scope="global")
    assert acc.list_roots() == []
    assert not _inside_allowed(d / "x")
    with pytest.raises(ValueError):
        acc.remove_root(str(d), scope="global")


def test_persistence_roundtrip(sandbox, tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    acc.add_root(str(d))
    assert acc.ACCESS_FILE.exists()
    assert any(item["path"] == str(d) for item in acc.list_roots())


def test_shell_path_args_respect_grant(sandbox, tmp_path):
    outside = tmp_path / "data"
    outside.mkdir()
    (outside / "x.txt").write_text("hello")
    with pytest.raises(PermissionError):
        import asyncio

        asyncio.run(run_shell_guarded("cat x.txt", cwd=outside))
    acc.add_root(str(outside))
    import asyncio

    out = asyncio.run(run_shell_guarded("cat x.txt", cwd=outside))
    assert "hello" in out


def test_session_scope_visibility(sandbox, tmp_path):
    d1 = tmp_path / "d1"
    d2 = tmp_path / "d2"
    d1.mkdir()
    d2.mkdir()
    acc.add_root(str(d1), scope="global")
    acc.add_root(str(d2), scope="session:abc")
    assert _inside_allowed(d1)
    assert not _inside_allowed(d2)
    acc.set_current_session("abc")
    assert _inside_allowed(d1)
    assert _inside_allowed(d2)
    acc.set_current_session("other")
    assert _inside_allowed(d1)
    assert not _inside_allowed(d2)


def test_session_scope_list_and_remove(sandbox, tmp_path):
    d = tmp_path / "sd"
    d.mkdir()
    acc.add_root(str(d), scope="session:s1")
    assert acc.list_roots() == [{"path": str(d), "scope": "session:s1"}]
    with pytest.raises(ValueError):
        acc.remove_root(str(d), scope="global")
    acc.remove_root(str(d), scope="session:s1")
    assert acc.list_roots() == []


def test_invalid_scope_rejected(sandbox):
    with pytest.raises(ValueError):
        acc.add_root("/tmp", scope="foo")