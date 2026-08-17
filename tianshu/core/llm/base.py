from __future__ import annotations

import json
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

Role = Literal["system", "user", "assistant", "tool"]


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass
class LLMMessage:
    role: Role
    content: str
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        if self.tool_calls:
            return {
                "role": self.role,
                "content": self.content or None,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                    }
                    for tc in self.tool_calls
                ],
            }
        if self.tool_call_id:
            return {"role": "tool", "tool_call_id": self.tool_call_id, "content": self.content}
        return {"role": self.role, "content": self.content}


@dataclass
class LLMResult:
    content: str | None
    tool_calls: list[ToolCall] | None = None
    usage: dict[str, int] | None = None
    reasoning: str | None = None

    @property
    def has_tool_calls(self) -> bool:
        return bool(self.tool_calls)


class LLMError(RuntimeError):
    pass


class BaseProvider(ABC):
    def __init__(self, base_url: str, api_key: str = "", model: str = "", temperature: float = 0.2, timeout: float = 120.0, max_tokens: int | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.temperature = temperature
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.usage_hook: Callable[[str, dict], None] | None = None

    @abstractmethod
    async def chat(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMResult: ...

    async def close(self) -> None:
        return None