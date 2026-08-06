from __future__ import annotations

import pytest

from tianshu.core.tools.registry import ToolRegistry, Tool


def test_register_and_schema():
    registry = ToolRegistry()

    @registry.decorator("add", description="相加")
    async def add(a: int, b: int = 0) -> int:
        return a + b

    schemas = registry.schemas()
    assert schemas[0]["function"]["name"] == "add"
    props = schemas[0]["function"]["parameters"]["properties"]
    assert props["a"]["type"] == "integer"
    assert props["b"]["default"] == 0


def test_unknown_tool_returns_none():
    registry = ToolRegistry()
    assert registry.get("nope") is None


@pytest.mark.asyncio
async def test_tool_registry_lookup_and_call():
    registry = ToolRegistry()

    async def double(x: int) -> int:
        return x * 2

    registry.register(Tool(name="double", description="翻倍", func=double))
    tool = registry.get("double")
    assert tool is not None
    result = await tool.func(x=4)
    assert result == 8