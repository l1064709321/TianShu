from __future__ import annotations

import json

import httpx
import pytest
import respx

from tianshu.core.llm.base import LLMMessage
from tianshu.core.llm.factory import create_provider


def chat_response(content: str | None = None, tool_calls: list[dict] | None = None) -> dict:
    msg: dict = {}
    if content is not None:
        msg["content"] = content
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


@respx.mock
@pytest.mark.asyncio
async def test_plain_chat_request_format():
    """验证请求体包含 model、system 消息、auth 头。"""
    url = "https://custom.example.com/v1/chat/completions"
    respx.post(url).mock(return_value=httpx.Response(200, json=chat_response(content="你好")))
    provider = create_provider("custom", "https://custom.example.com/v1", "my-model", "sk-abc", max_tokens=4096)

    result = await provider.chat(
        [
            LLMMessage(role="system", content="你是助手"),
            LLMMessage(role="user", content="hello"),
        ]
    )

    request = respx.calls.last.request
    body = json.loads(request.content)
    assert body["model"] == "my-model"
    assert body["max_tokens"] == 4096
    assert body["messages"][0] == {"role": "system", "content": "你是助手"}
    assert body["messages"][1] == {"role": "user", "content": "hello"}
    assert request.headers["Authorization"] == "Bearer sk-abc"
    assert result.content == "你好"
    assert result.usage["total_tokens"] == 15


@respx.mock
@pytest.mark.asyncio
async def test_tool_call_round_trip():
    """验证工具调用解析与参数回传。"""
    url = "https://api.vendor.com/v1/chat/completions"
    respx.post(url).mock(
        return_value=httpx.Response(
            200,
            json=chat_response(
                tool_calls=[
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "fetch_url", "arguments": '{"url": "https://a.com"}'},
                    }
                ]
            ),
        )
    )
    provider = create_provider("custom", "https://api.vendor.com/v1", "v-model", "sk-x")

    result = await provider.chat([LLMMessage(role="user", content="go")], tools=[{"type": "function"}])

    assert result.has_tool_calls
    tc = result.tool_calls[0]
    assert tc.id == "call_1"
    assert tc.name == "fetch_url"
    assert tc.arguments == {"url": "https://a.com"}


@respx.mock
@pytest.mark.asyncio
async def test_ollama_no_auth_header():
    """Ollama 本地服务不应带 Authorization 头。"""
    url = "http://localhost:11434/v1/chat/completions"
    respx.post(url).mock(return_value=httpx.Response(200, json=chat_response(content="ok")))
    provider = create_provider("ollama", "http://localhost:11434/v1", "qwen2.5")

    await provider.chat([LLMMessage(role="user", content="hi")])

    assert "Authorization" not in respx.calls.last.request.headers


@respx.mock
@pytest.mark.asyncio
async def test_http_error_raises_llm_error():
    respx.post("https://api.x.com/v1/chat/completions").mock(
        return_value=httpx.Response(401, text='{"error": "bad key"}')
    )
    provider = create_provider("custom", "https://api.x.com/v1", "m", "sk-bad")
    from tianshu.core.llm.base import LLMError

    with pytest.raises(LLMError, match="401"):
        await provider.chat([LLMMessage(role="user", content="hi")])


@respx.mock
@pytest.mark.asyncio
async def test_malformed_arguments_fallback_empty():
    url = "https://api.x.com/v1/chat/completions"
    respx.post(url).mock(
        return_value=httpx.Response(
            200,
            json=chat_response(
                tool_calls=[
                    {"id": "c", "type": "function", "function": {"name": "t", "arguments": "{bad json"}}
                ]
            ),
        )
    )
    provider = create_provider("custom", "https://api.x.com/v1", "m", "")
    result = await provider.chat([LLMMessage(role="user", content="go")])
    assert result.tool_calls[0].arguments == {}