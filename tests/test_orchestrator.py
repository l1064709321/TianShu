from __future__ import annotations

import pytest

from tianshu.core.agent.runtime import Agent
from tianshu.core.llm.base import LLMResult, ToolCall
from tianshu.core.orchestrator.service import Orchestration, Orchestrator, _parse_plan


class PlanningProvider:
    def __init__(self) -> None:
        self.results: list[LLMResult] = []

    async def chat(self, messages, tools=None, **kwargs):
        return self.results.pop(0)


def test_parse_plan_from_tool_call():
    tc = ToolCall(id="1", name="produce_plan", arguments={"subtasks": [{"worker": "a", "goal": "x"}, {"worker": "b", "goal": "y"}]})
    result = LLMResult(content="", tool_calls=[tc])
    plan = _parse_plan("任务", result)
    assert len(plan.subtasks) == 2
    assert plan.subtasks[0].worker == "a"
    assert plan.subtasks[0].goal == "x"


def test_parse_plan_from_raw_json():
    result = LLMResult(content='{"subtasks": [{"worker": "c", "goal": "z"}]}')
    plan = _parse_plan("任务", result)
    assert plan.subtasks[0].worker == "c"


@pytest.mark.asyncio
async def test_orchestrator_dispatch_to_workers():
    class F:
        def __init__(self, results):
            self.results = results

        async def chat(self, messages, tools=None, **kwargs):
            return self.results.pop(0)

    plan_result = LLMResult(
        content="",
        tool_calls=[ToolCall(id="p", name="produce_plan", arguments={"subtasks": [{"worker": "w1", "goal": "加法"}, {"worker": "w2", "goal": "乘法"}]})],
    )

    async def make_agent(name):
        a = Agent(name=name, system_prompt="", provider_name="openai", base_url="http://x", model="m")
        a.provider = F([LLMResult(content=f"{name} 完成")])
        return a

    w1 = await make_agent("w1")
    w2 = await make_agent("w2")
    bus = w1.bus
    bus.register(w1)
    bus.register(w2)

    main = Agent(name="main", system_prompt="", provider_name="openai", base_url="http://x", model="m")
    main.provider = F([plan_result, LLMResult(content="汇总: 全部完成")])
    main.bus = bus
    bus.register(main)

    orch = Orchestrator(main, bus=bus, parallel=True)
    result = await orch.run("测试任务")
    assert isinstance(result, Orchestration)
    assert len(result.subtasks) == 2
    assert all(st.status in ("done",) for st in result.subtasks)
    assert result.summary == "汇总: 全部完成"