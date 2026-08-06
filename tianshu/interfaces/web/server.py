from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.responses import FileResponse

from tianshu.app import TianshuApp, create_app
from tianshu.config import PROJECT_ROOT, settings
from tianshu.core.review.system import ReviewSystem


STATIC_DIR = Path(__file__).resolve().parent / "static"
HEARTBEAT_INTERVAL = 30
DB_PATH = PROJECT_ROOT / "tianshu.db"


async def _event_broadcast(agent: str, event: str, data: dict) -> None:
    payload = {"type": "agent_event", "agent": agent, "event": event, "data": data}
    for q in list(APP_STATE["event_queues"]):
        try:
            q.put_nowait(payload)
        except Exception:  # noqa: BLE001
            APP_STATE["event_queues"].discard(q)


APP_STATE: dict = {"event_queues": set()}


def build_app(provider: str | None = None) -> TianshuApp:
    t = create_app(provider_name=provider, session_db=str(DB_PATH))
    t.set_event_handler(_event_broadcast)
    return t


@asynccontextmanager
async def lifespan(app: FastAPI):
    tianshu = build_app()
    if tianshu.sessions:
        await tianshu.sessions.connect()
    app.state.tianshu = tianshu
    app.state.review_queues: set[asyncio.Queue] = set()
    _bind_review(tianshu, app.state.review_queues)
    yield
    for q in app.state.review_queues:
        q.put_nowait(None)
    if tianshu.sessions:
        await tianshu.sessions.close()


def _bind_review(tianshu: TianshuApp, queues: set[asyncio.Queue]) -> None:
    def broadcast(req) -> None:
        for q in list(queues):
            try:
                q.put_nowait(req)
            except Exception:  # noqa: BLE001
                queues.discard(q)

    tianshu.review._subscribers.clear()
    tianshu.review.subscribe(broadcast)


app = FastAPI(title="天枢", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


class AskRequest(BaseModel):
    task: str
    use_orchestrator: bool = True
    session_id: str = ""


class ReviewDecision(BaseModel):
    review_id: str
    approve: bool


class SwitchRequest(BaseModel):
    provider: str


class SessionRequest(BaseModel):
    session_id: str = ""
    title: str = ""


@app.get("/api/state")
async def get_state():
    tianshu: TianshuApp = app.state.tianshu
    return tianshu.state()


@app.get("/api/memory")
async def memory_state():
    tianshu: TianshuApp = app.state.tianshu
    out: dict = {"memory_stats": tianshu.memory_stats or {}}
    if tianshu.cache_monitor:
        out["cache"] = tianshu.cache_monitor.summary()
    if tianshu.memory:
        out["blocks"] = tianshu.memory.block_summary()
    return out


@app.get("/api/providers")
async def get_providers():
    out = []
    for p in settings.providers:
        out.append(
            {
                "name": p.name,
                "base_url": p.base_url,
                "model": p.model,
                "api_key": f"{p.api_key[:6]}..." if p.api_key else "",
            }
        )
    return {"default": settings.default_provider, "providers": out}


@app.post("/api/provider/switch")
async def provider_switch(req: SwitchRequest):
    try:
        tianshu = build_app(provider=req.provider)
    except KeyError as e:
        return {"ok": False, "error": str(e)}
    app.state.tianshu = tianshu
    _bind_review(tianshu, app.state.review_queues)
    return {"ok": True, "provider": req.provider}


@app.get("/api/sessions")
async def sessions_list():
    tianshu: TianshuApp = app.state.tianshu
    if tianshu.sessions is None:
        return {"sessions": [], "current": ""}
    return {"sessions": await tianshu.sessions.list_sessions(), "current": tianshu.current_session}


@app.post("/api/session")
async def session_new(req: SessionRequest):
    tianshu: TianshuApp = app.state.tianshu
    if tianshu.sessions is None:
        return {"ok": False, "error": "会话存储未启用"}
    sid = await tianshu.new_session(req.title)
    return {"ok": True, "session_id": sid}


@app.post("/api/session/switch")
async def session_switch(req: SessionRequest):
    tianshu: TianshuApp = app.state.tianshu
    if tianshu.sessions is None:
        return {"ok": False, "error": "会话存储未启用"}
    if not await tianshu.sessions.get_session(req.session_id):
        return {"ok": False, "error": "会话不存在"}
    tianshu.current_session = req.session_id
    return {"ok": True, "session_id": req.session_id}


@app.get("/api/session/{session_id}/messages")
async def session_messages(session_id: str):
    tianshu: TianshuApp = app.state.tianshu
    if tianshu.sessions is None:
        return {"messages": []}
    return {"messages": await tianshu.sessions.list_messages(session_id)}


@app.post("/api/ask")
async def ask(req: AskRequest):
    tianshu: TianshuApp = app.state.tianshu
    if req.session_id:
        tianshu.current_session = req.session_id
    elif not tianshu.current_session and tianshu.sessions:
        tianshu.current_session = await tianshu.new_session()
    async with tianshu.busy_lock:
        plan = await tianshu.ask(req.task, use_orchestrator=req.use_orchestrator)
    return plan.to_dict()


@app.post("/api/review/decide")
async def decide(req: ReviewDecision):
    tianshu: TianshuApp = app.state.tianshu
    ok = tianshu.review.decide(req.review_id, req.approve, by="web")
    return {"ok": ok}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    my_queue: asyncio.Queue = asyncio.Queue()
    event_queue: asyncio.Queue = asyncio.Queue()
    app.state.review_queues.add(my_queue)
    APP_STATE["event_queues"].add(event_queue)

    async def forward():
        while True:
            item = await my_queue.get()
            if item is None:
                break
            await ws.send_json({"type": "review_request", "data": item.__dict__})

    async def forward_events():
        while True:
            item = await event_queue.get()
            if item is None:
                break
            try:
                await ws.send_json(item)
            except Exception:  # noqa: BLE001
                return

    async def server_heartbeat():
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            try:
                await ws.send_json({"type": "server_ping"})
            except Exception:  # noqa: BLE001
                return

    fwd = asyncio.create_task(forward())
    evt = asyncio.create_task(forward_events())
    hb = asyncio.create_task(server_heartbeat())
    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")
            if msg_type == "ask":
                tianshu: TianshuApp = app.state.tianshu
                sid = data.get("session_id", "")
                if sid:
                    tianshu.current_session = sid
                elif not tianshu.current_session and tianshu.sessions:
                    tianshu.current_session = await tianshu.new_session()
                tianshu.clear_cancel()
                await ws.send_json({"type": "task_start"})
                if tianshu.is_busy():
                    await ws.send_json({"type": "queued", "message": "前一个任务仍在执行,当前任务排队中..."})
                async with tianshu.busy_lock:
                    plan = await tianshu.ask(data.get("task", ""), use_orchestrator=data.get("use_orchestrator", True))
                await ws.send_json({"type": "result", "data": plan.to_dict()})
            elif msg_type == "cancel":
                tianshu: TianshuApp = app.state.tianshu
                tianshu.cancel()
                await ws.send_json({"type": "cancelled"})
            elif msg_type == "review":
                tianshu: TianshuApp = app.state.tianshu
                ok = tianshu.review.decide(data.get("review_id", ""), data.get("approve", False), by="web")
                await ws.send_json({"type": "review_result", "ok": ok})
            elif msg_type in ("ping", "pong", "server_pong"):
                await ws.send_json({"type": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        app.state.review_queues.discard(my_queue)
        APP_STATE["event_queues"].discard(event_queue)
        fwd.cancel()
        evt.cancel()
        hb.cancel()