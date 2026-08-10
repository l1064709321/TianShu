from __future__ import annotations

import json
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


def build_mock_app() -> FastAPI:
    """本地 OpenAI 兼容 mock 服务,用于无 key 端到端验证全流程。"""

    app = FastAPI(title="tianshu-mock-llm")

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.post("/v1/chat/completions")
    async def chat(req: Request):
        body = await req.json()
        messages = body.get("messages", [])
        tools = body.get("tools", [])
        last_user = ""
        for m in reversed(messages):
            if m.get("role") in ("user", "tool") and isinstance(m.get("content"), str):
                last_user = m["content"]
                break

        tool_names = [t["function"]["name"] for t in tools]
        content = last_user
        has_user_msg = any(m.get("role") == "user" for m in messages)

        if tools and has_user_msg:
            if not _contains_tool_result(messages):
                first = tool_names[0]
                fn = _pick_tool_fn(first, last_user)
                return _resp(
                    content=None,
                    tool_calls=[
                        {
                            "id": "call_mock_1",
                            "type": "function",
                            "function": {"name": first, "arguments": json.dumps(fn, ensure_ascii=False)},
                        }
                    ],
                )

        return _resp(content=f"[mock 回复] 收到: {content[:100]}")

    return app


def _contains_tool_result(messages: list[dict]) -> bool:
    return any(m.get("role") == "tool" for m in messages)


def _pick_tool_fn(name: str, last_user: str) -> dict:
    if name == "call_agent":
        return {"agent": "assistant", "task": last_user}
    if name == "fetch_url":
        m = re.search(r"https?://\S+", last_user)
        return {"url": m.group(0) if m else "https://example.com"}
    if name in ("read_file", "write_file"):
        if name == "read_file":
            return {"path": "workspace/test.txt"}
        return {"path": "workspace/test.txt", "content": last_user}
    if name == "run_shell":
        return {"command": "echo mock"}
    if name == "load_skill":
        return {"name": "chat"}
    if name == "produce_plan":
        return {
            "subtasks": [
                {"worker": "assistant", "goal": last_user},
            ]
        }
    if name == "list_dir":
        return {}
    return {}


def _resp(content: str | None, tool_calls: list | None = None) -> JSONResponse:
    msg: dict = {}
    if content is not None:
        msg["content"] = content
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return JSONResponse(
        {
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 1,
                "total_tokens": 101,
                "prompt_tokens_details": {"cached_tokens": 60},
                "prompt_cache_hit_tokens": 60,
                "prompt_cache_miss_tokens": 40,
            },
        }
    )


app = build_mock_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=9100)