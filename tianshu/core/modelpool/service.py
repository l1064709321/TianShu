from __future__ import annotations

import time
from typing import Any

import httpx

from tianshu.core.llm.base import BaseProvider, LLMError, LLMMessage, LLMResult
from tianshu.core.llm.factory import create_provider
from tianshu.core.log import get_logger
from tianshu.core.modelpool.catalog import default_catalog
from tianshu.core.modelpool.store import PoolStore, mask_key

logger = get_logger("modelpool.service")


def is_auth_error(error: str) -> bool:
    return ("401" in error or "403" in error or "invalid_api_key" in error.lower() or "authentication" in error.lower())


class KeySelectorProvider(BaseProvider):
    """多 Key 选择器:前端指定首选 Key,失败(401/403 视为过期)自动切换下一个有效 Key。"""

    usage_hook: Any = None

    def __init__(
        self,
        name: str,
        base_url: str,
        model: str,
        keys: list[dict[str, Any]],
        preferred_key: str = "",
        temperature: float = 0.2,
        max_tokens: int | None = None,
        timeout: float = 120.0,
    ) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.keys = [k for k in keys if k.get("value") and k.get("enabled", True)]
        self.preferred_key = preferred_key
        self._providers: dict[str, BaseProvider] = {}
        self.usage_hook = None
        self._store: PoolStore | None = None

    def bind_store(self, store: PoolStore) -> None:
        self._store = store

    def _provider_for(self, key: dict[str, Any]) -> BaseProvider:
        if key["id"] not in self._providers:
            self._providers[key["id"]] = create_provider(
                self.name, self.base_url, self.model, key["value"],
                temperature=self.temperature, max_tokens=self.max_tokens,
            )
        return self._providers[key["id"]]

    def _rotation(self) -> list[dict[str, Any]]:
        ok = [k for k in self.keys if k.get("status") in (None, "", "ok", "unknown", "enabled")]
        bad = [k for k in self.keys if k not in ok]
        ok_sorted = sorted(ok, key=lambda k: (k.get("id") != self.preferred_key, k.get("checked_at", 0) or 0))
        return ok_sorted + sorted(bad, key=lambda k: k.get("checked_at", 0) or 0)

    async def chat(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        if not self.keys:
            raise LLMError(f"厂商 {self.name} 没有可用 Key")
        rotation = self._rotation()
        last_error: Exception | None = None
        for i, key in enumerate(rotation):
            try:
                result = await self._provider_for(key).chat(messages, tools=tools, **kwargs)
                if self.usage_hook and result.usage:
                    try:
                        self.usage_hook(self.model, result.usage)
                    except Exception:
                        logger.exception("usage_hook 异常 model=%s", self.model)
                if self._store:
                    self._store.touch_key(self.name, key["id"], "ok")
                return result
            except LLMError as e:
                last_error = e
                if is_auth_error(str(e)) and i < len(rotation) - 1:
                    logger.warning("Key %s 无效/过期(%s),自动切换下一个...", mask_key(key["value"]), e)
                    if self._store:
                        self._store.touch_key(self.name, key["id"], "expired", str(e))
                    key["status"] = "expired"
                    key["checked_at"] = time.time()
                    continue
                if is_auth_error(str(e)):
                    if self._store:
                        self._store.touch_key(self.name, key["id"], "expired", str(e))
                    key["status"] = "expired"
                raise LLMError(f"厂商 {self.name} 所有 Key 均失败: {last_error}") from e
        raise LLMError(f"厂商 {self.name} 所有 Key 均失败: {last_error or '未知错误'}")


async def test_connection(
    base_url: str,
    model: str,
    api_key: str = "",
    api_style: str = "openai",
    timeout: float = 30.0,
) -> dict[str, Any]:
    """发一条最小请求验证 Key/地址可用,返回耗时与结果。"""
    start = time.time()
    headers = {"Content-Type": "application/json"}
    base = base_url.rstrip("/")
    try:
        if api_style == "anthropic":
            headers["x-api-key"] = api_key
            headers["anthropic-version"] = "2023-06-01"
            payload = {"model": model, "max_tokens": 4, "messages": [{"role": "user", "content": "ping"}]}
            url = f"{base}/v1/messages"
        else:
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            payload = {"model": model, "max_tokens": 4, "messages": [{"role": "user", "content": "ping"}]}
            url = f"{base}/chat/completions"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)
        elapsed = round((time.time() - start) * 1000)
        if resp.status_code in (200, 201):
            data = resp.json()
            model_ok = data.get("model") and str(data.get("model")).lower() == str(model).lower()
            return {"ok": True, "latency_ms": elapsed, "model": data.get("model") or model, "matches": model_ok}
        if resp.status_code == 401:
            return {"ok": False, "latency_ms": elapsed, "error": "Key 无效或已过期(401)", "code": 401}
        if resp.status_code == 403:
            return {"ok": False, "latency_ms": elapsed, "error": "无权限(403),检查 Key 或配额", "code": 403}
        if resp.status_code in (404, 400):
            body = resp.text[:300]
            if "model" in body.lower() or "not found" in body.lower():
                return {"ok": False, "latency_ms": elapsed, "error": f"模型名可能不存在: {body}", "code": resp.status_code}
        return {"ok": False, "latency_ms": elapsed, "error": f"HTTP {resp.status_code}: {resp.text[:300]}", "code": resp.status_code}
    except httpx.HTTPError as e:
        return {"ok": False, "latency_ms": round((time.time() - start) * 1000), "error": f"网络错误: {e}"}


