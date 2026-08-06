from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tianshu.core.sandbox.manager import run_in_sandbox
from tianshu.core.tools.builtin import run_shell_guarded, fetch_url_guarded

pytestmark = pytest.mark.asyncio


async def test_sandbox_runs_command():
    out, err = await run_in_sandbox(["echo", "hello-sandbox"], Path.cwd(), timeout=10)
    assert err is None
    assert "hello-sandbox" in out


async def test_sandbox_python_deps_available():
    out, err = await run_in_sandbox(
        ["python3", "-c", "import fastapi, httpx; print('deps-ok')"],
        Path.cwd(),
        timeout=15,
    )
    assert err is None
    assert "deps-ok" in out


async def test_sandbox_memory_limit():
    out, err = await run_in_sandbox(
        ["python3", "-c", "x = [bytearray(1024*1024) for _ in range(2000)]"],
        Path.cwd(),
        timeout=15,
    )
    assert "MemoryError" in out


async def test_sandbox_cpu_timeout():
    out, err = await run_in_sandbox(
        ["python3", "-c", "import time; time.sleep(60)"],
        Path.cwd(),
        timeout=3,
    )
    assert "超时" in out


async def test_run_shell_guarded_blocklist():
    with pytest.raises(PermissionError):
        await run_shell_guarded("rm -rf /tmp/x")
    with pytest.raises(PermissionError):
        await run_shell_guarded("cat /etc/passwd | grep root")
    with pytest.raises(PermissionError):
        await run_shell_guarded("find / -exec rm")


async def test_run_shell_guarded_allowlist():
    out = await run_shell_guarded("echo ok", cwd=Path.cwd())
    assert "ok" in out


async def test_fetch_url_blocks_private_network():
    with pytest.raises(PermissionError):
        await fetch_url_guarded("http://127.0.0.1:9100/x")
    with pytest.raises(PermissionError):
        await fetch_url_guarded("http://192.168.1.1/x")
    with pytest.raises(PermissionError):
        await fetch_url_guarded("file:///etc/passwd")
