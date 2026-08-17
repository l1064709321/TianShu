from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tianshu.core.llm.base import LLMError, LLMMessage, LLMResult
from tianshu.core.llm.dispatcher import (
    DispatchConfig,
    Dispatcher,
    MultiProviderChain,
    RoutingStrategy,
    create_dispatcher_from_providers,
)


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
    dispatcher.add_deployment("default", "p1", "http://localhost:9100/v1", "mock-model", api_key="k")
    with patch("tianshu.core.llm.dispatcher.create_provider") as mock_create:
        mock_create.return_value = _make_provider(success=True, result=_make_result("good"))
        result = await dispatcher.chat([LLMMessage(role="user", content="hi")])
        assert result.content == "good"


@pytest.mark.asyncio
async def test_dispatcher_weighted_failover():
    dispatcher = Dispatcher(DispatchConfig(enable_weighted_failover=True, num_retries=0))
    dispatcher.add_deployment("g1", "p1", "http://host1/v1", "m1", weight=1)
    dispatcher.add_deployment("g1", "p2", "http://host2/v1", "m2", weight=1)
    call_log = []

    async def mock_chat(messages, tools=None, cancel_event=None):
        call_log.append(1)
        if len(call_log) == 1:
            raise LLMError("host1 down")
        return _make_result("from_host2")

    p = MagicMock()
    p.chat = AsyncMock(side_effect=mock_chat)
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        result = await dispatcher.chat([LLMMessage(role="user", content="hi")])
        assert result.content == "from_host2"
        assert len(call_log) == 2


@pytest.mark.asyncio
async def test_dispatcher_all_fail():
    dispatcher = Dispatcher(DispatchConfig(num_retries=0))
    dispatcher.add_deployment("g1", "p1", "http://fail1/v1", "m1")
    p = MagicMock()
    p.chat = AsyncMock(side_effect=LLMError("connection refused"))
    with (
        patch("tianshu.core.llm.dispatcher.create_provider", return_value=p),
        pytest.raises(LLMError, match="所有模型组均失败"),
    ):
        await dispatcher.chat([LLMMessage(role="user", content="hi")])


@pytest.mark.asyncio
async def test_dispatcher_no_groups():
    dispatcher = Dispatcher()
    with pytest.raises(LLMError, match="无可用模型组"):
        await dispatcher.chat([LLMMessage(role="user", content="hi")])


@pytest.mark.asyncio
async def test_dispatcher_group_fallback():
    dispatcher = Dispatcher(DispatchConfig())
    dispatcher.add_deployment("primary", "p1", "http://host1/v1", "m1")
    dispatcher.add_deployment("backup", "p2", "http://host2/v1", "m2")
    dispatcher.add_fallback("primary", ["backup"])
    call_log = []

    async def mock_chat(messages, tools=None, cancel_event=None):
        call_log.append(1)
        if len(call_log) == 1:
            raise LLMError("primary down")
        return _make_result("from_backup")

    p = MagicMock()
    p.chat = AsyncMock(side_effect=mock_chat)
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        result = await dispatcher.chat([LLMMessage(role="user", content="hi")])
        assert result.content == "from_backup"


@pytest.mark.asyncio
async def test_dispatcher_cooldown():
    dispatcher = Dispatcher(DispatchConfig(enable_cooldowns=True, allowed_fails=1, cooldown_time=60, num_retries=0))
    dispatcher.add_deployment("g1", "p1", "http://host1/v1", "m1")
    dispatcher.add_deployment("g1", "p2", "http://host2/v1", "m2")
    call_log = []

    async def mock_chat(messages, tools=None, cancel_event=None):
        call_log.append(1)
        raise LLMError("always fail")

    p = MagicMock()
    p.chat = AsyncMock(side_effect=mock_chat)
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        with pytest.raises(LLMError):
            await dispatcher.chat([LLMMessage(role="user", content="hi")])
        stats = await dispatcher.get_stats()
        cooldown_deps = [d for d in stats["deployments"] if d["cooldown"]]
        assert len(cooldown_deps) > 0, "应有部署进入冷却"


@pytest.mark.asyncio
async def test_dispatcher_latency_based():
    dispatcher = Dispatcher(DispatchConfig(routing_strategy=RoutingStrategy.LATENCY_BASED, num_retries=0))
    dispatcher.add_deployment("g1", "fast", "http://fast/v1", "m")
    dispatcher.add_deployment("g1", "slow", "http://slow/v1", "m")
    dispatcher._deployments["fast"].avg_latency_ms = 50.0
    dispatcher._deployments["slow"].avg_latency_ms = 5000.0
    picked = []

    def side_effect(name, *args, **kwargs):
        p = MagicMock()
        async def chat(messages, tools=None, cancel_event=None):
            picked.append(name)
            return _make_result(name)
        p.chat = AsyncMock(side_effect=chat)
        return p

    with patch("tianshu.core.llm.dispatcher.create_provider", side_effect=side_effect):
        await dispatcher.chat([LLMMessage(role="user", content="a")])
        await dispatcher.chat([LLMMessage(role="user", content="b")])
        assert picked == ["fast", "fast"], "延迟策略应始终选择最低延迟部署"


