from __future__ import annotations

import asyncio

import pytest

from tianshu.core.identity import DEFAULT_IDENTITY_CARD, IDENTITY_FILE_ENV, load_identity_card


def test_default_card_contains_identity():
    assert "天枢" in DEFAULT_IDENTITY_CARD
    assert "身份" in DEFAULT_IDENTITY_CARD


def test_load_identity_uses_env_file(tmp_path, monkeypatch):
    f = tmp_path / "identity.md"
    f.write_text("自定义身份:我是天枢测试机", encoding="utf-8")
    monkeypatch.setenv(IDENTITY_FILE_ENV, str(f))
    assert load_identity_card() == "自定义身份:我是天枢测试机"


def test_load_identity_explicit_path_beats_env(tmp_path, monkeypatch):
    f1 = tmp_path / "identity.md"
    f2 = tmp_path / "other.md"
    f1.write_text("文件A", encoding="utf-8")
    f2.write_text("文件B", encoding="utf-8")
    monkeypatch.setenv(IDENTITY_FILE_ENV, str(f1))
    assert load_identity_card(str(f2)) == "文件B"


def test_load_identity_falls_back_to_builtin(tmp_path, monkeypatch):
    monkeypatch.setenv(IDENTITY_FILE_ENV, str(tmp_path / "nope.md"))
    assert load_identity_card() == DEFAULT_IDENTITY_CARD


@pytest.mark.asyncio
async def test_app_agents_all_carry_identity():
    from tianshu.app import create_app

    t = await asyncio.to_thread(create_app, provider_name="mock", review_mode="auto_approve")
    try:
        for a in t.agents.values():
            assert "身份卡片" in a.system_prompt, f"{a.name} 缺少身份卡片"
            assert "天枢" in a.system_prompt
    finally:
        pass