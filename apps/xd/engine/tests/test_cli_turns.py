"""실제 claude·codex CLI 로 도는 턴 — 모델만 가짜(Anthropic SSE · OpenAI Responses SSE, 키 없음).

CLI 가 이 PC 에 없으면 건너뛴다(CI 에는 없다 — 실제 CLI 로는 로컬과 M6 설치본에서 본다). 보는 것:
도구는 XD 도구 다리(MCP `connector`)로만 닿고(네이티브 0), 그 도구가 작업 공간에서 실제로 돌며, 턴이 종결 하나로 끝난다.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

from daemon_proc import DaemonProc, turn
from fakes.fake_anthropic import FakeAnthropic
from fakes.fake_responses import FakeResponses


def _find(name: str, *extra: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for p in extra:
        if Path(p).expanduser().exists():
            return str(Path(p).expanduser())
    return None


CLAUDE = os.environ.get("XD_TEST_CLAUDE") or _find("claude", "~/.local/bin/claude")
CODEX = os.environ.get("XD_TEST_CODEX") or _find("codex", "~/.local/codex-cli/bin/codex")


def _tool_events(d: DaemonProc, turn_id: str):
    return [e["event"] for e in d.of(turn_id) if e["type"] == "tool"]


@pytest.mark.skipif(not CLAUDE, reason="claude CLI not installed")
def test_claude_code_turn_uses_only_the_xd_tool_bridge(tmp_path):
    root = tmp_path / "XD"
    model = FakeAnthropic([
        lambda body: ("tool", "mcp__connector__Write", {"file_path": "from-claude.txt", "content": "via-cli"}),
        lambda body: ("text", "done-claude"),
    ])
    d = DaemonProc(root, tmp=tmp_path)
    d.send({"type": "configure", "dangerous": []})
    d.until(lambda e: e["type"] == "configured")
    home = tmp_path / "claude-home"
    home.mkdir()
    d.send(turn("t1", config={
        "provider": "claude_code", "model": "sonnet", "api_key": "sk-ant-test",
        "base_url": f"http://127.0.0.1:{model.port}",
        "cli": {"binary": CLAUDE, "home": str(home), "auth": "api_key", "timeout_s": 120},
    }))
    end = d.terminal("t1", timeout=180)
    d.close()
    assert end["type"] == "done", (end, (tmp_path / "engine-stderr.log").read_text()[-3000:])
    assert (root / "workspace" / "Tester" / "from-claude.txt").read_text() == "via-cli"
    text = "".join(e["text"] for e in d.of("t1") if e["type"] == "chunk")
    assert "done-claude" in text
    assert any(ev.get("tool_name", "").endswith("Write") for ev in _tool_events(d, "t1"))
    # 모델이 본 도구는 XD 다리의 것뿐이다(네이티브 0개), 그리고 이 PC 를 말하는 실행 환경 안내가 갔다.
    first = model.main[0]
    names = [t["name"] for t in first.get("tools", [])]
    assert names and all(n.startswith("mcp__connector__") for n in names), names
    assert {"mcp__connector__Write", "mcp__connector__Read", "mcp__connector__Bash"} <= set(names)
    assert "no server and no sandbox" in str(first.get("system"))


@pytest.mark.skipif(not CODEX, reason="codex CLI not installed")
def test_codex_turn_uses_only_the_xd_tool_bridge(tmp_path):
    root = tmp_path / "XD"
    model = FakeResponses([
        lambda body: ("tool", "Write", {"file_path": "from-codex.txt", "content": "via-codex"}),
        lambda body: ("text", "done-codex"),
    ])
    d = DaemonProc(root, tmp=tmp_path)
    d.send({"type": "configure", "dangerous": []})
    d.until(lambda e: e["type"] == "configured")
    home = tmp_path / "codex-home"
    home.mkdir()
    d.send(turn("t1", config={
        "provider": "codex", "model": "gpt-5.3-codex", "api_key": "sk-test",
        "base_url": f"http://127.0.0.1:{model.port}/v1",
        "cli": {"binary": CODEX, "home": str(home), "auth": "api_key", "timeout_s": 120},
    }))
    end = d.terminal("t1", timeout=180)
    d.close()
    assert end["type"] == "done", (end, (tmp_path / "engine-stderr.log").read_text()[-3000:])
    assert (root / "workspace" / "Tester" / "from-codex.txt").read_text() == "via-codex"
    text = "".join(e["text"] for e in d.of("t1") if e["type"] == "chunk")
    assert "done-codex" in text
    first = model.main[0]
    spaces = [t for t in first.get("tools", []) if t.get("type") == "namespace"]
    assert [s.get("name") for s in spaces] == ["mcp__connector"], first.get("tools")
    inner = {x.get("name") for x in spaces[0].get("tools", [])}
    assert {"Write", "Read", "Bash"} <= inner
    # codex 가 끌 수 없는 것만 남는다: MCP 리소스 조회 셋(우리 다리는 빈 목록을 답한다)과 request_user_input
    # (exec 모드에서 codex 가 스스로 "지원 안 함" 으로 돌려준다). 셸·파일·웹·이미지 같은 네이티브는 없다.
    natives = {t.get("name") for t in first.get("tools", []) if t.get("type") != "namespace"}
    assert natives <= {"list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "request_user_input"}, natives
