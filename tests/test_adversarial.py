from __future__ import annotations

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from tianshu.core.tools.builtin import fetch_url_guarded, run_shell_guarded
from tianshu.core.tools.registry import ToolRegistry
from tianshu.core.tools.builtin import register_builtin_tools

pytestmark = pytest.mark.asyncio


async def test_shell_allowlist_rejects_interpreters():
    attacks = [
        "python3 -c 'import os\nos.system(\"id\")'",
        "python -c 'print(1)'",
        "node -e 'process.exit(0)'",
        "pip install requests",
        "git clone https://example.com/x",
        "npm install",
        "pytest --version",
    ]
    for cmd in attacks:
        with pytest.raises(PermissionError):
            await run_shell_guarded(cmd)


async def test_shell_allowlist_rejects_rmtree_bypass():
    with pytest.raises(PermissionError):
        await run_shell_guarded("python3 -c 'import shutil\nshutil.rmtree(\"/tmp\")'")


async def _httpbin_alive() -> bool:
    try:
        import urllib.request

        urllib.request.urlopen("https://httpbin.org/status/200", timeout=5)
        return True
    except Exception:  # noqa: BLE001
        return False


async def test_fetch_redirect_to_private_blocked():
    if not await _httpbin_alive():
        pytest.skip("httpbin 不可达")
    hit = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            hit.append(1)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 9017), H)
    threading.Thread(target=srv.handle_request, daemon=True).start()
    with pytest.raises(PermissionError):
        await fetch_url_guarded("https://httpbin.org/redirect-to?url=http://127.0.0.1:9017/probe")
    assert not hit, "重定向 SSRF 未被拦截,内网被访问"


async def test_search_files_rejects_dotdot():
    registry = ToolRegistry()
    register_builtin_tools(registry)
    tool = registry.get("search_files")
    assert tool is not None
    with pytest.raises(PermissionError):
        await tool.func("../../etc")
