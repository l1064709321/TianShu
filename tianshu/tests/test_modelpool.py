from __future__ import annotations

import pytest

from tianshu.core.llm.base import LLMError, LLMMessage, LLMResult
from tianshu.core.modelpool import (
    PoolStore,
    default_catalog,
    is_auth_error,
    key_id,
    mask_key,
    pool_vendors,
)


@pytest.fixture
def store(tmp_path):
    return PoolStore(tmp_path / "models.json")


def test_catalog_contains_key_vendors():
    cat = default_catalog()
    for need in ("openai", "anthropic", "xai", "google", "deepseek", "qwen", "zhipu", "moonshot", "ollama", "agnes"):
        assert need in cat
        assert cat[need]["base_url"]
        assert cat[need]["models"]


def test_mock_vendor_marked_unsupported():
    assert default_catalog()["anthropic"]["supported"] is False


def test_key_id_and_mask():
    kid = key_id("sk-abc")
    assert len(kid) == 12
    assert mask_key("sk-abcdefgh1234") == "sk-abc...1234"
    assert mask_key("short") == "shor..."
    assert mask_key("x" * 9) == "xxxxxx...xxxx"


def test_store_add_remove_toggle(store):
    kid = store.add_key("openai", "sk-test-key-0001", "主key")
    assert kid == key_id("sk-test-key-0001")
    assert store.key_values("openai")[0]["value"] == "sk-test-key-0001"
    assert store.set_key_enabled("openai", kid, False)
    assert store.key_values("openai") == []
    assert store.remove_key("openai", kid)
    assert not store.remove_key("openai", kid)
    store.set_default("openai")
    assert store.data["default_vendor"] == "openai"
    store.set_preferred_key("openai", "pref-id")
    assert store.data["preferred_keys"]["openai"] == "pref-id"


def test_store_touch_status(store):
    kid = store.add_key("agnes", "sk-agnes-1")
    store.touch_key("agnes", kid, "expired", "401")
    assert store.key_values("agnes")[0]["status"] == "expired"


def test_store_persists_roundtrip(tmp_path):
    p = tmp_path / "models.json"
    s1 = PoolStore(p)
    s1.add_key("deepseek", "sk-dd-1", "a")
    s1.set_default("deepseek")
    s1.set_refreshed_models("deepseek", ["deepseek-chat", "deepseek-reasoner"])
    s2 = PoolStore(p)
    assert s2.data["default_vendor"] == "deepseek"
    assert s2.vendor("deepseek")["refreshed_models"] == ["deepseek-chat", "deepseek-reasoner"]


def test_asset_auth_error_detection():
    assert is_auth_error("LLM 请求失败 HTTP 401: invalid api key")
    assert is_auth_error("HTTP 403 forbidden")
    assert not is_auth_error("HTTP 500: server error")


class FakeBadProvider:
    def __init__(self, key):
        self._k = key
        self.usage_hook = None

    async def chat(self, messages, tools=None, **kwargs):
        if self._k.get("value") == "expired":
            raise LLMError("LLM 请求失败 HTTP 401: key 过期")
        return LLMResult(content="ok", usage=None)


@pytest.mark.asyncio
async def test_key_selector_rotates_expired(store):
    from tianshu.core.modelpool.service import KeySelectorProvider as KSP

    class KSP2(KSP):
        def _provider_for(self, key):
            return FakeBadProvider(key)

    store.add_key("openai", "expired", "死key")
    store.add_key("openai", "valid", "活key")
    keys = store.key_values("openai")
    sel = KSP2(
        name="openai", base_url="https://api.openai.com/v1", model="gpt-4o",
        keys=keys,
        preferred_key=keys[0]["id"],
    )
    sel.bind_store(store)
    result = await sel.chat([LLMMessage(role="user", content="hi")])
    assert result.content == "ok"
    assert sel.keys[0]["status"] == "expired"
    assert store.vendor("openai")["keys"][0]["status"] == "expired"


@pytest.mark.asyncio
async def test_key_selector_all_failed(store):
    from tianshu.core.modelpool.service import KeySelectorProvider as KSP

    class KSP2(KSP):
        def _provider_for(self, key):
            return FakeBadProvider(key)

    sel = KSP2(
        name="openai", base_url="https://api.openai.com/v1", model="gpt-4o",
        keys=[{"id": "dead", "value": "expired", "enabled": True, "status": "ok", "checked_at": 0}],
    )
    sel.bind_store(store)
    with pytest.raises(LLMError) as exc:
        await sel.chat([LLMMessage(role="user", content="hi")])
    assert "所有 Key 均失败" in str(exc.value)


def test_pool_vendors_views(store):
    store.add_key("agnes", "sk-agnes-view-1", "主key")
    store.set_default("agnes")
    vendors = pool_vendors(store)
    ag = next(v for v in vendors if v["key"] == "agnes")
    assert ag["connected"] is True
    assert ag["default"] is True
    assert "sk-agnes-view-1" not in (ag["keys"][0]["masked"] or "")
    assert ag["models"]