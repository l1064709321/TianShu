from __future__ import annotations

import pytest

from tianshu.config import SKILLS_DIR
from tianshu.core.agent.runtime import Agent, MessageBus, ToolCall
from tianshu.core.llm.base import LLMResult
from tianshu.core.skills.repository import SkillRepository
from tianshu.core.tools.registry import Tool, ToolRegistry


class FakeProvider:
    def __init__(self, turns: list[list[ToolCall]]) -> None:
        self.turns = turns
        self.usage_hook = None

    async def chat(self, history, tools=None, cancel_event=None):
        if self.turns:
            return LLMResult(content="", tool_calls=self.turns.pop(0))
        return LLMResult(content="done", tool_calls=[])


def _agent_with_echo(turns):
    registry = ToolRegistry()

    async def echo(x: int = 0) -> str:
        return f"ok:{x}"

    registry.register(Tool(name="echo", description="echo", func=echo))
    agent = Agent(
        name="test",
        system_prompt="p",
        provider_name="mock",
        model="m",
        base_url="http://x",
        api_key="",
        registry=registry,
        bus=MessageBus(),
        max_iterations=10,
    )
    agent.provider = FakeProvider(turns)
    return agent


@pytest.mark.asyncio
async def test_duplicate_call_intercepted():
    dup = ToolCall(id="c1", name="echo", arguments={"x": 1})
    agent = _agent_with_echo([[dup], [dup]])
    result = await agent.handle_message("hi")
    errors = [t.error or "" for t in result.tool_calls]
    assert any("死循环" in e for e in errors)
    assert any("重复调用" in e for e in errors)


@pytest.mark.asyncio
async def test_same_tool_different_args_allowed():
    a = ToolCall(id="c1", name="echo", arguments={"x": 1})
    b = ToolCall(id="c2", name="echo", arguments={"x": 2})
    agent = _agent_with_echo([[a], [b]])
    result = await agent.handle_message("hi")
    assert all(not t.error for t in result.tool_calls)


def test_judge_skill_registered():
    repo = SkillRepository(SKILLS_DIR)
    repo.scan()
    names = [s.name for s in repo.list()]
    assert "judge" in names
    descs = "\n".join(s.description or "" for s in repo.list())
    assert "一致性" in descs