from __future__ import annotations

import pytest

from tianshu.core.agent.runtime import Agent, AgentResult, MessageBus, build_agent_call_tool
from tianshu.core.tools.registry import Tool, ToolRegistry


class FakeProvider:
    def __init__(self) -> None:
        self.scenario: list[dict] = []

    async def chat(self, messages, tools=None, **kwargs):
        step = self.scenario.pop(0)
        from tianshu.core.llm.base import LLMResult, ToolCall

        calls = None
        if step.get("tool"):
            calls = [ToolCall(id=f"c{len(self.scenario)}", name=step["tool"]["name"], arguments=step["tool"]["arguments"])]
        return LLMResult(content=step.get("content"), tool_calls=calls)


def make_agent(name: str, bus: MessageBus, tools: list) -> Agent:
    registry = ToolRegistry()
    for name_, func, desc in tools:
        registry.register(
            Tool(name=name_, description=desc, func=func)
        )
    agent = Agent(name=name, system_prompt="", provider_name="openai", base_url="http://x", model="m")
    agent.registry = registry
    agent.bus = bus
    agent.provider = FakeProvider()
    return agent


@pytest.mark.asyncio
async def test_agent_calls_child_via_bus():
    bus = MessageBus()

    async def add(a: int, b: int) -> int:
        return a + b

    worker_registry = ToolRegistry()

    def reg(registry, name, fn, desc):
        registry.register(Tool(name=name, description=desc, func=fn))

    reg(worker_registry, "add", add, "加法")
    worker = Agent(name="math", system_prompt="", provider_name="openai", base_url="http://x", model="m")
    worker.registry = worker_registry
    worker.provider = FakeProvider()
    worker.bus = bus

    main_registry = ToolRegistry()
    main_registry.register(build_agent_call_tool(bus))
    main = Agent(name="main", system_prompt="", provider_name="openai", base_url="http://x", model="m")
    main.registry = main_registry
    main.provider = FakeProvider()
    main.bus = bus

    bus.register(worker)
    bus.register(main)

    main.provider.scenario = [
        {"tool": {"name": "call_agent", "arguments": {"agent": "math", "task": "2+3"}}},
        {"content": "答案 5"},
    ]
    worker.provider.scenario = [{"tool": {"name": "add", "arguments": {"a": 2, "b": 3}}}, {"content": "答案 5"}]

    result = await main.handle_message("计算 2+3")
    assert isinstance(result, AgentResult)
    assert "答案 5" in result.content, result
    assert result.child_agents == ["math"]


@pytest.mark.asyncio
async def test_agent_direct_tool():
    async def greet(name: str) -> str:
        return f"hello {name}"

    registry = ToolRegistry()
    registry.register(Tool(name="greet", description="打招呼", func=greet))
    agent = Agent(name="a", system_prompt="", provider_name="openai", base_url="http://x", model="m")
    agent.registry = registry
    agent.provider = FakeProvider()
    agent.provider.scenario = [{"tool": {"name": "greet", "arguments": {"name": "world"}}}, {"content": "完成"}]

    result = await agent.handle_message("hi")
    assert result.content == "完成"
    assert result.tool_calls[0].name == "greet"
    assert result.tool_calls[0].output == "hello world"