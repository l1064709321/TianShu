from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from tianshu.core.llm.base import BaseProvider, LLMError, LLMMessage, LLMResult
from tianshu.core.llm.factory import create_provider
from tianshu.core.log import get_logger

logger = get_logger("llm.dispatcher")


class RoutingStrategy(str, Enum):
    SIMPLE_SHUFFLE = "simple-shuffle"
    LEAST_BUSY = "least-busy"
    USAGE_BASED = "usage-based-routing"
    LATENCY_BASED = "latency-based-routing"
    COST_BASED = "cost-based-routing"


class ErrorKind(str, Enum):
    RETRYABLE = "retryable"
    NON_RETRYABLE = "non-retryable"
    CONTEXT_WINDOW = "context-window"
    CONTENT_POLICY = "content-policy"


@dataclass
class Deployment:
    name: str
    base_url: str
    model: str
    api_key: str = ""
    weight: int = 1
    rpm: int | None = None
    tpm: int | None = None
    order: int = 999
    input_cost_per_1m: float = 0.0
    output_cost_per_1m: float = 0.0
    cooldown: bool = False
    cooldown_until: float = 0.0
    allowed_fails: int = 1
    active_requests: int = 0
    total_requests: int = 0
    success_count: int = 0
    fail_count: int = 0
    last_latency_ms: float = 0.0
    latency_window: list[float] = field(default_factory=list)
    avg_latency_ms: float = 0.0


@dataclass
class FallbackRule:
    group: str
    targets: list[str]


@dataclass
class DispatchConfig:
    routing_strategy: RoutingStrategy = RoutingStrategy.SIMPLE_SHUFFLE
    num_retries: int = 2
    retry_delay: float = 1.0
    timeout: float = 120.0
    max_tokens: int | None = None
    temperature: float = 0.2
    enable_cooldowns: bool = True
    cooldown_time: float = 60.0
    allowed_fails: int = 1
    max_fallbacks: int = 5
    enable_weighted_failover: bool = True
    fallbacks: dict[str, list[str]] = field(default_factory=dict)
    context_window_fallbacks: dict[str, list[str]] = field(default_factory=dict)
    content_policy_fallbacks: dict[str, list[str]] = field(default_factory=dict)


