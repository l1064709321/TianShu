from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Coroutine

from tianshu.core.llm.base import LLMMessage, ToolCall
from tianshu.core.llm.factory import create_provider
from tianshu.core.log import get_logger
from tianshu.core.review.system import ReviewSystem, gate_tool
from tianshu.core.tools.registry import ToolRegistry, Tool

logger = get_logger("agent.runtime")


@dataclass
class ToolResult:
    name: str
    output: str
    error: str | None = None


@dataclass
class AgentResult:
    content: str
    tool_calls: list[ToolResult] = field(default_factory=list)
    child_agents: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "tool_calls": [t.__dict__ for t in self.tool_calls],
            "child_agents": self.child_agents,
            "error": self.error,
        }


class MessageBus:
    """Agent 之间的消息总线,支持任意 Agent 相互调用与等待回复。"""

    def __init__(self) -> None:
        self._agents: dict[str, "Agent"] = {}
        self._pending: dict[str, asyncio.Future[AgentResult]] = {}
        self._lock = asyncio.Lock()

    def register(self, agent: "Agent") -> None:
        self._agents[agent.name] = agent

    def unregister(self, name: str) -> None:
        self._agents.pop(name, None)

    async def send(self, to: str, message: str, sender: str = "") -> AgentResult:
        agent = self._agents.get(to)
        if agent is None:
            raise KeyError(f"目标 Agent 不存在: {to}")
        return await agent.handle_message(message, sender)


class Agent:
    def __init__(
        self,
        name: str,
        system_prompt: str,
        provider_name: str,
        model: str = "",
        base_url: str = "",
        api_key: str = "",
        registry: ToolRegistry | None = None,
        bus: MessageBus | None = None,
        review: ReviewSystem | None = None,
        temperature: float = 0.2,
        max_tokens: int | None = None,
        max_iterations: int = 10,
        debug: bool = False,
        event_sink: Callable[[str, str, dict], Awaitable[None]] | None = None,
        cancelled: asyncio.Event | None = None,
    ) -> None:
        self.name = name
        self.system_prompt = system_prompt
        self.registry = registry or ToolRegistry()
        self.bus = bus or MessageBus()
        self.review = review
        self.provider = create_provider(provider_name, base_url, model, api_key, temperature=temperature, max_tokens=max_tokens)
        self.max_iterations = max_iterations
        self.messages: list[LLMMessage] = []
        self.debug = debug
        self.event_sink = event_sink
        self.cancelled = cancelled or asyncio.Event()

    async def handle_message(self, message: str, sender: str = "") -> AgentResult:
        history = [LLMMessage(role="system", content=self.system_prompt)]
        history += self.messages
        history.append(LLMMessage(role="user", content=f"(来自 {sender or '上级'} 的任务)\n{message}"))
        try:
            return await self._run_loop(history)
        except Exception as e:  # noqa: BLE001
            logger.exception("Agent %s 运行异常", self.name)
            return AgentResult(content="", error=str(e))

    async def _run_loop(self, history: list[LLMMessage]) -> AgentResult:
        tool_results: list[ToolResult] = []
        children: list[str] = []
        tools = self.registry.schemas()

        for i in range(self.max_iterations):
            result = await self.provider.chat(history, tools=tools, cancel_event=self.cancelled)
            history.append(LLMMessage(role="assistant", content=result.content or "", tool_calls=result.tool_calls))

            if not result.has_tool_calls:
                self.messages = history[1:]
                return AgentResult(content=result.content or "", tool_calls=tool_results, child_agents=children)

            if self.cancelled.is_set():
                return AgentResult(content="(任务已取消)", tool_calls=tool_results, child_agents=children)

            for tc in result.tool_calls:
                if self.cancelled.is_set():
                    return AgentResult(content="(任务已取消)", tool_calls=tool_results, child_agents=children)
                if tc.name == "call_agent":
                    child_name = tc.arguments.get("agent", "")
                    await self._emit("agent_action", agent=self.name, action="call_agent", target=child_name)
                    child = await self._dispatch_child(tc)
                    children.append(child_name)
                    output = child.content or "(无输出)"
                    if child.error:
                        output = f"错误: {child.error}"
                else:
                    await self._emit("agent_action", agent=self.name, action="tool", tool=tc.name, args=tc.arguments)
                    output, err = await self._exec_tool(tc)
                    tool_results.append(ToolResult(name=tc.name, output=output or "", error=err))
                    if err:
                        output = f"错误: {err}"
                history.append(
                    LLMMessage(role="tool", tool_call_id=tc.id, content=str(output)[:12000])
                )

        self.messages = history[1:]
        return AgentResult(content="(达到最大迭代次数)", tool_calls=tool_results, child_agents=children)

    async def _emit(self, event: str, **data: Any) -> None:
        if self.event_sink:
            try:
                await self.event_sink(self.name, event, data)
            except Exception:  # noqa: BLE001
                logger.exception("event_sink 异常 agent=%s event=%s", self.name, event)

    async def _dispatch_child(self, tc: ToolCall) -> AgentResult:
        name = tc.arguments.get("agent", "")
        task = tc.arguments.get("task", "")
        return await self.bus.send(name, task, sender=self.name)

    async def _exec_tool(self, tc: ToolCall) -> tuple[str, str | None]:
        tool = self.registry.get(tc.name)
        if tool is None:
            return "", f"工具不存在: {tc.name}"
        try:
            if tool.requires_review:
                if self.review is None:
                    return "", f"工具 {tc.name} 需要审核但未配置审核系统"
                await gate_tool(self.review, self.name, tool, tc.arguments)
            out = tool.func(**tc.arguments)
            if asyncio.iscoroutine(out):
                out = await out
            if isinstance(out, str):
                return out, None
            if tool.format_result == "json":
                return json.dumps(out, ensure_ascii=False, default=str), None
            return str(out), None
        except Exception as e:  # noqa: BLE001
            return "", f"{type(e).__name__}: {e}"


def build_agent_call_tool(bus: MessageBus) -> Tool:
    async def call_agent(agent: str, task: str) -> str:
        result = await bus.send(agent, task)
        return result.content or "(无输出)"

    return Tool(
        name="call_agent",
        description="调用另一个 Agent 处理子任务,传入目标 Agent 名称和任务描述",
        func=call_agent,
        parameters={
            "type": "object",
            "properties": {
                "agent": {"type": "string", "description": "目标 Agent 名称"},
                "task": {"type": "string", "description": "分配给目标 Agent 的任务"},
            },
            "required": ["agent", "task"],
        },
    )