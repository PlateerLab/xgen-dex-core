"""사용자 MCP 서버 — 연결 풀(턴을 넘어 산다)·도구 이름·데몬 턴."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

from daemon_proc import DaemonProc, turn
from xd_engine.mcp_pool import McpPool, McpServerSpec, McpSpecError
from xd_engine.mcp_tools import MAX_TOOL_NAME, tool_name

DEMO = str(Path(__file__).parent / "fakes" / "mcp_demo.py")


def demo(slug: str = "demo", **extra) -> McpServerSpec:
    return McpServerSpec.parse({"slug": slug, "label": "Demo", "transport": "stdio", "command": sys.executable, "args": [DEMO], **extra})


def call(pool: McpPool, agent: str, slug: str, tool: str, args=None):
    import asyncio

    return asyncio.run_coroutine_threadsafe(pool.call(agent, slug, tool, args or {}, 30), pool.loop).result(40)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def test_spec_rules():
    with pytest.raises(McpSpecError):
        McpServerSpec.parse({"slug": "Bad_Slug", "command": "x"})
    for reserved in ("local", "mobile", "web", "connector"):
        with pytest.raises(McpSpecError):
            McpServerSpec.parse({"slug": reserved, "command": "x"})
    with pytest.raises(McpSpecError):
        McpServerSpec.parse({"slug": "a", "transport": "stdio"})
    with pytest.raises(McpSpecError):
        McpServerSpec.parse({"slug": "a", "transport": "http", "url": "file:///x"})
    a = McpServerSpec.parse({"slug": "a", "command": "x", "env": {"K": "1"}})
    b = McpServerSpec.parse({"slug": "a", "command": "x", "env": {"K": "2"}})
    assert a.fingerprint() != b.fingerprint()  # 비밀 값이 바뀌어도 다시 붙는다


def test_tool_names_fit_and_are_stable():
    assert tool_name("github", "create_issue") == "mcp_github_create_issue"
    long = "x" * 200
    n = tool_name("abcdefghijkl", long)
    assert len(n) <= MAX_TOOL_NAME and n == tool_name("abcdefghijkl", long)
    assert len("mcp__connector__" + n) <= 64
    # 다른 이름이 같은 앞부분으로 다듬어져도 겹치지 않는다
    assert tool_name("s", "a.b") != tool_name("s", "a_b")
    assert all(c.isalnum() or c in "_-" for c in tool_name("s", "한글 도구!"))


def test_pool_connects_calls_and_keeps_the_connection_across_turns(tmp_path):
    pool = McpPool()
    try:
        spec = demo(env={"DEMO_TOKEN": "t1"})
        views = pool.ensure("a1", [spec], cwd=str(tmp_path), wait_s=60)
        assert [(v.slug, v.state) for v in views] == [("demo", "connected")], views
        assert sorted(t["name"] for t in views[0].tools) == ["boom", "echo", "slow", "where"]
        assert call(pool, "a1", "demo", "echo", {"text": "hi"}) == {"content": [{"type": "text", "text": "echo: hi"}], "isError": False}
        failed = call(pool, "a1", "demo", "boom")
        assert failed["isError"] is True and "boom from the server" in failed["content"][0]["text"]
        cwd, pid, token = call(pool, "a1", "demo", "where")["content"][0]["text"].split("|")
        assert Path(cwd).resolve() == tmp_path.resolve() and token == "t1"
        # 같은 설정이면 같은 프로세스를 다시 쓴다
        pool.ensure("a1", [spec], cwd=str(tmp_path), wait_s=60)
        assert call(pool, "a1", "demo", "where")["content"][0]["text"].split("|")[1] == pid
        # 비밀(env)이 바뀌면 다시 붙는다 — 옛 프로세스는 닫힌다
        pool.ensure("a1", [demo(env={"DEMO_TOKEN": "t2"})], cwd=str(tmp_path), wait_s=60)
        _, pid2, token2 = call(pool, "a1", "demo", "where")["content"][0]["text"].split("|")
        assert pid2 != pid and token2 == "t2"
        if sys.platform != "win32":
            for _ in range(50):
                if not _alive(int(pid)):
                    break
                time.sleep(0.1)
            assert not _alive(int(pid))
        # 목록에서 빠지면 닫는다
        assert pool.ensure("a1", [], cwd=str(tmp_path), wait_s=5) == []
        assert not pool.has_agent("a1")
    finally:
        pool.close_all()


def test_a_failing_server_does_not_stop_the_others(tmp_path):
    pool = McpPool()
    try:
        bad = McpServerSpec.parse({"slug": "bad", "command": sys.executable, "args": [DEMO, "--crash"]})
        missing = McpServerSpec.parse({"slug": "nope", "command": str(tmp_path / "no-such-program")})
        views = pool.ensure("a1", [demo(), bad, missing], cwd=str(tmp_path), wait_s=60)
        states = {v.slug: (v.state, v.error) for v in views}
        assert states["demo"][0] == "connected"
        assert states["bad"][0] == "failed" and states["bad"][1]
        assert states["nope"][0] == "failed" and states["nope"][1]
        assert call(pool, "a1", "demo", "echo", {"text": "still"})["content"][0]["text"] == "echo: still"
    finally:
        pool.close_all()


def test_close_all_leaves_no_server_process(tmp_path):
    pool = McpPool()
    pool.ensure("a1", [demo()], cwd=str(tmp_path), wait_s=60)
    pid = int(call(pool, "a1", "demo", "where")["content"][0]["text"].split("|")[1])
    pool.close_all()
    if sys.platform != "win32":
        for _ in range(50):
            if not _alive(pid):
                break
            time.sleep(0.1)
        assert not _alive(pid)


def test_daemon_turn_uses_mcp_tools_and_reports_servers(tmp_path):
    root = tmp_path / "XD"
    d = DaemonProc(
        root,
        script={
            "responses": [
                {"tools": [{"name": "mcp_demo_echo", "input": {"text": "from the turn"}}]},
                {"text": "done"},
            ]
        },
        tmp=tmp_path,
    )
    try:
        d.until(lambda e: e["type"] == "ready")
        servers = [
            {"slug": "demo", "label": "Demo", "transport": "stdio", "command": sys.executable, "args": [DEMO]},
            {"slug": "broken", "label": "Broken", "transport": "stdio", "command": str(tmp_path / "missing")},
        ]
        d.send(turn("t1", agent={"mcp_servers": servers}))
        end = d.terminal("t1", timeout=120)
        assert end["type"] == "done", d.of("t1")
        status = next(e for e in d.of("t1") if e["type"] == "mcp")
        assert [(s["slug"], s["state"]) for s in status["servers"]] == [("demo", "connected"), ("broken", "failed")]
        assert status["servers"][0]["tools"] == 4
        results = [e["event"] for e in d.of("t1") if e["type"] == "tool" and e["event"].get("type") == "tool_result"]
        assert any("echo: from the turn" in str(r) for r in results), results
        # [연결 확인]
        d.send({"type": "mcp_test", "id": "q1", "server": servers[0]})
        ok = d.until(lambda e: e["type"] == "mcp_test_result" and e["id"] == "q1", timeout=90)
        assert ok["ok"] is True and sorted(t["name"] for t in ok["tools"]) == ["boom", "echo", "slow", "where"]
        d.send({"type": "mcp_test", "id": "q2", "server": servers[1]})
        bad = d.until(lambda e: e["type"] == "mcp_test_result" and e["id"] == "q2", timeout=90)
        assert bad["ok"] is False and bad["error"]
    finally:
        assert d.close() == 0


def _wait(pred, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.1)
    return False


@pytest.mark.skipif(sys.platform == "win32", reason="SIGKILL")
def test_a_dead_server_is_noticed_and_reconnected(tmp_path):
    import signal

    pool = McpPool(ping_every_s=0.5)
    try:
        pool.ensure("a1", [demo()], cwd=str(tmp_path), wait_s=60)
        pid = int(call(pool, "a1", "demo", "where")["content"][0]["text"].split("|")[1])
        os.kill(pid, signal.SIGKILL)
        assert _wait(lambda: pool.snapshot("a1", ["demo"])[0].state == "failed"), pool.snapshot("a1", ["demo"])
        started = time.monotonic()
        with pytest.raises(Exception):
            call(pool, "a1", "demo", "echo", {"text": "x"})
        assert time.monotonic() - started < 5
        # 다음 턴은 곧바로 다시 붙는다(설정이 틀린 것이 아니라 죽은 것이다)
        views = pool.ensure("a1", [demo()], cwd=str(tmp_path), wait_s=60)
        assert views[0].state == "connected"
        assert call(pool, "a1", "demo", "echo", {"text": "back"})["content"][0]["text"] == "echo: back"
    finally:
        pool.close_all()


@pytest.mark.skipif(sys.platform == "win32", reason="process checks")
def test_concurrent_ensures_leave_no_orphan_process(tmp_path):
    import threading

    pids = tmp_path / "pids.txt"
    pool = McpPool()
    try:
        errors = []

        def go(token):
            try:
                pool.ensure("a1", [demo(env={"DEMO_TOKEN": token, "DEMO_PIDS": str(pids)})], cwd=str(tmp_path), wait_s=60)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=go, args=(f"t{i}",)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        assert not errors
    finally:
        pool.close_all()
    started = [int(x) for x in pids.read_text().split()]
    assert len(started) >= 1
    assert _wait(lambda: not any(_alive(p) for p in started)), [p for p in started if _alive(p)]


def test_a_running_turn_keeps_its_servers_open(tmp_path):
    pool = McpPool(idle_close_s=0.5)
    try:
        pool.acquire("a1")
        pool.ensure("a1", [demo()], cwd=str(tmp_path), wait_s=60)
        time.sleep(2.0)  # 빌려 간 동안은 오래 안 써도 닫지 않는다
        assert pool.has_agent("a1")
        assert call(pool, "a1", "demo", "echo", {"text": "late"})["content"][0]["text"] == "echo: late"
        pool.release("a1")
        assert _wait(lambda: not pool.has_agent("a1"), timeout=10)
    finally:
        pool.close_all()


def test_a_call_in_flight_ends_when_its_server_closes(tmp_path):
    import asyncio
    import threading

    pool = McpPool()
    try:
        pool.ensure("a1", [demo()], cwd=str(tmp_path), wait_s=60)
        out = {}

        def slow():
            started = time.monotonic()
            try:
                asyncio.run_coroutine_threadsafe(pool.call("a1", "demo", "slow", {"seconds": 30}, 60), pool.loop).result(70)
            except Exception as exc:  # noqa: BLE001
                out["error"] = str(exc)
            out["took"] = time.monotonic() - started

        t = threading.Thread(target=slow)
        t.start()
        time.sleep(1.0)
        pool.close_agent("a1")
        t.join(20)
        assert "stopped" in out.get("error", ""), out
        assert out["took"] < 15
    finally:
        pool.close_all()


def test_error_text_hides_url_secrets():
    from xd_engine.mcp_pool import short_error

    msg = short_error(RuntimeError("Client error '401' for url 'https://user:pw@api.example.com/mcp?key=SECRETQ&x=1'"))
    assert "SECRETQ" not in msg and "pw@" not in msg and "api.example.com/mcp" in msg


def test_an_invalid_server_does_not_block_the_turn(tmp_path):
    root = tmp_path / "XD"
    d = DaemonProc(root, script={"responses": [{"text": "ok"}]}, tmp=tmp_path)
    try:
        d.until(lambda e: e["type"] == "ready")
        d.send(turn("t1", agent={"mcp_servers": [{"slug": "bad", "label": "Bad", "transport": "http", "url": "ftp://x"}]}))
        assert d.terminal("t1", timeout=60)["type"] == "done"
        status = next(e for e in d.of("t1") if e["type"] == "mcp")
        assert [(s["label"], s["state"]) for s in status["servers"]] == [("Bad", "failed")]
    finally:
        assert d.close() == 0


def test_a_long_tool_call_is_not_mistaken_for_a_dead_server(tmp_path):
    """요청을 하나씩 처리하는 서버(시험 서버의 slow 는 이벤트 루프를 막는다)도 긴 호출 중에 죽은 것으로 보지 않는다."""
    import asyncio

    # ping 이 0.5초 안에 답을 못 받으면 늦은 것 — 3초 호출 동안 묻는다면 세 번 넘게 늦어 죽은 것으로 볼 것이다.
    pool = McpPool(ping_every_s=0.3, ping_timeout_s=0.5)
    try:
        pool.ensure("a1", [demo()], cwd=str(tmp_path), wait_s=60)
        res = asyncio.run_coroutine_threadsafe(pool.call("a1", "demo", "slow", {"seconds": 3}, 30), pool.loop).result(40)
        assert res["content"][0]["text"] == "slept"
        assert pool.snapshot("a1", ["demo"])[0].state == "connected"
    finally:
        pool.close_all()


def test_stdio_server_stderr_goes_to_its_own_log(tmp_path):
    """서버가 요청마다 쓰는 줄(FastMCP 는 ping 도 적는다)이 엔진 로그를 밀어내지 않게 — 서버마다 따로."""
    pool = McpPool(log_dir=str(tmp_path / "logs"))
    try:
        pool.ensure("a1", [demo()], cwd=str(tmp_path), wait_s=60)
        call(pool, "a1", "demo", "echo", {"text": "x"})
    finally:
        pool.close_all()
    assert (tmp_path / "logs" / "demo.log").exists()


def test_closed_detection_is_by_kind_not_by_words():
    from mcp.shared.exceptions import McpError
    from mcp.types import CONNECTION_CLOSED, ErrorData
    from xd_engine.mcp_pool import _is_closed

    assert _is_closed(McpError(ErrorData(code=CONNECTION_CLOSED, message="Connection closed")))
    # 도구가 낸 실패가 그 말을 담아도 끊긴 것이 아니다
    assert not _is_closed(McpError(ErrorData(code=-32603, message="database connection closed by peer")))
    assert not _is_closed(RuntimeError("connection closed"))
