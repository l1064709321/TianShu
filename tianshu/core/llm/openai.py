from __future__ import annotations

import asyncio
from typing import Any

import httpx

from tianshu.core.llm.base import BaseProvider, LLMError, LLMMessage, LLMResult, ToolCall
from tianshu.core.log import get_logger

logger = get_logger("llm.openai")


class OpenAIProvider(BaseProvider):
    async def chat(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        try:
            result = await self._chat_impl(messages, tools, **kwargs)
        except LLMError as e:
            logger.error("LLM 调用失败 model=%s error=%s", self.model, e)
            raise
        if self.usage_hook and result.usage:
            try:
                self.usage_hook(self.model, result.usage)
            except Exception:  # noqa: BLE001
                logger.exception("usage_hook 异常 model=%s", self.model)
        return result

    async def _chat_impl(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        cancel_event = kwargs.pop("cancel_event", None)
        payload: dict[str, Any] = {
            "model": kwargs.pop("model", self.model),
            "messages": [m.to_dict() for m in messages],
            "temperature": kwargs.pop("temperature", self.temperature),
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = kwargs.pop("tool_choice", "auto")
        if self.max_tokens:
            payload["max_tokens"] = self.max_tokens
        payload.update(kwargs)

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                if cancel_event is not None:
                    if cancel_event.is_set():
                        raise LLMError("请求已取消")
                    done, pending = await asyncio.wait(
                        {
                            asyncio.create_task(client.post(f"{self.base_url}/chat/completions", json=payload, headers=headers)),
                            asyncio.create_task(cancel_event.wait()),
                        },
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for t in pending:
                        t.cancel()
                    finished = done.pop()
                    try:
                        resp = finished.result()
                    except asyncio.CancelledError:
                        raise LLMError("请求已取消") from None
                    if cancel_event.is_set():
                        raise LLMError("请求已取消")
                else:
                    resp = await client.post(f"{self.base_url}/chat/completions", json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except asyncio.CancelledError:
            raise LLMError("请求已取消") from None
        except httpx.HTTPStatusError as e:
            raise LLMError(f"LLM 请求失败 HTTP {e.response.status_code}: {e.response.text[:500]}") from e
        except httpx.HTTPError as e:
            raise LLMError(f"LLM 网络错误: {e}") from e

        if "choices" not in data or not data["choices"]:
            raise LLMError(f"LLM 响应缺失 choices: {data}")

        choice = data["choices"][0]
        msg = choice.get("message", {})
        content = msg.get("content")
        tool_calls = None
        raw_calls = msg.get("tool_calls") or []
        if raw_calls:
            tool_calls = []
            for tc in raw_calls:
                fn = tc.get("function", {})
                try:
                    import json

                    arguments = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                tool_calls.append(ToolCall(id=tc.get("id", ""), name=fn.get("name", ""), arguments=arguments))

        return LLMResult(
            content=content,
            tool_calls=tool_calls,
            usage=data.get("usage"),
        )