async def refresh_models(
    base_url: str,
    api_key: str = "",
    api_style: str = "openai",
    timeout: float = 20.0,
) -> list[str]:
    """已配 Key 的厂商在线刷新模型列表。"""
    base = base_url.rstrip("/")
    headers = {"Content-Type": "application/json"}
    if api_style == "anthropic":
        headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
        url = f"{base}/v1/models"
    else:
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        url = f"{base}/models"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    models = []
    for m in data.get("data", []):
        mid = m.get("id") or m.get("name") or ""
        if mid:
            models.append(mid)
    if not models and "models" in data:
        models = list(data["models"].keys())
    models = sorted(set(models))
    fallback = {"gpt": "gpt-4o", "claude": "claude-sonnet-4-5"}
    return models or [fallback.get(base.split("/")[-1] or "", "unknown")]


def build_key_selector(
    name: str,
    base_url: str,
    model: str,
    keys: list[dict[str, Any]],
    preferred_key: str = "",
    temperature: float = 0.2,
    max_tokens: int | None = None,
) -> KeySelectorProvider:
    return KeySelectorProvider(
        name, base_url, model, keys,
        preferred_key=preferred_key,
        temperature=temperature,
        max_tokens=max_tokens,
    )


def pool_vendors(store: PoolStore) -> list[dict[str, Any]]:
    """目录 + 已保存配置合并后的厂商视图(Key 掩码,不泄露原文)。"""
    out = []
    catalog = default_catalog()
    seen = set()
    for key, cfg in catalog.items():
        seen.add(key)
        out.append(_vendor_view(key, cfg, store))
    for key, cfg in store.vendors().items():
        if key in seen:
            continue
        out.append(_vendor_view(key, cfg, store))
    return out


def _vendor_view(key: str, cfg: dict[str, Any], store: PoolStore) -> dict[str, Any]:
    saved = store.vendor(key) or {}
    keys = []
    for k in saved.get("keys", []):
        keys.append(
            {
                "id": k["id"],
                "label": k.get("label", ""),
                "enabled": k.get("enabled", True),
                "status": k.get("status", "unknown"),
                "checked_at": k.get("checked_at", 0),
                "masked": mask_key(k.get("value", "")),
            }
        )
    base_url = saved.get("base_url") or cfg.get("base_url", "")
    return {
        "key": key,
        "name": cfg.get("name") or saved.get("name") or key,
        "region": cfg.get("region", ""),
        "api_style": cfg.get("api_style", "openai"),
        "base_url": base_url,
        "key_required": cfg.get("key_required", True),
        "free": cfg.get("free", False),
        "supported": cfg.get("supported", True),
        "notes": cfg.get("notes", ""),
        "models": saved.get("refreshed_models") or cfg.get("models", os_models(cfg)),
        "model": saved.get("model", "") or (saved.get("refreshed_models") or cfg.get("models", os_models(cfg)) or [""])[0],
        "refreshed_at": saved.get("models_refreshed_at", 0),
        "keys": keys,
        "preferred_key": store.data.get("preferred_keys", {}).get(key, ""),
        "connected": bool(keys),
        "default": store.data.get("default_vendor") == key,
    }


def os_models(cfg: dict[str, Any]) -> list[str]:
    return cfg.get("models", [])


def load_default_provider(store: PoolStore) -> dict[str, Any]:
    """当前默认厂商(优先模型池配置,缺省回退 mock)。"""
    cat = default_catalog()
    for vkey, vcfg in cat.items():
        if vkey == store.data.get("default_vendor") or (not store.data.get("default_vendor") and vcfg.get("key") == "mock"):
            return {
                "name": vkey,
                "base_url": vcfg.get("base_url", ""),
                "model": (vcfg.get("models") or [""])[0],
                "api_key": "",
            }
    return {"name": "mock", "base_url": "http://localhost:9100/v1", "model": "mock-model", "api_key": ""}