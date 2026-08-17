from __future__ import annotations

from pathlib import Path

from tianshu.core.skills.repository import SkillRepository, _parse_frontmatter


def test_parse_frontmatter():
    text = "---\nname: foo\ndescription: 测试\n---\n\n正文内容"
    meta, body = _parse_frontmatter(text)
    assert meta["name"] == "foo"
    assert meta["description"] == "测试"
    assert body == "正文内容"


def test_repo_scan(tmp_path: Path):
    (tmp_path / "chat").mkdir()
    (tmp_path / "chat" / "SKILL.md").write_text(
        "---\nname: chat\ndescription: 聊天\n---\n# 聊天\n指令", encoding="utf-8"
    )
    repo = SkillRepository(tmp_path)
    repo.scan()
    assert "chat" in [s.name for s in repo.list()]
    skill = repo.get("chat")
    assert skill is not None
    assert skill.description == "聊天"
    assert "指令" in skill.instructions


def test_repo_empty(tmp_path: Path):
    repo = SkillRepository(tmp_path / "missing")
    repo.scan()
    assert repo.list() == []
    assert repo.get("x") is None