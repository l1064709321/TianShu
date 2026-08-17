from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from tianshu.core.agent.runtime import Agent, AgentResult, MessageBus
from tianshu.core.log import get_logger

logger = get_logger("orchestrator")


@dataclass
class SubTask:
    id: str
    worker: str
    goal: str
    status: str = "pending"
    result: AgentResult | None = None
    error: str | None = None


@dataclass
class Orchestration:
    task: str
    subtasks: list[SubTask] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "task": self.task,
            "subtasks": [_serialize_subtask(s) for s in self.subtasks],
            "summary": self.summary,
        }


def _serialize_subtask(st: SubTask) -> dict[str, Any]:
    d = dict(st.__dict__)
    if d.get("result") is not None:
        d["result"] = d["result"].to_dict()
    return d


class Orchestrator:
    """主 Agent: 分解任务 -> 并行或串行调度子 Agent -> 汇总结果。"""

    def __init__(
        self,
        main_agent: Agent,
        bus: MessageBus | None = None,
        parallel: bool = True,
        max_workers: int | None = None,
        decompose_iterations: int = 3,
        event_sink=None,
    ) -> None:
        self.main = main_agent
        self.bus = bus or main_agent.bus
        self.parallel = parallel
        self.max_workers = max_workers
        self.decompose_iterations = decompose_iterations
        self.event_sink = event_sink or (lambda *a, **k: None)

    async def run(self, task: str, planning_prompt: str = "", context: str = "") -> Orchestration:
        await self._emit("phase", phase="decompose")
        plan = await self.decompose(task, planning_prompt, context)
        if not plan.subtasks:
            await self._emit("phase", phase="direct")
            msg = f"{context}\n\n{task}".strip() if context else task
            result = await self.main.handle_message(msg)
            return Orchestration(task=task, summary=result.content or "")

        for st in plan.subtasks:
            await self._emit("subtask_start", worker=st.worker, goal=st.goal, subtask_id=st.id)

        if self.parallel:
            sem = asyncio.Semaphore(self.max_workers if self.max_workers else len(plan.subtasks))
            async def _one(st: SubTask) -> None:
                async with sem:
                    await self._execute(st)
                await self._emit("subtask_done", worker=st.worker, subtask_id=st.id, status=st.status)
            await asyncio.gather(*(_one(st) for st in plan.subtasks))
        else:
            for st in plan.subtasks:
                await self._execute(st)
                await self._emit("subtask_done", worker=st.worker, subtask_id=st.id, status=st.status)

        await self._emit("phase", phase="aggregate")
        summary = await self.aggregate(task, plan)
        plan.summary = summary
        await self._emit("phase", phase="done")
        return plan

    async def _emit(self, event: str, **data: Any) -> None:
        try:
            await self.event_sink("orchestrator", event, data)
        except Exception:
            logger.exception("event_sink 异常 event=%s", event)

    async def decompose(self, task: str, planning_prompt: str = "", context: str = "") -> Orchestration:
        ctx_line = f"\n参考上下文:\n{context}" if context else ""
        prompt = (
            planning_prompt
            or (
                f"你是任务规划者。将以下任务拆解为若干可并行或串行执行的子任务,"
                f"每个子任务需指明:worker(执行该任务的最佳 Agent 名称)、goal(清晰的目标描述)。\n"
                f"任务: {task}\n"
                f"可用 Agent: {', '.join(self.bus._agents.keys())}\n"
                f"请以 JSON 输出,格式: {{\"subtasks\": [{{\"worker\": \"...\", \"goal\": \"...\"}}]}}"
                f"{ctx_line}"
            )
        )
        result = await self.main.provider.chat(
            [tianshu_msg(prompt)],
            tools=[decompose_tool_schema()],
        )
        return _parse_plan(task, result)

    async def _execute(self, st: SubTask) -> None:
        worker = self.bus._agents.get(st.worker)
        if worker is None:
            st.status = "failed"
            st.error = f"Worker 不存在: {st.worker}"
            return
        try:
            st.result = await worker.handle_message(st.goal, sender="orchestrator")
            st.status = st.result.error or "done"
            if st.result.error:
                st.status = "error"
        except Exception as e:
            st.status = "failed"
            st.error = str(e)
            logger.exception("子任务执行失败 worker=%s goal=%s", st.worker, st.goal[:100])

    async def aggregate(self, task: str, plan: Orchestration) -> str:
        if not plan.subtasks:
            return ""
        parts = []
        for st in plan.subtasks:
            parts.append(f"[{st.worker}] {st.goal}\n结果: {st.result.content if st.result else st.error}")
        prompt = (
            f"你是汇总员。以下是主任务 '{task}' 各子任务的执行结果,请整合成一份完整、连贯的最终答复。\n\n"
            + "\n\n".join(parts)
        )
        result = await self.main.provider.chat([tianshu_msg(prompt)])
        return result.content or ""


def tianshu_msg(content: str):
    from tianshu.core.llm.base import LLMMessage

    return LLMMessage(role="user", content=content)


def decompose_tool_schema() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "produce_plan",
            "description": "输出子任务拆解计划",
            "parameters": {
                "type": "object",
                "properties": {
                    "subtasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "worker": {"type": "string"},
                                "goal": {"type": "string"},
                            },
                            "required": ["worker", "goal"],
                        },
                    }
                },
                "required": ["subtasks"],
            },
        },
    }


def _parse_plan(task: str, result) -> Orchestration:
    plan = Orchestration(task=task)
    raw = result.content or ""
    if result.tool_calls:
        for tc in result.tool_calls:
            if tc.name == "produce_plan":
                for idx, item in enumerate(tc.arguments.get("subtasks", [])):
                    plan.subtasks.append(
                        SubTask(id=f"st_{idx}", worker=item.get("worker", ""), goal=item.get("goal", ""))
                    )
                return plan
    import json as _json
    import re as _re

    m = _re.search(r"\{.*\}", raw, _re.DOTALL)
    if m:
        try:
            data = _json.loads(m.group(0))
        except _json.JSONDecodeError:
            data = {}
        for idx, item in enumerate(data.get("subtasks", [])):
            plan.subtasks.append(
                SubTask(id=f"st_{idx}", worker=item.get("worker", ""), goal=item.get("goal", ""))
            )
    return plan