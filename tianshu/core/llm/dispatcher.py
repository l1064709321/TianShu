from __future__ import annotations

import asyncio
import random
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from tianshu.core.llm.base import BaseProvider, LLMError, LLMMessage, LLMResult, ToolCall
from tianshu.core.llm.factory import create_provider
from tianshu.core.log import get_logger
from tianshu.core.tools.builtin import fetch_url_guarded

logger = get_logger("llm.dispatcher")


@dataclass
class ProviderEndpoint:
    name: str
    base_url: str
    model: str
    api_key: str = ""
    weight: int = 1
    enabled: bool = True
    consecutive_failures: int = 0
    last_used: float = 0.0
    success_count: int = 0
    fail_count: int = 0


@dataclass
class DispatchConfig:
    strategy: str = "round_robin"
    fallback_enabled: bool = True
    max_retries: int = 2
    retry_delay: float = 1.0
    health_check_interval: float = 60.0
    failure_threshold: int = 3
    timeout: float = 120.0
    max_tokens: int | None = None
    temperature: float = 0.2


class Dispatcher:
    def __init__(self, config: DispatchConfig | None = None) -> None:
        self.config = config or DispatchConfig()
        self._endpoints: dict[str, ProviderEndpoint] = {}
        self._lock = asyncio.Lock()
        self._rr_index: int = 0
        self._last_health_check: float = 0.0
        self._stats: dict[str, dict[str, int]] = defaultdict(lambda: {"success": 0, "fail": 0, "retry": 0})

    def add_endpoint(
        self,
        name: str,
        base_url: str,
        model: str,
        api_key: str = "",
        weight: int = 1,
    ) -> None:
        self._endpoints[name] = ProviderEndpoint(
            name=name,
            base_url=base_url.rstrip("/"),
            model=model,
            api_key=api_key,
            weight=weight,
        )
        logger.info("注册调度端点: %s -> %s/%s", name, base_url, model)

    def list_endpoints(self) -> list[dict[str, Any]]:
        result = []
        for ep in self._endpoints.values():
            result.append({
                "name": ep.name,
                "base_url": ep.base_url,
                "model": ep.model,
                "weight": ep.weight,
                "enabled": ep.enabled,
                "consecutive_failures": ep.consecutive_failures,
                "success_count": ep.success_count,
                "fail_count": ep.fail_count,
            })
        return result

    async def chat(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        async with self._lock:
            await self._health_check()
            candidates = self._select_candidates()
            if not candidates:
                raise LLMError("无可用端点")

        result = None
        attempts = []

        for ep in candidates:
            attempt = {
                "endpoint": ep.name,
                "attempt": 0,
                "success": False,
                "error": None,
            }
            for retry in range(self.config.max_retries + 1):
                attempt["attempt"] = retry
                try:
                    logger.debug("调度请求: endpoint=%s model=%s retry=%d", ep.name, ep.model, retry)
                    provider = create_provider(
                        ep.name,
                        ep.base_url,
                        ep.model,
                        ep.api_key,
                        timeout=self.config.timeout,
                        max_tokens=self.config.max_tokens,
                        temperature=self.config.temperature,
                    )
                    result = await provider.chat(messages, tools=tools, cancel_event=kwargs.get("cancel_event"))
                    attempt["success"] = True
                    ep.consecutive_failures = 0
                    ep.success_count += 1
                    ep.last_used = time.time()
                    self._stats[ep.name]["success"] += 1
                    logger.info("请求成功: endpoint=%s model=%s", ep.name, ep.model)
                    break
                except LLMError as e:
                    attempt["error"] = str(e)
                    ep.consecutive_failures += 1
                    ep.fail_count += 1
                    self._stats[ep.name]["fail"] += 1
                    logger.warning("请求失败: endpoint=%s error=%s", ep.name, e)
                    if retry < self.config.max_retries and self.config.fallback_enabled:
                        attempt["retry"] = True
                        self._stats[ep.name]["retry"] += 1
                        await asyncio.sleep(self.config.retry_delay)
                        continue
                    break
            attempts.append(attempt)
            if attempt["success"]:
                break

        if result is None and attempts:
            last_error = attempts[-1]["error"] or "未知错误"
            raise LLMError(f"所有端点均失败: {last_error}")

        return result or LLMResult(content="")

    def _select_candidates(self) -> list[ProviderEndpoint]:
        now = time.time()
        if self.config.strategy == "round_robin":
            return self._round_robin_select(now)
        elif self.config.strategy == "weighted":
            return self._weighted_select(now)
        elif self.config.strategy == "least_connections":
            return self._least_connections_select(now)
        elif self.config.strategy == "smart":
            return self._smart_select(now)
        return self._round_robin_select(now)

    def _round_robin_select(self, now: float) -> list[ProviderEndpoint]:
        healthy = [ep for ep in self._endpoints.values() if ep.enabled and ep.consecutive_failures < self.config.failure_threshold]
        if not healthy:
            return list(self._endpoints.values())
        start = self._rr_index
        for i in range(len(healthy)):
            idx = (start + i) % len(healthy)
            self._rr_index = (idx + 1) % len(healthy)
            return [healthy[idx]]
        return [healthy[0]]

    def _weighted_select(self, now: float) -> list[ProviderEndpoint]:
        healthy = [ep for ep in self._endpoints.values() if ep.enabled and ep.consecutive_failures < self.config.failure_threshold]
        if not healthy:
            return list(self._endpoints.values())
        total_weight = sum(ep.weight for ep in healthy)
        if total_weight == 0:
            return [healthy[0]]
        r = random.uniform(0, total_weight)
        cumulative = 0
        for ep in healthy:
            cumulative += ep.weight
            if r <= cumulative:
                return [ep]
        return [healthy[-1]]

    def _least_connections_select(self, now: float) -> list[ProviderEndpoint]:
        healthy = [ep for ep in self._endpoints.values() if ep.enabled and ep.consecutive_failures < self.config.failure_threshold]
        if not healthy:
            return list(self._endpoints.values())
        return [min(healthy, key=lambda ep: ep.consecutive_failures)]

    def _smart_select(self, now: float) -> list[ProviderEndpoint]:
        healthy = [ep for ep in self._endpoints.values() if ep.enabled and ep.consecutive_failures < self.config.failure_threshold]
        if not healthy:
            return list(self._endpoints.values())
        scored = []
        for ep in healthy:
            success_rate = ep.success_count / (ep.success_count + ep.fail_count + 1)
            recency = now - ep.last_used
            score = success_rate * 0.7 + (1.0 / (1.0 + recency / 3600)) * 0.3
            scored.append((score, ep))
        scored.sort(key=lambda x: -x[0])
        return [scored[0][1]]

    async def _health_check(self) -> None:
        now = time.time()
        if now - self._last_health_check < self.config.health_check_interval:
            return
        self._last_health_check = now
        for ep in list(self._endpoints.values()):
            if ep.consecutive_failures >= self.config.failure_threshold:
                logger.warning("端点 %s 连续失败%d次,标记为不可用", ep.name, ep.consecutive_failures)
                ep.enabled = False
            elif ep.consecutive_failures > 0:
                ep.consecutive_failures = max(0, ep.consecutive_failures - 1)

    async def enable_endpoint(self, name: str) -> bool:
        async with self._lock:
            if name in self._endpoints:
                self._endpoints[name].enabled = True
                self._endpoints[name].consecutive_failures = 0
                return True
            return False

    async def disable_endpoint(self, name: str) -> bool:
        async with self._lock:
            if name in self._endpoints:
                self._endpoints[name].enabled = False
                return True
            return False

    async def get_stats(self) -> dict[str, Any]:
        async with self._lock:
            return {
                "endpoints": self.list_endpoints(),
                "strategy": self.config.strategy,
                "stats": dict(self._stats),
            }


class MultiProviderChain:
    """多 Provider 链式调用,支持自定义降级逻辑"""

    def __init__(self, providers: list[tuple[str, str, str, str]], config: DispatchConfig | None = None) -> None:
        self.config = config or DispatchConfig()
        self._providers: dict[str, BaseProvider] = {}
        for name, base_url, model, api_key in providers:
            self._providers[name] = create_provider(name, base_url, model, api_key, timeout=self.config.timeout)

    async def chat(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        results = []
        for name, provider in self._providers.items():
            try:
                logger.debug("尝试 Provider: %s", name)
                result = await provider.chat(messages, tools=tools, cancel_event=kwargs.get("cancel_event"))
                results.append({"name": name, "result": result, "error": None})
                logger.info("Provider %s 成功", name)
                return result
            except LLMError as e:
                results.append({"name": name, "result": None, "error": str(e)})
                logger.warning("Provider %s 失败: %s", name, e)
                continue

        last_error = results[-1]["error"] if results else "无可用 Provider"
        raise LLMError(f"所有 Provider 均失败: {last_error}")

    def get_status(self) -> list[dict[str, Any]]:
        return [
            {"name": name, "base_url": p.base_url, "model": p.model}
            for name, p in self._providers.items()
        ]


def create_dispatcher_from_providers(
    providers: list[dict[str, Any]],
    strategy: str = "smart",
) -> Dispatcher:
    dispatcher = Dispatcher(DispatchConfig(strategy=strategy))
    for p in providers:
        dispatcher.add_endpoint(
            name=p["name"],
            base_url=p["base_url"],
            model=p["model"],
            api_key=p.get("api_key", ""),
            weight=p.get("weight", 1),
        )
    return dispatcher
