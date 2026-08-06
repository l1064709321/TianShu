from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path
from typing import Any

from tianshu.config import PROJECT_ROOT
from tianshu.core.log import get_logger

logger = get_logger("sandbox.docker")

IMAGE_NAME = "tianshu-sandbox"
DOCKERFILE = """FROM python:3.12-slim

RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \\
    fastapi uvicorn pydantic pydantic-settings httpx typer rich \\
    prompt-toolkit beautifulsoup4 pyyaml aiosqlite pytest

WORKDIR /workspace
CMD ["bash"]
"""


async def _run_docker(args: list[str], timeout: int = 60) -> tuple[str, str | None]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except FileNotFoundError:
        return "", "docker 命令不存在"
    except asyncio.TimeoutError:
        return "", "(docker 操作超时)"
    out = stdout.decode(errors="replace").strip()
    err = stderr.decode(errors="replace").strip()
    if proc.returncode != 0:
        return out, err or f"docker 返回码 {proc.returncode}"
    return out, None


async def docker_available() -> bool:
    out, err = await _run_docker(["info", "--format", "{{.ServerVersion}}"], timeout=15)
    return err is None


async def ensure_image(force_rebuild: bool = False) -> str | None:
    if not force_rebuild:
        out, err = await _run_docker(["image", "inspect", IMAGE_NAME, "--format", "{{.Id}}"], timeout=15)
        if err is None:
            return IMAGE_NAME
    df_path = PROJECT_ROOT / "tianshu" / "core" / "sandbox" / "Dockerfile"
    df_path.write_text(DOCKERFILE, encoding="utf-8")
    out, err = await _run_docker(
        ["build", "-t", IMAGE_NAME, "-f", str(df_path), str(df_path.parent)],
        timeout=300,
    )
    if err is not None:
        logger.error("沙箱镜像构建失败: %s", err)
        return None
    logger.info("沙箱镜像构建成功")
    return IMAGE_NAME


async def run_in_docker(
    args: list[str],
    cwd: Path,
    timeout: int = 30,
    env_extra: dict[str, str] | None = None,
) -> tuple[str, str | None]:
    image = await ensure_image()
    if image is None:
        return "", "Docker 沙箱不可用: 镜像构建失败"
    rel = str(cwd.resolve())
    cmd = ["run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1"]
    cmd += ["-v", f"{rel}:/workspace:rw", "-w", "/workspace"]
    cmd += ["--name", f"ts-sandbox-{asyncio.current_task().get_name()[:24]}"]
    cmd += [image]
    cmd += args
    out, err = await _run_docker(cmd, timeout=timeout + 15)
    if err is not None:
        return out, f"Docker 执行失败: {err}"
    return out or "(无输出)", None
