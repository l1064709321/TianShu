from __future__ import annotations

import pytest

from tianshu.core.session import SessionStore


@pytest.fixture
async def store(tmp_path):
    s = SessionStore(tmp_path / "test.db")
    await s.connect()
    yield s
    await s.close()


@pytest.mark.asyncio
async def test_session_lifecycle(store):
    sid = await store.create_session("测试会话", "mock", "m-model")
    assert len(sid) == 12

    sessions = await store.list_sessions()
    assert sessions[0]["title"] == "测试会话"
    assert sessions[0]["provider"] == "mock"
    assert sessions[0]["model"] == "m-model"

    got = await store.get_session(sid)
    assert got["id"] == sid


@pytest.mark.asyncio
async def test_messages_roundtrip(store):
    sid = await store.create_session("s", "mock", "m")
    await store.add_message(sid, "user", "你好")
    await store.add_message(sid, "orchestrator", "你好,我是天枢")
    msgs = await store.list_messages(sid)
    assert [m["role"] for m in msgs] == ["user", "orchestrator"]
    assert msgs[1]["content"] == "你好,我是天枢"


@pytest.mark.asyncio
async def test_save_orchestration(store):
    sid = await store.create_session("s", "mock", "m")
    await store.save_orchestration(
        sid,
        task="任务",
        summary="汇总结果",
        subtasks=[{"worker": "w1", "goal": "g1", "status": "done"}],
    )
    msgs = await store.list_messages(sid)
    assert msgs[-1]["role"] == "orchestrator"
    assert msgs[-1]["content"] == "汇总结果"


@pytest.mark.asyncio
async def test_persist_across_reconnect(tmp_path):
    path = tmp_path / "p.db"

    s1 = SessionStore(path)
    await s1.connect()
    sid = await s1.create_session("持久", "mock", "m")
    await s1.add_message(sid, "user", "断线前的问题")
    await s1.close()

    s2 = SessionStore(path)
    await s2.connect()
    sessions = await s2.list_sessions()
    assert sessions[0]["id"] == sid
    msgs = await s2.list_messages(sid)
    assert msgs[0]["content"] == "断线前的问题"
    await s2.close()