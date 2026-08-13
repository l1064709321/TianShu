from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tianshu.core.llm.dispatcher import (
    DispatchConfig,
    Dispatcher,
    MultiProviderChain,
    create_dispatcher_from_providers,
)
from tianshu.core.llm.base import LLMMessage, LLMResult, LLMError


def _make_result(content: str = "ok") -> LLMResult:
    return LLMResult(content=content)


def _make_provider(success: bool = True, result: LLMResult | None = None, error: str | None = None):
    p = MagicMock()
    p.chat = AsyncMock()
    if error:
        p.chat.side_effect = LLMError(error)
    elif result is not None:
        p.chat.return_value = result
    else:
        p.chat.return_value = _make_result("fallback")
    return p


@pytest.mark.asyncio
async def test_dispatcher_single_endpoint_success():
    dispatcher = Dispatcher(DispatchConfig())
    dispatcher.add_endpoint("p1", "http://localhost:9100/v1", "mock-model", api_key="k")
    with patch("tianshu.core.llm.dispatcher.create_provider") as mock_create:
        mock_create.return_value = _make_provider(success=True, result=_make_result("good"))
        result = await dispatcher.chat([LLMMessage(role="user", content="hi")])
        assert result.content == "good"
        mock_create.assert_called_once()


@pytest.mark.asyncio
async def test_dispatcher_fallback_on_failure():
    dispatcher = Dispatcher(DispatchConfig(fallback_enabled=True, max_retries=1))
    dispatcher.add_endpoint("p1", "http://host1/v1", "m1")
    dispatcher.add_endpoint("p2", "http://host2/v1", "m2")
    call_count = 0

    async def mock_chat(messages, tools=None, cancel_event=None):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise LLMError("host1 down")
        return _make_result("from_host2")

    with patch("tianshu.core.llm.dispatcher.create_provider") as mock_create:
        p = MagicMock()
        p.chat = AsyncMock(side_effect=mock_chat)
        mock_create.return_value = p
        result = await dispatcher.chat([LLMMessage(role="user", content="hi")])
        assert result.content == "from_host2"
        assert call_count == 2


@pytest.mark.asyncio
async def test_dispatcher_all_fail():
    dispatcher = Dispatcher(DispatchConfig(max_retries=0))
    dispatcher.add_endpoint("p1", "http://fail1/v1", "m1")
    with patch("tianshu.core.llm.dispatcher.create_provider") as mock_create:
        mock_create.return_value = _make_provider(error="connection refused")
        with pytest.raises(LLMError, match="所有端点均失败"):
            await dispatcher.chat([LLMMessage(role="user", content="hi")])


@pytest.mark.asyncio
async def test_dispatcher_no_endpoints():
    dispatcher = Dispatcher()
    with pytest.raises(LLMError, match="无可用端点"):
        await dispatcher.chat([LLMMessage(role="user", content="hi")])


@pytest.mark.asyncio
async def test_dispatcher_disable_endpoint():
    dispatcher = Dispatcher()
    dispatcher.add_endpoint("p1", "http://host1/v1", "m1")
    dispatcher.add_endpoint("p2", "http://host2/v1", "m2")
    await dispatcher.disable_endpoint("p1")
    status = await dispatcher.get_stats()
    assert status["endpoints"][0]["enabled"] is False
    assert status["endpoints"][1]["enabled"] is True


@pytest.mark.asyncio
async def test_dispatcher_round_robin():
    dispatcher = Dispatcher(DispatchConfig(strategy="round_robin"))
    dispatcher.add_endpoint("a", "http://a/v1", "m")
    dispatcher.add_endpoint("b", "http://b/v1", "m")
    order = []

    async def mock_chat(messages, tools=None, cancel_event=None):
        host = messages[0].content if messages else ""
        order.append(host)
        return _make_result("ok")

    with patch("tianshu.core.llm.dispatcher.create_provider") as mock_create:
        p = MagicMock()
        p.chat = AsyncMock(side_effect=mock_chat)
        mock_create.return_value = p
        await dispatcher.chat([LLMMessage(role="user", content="a")])
        await dispatcher.chat([LLMMessage(role="user", content="b")])
        assert len(order) == 2


@pytest.mark.asyncio
async def test_dispatcher_health_check():
    dispatcher = Dispatcher(DispatchConfig(failure_threshold=1, health_check_interval=0))
    dispatcher.add_endpoint("p1", "http://host1/v1", "m1")
    call_count = 0

    async def mock_chat(messages, tools=None, cancel_event=None):
        nonlocal call_count
        call_count += 1
        raise LLMError("always fail")

    with patch("tianshu.core.llm.dispatcher.create_provider") as mock_create:
        p = MagicMock()
        p.chat = AsyncMock(side_effect=mock_chat)
        mock_create.return_value = p
        with pytest.raises(LLMError, match="所有端点均失败"):
            await dispatcher.chat([LLMMessage(role="user", content="hi")])
        status = await dispatcher.get_stats()
        assert status["endpoints"][0]["consecutive_failures"] == 1
        assert status["endpoints"][0]["enabled"] is False


def test_create_dispatcher_from_providers():
    providers = [
        {"name": "deepseek", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat", "api_key": "k", "weight": 3},
        {"name": "qwen", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-max", "api_key": "k2", "weight": 2},
    ]
    d = create_dispatcher_from_providers(providers, strategy="weighted")
    eps = d.list_endpoints()
    assert len(eps) == 2
    assert eps[0]["name"] == "deepseek"
    assert eps[0]["weight"] == 3


@pytest.mark.asyncio
async def test_multi_provider_chain():
    chain = MultiProviderChain([])
    call_order = []

    async def primary_chat(messages, tools=None, cancel_event=None):
        call_order.append("primary")
        raise LLMError("primary unavailable")

    async def secondary_chat(messages, tools=None, cancel_event=None):
        call_order.append("secondary")
        return _make_result("from_secondary")

    chain._providers = {
        "primary": MagicMock(chat=AsyncMock(side_effect=primary_chat)),
        "secondary": MagicMock(chat=AsyncMock(side_effect=secondary_chat)),
    }
    result = await chain.chat([LLMMessage(role="user", content="hi")])
    assert result.content == "from_secondary"
    assert call_order == ["primary", "secondary"]


@pytest.mark.asyncio
async def test_multi_provider_chain_all_fail():
    chain = MultiProviderChain([])
    chain._providers = {
        "p1": MagicMock(chat=AsyncMock(side_effect=LLMError("all down"))),
    }
    with pytest.raises(LLMError, match="所有 Provider 均失败"):
        await chain.chat([LLMMessage(role="user", content="hi")])


@pytest.mark.asyncio
async def test_dispatcher_stats_tracking():
    dispatcher = Dispatcher(DispatchConfig())
    dispatcher.add_endpoint("p1", "http://host1/v1", "m1")
    with patch("tianshu.core.llm.dispatcher.create_provider") as mock_create:
        mock_create.return_value = _make_provider(success=True, result=_make_result("ok"))
        await dispatcher.chat([LLMMessage(role="user", content="a")])
        await dispatcher.chat([LLMMessage(role="user", content="b")])
        stats = await dispatcher.get_stats()
        assert stats["stats"]["p1"]["success"] == 2
