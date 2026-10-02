"""데몬을 실제 프로세스로 띄워 프로토콜 v1 을 확인한다 — 가짜 LLM(xd_fake)으로 키·네트워크 없이."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from daemon_proc import RM_RF, DaemonProc, turn

TERMINALS = ("done", "error", "cancelled")


def _terminals(d: DaemonProc, turn_id: str):
    return [e for e in d.of(turn_id) if e["type"] in TERMINALS]


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "XD"


def _daemon(root: Path, tmp_path: Path, responses=None) -> DaemonProc:
    return DaemonProc(root, script={"responses": responses or []}, tmp=tmp_path)


def test_ready_ping_and_nothing_but_protocol_on_stdout(root, tmp_path):
    d = _daemon(root, tmp_path)
    ready = d.until(lambda e: e["type"] == "ready")
    assert ready["protocol"] == 1
    assert ready["runtime"] and ready["python"].startswith("3.")
    assert Path(ready["root"]) == root.resolve()
    d.send({"type": "ping", "id": "p1"})
    assert d.until(lambda e: e["type"] == "pong")["id"] == "p1"
    assert d.close() == 0
    assert (root / "workspace").is_dir() and (root / ".xd").is_dir()
    assert not [e for e in d.seen if e["type"] == "__garbage__"]


def test_tool_turn_runs_to_the_end_and_the_model_sees_the_result(root, tmp_path):
    d = _daemon(root, tmp_path, [
        {"text": "making it", "tools": [{"name": "Write", "input": {"file_path": "notes/hello.txt", "content": "hi there"}}]},
        {"text": "wrote notes/hello.txt"},
    ])
    d.send(turn("t1"))
    end = d.terminal("t1")
    assert end["type"] == "done", d.seen
    kinds = [e["type"] for e in d.of("t1")]
    assert kinds[0] == "started"
    tool_events = [e["event"]["type"] for e in d.of("t1") if e["type"] == "tool"]
    assert tool_events == ["tool_call", "tool_result"]
    assert "".join(e["text"] for e in d.of("t1") if e["type"] == "chunk") == "wrote notes/hello.txt"
    assert any(e["type"] == "usage" for e in d.of("t1"))
    assert len(_terminals(d, "t1")) == 1
    # 파일은 그 에이전트의 작업 공간에, 엔진 상태는 .xd 에.
    assert (root / "workspace" / "Tester" / "notes" / "hello.txt").read_text(encoding="utf-8") == "hi there"
    assert (root / ".xd" / "agents" / "a1" / "memory").is_dir()
    assert not (root / "workspace" / "Tester" / "memory").exists()
    # 두 번째 요청의 마지막 메시지가 도구 결과 — 모델이 결과를 보고 답했다.
    reqs = [r for r in d.requests() if r["purpose"] != "memory.structured"]
    assert len(reqs) >= 2
    assert "tool_result" in str(reqs[1]["last"])
    assert d.close() == 0


def test_history_reaches_the_model(root, tmp_path):
    d = _daemon(root, tmp_path, [{"text": "ok"}])
    history = [{"role": "user", "content": "earlier question"}, {"role": "assistant", "content": "earlier answer"}]
    d.send(turn("t1", history=history))
    assert d.terminal("t1")["type"] == "done"
    first = d.requests()[0]
    assert first["count"] == 3
    d.close()


def test_runtime_failure_is_one_error_event_not_text(root, tmp_path):
    d = _daemon(root, tmp_path, [{"error": "upstream exploded"}])
    d.send(turn("t1"))
    end = d.terminal("t1")
    assert end["type"] == "error" and end["code"] == "runtime"
    assert "upstream exploded" in end["message"]
    assert not any("[ERROR]" in e.get("text", "") for e in d.of("t1") if e["type"] == "chunk")
    assert len(_terminals(d, "t1")) == 1
    d.close()


@pytest.mark.parametrize(
    "agent,config,needle",
    [
        ({"workspace": "../escape"}, {}, "workspace folder name"),
        ({"workspace": "CON"}, {}, "workspace folder name"),
        ({"id": "../a1"}, {}, "agent id"),
        ({}, {"provider": "anthropic", "model": "claude-x"}, "no API key"),
        ({}, {"provider": "claude_code", "model": "sonnet"}, "not available"),
        ({"folders": ["relative/path"]}, {}, "absolute"),
    ],
)
def test_bad_requests_end_with_one_error(root, tmp_path, agent, config, needle):
    d = _daemon(root, tmp_path)
    d.send(turn("t1", agent=agent, config=config))
    end = d.terminal("t1")
    assert end["type"] == "error" and end["code"] == "bad_request", end
    assert needle in end["message"]
    assert [e["type"] for e in d.of("t1")] == ["started", "error"]
    assert not (root / "escape").exists()
    d.close()


def test_one_turn_per_conversation(root, tmp_path):
    d = _daemon(root, tmp_path, [{"tools": [{"name": "Bash", "input": {"command": "sleep 5"}}]}, {"text": "slept"}])
    d.send({"type": "configure", "dangerous": []})
    d.until(lambda e: e["type"] == "configured")
    d.send(turn("t1"))
    d.until(lambda e: e.get("id") == "t1" and e["type"] == "tool")
    d.send(turn("t2"))
    end2 = d.terminal("t2")
    assert end2["type"] == "error" and end2["code"] == "busy"
    d.send({"type": "cancel", "id": "t1"})
    assert d.terminal("t1")["type"] == "cancelled"
    d.close()


def test_cancel_stops_a_running_tool_quickly(root, tmp_path):
    d = _daemon(root, tmp_path, [{"tools": [{"name": "Bash", "input": {"command": "sleep 30"}}]}, {"text": "never"}])
    d.send({"type": "configure", "dangerous": []})
    d.until(lambda e: e["type"] == "configured")
    d.send(turn("t1"))
    d.until(lambda e: e.get("id") == "t1" and e["type"] == "tool")
    d.send({"type": "cancel", "id": "t1"})
    end = d.terminal("t1", timeout=20)
    assert end["type"] == "cancelled"
    assert len(_terminals(d, "t1")) == 1
    assert not any(e.get("text") == "never" for e in d.of("t1"))
    d.close()


def test_shutdown_cancels_running_turns_before_exit(root, tmp_path):
    d = _daemon(root, tmp_path, [{"tools": [{"name": "Bash", "input": {"command": "sleep 30"}}]}])
    d.send({"type": "configure", "dangerous": []})
    d.until(lambda e: e["type"] == "configured")
    d.send(turn("t1"))
    d.until(lambda e: e.get("id") == "t1" and e["type"] == "tool")
    assert d.close(timeout=30) == 0
    assert [e["type"] for e in _terminals(d, "t1")] == ["cancelled"]


def test_dangerous_command_denied_is_not_run(root, tmp_path):
    keep = root / "workspace" / "Tester" / "keep"
    keep.mkdir(parents=True)
    d = _daemon(root, tmp_path, [
        {"tools": [{"name": "Bash", "input": {"command": "rm -rf keep"}}]},
        {"text": "the user said no"},
    ])
    d.send({"type": "configure", "dangerous": [RM_RF]})
    d.until(lambda e: e["type"] == "configured")
    d.send(turn("t1"))
    ask = d.until(lambda e: e["type"] == "approval_request")
    assert ask["id"] == "t1" and ask["command"] == "rm -rf keep"
    d.send({"type": "approval_reply", "id": "t1", "request": ask["request"], "answer": "deny"})
    assert d.terminal("t1")["type"] == "done"
    result = [e["event"] for e in d.of("t1") if e["type"] == "tool" and e["event"]["type"] != "tool_call"][0]
    assert "user_denied" in str(result)
    assert keep.is_dir()
    d.close()


def test_session_approval_covers_the_conversation_only(root, tmp_path):
    d = _daemon(root, tmp_path, [
        {"tools": [{"name": "Bash", "input": {"command": "echo rm -rf a"}}]},
        {"tools": [{"name": "Bash", "input": {"command": "echo rm -rf b"}}]},
        {"text": "both ran"},
    ])
    d.send({"type": "configure", "dangerous": [RM_RF]})
    d.until(lambda e: e["type"] == "configured")
    d.send(turn("t1", conversation="c1"))
    ask = d.until(lambda e: e["type"] == "approval_request")
    d.send({"type": "approval_reply", "id": "t1", "request": ask["request"], "answer": "session"})
    assert d.terminal("t1")["type"] == "done"
    assert len([e for e in d.of("t1") if e["type"] == "approval_request"]) == 1
    # 다른 대화에서는 다시 묻는다.
    d.send(turn("t2", conversation="c2"))
    ask2 = d.until(lambda e: e["type"] == "approval_request" and e["id"] == "t2")
    d.send({"type": "approval_reply", "id": "t2", "request": ask2["request"], "answer": "once"})
    d.until(lambda e: e["type"] == "approval_request" and e["id"] == "t2" and e["request"] != ask2["request"])
    d.send({"type": "cancel", "id": "t2"})
    assert d.terminal("t2")["type"] == "cancelled"
    d.close()


def test_batch_runs_go_through_the_same_gate(root, tmp_path):
    keep = root / "workspace" / "Tester" / "keep"
    keep.mkdir(parents=True)
    d = _daemon(root, tmp_path, [
        {"tools": [{"name": "ToolBatch", "input": {"tool": "Bash", "inputs": [{"command": "rm -rf keep"}]}}]},
        {"text": "done"},
    ])
    d.send({"type": "configure", "dangerous": [RM_RF]})
    d.until(lambda e: e["type"] == "configured")
    d.send(turn("t1"))
    ask = d.until(lambda e: e["type"] == "approval_request")
    d.send({"type": "approval_reply", "id": "t1", "request": ask["request"], "answer": "deny"})
    assert d.terminal("t1")["type"] == "done"
    assert keep.is_dir()
    d.close()


def test_without_rules_every_shell_command_asks(root, tmp_path):
    d = _daemon(root, tmp_path, [{"tools": [{"name": "Bash", "input": {"command": "echo harmless"}}]}, {"text": "ok"}])
    d.send(turn("t1"))
    ask = d.until(lambda e: e["type"] == "approval_request")
    assert ask["command"] == "echo harmless"
    d.send({"type": "approval_reply", "id": "t1", "request": ask["request"], "answer": "once"})
    assert d.terminal("t1")["type"] == "done"
    result = [e["event"] for e in d.of("t1") if e["type"] == "tool" and e["event"]["type"] == "tool_result"][0]
    assert "harmless" in result["result"]
    d.close()


def test_file_tools_stay_inside_workspace_and_linked_folders(root, tmp_path):
    linked = tmp_path / "linked"
    linked.mkdir()
    outside = tmp_path / "outside.txt"
    d = _daemon(root, tmp_path, [
        {"tools": [
            {"name": "Write", "input": {"file_path": str(linked / "in-linked.txt"), "content": "linked ok"}},
            {"name": "Write", "input": {"file_path": str(outside), "content": "should not exist"}},
        ]},
        {"text": "done"},
    ])
    d.send(turn("t1", agent={"folders": [str(linked)]}))
    assert d.terminal("t1")["type"] == "done"
    assert (linked / "in-linked.txt").read_text(encoding="utf-8") == "linked ok"
    assert not outside.exists()
    results = [e["event"] for e in d.of("t1") if e["type"] == "tool" and e["event"]["type"] != "tool_call"]
    assert len(results) == 2
    assert any(r["type"] == "tool_error" or "outside" in str(r).lower() or "not allowed" in str(r).lower() for r in results)
    d.close()


def test_linked_folder_inside_state_is_refused(root, tmp_path):
    d = _daemon(root, tmp_path)
    d.until(lambda e: e["type"] == "ready")
    d.send(turn("t1", agent={"folders": [str(root / ".xd")]}))
    end = d.terminal("t1")
    assert end["type"] == "error" and end["code"] == "bad_request"
    d.close()


def test_protocol_errors_do_not_kill_the_daemon(root, tmp_path):
    d = _daemon(root, tmp_path)
    d.send_raw(b"this is not json\n")
    d.until(lambda e: e["type"] == "protocol_error")
    d.send({"type": "nope"})
    d.until(lambda e: e["type"] == "protocol_error" and "nope" in e["message"])
    d.send({"type": "configure", "dangerous": [{"source": "(", "flags": "i"}]})
    d.until(lambda e: e["type"] == "protocol_error" and "dangerous" in e["message"])
    d.send({"type": "approval_reply", "id": "ghost", "request": "x", "answer": "once"})
    d.until(lambda e: e["type"] == "protocol_error" and "approval_reply" in e["message"])
    d.send({"type": "ping", "id": "still-alive"})
    assert d.until(lambda e: e["type"] == "pong")["id"] == "still-alive"
    assert d.close() == 0


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_unusable_root_is_fatal(tmp_path):
    blocker = tmp_path / "file-not-dir"
    blocker.write_text("x")
    d = DaemonProc(blocker / "XD", tmp=tmp_path)
    fatal = d.until(lambda e: e["type"] == "fatal")
    assert "root folder unusable" in fatal["message"]
    assert d.close() == 2


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process check")
def test_cancel_leaves_no_process_behind(root, tmp_path):
    """취소한 셸 명령이 띄운 자식까지 끝난다(런타임 4.83.1 — 그 전에는 고아로 남았다)."""
    import os
    import time

    d = _daemon(root, tmp_path, [{"tools": [{"name": "Bash", "input": {"command": "sleep 30 & echo $! > child.txt; wait"}}]}])
    d.send({"type": "configure", "dangerous": []})
    d.until(lambda e: e["type"] == "configured")
    d.send(turn("t1"))
    child_file = root / "workspace" / "Tester" / "child.txt"
    deadline = time.monotonic() + 20
    while not (child_file.exists() and child_file.read_text().strip()):
        assert time.monotonic() < deadline, d.seen
        time.sleep(0.05)
    child = int(child_file.read_text().strip())
    d.send({"type": "cancel", "id": "t1"})
    assert d.terminal("t1")["type"] == "cancelled"

    def alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        stat = Path(f"/proc/{pid}/stat")
        return not (stat.exists() and stat.read_text().rsplit(")", 1)[1].split()[0] == "Z")

    deadline = time.monotonic() + 5
    while alive(child) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not alive(child), "the cancelled command's child is still running"
    d.close()
