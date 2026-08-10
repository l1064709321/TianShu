from __future__ import annotations

import time
import urllib.request

import pytest

from tianshu.cli.main import _ensure_mockllm_if_needed


def test_ensure_mockllm_starts_when_unreachable(monkeypatch):
    from tianshu.config import settings

    port = 9911
    original_providers = settings.providers
    original_default = settings.default_provider
    from tianshu.config import LLMProviderConfig

    cfg = LLMProviderConfig(
        name="mock", base_url=f"http://localhost:{port}/v1", api_key="", model="mock-model"
    )
    settings.providers = [cfg]
    settings.default_provider = "mock"
    proc = None
    try:
        _ensure_mockllm_if_needed()
        import subprocess

        r = urllib.request.urlopen(f"http://localhost:{port}/healthz", timeout=2)
        assert r.status == 200
        p = subprocess.run(
            ["pgrep", "-f", f"[m]ockllm.*{port}"],
            capture_output=True, text=True,
        )
        assert p.returncode == 0
        proc = p.stdout.strip()
    finally:
        if proc:
            import subprocess as sp

            sp.run(["kill", proc], capture_output=True)
        settings.providers = original_providers
        settings.default_provider = original_default


def test_ensure_mockllm_skips_when_reachable(monkeypatch):
    proc = None
    started = {"n": 0}

    import subprocess

    def fake_popen(cmd, **kwargs):
        started["n"] += 1
        return subprocess.Popen(["true"])

    monkeypatch.setattr("tianshu.cli.main.subprocess.Popen", fake_popen)
    monkeypatch.setattr(
        "tianshu.cli.main.urllib.request.urlopen",
        lambda url, timeout=1: type("R", (), {"status": 200})(),
    )
    _ensure_mockllm_if_needed()
    assert started["n"] == 0