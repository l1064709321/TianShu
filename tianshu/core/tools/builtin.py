from __future__ import annotations

import asyncio
import ipaddress
import os
import shlex
import subprocess
import urllib.parse
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
import httpx

from tianshu.config import WORKSPACE_DIR
from tianshu.core.tools.registry import ToolRegistry, RAW

SHELL_ALLOWED = {
    "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "pwd",
    "echo", "sort", "uniq", "diff", "tree", "stat", "file", "which",
    "python", "python3", "pip", "pip3", "pytest", "git", "node", "npm", "npm.cmd",
}

SHELL_BANNED_FLAGS = {"-rf", "--recursive", "-exec", "-execdir", "-delete", ">", ">>", "|", ";", "&&", "||", "$(", "`"}


async def run_shell_guarded(command: str, timeout: int = 30, cwd: Path = WORKSPACE_DIR) -> str:
    low = command.lower()
    for flag in SHELL_BANNED_FLAGS:
        if flag in low:
            raise PermissionError(f"禁止命令中的危险语法: {flag}")
    parts = shlex.split(command)
    if not parts:
        raise PermissionError("命令为空")
    cmd = parts[0].split("/")[-1]
    if cmd not in SHELL_ALLOWED:
        raise PermissionError(f"禁止的命令: {cmd} (仅允许: {', '.join(sorted(SHELL_ALLOWED))})")
    from tianshu.core.sandbox.manager import run_in_sandbox

    out, err = await run_in_sandbox(parts, cwd, timeout=timeout)
    if err:
        return f"错误: {err}"
    return out


def _is_private_host(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast


async def fetch_url_guarded(url: str, timeout: int = 30) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise PermissionError(f"仅允许 http/https 协议: {parsed.scheme}")
    host = parsed.hostname or ""
    if _is_private_host(host):
        raise PermissionError(f"禁止访问内网地址: {host}")
    try:
        resolved = set()
        for info in await asyncio.get_running_loop().getaddrinfo(host, None):
            resolved.add(info[4][0])
    except OSError as e:
        raise PermissionError(f"域名解析失败: {host}") from e
    for ip in resolved:
        if _is_private_host(ip):
            raise PermissionError(f"域名解析到内网地址,已拦截: {ip}")
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(url, headers={"User-Agent": "Tianshu/0.1"})
        resp.raise_for_status()
    if "text/html" in resp.headers.get("content-type", ""):
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "noscript", "svg"]):
            tag.decompose()
        return soup.get_text(separator="\n", strip=True)[:20000]
    return resp.text[:20000]


def _ensure_inside_workspace(p: Path) -> Path:
    p = p.resolve()
    ws = WORKSPACE_DIR.resolve()
    if p != ws and ws not in p.parents:
        raise PermissionError(f"禁止访问工作区外的路径: {p}")
    return p


def _resolve(path: str) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = WORKSPACE_DIR / p
    return p.resolve()


def register_builtin_tools(registry: ToolRegistry) -> None:
    @registry.decorator("read_file", description="读取文件内容", format_result=RAW)
    async def read_file(path: str) -> str:
        p = _ensure_inside_workspace(_resolve(path))
        return p.read_text(encoding="utf-8")

    @registry.decorator("write_file", description="写入文件(覆盖),目录不存在时自动创建", requires_review=True)
    async def write_file(path: str, content: str) -> str:
        p = _ensure_inside_workspace(_resolve(path))
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"已写入 {path} ({len(content)} 字符)"

    @registry.decorator("list_dir", description="列出目录内容", format_result=RAW)
    async def list_dir(path: str = ".") -> str:
        p = _ensure_inside_workspace(_resolve(path))
        entries = sorted(os.listdir(p), key=str.lower)
        lines = []
        for e in entries:
            ep = p / e
            kind = "D" if ep.is_dir() else "F"
            lines.append(f"{kind} {e}")
        return "\n".join(lines) if lines else "(空目录)"

    @registry.decorator("run_shell", description="在本地执行 shell 命令,仅允许白名单读取类命令", requires_review=True)
    async def run_shell(command: str, timeout: int = 30) -> str:
        return await run_shell_guarded(command, timeout)

    @registry.decorator("fetch_url", description="抓取网页内容并转为纯文本(禁止内网)", format_result=RAW)
    async def fetch_url(url: str, timeout: int = 30) -> str:
        return await fetch_url_guarded(url, timeout)

    @registry.decorator("search_files", description="按 glob 模式搜索工作区文件", format_result=RAW)
    async def search_files(pattern: str) -> str:
        hits = [str(p.relative_to(WORKSPACE_DIR)) for p in WORKSPACE_DIR.glob(pattern)]
        return "\n".join(hits) if hits else "(无匹配)"