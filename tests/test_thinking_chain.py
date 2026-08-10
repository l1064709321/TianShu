from __future__ import annotations

import asyncio
import httpx
import respx

from tianshu.core.llm.base import LLMMessage
from tianshu.core.llm.factory import create_provider


def test_openai_provider_parses_reasoning(respx_mock):
    respx_mock.post("https://test-llm.example/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "答案",
                            "reasoning_content": "我先分析问题,然后基于已有信息给出答案",
                        }
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )
    )
    p = create_provider("future-vendor-xyz", "https://test-llm.example/v1", "m", "")
    result = asyncio.run(p.chat([LLMMessage(role="user", content="hi")]))
    assert result.reasoning == "我先分析问题,然后基于已有信息给出答案"


def test_openai_provider_reasoning_none_when_missing(respx_mock):
    respx_mock.post("https://test-llm2.example/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": "答案"}}]})
    )
    p = create_provider("future-vendor-xyz", "https://test-llm2.example/v1", "m", "")
    result = asyncio.run(p.chat([LLMMessage(role="user", content="hi")]))
    assert result.reasoning is None


def test_mock_llm_returns_reasoning_content():
    from fastapi.testclient import TestClient

    from tianshu.interfaces.web.mock_llm import app

    client = TestClient(app)
    resp = client.post(
        "/v1/chat/completions",
        json={"model": "m", "messages": [{"role": "user", "content": "你好"}]},
    )
    data = resp.json()
    assert data["choices"][0]["message"]["reasoning_content"]


async def test_agent_emits_thinking_event():
    from tianshu.core.agent.runtime import Agent

    emitted = []

    class FakeProvider:
        def __init__(self):
            self.calls = 0

        async def chat(self, messages, tools=None, **kwargs):
            self.calls += 1
            from tianshu.core.llm.base import LLMResult, ToolCall

            if self.calls == 1:
                return LLMResult(
                    content="",
                    reasoning="我在思考第一步",
                    tool_calls=[ToolCall(id="a", name="no_such_tool", arguments={})],
                )
            return LLMResult(content="完成", reasoning="思考完毕,输出答案")

    async def sink(name, event, data):
        emitted.append((name, event, data))

    agent = Agent(
        name="t",
        system_prompt="sys",
        provider_name="x",
        event_sink=sink,
    )
    agent.provider = FakeProvider()
    result = await agent.handle_message("任务")
    assert result.content == "完成"
    thinking = [e for e in emitted if e[1] == "thinking"]
    assert len(thinking) == 2
    assert thinking[0][2]["content"] == "我在思考第一步"
    assert thinking[1][2]["agent"] == "t"