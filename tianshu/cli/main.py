from __future__ import annotations

import asyncio
import json

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel

from tianshu.app import create_app
from tianshu.core.llm.factory import create_provider

app = typer.Typer(help="天枢 - 多 Agent 协同系统", no_args_is_help=True)
console = Console()


@app.command()
def ask(
    prompt: str,
    provider: str = typer.Option("", help="LLM provider 名称"),
    model: str = typer.Option("", help="模型名称"),
    orchestrator: bool = typer.Option(True, "--orch/--direct", help="是否走主 Agent 调度"),
    review: str = typer.Option("manual", help="审核模式: manual/auto_approve/auto_reject"),
    parallel: bool = typer.Option(True, "--parallel/--serial"),
) -> None:
    """单次提问,由主 Agent 调度子 Agent 执行。"""

    async def _run() -> None:
        tianshu = create_app(provider_name=provider or None, model=model, review_mode=review, parallel=parallel)
        plan = await tianshu.ask(prompt, use_orchestrator=orchestrator)
        if plan.subtasks:
            for st in plan.subtasks:
                console.print(
                    Panel(
                        f"[bold]{st.worker}[/bold]  {st.goal}\n"
                        f"状态: [{'green' if st.status in ('done',) else 'yellow'}]{st.status}[/]\n"
                        + (st.result.content[:2000] if st.result and st.result.content else (st.error or "")),
                        title=f"子任务 {st.id}",
                        border_style="dim",
                    )
                )
        console.print(Markdown(plan.summary or "(无输出)"))

    asyncio.run(_run())


@app.command()
def chat(
    provider: str = typer.Option("", help="LLM provider 名称"),
    model: str = typer.Option("", help="模型名称"),
    review: str = typer.Option("manual", help="审核模式"),
) -> None:
    """交互式聊天,支持多轮对话与 Agent 协同。"""

    import prompt_toolkit
    from prompt_toolkit.history import InMemoryHistory
    from prompt_toolkit.patch_stdout import patch_stdout
    from prompt_toolkit.styles import Style

    style = Style.from_dict({"prompt": "bold cyan"})

    async def _run() -> None:
        tianshu = create_app(provider_name=provider or None, model=model, review_mode=review)
        history = InMemoryHistory()
        console.print(
            Panel(
                "天枢已就绪。输入任务开始,输入 /exit 退出,输入 /agents 查看 Agent,"
                "/skills 查看技能,/approve <id> 批准审核",
                title="天枢",
            )
        )
        with patch_stdout():
            while True:
                try:
                    line = await asyncio.to_thread(
                        prompt_toolkit.prompt,
                        "你> ",
                        history=history,
                        style=style,
                    )
                except (EOFError, KeyboardInterrupt):
                    break
                cmd = line.strip()
                if not cmd:
                    continue
                if cmd in ("/exit", "/quit"):
                    break
                if cmd == "/agents":
                    console.print(", ".join(tianshu.agents))
                    continue
                if cmd == "/skills":
                    console.print(tianshu.skills.descriptions() or "(无)")
                    continue
                if cmd == "/memory":
                    if tianshu.memory:
                        blocks = tianshu.memory.load()
                        for b in blocks:
                            if b.entries:
                                console.print(f"[bold]{b.key}[/bold]")
                                for e in b.entries[:10]:
                                    console.print(f"  - {e}")
                            else:
                                console.print(f"[dim]{b.key}: (空)[/dim]")
                    else:
                        console.print("(记忆未启用)")
                    continue
                if cmd.startswith("/approve "):
                    rid = cmd.split()[-1]
                    ok = tianshu.review.decide(rid, True)
                    console.print(f"审批 {'成功' if ok else '失败(不存在或已处理)'}")
                    continue
                with console.status("天枢思考中..."):
                    plan = await tianshu.ask(cmd, use_orchestrator=True)
                for st in plan.subtasks:
                    console.print(f"[dim]· {st.worker}: {st.status}[/dim]")
                console.print(Markdown(plan.summary or "(无输出)"))

    asyncio.run(_run())


@app.command()
def state(
    provider: str = typer.Option("", help="LLM provider 名称"),
) -> None:
    """查看系统状态: Agent、技能、待审批。"""

    tianshu = create_app(provider_name=provider or None)
    console.print_json(json.dumps(tianshu.state(), ensure_ascii=False))


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", help="监听地址"),
    port: int = typer.Option(8000, help="监听端口"),
) -> None:
    """启动 Web 服务(API + 前端界面)。"""

    import uvicorn

    from tianshu.interfaces.web.server import app

    uvicorn.run(app, host=host, port=port)


@app.command()
def desktop(
    port: int = typer.Option(8000, help="内部服务端口"),
) -> None:
    """启动桌面端应用(原生窗口或浏览器回退)。"""

    from tianshu.interfaces.desktop.launcher import run

    run(port=port)


@app.command()
def mockllm(
    host: str = typer.Option("127.0.0.1"),
    port: int = typer.Option(9100),
) -> None:
    """启动本地 mock LLM 服务(离线端到端验证,无需真实 key)。

    配合用法:
      echo 'TIANSHU_DEFAULT_PROVIDER=mock' > /tmp/ts-mock.env
      TIANSHU_ENV=/tmp/... tianshu ask "..."  # 或临时改 .env
    """

    import uvicorn

    from tianshu.interfaces.web.mock_llm import app as mock_app

    uvicorn.run(mock_app, host=host, port=port)


@app.command()
def providers() -> None:
    """列出支持的 LLM 厂商。"""

    from tianshu.core.llm.factory import available_providers

    console.print("支持的 provider:", ", ".join(available_providers()))


@app.command()
def doctor(
    timeout: float = typer.Option(15.0, help="连接测试超时(秒)"),
) -> None:
    """检查配置与模型连接是否正常。"""

    import asyncio as _asyncio

    from tianshu.config import get_provider
    from tianshu.core.llm.base import LLMMessage

    async def _run() -> None:
        cfg = get_provider()
        console.print(f"[bold]当前默认 Provider:[/bold] {cfg.name}")
        console.print(f"  base_url: {cfg.base_url}")
        console.print(f"  model:    {cfg.model}")
        console.print(f"  api_key:  {'已配置 ' + cfg.api_key[:8] + '...' if cfg.api_key else '(未配置)'}")
        provider = create_provider(cfg.name, cfg.base_url, cfg.model, cfg.api_key, temperature=cfg.temperature, max_tokens=cfg.max_tokens, timeout=timeout)
        with console.status("发送测试请求..."):
            try:
                result = await provider.chat(
                    [LLMMessage(role="user", content="回复'连接正常'四个字即可")]
                )
            except Exception as e:  # noqa: BLE001
                console.print(f"[red]连接失败: {e}[/red]")
                return
        console.print(f"[green]连接正常[/green],模型回复: {result.content[:200]}")

    _asyncio.run(_run())


def main() -> None:
    app()


if __name__ == "__main__":
    main()