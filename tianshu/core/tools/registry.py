from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, create_model

RAW: str = "RAW"

ToolFn = Callable[..., Awaitable[Any] | Any]


@dataclass
class Tool:
    name: str
    description: str
    func: ToolFn
    parameters: dict[str, Any] = field(default_factory=dict)
    format_result: str = "json"
    requires_review: bool = False

    @property
    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters or {"type": "object", "properties": {}},
            },
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def list(self) -> list[Tool]:
        return list(self._tools.values())

    def schemas(self) -> list[dict[str, Any]]:
        return [t.schema for t in self._tools.values()]

    def decorator(self, name: str, description: str = "", format_result: str = "json", requires_review: bool = False):
        def wrap(fn: ToolFn) -> ToolFn:
            model = _build_parameter_model(fn)
            tool = Tool(
                name=name,
                description=description or fn.__doc__ or "",
                func=fn,
                parameters=model.model_json_schema(),
                format_result=format_result,
                requires_review=requires_review,
            )
            self._tools[name] = tool
            return fn

        return wrap


def _build_parameter_model(fn: ToolFn) -> type[BaseModel]:
    sig = inspect.signature(fn)
    fields: dict[str, Any] = {}
    annotations = getattr(fn, "__annotations__", {})
    for pname, param in sig.parameters.items():
        if pname in ("self", "ctx", "registry"):
            continue
        if pname.startswith("_"):
            continue
        typ = annotations.get(pname, str)
        if getattr(typ, "__origin__", None) is not None:
            typ = str
        default = param.default if param.default is not inspect.Parameter.empty else ...
        fields[pname] = (typ, default)
    return create_model(f"{fn.__name__}_params", **fields)  # type: ignore[call-overload]