class Dispatcher:
    """LiteLLM 风格智能调度器:加权随机/最低延迟/成本优先 + 加权故障转移 + 熔断冷却 + 分类 fallback"""

    def __init__(self, config: DispatchConfig | None = None) -> None:
        self.config = config or DispatchConfig()
        self._deployments: dict[str, Deployment] = {}
        self._groups: dict[str, list[str]] = {}
        self._lock = asyncio.Lock()

    def add_deployment(
        self,
        group: str,
        name: str,
        base_url: str,
        model: str,
        api_key: str = "",
        weight: int = 1,
        rpm: int | None = None,
        tpm: int | None = None,
        order: int = 999,
        input_cost_per_1m: float = 0.0,
        output_cost_per_1m: float = 0.0,
    ) -> None:
        dep = Deployment(
            name=name,
            base_url=base_url.rstrip("/"),
            model=model,
            api_key=api_key,
            weight=weight,
            rpm=rpm,
            tpm=tpm,
            order=order,
            input_cost_per_1m=input_cost_per_1m,
            output_cost_per_1m=output_cost_per_1m,
            allowed_fails=self.config.allowed_fails,
        )
        self._deployments[name] = dep
        self._groups.setdefault(group, []).append(name)
        logger.info("注册部署: 组=%s 名称=%s -> %s/%s weight=%d order=%d", group, name, base_url, model, weight, order)

    def add_fallback(self, group: str, targets: list[str]) -> None:
        self.config.fallbacks[group] = targets

    def add_context_window_fallback(self, group: str, targets: list[str]) -> None:
        self.config.context_window_fallbacks[group] = targets

    def add_content_policy_fallback(self, group: str, targets: list[str]) -> None:
        self.config.content_policy_fallbacks[group] = targets

    def list_deployments(self) -> list[dict[str, Any]]:
        result = []
        for dep in self._deployments.values():
            result.append({
                "name": dep.name,
                "base_url": dep.base_url,
                "model": dep.model,
                "weight": dep.weight,
                "rpm": dep.rpm,
                "tpm": dep.tpm,
                "order": dep.order,
                "cooldown": dep.cooldown,
                "cooldown_until": dep.cooldown_until,
                "active_requests": dep.active_requests,
                "total_requests": dep.total_requests,
                "success_count": dep.success_count,
                "fail_count": dep.fail_count,
                "avg_latency_ms": round(dep.avg_latency_ms, 2),
            })
        return result

    async def chat(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        model_group: str | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        group = model_group or (next(iter(self._groups)) if self._groups else None)
        if group is None or group not in self._groups:
            raise LLMError("无可用模型组")

        visited: set[str] = set()
        chain = self._build_chain(group, visited)
        return await self._run_chain(chain, messages, tools, **kwargs)

    def _build_chain(self, group: str, visited: set[str]) -> list[str]:
        """构建 fallback 链:当前组(按优先级/权重)-> fallback 组 -> 跨组 fallback(最多 max_fallbacks)"""
        chain: list[str] = []
        current = group
        for _ in range(self.config.max_fallbacks + 1):
            if current in visited:
                break
            visited.add(current)
            chain.append(current)
            targets = self.config.fallbacks.get(current) or []
            next_group = targets[0] if targets else None
            if next_group is None or next_group not in self._groups:
                break
            current = next_group
        return chain

    async def _run_chain(
        self,
        chain: list[str],
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None,
        **kwargs: Any,
    ) -> LLMResult:
        last_error: Exception | None = None
        for group in chain:
            try:
                return await self._call_group(group, messages, tools, **kwargs)
            except LLMError as e:
                last_error = e
                logger.warning("模型组 %s 全部失败: %s,切换到下一组", group, e)
        raise LLMError(f"所有模型组均失败: {last_error or '未知错误'}")

    async def _call_group(
        self,
        group: str,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None,
        **kwargs: Any,
    ) -> LLMResult:
        excluded: set[str] = set()
        for _ in range(len(self._groups.get(group, [])) * (self.config.num_retries + 1)):
            dep = await self._pick_deployment(group, excluded)
            if dep is None:
                break
            try:
                return await self._call_deployment(dep, messages, tools, **kwargs)
            except LLMError as e:
                await self._on_failure(dep, e)
                if self.config.enable_weighted_failover:
                    excluded.add(dep.name)
                    logger.info("部署 %s 失败,排除后按权重重选(组内故障转移)", dep.name)
                    continue
                break
            finally:
                dep.active_requests = max(0, dep.active_requests - 1)
        raise LLMError(f"模型组 {group} 内所有部署均失败")

    async def _pick_deployment(self, group: str, excluded: set[str]) -> Deployment | None:
        async with self._lock:
            now = time.time()
            names = [n for n in self._groups.get(group, []) if n not in excluded]
            if not names:
                return None
            deps = [self._deployments[n] for n in names if not self._is_in_cooldown(self._deployments[n], now)]
            if not deps:
                deps = [self._deployments[n] for n in names]

            strategy = self.config.routing_strategy
            if strategy == RoutingStrategy.SIMPLE_SHUFFLE:
                return self._pick_weighted_random(deps)
            elif strategy == RoutingStrategy.LEAST_BUSY:
                return min(deps, key=lambda d: d.active_requests)
            elif strategy == RoutingStrategy.USAGE_BASED:
                return self._pick_usage_based(deps)
            elif strategy == RoutingStrategy.LATENCY_BASED:
                return min(deps, key=lambda d: d.avg_latency_ms or 999999.0)
            elif strategy == RoutingStrategy.COST_BASED:
                return min(deps, key=lambda d: d.input_cost_per_1m + d.output_cost_per_1m)
            return self._pick_weighted_random(deps)

    @staticmethod
    def _pick_weighted_random(deps: list[Deployment]) -> Deployment:
        total = sum(d.weight for d in deps)
        if total <= 0:
            return random.choice(deps)
        r = random.uniform(0, total)
        cumulative = 0
        for dep in deps:
            cumulative += dep.weight
            if r <= cumulative:
                return dep
        return deps[-1]

    @staticmethod
    def _pick_usage_based(deps: list[Deployment]) -> Deployment:
        def usage_score(d: Deployment) -> float:
            if d.rpm:
                return d.total_requests / d.rpm
            return 0.0
        return min(deps, key=usage_score)

    @staticmethod
    def _is_in_cooldown(dep: Deployment, now: float) -> bool:
        if not dep.cooldown:
            return False
        if now >= dep.cooldown_until:
            dep.cooldown = False
            dep.cooldown_until = 0.0
            dep.fail_count = 0
            logger.info("部署 %s 冷却结束,恢复流量", dep.name)
            return False
        return True

    async def _call_deployment(
        self,
        dep: Deployment,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None,
        **kwargs: Any,
    ) -> LLMResult:
        dep.active_requests += 1
        dep.total_requests += 1
        start = time.time()
        try:
            provider = create_provider(
                dep.name, dep.base_url, dep.model, dep.api_key,
                timeout=self.config.timeout,
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature,
            )
            result = await provider.chat(messages, tools=tools, cancel_event=kwargs.get("cancel_event"))
            elapsed_ms = (time.time() - start) * 1000
            dep.success_count += 1
            dep.fail_count = 0
            dep.last_latency_ms = elapsed_ms
            dep.latency_window.append(elapsed_ms)
            if len(dep.latency_window) > 100:
                dep.latency_window.pop(0)
            dep.avg_latency_ms = sum(dep.latency_window) / len(dep.latency_window)
            logger.info("成功: %s latency=%.0fms avg=%.0fms", dep.name, elapsed_ms, dep.avg_latency_ms)
            return result
        except LLMError as e:
            specialized = await self._try_specialized_fallback(dep, e, messages, tools, **kwargs)
            if specialized is not None:
                elapsed_ms = (time.time() - start) * 1000
                dep.success_count += 1
                dep.fail_count = 0
                dep.last_latency_ms = elapsed_ms
                logger.info("专类 fallback 成功: %s", dep.name)
                return specialized
            elapsed_ms = (time.time() - start) * 1000
            dep.last_latency_ms = elapsed_ms
            raise
        finally:
            dep.active_requests = max(0, dep.active_requests - 1)

    async def _try_specialized_fallback(
        self,
        dep: Deployment,
        error: LLMError,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None,
        **kwargs: Any,
    ) -> LLMResult | None:
        """错误分类:LiteLLM 三层 fallback(普通/上下文超长/内容策略)"""
        err_str = str(error)
        kind = self._classify_error(err_str)
        targets: list[str] = []

        if kind == ErrorKind.CONTEXT_WINDOW:
            targets = self.config.context_window_fallbacks.get(dep.name) or self.config.context_window_fallbacks.get(self._find_group(dep.name), [])
            logger.info("上下文超限,走 context_window_fallbacks -> %s", targets)
        elif kind == ErrorKind.CONTENT_POLICY:
            targets = self.config.content_policy_fallbacks.get(dep.name) or []
            logger.info("内容策略拒绝,走 content_policy_fallbacks -> %s", targets)
        else:
            return None

        for group in targets:
            if group not in self._groups:
                continue
            try:
                return await self._call_group(group, messages, tools, **kwargs)
            except LLMError:
                continue
        return None

    @staticmethod
    def _classify_error(error: str) -> ErrorKind:
        lower = error.lower()
        if "context" in lower and ("exceed" in lower or "length" in lower or "too long" in lower):
            return ErrorKind.CONTEXT_WINDOW
        if "content" in lower and ("policy" in lower or "filter" in lower or "safety" in lower or "moderation" in lower):
            return ErrorKind.CONTENT_POLICY
        return ErrorKind.RETRYABLE

    def _find_group(self, name: str) -> str:
        for group, names in self._groups.items():
            if name in names:
                return group
        return ""

    async def _on_failure(self, dep: Deployment, error: LLMError) -> None:
        elapsed_ms = dep.last_latency_ms
        dep.fail_count += 1
        logger.warning("失败: %s error=%s fail_count=%d", dep.name, error, dep.fail_count)
        if self.config.enable_cooldowns and dep.fail_count >= dep.allowed_fails:
            dep.cooldown = True
            dep.cooldown_until = time.time() + self.config.cooldown_time
            logger.warning("部署 %s 连续失败%d次,进入冷却 %ds", dep.name, dep.fail_count, self.config.cooldown_time)
        dep.latency_ms = elapsed_ms

    async def get_stats(self) -> dict[str, Any]:
        async with self._lock:
            return {
                "deployments": self.list_deployments(),
                "groups": {g: len(n) for g, n in self._groups.items()},
                "strategy": self.config.routing_strategy.value,
                "fallbacks": self.config.fallbacks,
                "cooldowns": {
                    d.name: {"cooldown": d.cooldown, "until": d.cooldown_until}
                    for d in self._deployments.values()
                },
            }

    async def disable_deployment(self, name: str) -> bool:
        async with self._lock:
            if name in self._deployments:
                dep = self._deployments[name]
                dep.cooldown = True
                dep.cooldown_until = time.time() + 31536000
                return True
            return False

    async def enable_deployment(self, name: str) -> bool:
        async with self._lock:
            if name in self._deployments:
                dep = self._deployments[name]
                dep.cooldown = False
                dep.cooldown_until = 0.0
                dep.fail_count = 0
                return True
            return False


class MultiProviderChain:
    """多 Provider 链式调用 - 按配置顺序依次尝试"""

    def __init__(self, providers: list[tuple[str, str, str, str]], config: DispatchConfig | None = None) -> None:
        self.config = config or DispatchConfig()
        self._providers: dict[str, BaseProvider] = {}
        for name, base_url, model, api_key in providers:
            self._providers[name] = create_provider(
                name, base_url, model, api_key,
                timeout=self.config.timeout,
            )

    async def chat(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        last_error = None
        for name, provider in self._providers.items():
            try:
                logger.debug("尝试 Provider: %s", name)
                result = await provider.chat(messages, tools=tools, cancel_event=kwargs.get("cancel_event"))
                logger.info("Provider %s 成功", name)
                return result
            except LLMError as e:
                last_error = e
                logger.warning("Provider %s 失败: %s", name, e)
                continue
        raise LLMError(f"所有 Provider 均失败: {last_error or '未知错误'}")

    def get_status(self) -> list[dict[str, Any]]:
        return [
            {"name": name, "base_url": p.base_url, "model": p.model}
            for name, p in self._providers.items()
        ]


def create_dispatcher_from_providers(
    providers: list[dict[str, Any]],
    strategy: str = "simple-shuffle",
) -> Dispatcher:
    dispatcher = Dispatcher(DispatchConfig(routing_strategy=RoutingStrategy(strategy)))
    for p in providers:
        dispatcher.add_deployment(
            group=p.get("group", p["name"]),
            name=p["name"],
            base_url=p["base_url"],
            model=p["model"],
            api_key=p.get("api_key", ""),
            weight=p.get("weight", 1),
            rpm=p.get("rpm"),
            tpm=p.get("tpm"),
            order=p.get("order", 999),
            input_cost_per_1m=p.get("input_cost_per_1m", 0.0),
            output_cost_per_1m=p.get("output_cost_per_1m", 0.0),
        )
    return dispatcher