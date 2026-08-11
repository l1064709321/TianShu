from __future__ import annotations

import asyncio
import os
import resource
import shlex
import tempfile
from pathlib import Path
from typing import Any

from tianshu.core.log import get_logger
from tianshu.config import PROJECT_ROOT

logger = get_logger("sandbox.local")

MAX_MEMORY_MB = 512
MAX_CPU_SECONDS = 30

VENV_BIN = PROJECT_ROOT / ".venv" / "bin"


def _sandbox_env(env_extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not _is_sensitive_env(k)}
    env["TZ"] = "UTC"
    env["PYTHONUNBUFFERED"] = "1"
    if VENV_BIN.exists():
        env["PATH"] = f"{VENV_BIN}:{env.get('PATH', '')}"
    if env_extra:
        env.update(env_extra)
    return env


def _is_sensitive_env(key: str) -> bool:
    u = key.upper()
    if u in ("PATH", "TZ", "PYTHONUNBUFFERED", "HOME", "LANG", "LC_ALL"):
        return False
    if u.startswith("TIANSHU_") and any(s in u for s in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
        return True
    return any(s in u for s in ("API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"))


def _resource_limits() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_MB * 1024 * 1024, MAX_MEMORY_MB * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (MAX_CPU_SECONDS, MAX_CPU_SECONDS + 1))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))


def _wrap_with_ulimit(args: list[str], timeout: int) -> list[str]:
    mem_kb = MAX_MEMORY_MB * 1024
    timeout += 2
    prefix = [
        "/bin/bash", "-c",
        f"ulimit -v {mem_kb} 2>/dev/null; ulimit -t {MAX_CPU_SECONDS} 2>/dev/null; "
        f"ulimit -u 256 2>/dev/null; timeout {timeout} \"$@\" || "
        f"{{ rc=$?; [ $rc -eq 124 ] && echo '__SANDBOX_TIMEOUT__' >&2; exit $rc; }}",
        "sandbox",
        *args,
    ]
    return prefix


async def run_in_local_sandbox(
    args: list[str],
    cwd: Path,
    timeout: int = 30,
    env_extra: dict[str, str] | None = None,
) -> tuple[str, str | None]:
    """在降级沙箱中执行命令:临时目录 + 资源限制 + 工作区只读挂载思路。

    返回 (输出, 错误信息)。不抛异常,错误以返回值为准。
    """
    env = _sandbox_env(env_extra)
    with tempfile.TemporaryDirectory(prefix="ts-sandbox-") as tmp:
        tmp_path = Path(tmp)
        try:
            proc = await asyncio.create_subprocess_exec(
                *_wrap_with_ulimit(args, timeout),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(tmp_path if cwd is None else cwd),
                env=env,
                start_new_session=True,
            )
        except FileNotFoundError:
            return "", f"命令不存在: {args[0]}"
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout + 5)
        except asyncio.TimeoutError:
            proc.kill()
            return "", "(命令超时,已终止)"
        out = stdout.decode(errors="replace")
        err = stderr.decode(errors="replace")
        if "__SANDBOX_TIMEOUT__" in err:
            return "(命令超时,已终止)", None
        if err:
            out += f"\n[stderr]\n{err}"
        return out or "(无输出)", None


async def local_available() -> bool:
    return True
