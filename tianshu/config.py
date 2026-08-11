from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class LLMProviderConfig(BaseModel):
    name: str = "mock"
    base_url: str = "http://localhost:9100/v1"
    api_key: str = ""
    model: str = "mock-model"
    temperature: float = 0.2
    timeout: float = 120.0
    max_tokens: int | None = None


ENV_FILE = os.environ.get("TIANSHU_ENV", ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, env_prefix="TIANSHU_", extra="ignore")

    app_name: str = "tianshu"
    providers: list[LLMProviderConfig] = Field(default_factory=lambda: [LLMProviderConfig()])
    default_provider: str = "mock"
    mode: Literal["full", "headless"] = "full"


settings = Settings()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PROJECT_ROOT / "skills"
WORKSPACE_DIR = PROJECT_ROOT / "workspace"
SENSITIVE_DIR = WORKSPACE_DIR / ".ts-secrets"


def get_provider(name: str | None = None) -> LLMProviderConfig:
    name = name or settings.default_provider
    for p in settings.providers:
        if p.name == name:
            return p
    if name == settings.default_provider and settings.providers:
        return settings.providers[0]
    raise KeyError(f"provider 不存在: {name}")