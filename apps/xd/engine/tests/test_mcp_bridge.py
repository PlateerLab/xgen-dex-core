"""CLI 턴의 도구 다리 — 루프백 서버 + stdio 중계를 실제 프로세스로."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

import pytest

from xd_engine.mcp_bridge import ToolBridge

SHIM = Path(__file__).resolve().parents[1] / "xd_engine" / "mcp_shim.py"


class FakeSurface:
    """런타임 TurnToolSurface 의 겉모양 — Guide 를 부르면 숨긴 도구가 열린다."""

    def __init__(self) -> None:
        self.opened = False
        self.calls: List[str] = []

    def _tools(self) -> List[Dict[str, Any]]:
        tools = [{"name": "Guide", "description": "문을 연다 — 한국어 설명", "inputSchema": {"type": "object"}}]
        if self.opened:
            tools.append({"name": "Hidden", "description": "열린 도구", "inputSchema": {"type": "object"}})
        return tools

    def tools_list(self) -> List[Dict[str, Any]]:
        return self._tools()

    def exposed_names(self):
        return tuple(sorted(t["name"] for t in self._tools()))

    async def call(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        self.calls.append(name)
        if name == "Guide":
            self.opened = True
            return {"content": [{"type": "text", "text": "열었습니다"}], "isError": False}
        if name == "Boom":
            raise RuntimeError("boom")
        return {"content": [{"type": "text", "text": f"ran {name} {json.dumps(arguments, ensure_ascii=False)}"}], "isError": False}


class Shim:
    def __init__(self, bridge: ToolBridge, refresh_wait: str = "3") -> None:
        env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
        env.update({"XD_MCP_URL": bridge.url, "XD_MCP_TOKEN": bridge.token, "XD_MCP_REFRESH_WAIT_S": refresh_wait})
        self.proc = subprocess.Popen([sys.executable, "-I", str(SHIM)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.lines: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in iter(self.proc.stdout.readline, b""):
            self.lines.put(json.loads(raw.decode("utf-8")))

    def send(self, message: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def next(self, timeout: float = 10.0) -> dict:
        return self.lines.get(timeout=timeout)

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait(timeout=10)


@pytest.fixture
def bridge():
    surface = FakeSurface()
    b = ToolBridge(surface).start()
    b.surface = surface  # type: ignore[attr-defined]
    yield b
    b.stop()


def test_initialize_list_and_call_through_the_shim(bridge):
    shim = Shim(bridge)
    shim.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    init = shim.next()
    assert init["result"]["capabilities"]["tools"]["listChanged"] is True
    shim.send({"jsonrpc": "2.0", "method": "notifications/initialized"})  # 알림 — 답이 없어야 한다
    shim.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    listed = shim.next()
    assert listed["id"] == 2
    assert listed["result"]["tools"][0]["description"] == "문을 연다 — 한국어 설명"
    shim.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "Other", "arguments": {"q": "값"}}})
    called = shim.next()
    assert called["id"] == 3 and called["result"]["content"][0]["text"] == 'ran Other {"q": "값"}'
    assert "_meta" not in called["result"]
    shim.close()


def test_a_call_that_opens_tools_waits_for_the_cli_to_relist(bridge):
    shim = Shim(bridge)
    shim.send({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "Guide", "arguments": {}}})
    note = shim.next()
    assert note == {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
    # CLI 가 목록을 다시 읽기 전에는 호출 응답이 오지 않는다
    with pytest.raises(queue.Empty):
        shim.next(timeout=0.5)
    shim.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    first, second = shim.next(), shim.next()
    assert first["id"] == 2 and [t["name"] for t in first["result"]["tools"]] == ["Guide", "Hidden"]
    assert second["id"] == 1 and second["result"]["_meta"]["genyToolsChanged"] is True
    shim.close()


def test_a_cli_that_never_relists_only_waits_the_limit(bridge):
    shim = Shim(bridge, refresh_wait="0.3")
    started = time.monotonic()
    shim.send({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "Guide", "arguments": {}}})
    assert shim.next()["method"] == "notifications/tools/list_changed"
    assert shim.next()["id"] == 1
    assert time.monotonic() - started < 3
    shim.close()


def test_failures_are_protocol_errors(bridge):
    shim = Shim(bridge)
    shim.send({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "Boom", "arguments": {}}})
    assert shim.next()["error"]["message"] == "boom"
    shim.send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "X", "arguments": "text"}})
    assert shim.next()["error"]["code"] == -32602
    shim.send({"jsonrpc": "2.0", "id": 3, "method": "nope"})
    assert shim.next()["error"]["code"] == -32601
    shim.close()


def test_requests_without_the_token_are_refused(bridge):
    req = urllib.request.Request(f"{bridge.url}/rpc", data=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}', method="POST")
    with pytest.raises(urllib.error.HTTPError) as info:
        urllib.request.urlopen(req, timeout=5)
    assert info.value.code == 401


def test_a_stopped_bridge_becomes_a_transport_error():
    b = ToolBridge(FakeSurface()).start()
    shim = Shim(b)
    b.stop()
    shim.send({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert "transport error" in shim.next()["error"]["message"]
    shim.close()
