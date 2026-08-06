from __future__ import annotations

from tianshu.core.llm.base import BaseProvider
from tianshu.core.llm.openai import OpenAIProvider

_PROVIDER_TYPES: dict[str, type[BaseProvider]] = {
    "openai": OpenAIProvider,
    "ollama": OpenAIProvider,
    "deepseek": OpenAIProvider,
    "qwen": OpenAIProvider,
    "moonshot": OpenAIProvider,
    "zhipu": OpenAIProvider,
    "kimi": OpenAIProvider,
    "minimax": OpenAIProvider,
    "groq": OpenAIProvider,
    "openrouter": OpenAIProvider,
    "together": OpenAIProvider,
    "siliconflow": OpenAIProvider,
    "fireworks": OpenAIProvider,
    "mistral": OpenAIProvider,
    "lingyiwanwu": OpenAIProvider,
    "stepfun": OpenAIProvider,
    "baichuan": OpenAIProvider,
    "volcengine": OpenAIProvider,
    "hunyuan": OpenAIProvider,
    "nvidia": OpenAIProvider,
    "perplexity": OpenAIProvider,
    "cohere": OpenAIProvider,
    "together_ai": OpenAIProvider,
    "oneapi": OpenAIProvider,
    "newapi": OpenAIProvider,
    "litellm": OpenAIProvider,
    "vllm": OpenAIProvider,
    "sglang": OpenAIProvider,
    "lmstudio": OpenAIProvider,
    "custom": OpenAIProvider,
    "local": OpenAIProvider,
}

# 非 OpenAI 兼容协议,需要独立 Provider 实现(按需通过 register_provider 注册)


def register_provider(name: str, cls: type[BaseProvider]) -> None:
    _PROVIDER_TYPES[name] = cls


def create_provider(name: str, base_url: str, model: str, api_key: str = "", **kwargs) -> BaseProvider:
    cls = _PROVIDER_TYPES.get(name)
    if cls is None:
        cls = OpenAIProvider
        _PROVIDER_TYPES[name] = OpenAIProvider
    return cls(base_url=base_url, model=model, api_key=api_key, **kwargs)


def available_providers() -> list[str]:
    return sorted(_PROVIDER_TYPES)