@pytest.mark.asyncio
async def test_dispatcher_cost_based():
    dispatcher = Dispatcher(DispatchConfig(routing_strategy=RoutingStrategy.COST_BASED, num_retries=0))
    dispatcher.add_deployment("g1", "expensive", "http://e/v1", "m", input_cost_per_1m=10.0)
    dispatcher.add_deployment("g1", "cheap", "http://c/v1", "m", input_cost_per_1m=0.1)
    p = MagicMock()
    p.chat = AsyncMock(return_value=_make_result("ok"))
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        await dispatcher.chat([LLMMessage(role="user", content="a")])
        await dispatcher.chat([LLMMessage(role="user", content="b")])
        stats = await dispatcher.get_stats()
        deps = {d["name"]: d for d in stats["deployments"]}
        assert deps["cheap"]["total_requests"] > 0
        assert deps["expensive"]["total_requests"] == 0


@pytest.mark.asyncio
async def test_dispatcher_context_window_fallback():
    dispatcher = Dispatcher(DispatchConfig(num_retries=0))
    dispatcher.add_deployment("big", "p1", "http://host1/v1", "m1")
    dispatcher.add_deployment("long", "p2", "http://host2/v1", "m2")
    dispatcher.add_context_window_fallback("big", ["long"])
    call_log = []

    async def mock_chat(messages, tools=None, cancel_event=None):
        call_log.append(1)
        if len(call_log) == 1:
            raise LLMError("ContextWindowExceededError: too long")
        return _make_result("from_long")

    p = MagicMock()
    p.chat = AsyncMock(side_effect=mock_chat)
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        result = await dispatcher.chat([LLMMessage(role="user", content="hi" * 1000)])
        assert result.content == "from_long"
        assert len(call_log) == 2


def test_create_dispatcher_from_providers():
    providers = [
        {"name": "deepseek", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat", "api_key": "k", "weight": 3},
        {"name": "qwen", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-max", "api_key": "k2", "weight": 2},
    ]
    d = create_dispatcher_from_providers(providers, strategy="simple-shuffle")
    deps = d.list_deployments()
    assert len(deps) == 2
    assert deps[0]["name"] == "deepseek"
    assert deps[0]["weight"] == 3


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
    dispatcher.add_deployment("g1", "p1", "http://host1/v1", "m1")
    p = MagicMock()
    p.chat = AsyncMock(return_value=_make_result("ok"))
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        await dispatcher.chat([LLMMessage(role="user", content="a")])
        await dispatcher.chat([LLMMessage(role="user", content="b")])
        stats = await dispatcher.get_stats()
        deps = {d["name"]: d for d in stats["deployments"]}
        assert deps["p1"]["total_requests"] == 2
        assert deps["p1"]["success_count"] == 2


@pytest.mark.asyncio
async def test_dispatcher_disable_deployment():
    dispatcher = Dispatcher()
    dispatcher.add_deployment("g1", "p1", "http://host1/v1", "m1")
    dispatcher.add_deployment("g1", "p2", "http://host2/v1", "m2")
    await dispatcher.disable_deployment("p1")
    p = MagicMock()
    p.chat = AsyncMock(return_value=_make_result("ok"))
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        await dispatcher.chat([LLMMessage(role="user", content="a")])
        stats = await dispatcher.get_stats()
        deps = {d["name"]: d for d in stats["deployments"]}
        assert deps["p1"]["total_requests"] == 0
        assert deps["p2"]["total_requests"] == 1


@pytest.mark.asyncio
async def test_dispatcher_usage_based():
    dispatcher = Dispatcher(DispatchConfig(routing_strategy=RoutingStrategy.USAGE_BASED, num_retries=0))
    dispatcher.add_deployment("g1", "a", "http://a/v1", "m", rpm=100)
    dispatcher.add_deployment("g1", "b", "http://b/v1", "m", rpm=10)
    p = MagicMock()
    p.chat = AsyncMock(return_value=_make_result("ok"))
    with patch("tianshu.core.llm.dispatcher.create_provider", return_value=p):
        await dispatcher.chat([LLMMessage(role="user", content="a")])
        stats = await dispatcher.get_stats()
        deps = {d["name"]: d for d in stats["deployments"]}
        assert deps["a"]["total_requests"] + deps["b"]["total_requests"] == 1