from __future__ import annotations

from pathlib import Path
from typing import Any

from tianshu.core.log import get_logger

logger = get_logger("sandbox")

_backend: str | None = None


def set_backend(backend: str) -> None:
    global _backend
    _backend = backend


async def detect_backend() -> str:
    global _backend
    if _backend is not None:
        return _backend
    try:
        from tianshu.core.sandbox.docker import docker_available

        if await docker_available():
            _backend = "docker"
            logger.info("沙箱后端: docker")
            return _backend
    except Exception:  # noqa: BLE001
        logger.exception("docker 探测失败")
    _backend = "local"
    logger.info("沙箱后端: local(降级,无 Docker)")
    return _backend


async def run_in_sandbox(
    args: list[str],
    cwd: Path,
    timeout: int = 30,
    env_extra: dict[str, str] | None = None,
) -> tuple[str, str | None]:
    backend = await detect_backend()
    if backend == "docker":
        from tianshu.core.sandbox.docker import run_in_docker

        out, err = await run_in_docker(args, cwd, timeout=timeout, env_extra=env_extra)
        if err is not None:
            logger.warning("docker 执行失败,降级 local: %s", err[:200])
            backend = "local"
    if backend == "local":
        from tianshu.core.sandbox.local import run_in_local_sandbox

        out, err = await run_in_local_sandbox(args, cwd, timeout=timeout, env_extra=env_extra)
    return out, err
