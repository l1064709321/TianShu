from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable

from tianshu.core.tools.registry import Tool


class ReviewStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    TIMEOUT = "timeout"


@dataclass
class ReviewRequest:
    id: str
    agent: str
    tool: str
    arguments: dict = field(default_factory=dict)
    reason: str = ""
    status: ReviewStatus = ReviewStatus.PENDING
    created_at: float = field(default_factory=time.time)
    decided_by: str = ""


ReviewCallback = Callable[[ReviewRequest], None]


class ReviewSystem:
    """高危操作审批系统。可切换人工审批、自动放行、自动拒绝三种模式。"""

    def __init__(self, mode: str = "manual") -> None:
        self.mode = mode
        self._pending: dict[str, ReviewRequest] = {}
        self._events: dict[str, asyncio.Event] = {}
        self._subscribers: list[ReviewCallback] = []

    def subscribe(self, cb: ReviewCallback) -> None:
        self._subscribers.append(cb)

    def set_mode(self, mode: str) -> None:
        self.mode = mode

    def pending(self) -> list[ReviewRequest]:
        return list(self._pending.values())

    def get(self, review_id: str) -> ReviewRequest | None:
        return self._pending.get(review_id)

    async def request(
        self,
        agent: str,
        tool: str,
        arguments: dict,
        reason: str = "",
        timeout: float = 120.0,
    ) -> ReviewRequest:
        req = ReviewRequest(id=uuid.uuid4().hex[:12], agent=agent, tool=tool, arguments=arguments, reason=reason)
        if self.mode == "auto_approve":
            self._decide(req, ReviewStatus.APPROVED, "auto_approve")
            return req
        if self.mode == "auto_reject":
            self._decide(req, ReviewStatus.REJECTED, "auto_reject")
            return req

        self._pending[req.id] = req
        event = asyncio.Event()
        self._events[req.id] = event
        for cb in self._subscribers:
            cb(req)
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self._decide(req, ReviewStatus.TIMEOUT, "timeout")
        return req

    def decide(self, review_id: str, approve: bool, by: str = "human") -> bool:
        req = self._pending.get(review_id)
        if req is None or req.status != ReviewStatus.PENDING:
            return False
        self._decide(req, ReviewStatus.APPROVED if approve else ReviewStatus.REJECTED, by)
        return True

    def _decide(self, req: ReviewRequest, status: ReviewStatus, by: str) -> None:
        req.status = status
        req.decided_by = by
        self._pending.pop(req.id, None)
        event = self._events.pop(req.id, None)
        if event:
            event.set()


async def gate_tool(review: ReviewSystem, agent_name: str, tool: Tool, args: dict) -> None:
    req = await review.request(
        agent_name,
        tool.name,
        args,
        reason=f"工具 {tool.name} 属于高危操作",
    )
    if req.status != ReviewStatus.APPROVED:
        raise PermissionError(f"未通过审核: {req.status.value}({req.decided_by})")