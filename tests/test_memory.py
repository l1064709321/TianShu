from pathlib import Path

from tianshu.core.memory import ProjectMemory, approx_tokens, load_conversation_context


def make_memory(tmp_path: Path) -> ProjectMemory:
    return ProjectMemory(tmp_path / "PROJECT_MEMORY.md")


def test_approx_tokens():
    assert approx_tokens("abc def") == 2
    assert approx_tokens("你好世界") == 4
    assert approx_tokens("hello 世界 foo") == 4


def test_add_and_persist(tmp_path):
    m = make_memory(tmp_path)
    m.add_entry("goals", "做一个对标 opencode 的多 Agent 系统")
    assert tmp_path.joinpath("PROJECT_MEMORY.md").exists()
    m2 = make_memory(tmp_path)
    blocks = m2.load()
    assert any(b.key == "goals" and b.entries for b in blocks)


def test_max_per_block(tmp_path):
    m = make_memory(tmp_path)
    for i in range(15):
        m.add_entry("progress", f"进度条目 {i}", max_per_block=10)
    blocks = m.load()
    prog = next(b for b in blocks if b.key == "progress")
    assert len(prog.entries) == 10
    assert prog.entries[0] == "进度条目 14"


def test_select_core_always_injected(tmp_path):
    m = make_memory(tmp_path)
    m.add_entry("goals", "构建天枢系统")
    m.add_entry("progress", "实现编排器")
    out = m.select("")
    assert "[goals]" in out
    assert "构建天枢系统" in out
    assert "实现编排器" not in out


def test_select_relevant_block_only(tmp_path):
    m = make_memory(tmp_path)
    m.add_entry("progress", "实现了 Web 前端实时活动可视化")
    m.add_entry("progress", "修复了会话竞态 bug")
    out = m.select("前端页面怎么做的", budget=5000)
    assert "前端" in out
    assert "会话竞态" not in out


def test_select_token_budget(tmp_path):
    m = make_memory(tmp_path)
    for i in range(50):
        m.add_entry("progress", f"长条目内容{'数据' * 30}{i}")
    m.add_entry("goals", "目标块")
    out = m.select("", budget=120)
    assert approx_tokens(out) <= 120 + 60


def test_update_from_result(tmp_path):
    m = make_memory(tmp_path)

    class St:
        task = "修复前端 bug"
        summary = "修好了复制按钮"
        subtasks = []  # noqa: RUF012

    ok = m.update_from_result(St())
    assert ok["memorized"]
    blocks = m.load()
    prog = next(b for b in blocks if b.key == "progress")
    assert any("修复前端 bug" in e for e in prog.entries)


def test_update_from_result_error_blocker(tmp_path):
    m = make_memory(tmp_path)

    class St:
        task = "部署服务"
        summary = ""

        class S:
            worker = "ops"
            error = "端口占用"

        subtasks = [S()]  # noqa: RUF012

    m.update_from_result(St())
    blocks = m.load()
    blk = next(b for b in blocks if b.key == "blockers")
    assert any("端口占用" in e for e in blk.entries)


def test_load_conversation_context_limit():
    msgs = [
        {"role": "user", "content": f"问题{i}"}
        for i in range(20)
    ]
    out = load_conversation_context(msgs, max_msgs=5, max_tokens=100000)
    assert out.count("问题") == 5


def test_empty_context():
    assert load_conversation_context([]) == ""


def test_build_summarize_prompt():
    from tianshu.core.memory import build_summarize_prompt
    msgs = [
        {"role": "user", "content": "我们决定用 Python"},
        {"role": "assistant", "content": "好的"},
    ]
    out = build_summarize_prompt("旧摘要", msgs)
    assert out[0]["role"] == "system"
    assert "旧摘要" in out[1]["content"]
    assert "我们决定用 Python" in out[1]["content"]


async def test_summary_table_roundtrip(tmp_path):

    from tianshu.core.session import SessionStore
    db = tmp_path / "s.db"
    store = SessionStore(db)
    await store.connect()
    await store.save_summary("s1", "摘要内容", covered=5)
    got = await store.get_summary("s1")
    assert got and got["summary"] == "摘要内容"
    assert got["covered"] == 5
    assert await store.get_summary("nope") is None
    await store.close()
