#!/usr/bin/env python3
"""CLI 가 띄우는 stdio MCP 서버 — 받은 JSON-RPC 를 엔진의 도구 다리(:mod:`xd_engine.mcp_bridge`)로 넘긴다.

XGEN 서버의 중계(xgen-workflow ``scripts/connector_mcp_bridge.py``)와 같은 동작이다:

- **표준 라이브러리만** — 파일 경로로 바로 띄운다(``python -I <이 파일>``). 엔진 패키지를 import 하지 않는다.
- **요청마다 스레드** — 모델의 병렬 도구 호출이 SDK 경로처럼 병렬로 돌고, 긴 호출이 ``tools/list`` 를 막지 않는다.
- **알림에는 답하지 않는다**(``id`` 없는 메시지).
- **전송 실패는 MCP 오류로** — CLI 가 깨진 다리를 보지 않는다.
- 호출이 도구 목록을 바꾸면(``_meta.genyToolsChanged``) ``notifications/tools/list_changed`` 를 밀고, **CLI 가 목록을
  다시 읽을 때까지 그 호출의 응답을 붙든다.** 응답이 나가는 순간 CLI 가 다음 모델 요청을 조립하므로, 재조회가 길 위에
  있으면 새 도구가 한 요청 늦게 선다(2026-09-30 Claude Code 실측: "No such tool available").

환경 변수(엔진이 CLI 의 MCP 설정에 넣는다): ``XD_MCP_URL``·``XD_MCP_TOKEN``(필수), ``XD_MCP_TIMEOUT_S``(기본 3600),
``XD_MCP_REFRESH_WAIT_S``(재조회를 기다리는 상한, 기본 3 — 다시 읽지 않는 CLI 는 이만큼만 늦는다).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.request

_URL = (os.environ.get("XD_MCP_URL", "") or "").rstrip("/")
_TOKEN = os.environ.get("XD_MCP_TOKEN", "") or ""
_TIMEOUT = float(os.environ.get("XD_MCP_TIMEOUT_S", "3600") or 3600)
_REFRESH_WAIT_S = float(os.environ.get("XD_MCP_REFRESH_WAIT_S", "3") or 3)

_WRITE_LOCK = threading.Lock()
_LIST_SERVED = threading.Condition()
_list_served_count = 0


def _arm_parent_death_signal() -> None:
    """리눅스: CLI 가 죽으면 우리도 끝난다(다리를 쥔 고아가 되지 않게). 다른 OS 는 stdin 이 닫히면 끝난다."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        import signal

        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, signal.SIGTERM, 0, 0, 0)  # PR_SET_PDEATHSIG
    except Exception:  # noqa: BLE001
        pass


def _write(message: dict) -> None:
    # 바이트로, UTF-8 로 — Windows 의 stdout 은 시스템 코드 페이지라 한국어 도구 설명에서 깨진다(-I 로 띄우므로
    # PYTHONIOENCODING 으로는 못 바꾼다). 줄바꿈도 \n 그대로(텍스트 모드는 \r\n 으로 바꾼다).
    line = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
    with _WRITE_LOCK:  # 응답 한 줄이 다른 스레드의 줄과 섞이지 않게
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()


def _err(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _forward(envelope: dict) -> dict:
    req_id = envelope.get("id")
    if not _URL or not _TOKEN:
        return _err(req_id, -32603, "bridge misconfigured: missing XD_MCP_URL or XD_MCP_TOKEN")
    req = urllib.request.Request(
        f"{_URL}/rpc",
        data=json.dumps(envelope, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return _err(req_id, -32603, f"HTTP {exc.code}")
    except urllib.error.URLError as exc:
        return _err(req_id, -32603, f"transport error: {exc.reason}")
    except Exception as exc:  # noqa: BLE001
        return _err(req_id, -32603, f"bridge error: {exc}")
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return _err(req_id, -32603, f"invalid JSON response: {body[:200]}")


def _handle(envelope: dict) -> None:
    global _list_served_count
    response = _forward(envelope)
    changed = False
    try:
        changed = bool(
            envelope.get("method") == "tools/call"
            and isinstance(response.get("result"), dict)
            and (response["result"].get("_meta") or {}).get("genyToolsChanged")
        )
    except Exception:  # noqa: BLE001
        changed = False
    if changed:
        with _LIST_SERVED:
            seen = _list_served_count
        try:
            _write({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
        except Exception:  # noqa: BLE001 — 알림이 중계를 깨지 않는다
            pass
        with _LIST_SERVED:
            _LIST_SERVED.wait_for(lambda: _list_served_count > seen, timeout=_REFRESH_WAIT_S)
    _write(response)
    if envelope.get("method") == "tools/list":
        with _LIST_SERVED:
            _list_served_count += 1
            _LIST_SERVED.notify_all()


def main() -> int:
    _arm_parent_death_signal()
    workers = []
    for raw in iter(sys.stdin.buffer.readline, b""):
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            envelope = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write(f"xd mcp shim: malformed JSON: {line[:120]}\n")
            sys.stderr.flush()
            continue
        if not isinstance(envelope, dict) or "id" not in envelope:
            continue  # 알림 — 답하지 않는다
        worker = threading.Thread(target=_handle, args=(envelope,), daemon=True)
        worker.start()
        workers = [w for w in workers if w.is_alive()] + [worker]
    for worker in workers:  # 입력이 닫혀도 받은 요청의 응답은 마저 쓴다
        worker.join(timeout=5.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
