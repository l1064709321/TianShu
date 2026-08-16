from __future__ import annotations

import pytest

import tianshu.core.rollback as rb


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr(rb, "WS_DIR", ws)
    monkeypatch.setattr(rb, "SN_DIR", ws / ".ts-secrets")
    monkeypatch.setattr(rb, "SNAP_ROOT", ws / ".ts-snapshots")
    return ws


def test_auto_snapshot_backs_up_existing_file(sandbox):
    f = sandbox / "a.txt"
    f.write_text("old")
    snap = rb.auto_snapshot(f)
    assert snap is not None
    assert (rb.SNAP_ROOT / snap / "a.txt").read_text() == "old"


def test_auto_snapshot_skips_new_and_outside(sandbox, tmp_path):
    f = sandbox / "b.txt"
    assert rb.auto_snapshot(f) is None
    outside = tmp_path / "outside.txt"
    outside.write_text("x")
    assert rb.auto_snapshot(outside) is None


def test_restore_roundtrip(sandbox):
    f = sandbox / "doc.md"
    f.write_text("v1")
    rb.auto_snapshot(f)
    f.write_text("v2-broken")
    snaps_before = len(list(rb.SNAP_ROOT.glob("snap-*")))
    result = rb.restore_snapshot(rb.list_snapshots().splitlines()[-1].split("|")[0].strip(), "doc.md")
    assert f.read_text() == "v1"
    assert "自动备份" in result
    assert len(list(rb.SNAP_ROOT.glob("snap-*"))) == snaps_before + 1


def test_restore_rejects_outside_target(sandbox):
    rb.snapshot_all("init")
    with pytest.raises(PermissionError):
        rb.restore_snapshot(rb.list_snapshots().splitlines()[0].split("|")[0].strip(), "../escape")


def test_restore_unknown_snapshot(sandbox):
    with pytest.raises(FileNotFoundError):
        rb.restore_snapshot("snap-nope", "x.txt")


def test_restore_missing_file_in_snapshot(sandbox):
    rb.snapshot_all()
    snap = rb.list_snapshots().splitlines()[0].split("|")[0].strip()
    with pytest.raises(FileNotFoundError):
        rb.restore_snapshot(snap, "ghost.txt")


def test_snapshot_all_excludes_sensitive_and_git(sandbox):
    (sandbox / ".git").mkdir()
    (sandbox / ".git" / "HEAD").write_text("ref")
    (sandbox / ".ts-secrets").mkdir()
    (sandbox / ".ts-secrets" / "k").write_text("secret")
    (sandbox / "keep.txt").write_text("ok")
    result = rb.snapshot_all("manual")
    assert "1 个文件" in result
    snap_dir = rb.SNAP_ROOT / result.split("(")[0]
    snap_files = [str(f.relative_to(snap_dir)) for f in snap_dir.rglob("*") if f.is_file()]
    assert "keep.txt" in snap_files
    assert ".git/HEAD" not in snap_files
    assert ".ts-secrets/k" not in snap_files


def test_prune_keeps_max(sandbox, monkeypatch):
    monkeypatch.setattr(rb, "MAX_SNAPSHOTS", 3)
    for i in range(5):
        f = sandbox / "a.txt"
        f.write_text(f"v{i}")
        rb.auto_snapshot(f)
    assert len(list(rb.SNAP_ROOT.glob("snap-*"))) == 3


@pytest.mark.asyncio
async def test_write_file_tool_enables_agent_rollback(sandbox, monkeypatch):
    from tianshu.core.tools.builtin import register_builtin_tools
    from tianshu.core.tools.registry import ToolRegistry

    monkeypatch.setattr(rb, "SNAP_ROOT", sandbox / ".ts-snapshots")
    monkeypatch.setattr("tianshu.core.tools.builtin.WORKSPACE_DIR", sandbox)
    registry = ToolRegistry()
    register_builtin_tools(registry)
    p = sandbox / "report.md"
    p.write_text("good")
    await registry.get("write_file").func(path=str(p), content="bad content")
    assert p.read_text() == "bad content"
    assert registry.get("snapshot") and registry.get("rollback") and registry.get("list_snapshots")
    snaps = await registry.get("list_snapshots").func()
    assert "snap-" in snaps
    snap_name = snaps.splitlines()[0].split("|")[0].strip()
    await registry.get("rollback").func(snapshot_name=snap_name, target="report.md")
    assert p.read_text() == "good"