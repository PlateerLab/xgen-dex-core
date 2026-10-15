"""CLI 턴의 도구 다리 — 런타임의 턴 도구 표면(``TurnToolSurface``)을 루프백 MCP JSON-RPC 로 연다.

CLI(claude·codex)는 자기 에이전트 루프를 갖고 바깥 도구를 MCP 로만 받는다. 그래서 CLI 에게 주는 도구는
SDK 경로와 **같은 레지스트리**여야 하고(런타임이 턴마다 조립한 표면), 실행도 같은 자리(Stage 10, 턴 루프)여야
한다. 이 모듈이 그 표면을 127.0.0.1 의 HTTP 로 열고, CLI 는 :mod:`xd_engine.mcp_shim`(stdio)을 통해 붙는다.

메서드 집합과 응답 모양은 XGEN 서버의 브릿지(xgen-workflow ``controller/tools/connectorMcpInternal.py``)와
같다 — 같은 CLI 가 두 곳에서 같은 응답을 본다. 표면이 호출로 바뀌면(문이 방을 열거나 ToolSearch 가 숨긴 도구를
열면) 결과에 ``_meta.genyToolsChanged`` 를 찍어 중계가 ``list_changed`` 를 밀게 한다.

턴마다 하나 띄우고 턴이 끝나면 닫는다. 토큰이 없으면 답하지 않는다(같은 PC 의 다른 프로세스가 도구를 부를 수
없게).
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

logger = logging.getLogger("xd_engine.mcp_bridge")

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "xd-tools"
SERVER_VERSION = "1"
RPC_PATH = "/rpc"


class ToolBridge:
    """한 턴의 도구 표면을 여는 루프백 서버."""

    def __init__(self, surface: Any) -> None:
        self._surface = surface
        self.token = secrets.token_urlsafe(32)
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self.url = ""

    def start(self) -> "ToolBridge":
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 — http.server 계약
                if self.path != RPC_PATH or self.headers.get("Authorization", "") != f"Bearer {bridge.token}":
                    self._send(401, {"error": "unauthorized"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", 0))
                    envelope = json.loads(self.rfile.read(length).decode("utf-8"))
                    if not isinstance(envelope, dict):
                        raise ValueError("not an object")
                except Exception:  # noqa: BLE001 — 깨진 요청도 프로토콜 응답으로
                    self._send(200, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                    return
                self._send(200, bridge.dispatch(envelope))

            def _send(self, status: int, payload: Dict[str, Any]) -> None:
                raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args: Any) -> None:
                return

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._httpd.daemon_threads = True
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="xd-tool-bridge", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        """턴이 끝났다 — 절대 던지지 않는다(정리 실패가 턴을 깨지 않는다)."""
        httpd, self._httpd = self._httpd, None
        if httpd is None:
            return
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:  # noqa: BLE001
            logger.debug("tool bridge stop failed", exc_info=True)

    # ── JSON-RPC ─────────────────────────────────────────────────────
    def dispatch(self, envelope: Dict[str, Any]) -> Dict[str, Any]:
        req_id = envelope.get("id")
        method = str(envelope.get("method") or "")
        params = envelope.get("params") or {}

        def ok(result: Any) -> Dict[str, Any]:
            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        def err(code: int, message: str) -> Dict[str, Any]:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

        if method == "initialize":
            return ok(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": {"listChanged": True},
                        "resources": {"listChanged": False, "subscribe": False},
                        "prompts": {"listChanged": False},
                        "logging": {},
                    },
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                }
            )
        if method in ("notifications/initialized", "logging/setLevel", "ping"):
            return ok({})
        if method == "resources/list":
            return ok({"resources": []})
        if method == "resources/templates/list":
            return ok({"resourceTemplates": []})
        if method == "prompts/list":
            return ok({"prompts": []})
        if method == "completion/complete":
            return ok({"completion": {"values": [], "total": 0, "hasMore": False}})
        if method == "tools/list":
            return ok({"tools": self._surface.tools_list()})
        if method == "tools/call":
            name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            if not name:
                return err(-32602, "missing tool name")
            if not isinstance(arguments, dict):
                return err(-32602, "arguments must be an object")
            before = self._surface.exposed_names()
            try:
                # 표면의 call 은 턴 루프로 넘겨 실행한다 — 이 스레드에는 그 결과를 기다릴 루프만 있으면 된다.
                result = asyncio.run(self._surface.call(name, dict(arguments)))
            except Exception as exc:  # noqa: BLE001 — 실행 실패도 모델에게 돌아가는 결과다
                logger.warning("tool bridge: %s failed", name, exc_info=True)
                return err(-32603, str(exc))
            if self._surface.exposed_names() != before:
                result = {**result, "_meta": {**dict(result.get("_meta") or {}), "genyToolsChanged": True}}
            return ok(result)
        return err(-32601, f"method not found: {method}")
