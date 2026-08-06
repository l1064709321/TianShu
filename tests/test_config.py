from __future__ import annotations

import pytest

from tianshu.config import LLMProviderConfig, get_provider
from tianshu.core.llm.factory import available_providers, create_provider


def test_aggregator_and_selfhost_providers_in_pool():
    names = available_providers()
    for expected in ["openrouter", "siliconflow", "fireworks", "together", "perplexity", "oneapi", "newapi", "litellm", "vllm", "sglang", "lmstudio"]:
        assert expected in names


def test_aggregator_creates_openai_provider():
    p = create_provider("openrouter", "https://openrouter.ai/api/v1", "deepseek/deepseek-chat", "sk-x")
    assert p.base_url == "https://openrouter.ai/api/v1"
    assert p.model == "deepseek/deepseek-chat"


def test_unknown_name_falls_back_to_openai_compatible():
    p = create_provider("future-vendor-xyz", "https://api.xyz.com/v1", "m", "")
    from tianshu.core.llm.openai import OpenAIProvider

    assert isinstance(p, OpenAIProvider)


def test_provider_config_defaults():
    cfg = LLMProviderConfig()
    assert cfg.name == "mock"
    assert cfg.base_url == "http://localhost:9100/v1"
    assert cfg.model == "mock-model"
    assert cfg.timeout == 120.0


def test_custom_provider_config():
    cfg = LLMProviderConfig(
        name="myvendor",
        base_url="https://api.myvendor.com/v1",
        api_key="sk-custom",
        model="my-model",
        max_tokens=8192,
        temperature=0.1,
    )
    assert cfg.max_tokens == 8192
    assert cfg.temperature == 0.1
    assert not cfg.model_config


def test_get_provider_by_name(monkeypatch):
    from tianshu.config import settings

    cfg = LLMProviderConfig(name="pool_a", base_url="https://a.com/v1", api_key="k", model="m-a")
    cfg2 = LLMProviderConfig(name="pool_b", base_url="https://b.com/v1", api_key="k2", model="m-b")
    original = settings.providers
    settings.providers = [cfg, cfg2]
    try:
        assert get_provider("pool_b").base_url == "https://b.com/v1"
        assert get_provider("pool_a").model == "m-a"
    finally:
        settings.providers = original


def test_get_provider_missing(monkeypatch):
    from tianshu.config import settings

    original = settings.providers
    settings.providers = []
    try:
        with pytest.raises(KeyError):
            get_provider("nope")
    finally:
        settings.providers = original