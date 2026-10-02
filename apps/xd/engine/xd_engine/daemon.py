"""상주 데몬 — 명령을 읽고, 턴을 스레드에서 돌리고, 사건을 낸다.

명령(stdin, 한 줄에 하나)::

    {"type": "ping", "id"?}                          → pong
    {"type": "configure", "dangerous": [{source, flags}]}  → configured
    {"type": "turn", "id", "conversation", "text", "history"?, "agent": {...}, "config": {...}}
    {"type": "cancel", "id"}
    {"type": "approval_reply", "id", "request", "answer": "once" | "session" | "deny"}
    {"type": "models", "id", "provider", "api_key"?, "base_url"?}   → models_result
    {"type": "shutdown"}

사건(stdout)::

    ready{protocol, runtime, python, platform}
    started{id} · chunk{id, text} · tool{id, event} · progress{id, event} · usage{id, usage}
    approval_request{id, request, command}
    done{id} | error{id, code, message} | cancelled{id}      ← 턴마다 정확히 하나
    pong · configured · protocol_error{message}
    models_result{id, ok, models: [{id, display_name}], error?}   ← 제공자가 실제로 내는 모델(=연결 시험)

**턴마다 종결 사건은 정확히 하나다** (취소 > 실패 > 끝). 런타임은 실패를 예외가 아니라 ``[ERROR]`` 글로
흘리므로 여기서 읽어 ``error`` 로 바꾼다 — 그 글은 ``chunk`` 로 내보내지 않는다.
"""

from __future__ import annotations

import argparse
import logging
import platform
import re
import sys
import threading
from dataclasses import dataclass, field
from typing import Any, BinaryIO, Dict, List, Optional

from xd_engine import PROTOCOL_VERSION
from xd_engine.host import CLI_PROVIDERS, CliSetup, TurnSetup, XdHostServices
from xd_engine.layout import Layout, LayoutError, check_folder_name, check_id
from xd_engine.protocol import Channel, claim_stdout, read_commands
from xd_engine.safety import ANSWERS, ApprovalGate, compile_patterns

logger = logging.getLogger("xd_engine.daemon")

#: API 키가 있어야 도는 제공자 — 없으면 턴을 시작하지 않고 원인을 말한다(서버도 같다).
_KEY_REQUIRED = ("openai", "anthropic", "google")

#: 런타임의 실패 글. 스트림 도중이면 앞에 줄바꿈이 붙는다(host/runner.py ``f"\n[ERROR] {…}"``).
_RAW_ERROR = re.compile(r"^\s*\[ERROR\] ?(.*)$", re.DOTALL)
#: 실행 전 검사의 실패 글 ``[ERROR104: …]`` (host/param_validator.py).
_CODED_ERROR = re.compile(r"^\s*\[ERROR(\d{3}): ?(.*)\]\s*$", re.DOTALL)

#: 턴 하나가 런타임에 넘기는 값 중 main 이 정할 수 있는 것(그 밖의 키는 받지 않는다).
_OPTION_KEYS = (
    "temperature",
    "max_tokens",
    "max_iterations",
    "thinking",
    "context_window",
    "tool_exposure",
    "enable_compaction",
    "memory_distill",
)


class BadRequest(ValueError):
    pass


@dataclass
class Turn:
    id: str
    conversation: str
    cancel: threading.Event = field(default_factory=threading.Event)
    thread: Optional[threading.Thread] = None
    #: 승인 요청 id → (대답을 기다리는 Event, 대답).
    approvals: Dict[str, List[Any]] = field(default_factory=dict)
    approvals_lock: threading.Lock = field(default_factory=threading.Lock)
    approval_seq: int = 0


def classify_error_chunk(text: str, *, first: bool) -> Optional[tuple[str, str]]:
    """런타임의 실패 글이면 (code, message), 아니면 None.

    모델의 글이 우연히 ``[ERROR]`` 로 시작하는 것과 구분하려고 자리를 본다: 스트림 도중의 실패는
    런타임이 **줄바꿈을 앞에 붙여** 조각 하나로 낸다. 줄바꿈 없는 ``[ERROR] …`` 는 첫 조각일 때만
    (시작하지 못한 턴은 그 글 하나만 낸다).
    """
    m = _CODED_ERROR.match(text)
    if m and first:
        return f"E{m.group(1)}", m.group(2).strip()
    if text.startswith("\n[ERROR] ") or (first and text.startswith("[ERROR] ")):
        m = _RAW_ERROR.match(text)
        detail = (m.group(1) if m else text).strip()
        if detail.startswith("geny agent could not start:"):
            return "start", detail.split(":", 1)[1].strip()
        return "runtime", detail
    return None


class Daemon:
    def __init__(self, channel: Channel, layout: Layout) -> None:
        self.out = channel
        self.layout = layout
        self.gate = ApprovalGate()
        self._turns: Dict[str, Turn] = {}
        self._lock = threading.Lock()

    # ── 수명 ─────────────────────────────────────────────────────────
    def ready_event(self) -> Dict[str, Any]:
        try:
            from importlib.metadata import version

            runtime = version("xgen-agent-runtime")
        except Exception:  # noqa: BLE001
            runtime = ""
        return {
            "type": "ready",
            "protocol": PROTOCOL_VERSION,
            "runtime": runtime,
            "python": platform.python_version(),
            "platform": sys.platform,
            "root": str(self.layout.root),
        }

    def serve(self, stdin: BinaryIO) -> None:
        self.out.emit(self.ready_event())
        for command, problem in read_commands(stdin):
            if command is None:
                self.out.emit({"type": "protocol_error", "message": problem})
                continue
            if command.get("type") == "shutdown":
                break
            try:
                self.handle(command)
            except Exception as exc:  # noqa: BLE001 — 명령 하나가 데몬을 죽이지 않는다
                logger.exception("command failed")
                self.out.emit({"type": "protocol_error", "message": f"{type(exc).__name__}: {exc}"})
        self.stop()

    def stop(self, timeout: float = 10.0) -> None:
        """도는 턴을 모두 멈추고 끝나기를 기다린다 — 정리(teardown)가 돌 시간을 준다."""
        with self._lock:
            turns = list(self._turns.values())
        for turn in turns:
            turn.cancel.set()
            self._release_approvals(turn)
        for turn in turns:
            if turn.thread is not None:
                turn.thread.join(timeout)

    # ── 명령 ─────────────────────────────────────────────────────────
    def handle(self, cmd: Dict[str, Any]) -> None:
        kind = cmd.get("type")
        if kind == "ping":
            self.out.emit({"type": "pong", "id": cmd.get("id")})
        elif kind == "configure":
            self._configure(cmd)
        elif kind == "turn":
            self._start_turn(cmd)
        elif kind == "cancel":
            turn = self._turns.get(str(cmd.get("id") or ""))
            if turn is not None:
                turn.cancel.set()
                self._release_approvals(turn)
        elif kind == "approval_reply":
            self._approval_reply(cmd)
        elif kind == "models":
            threading.Thread(target=self._models, args=(cmd,), name="models", daemon=True).start()
        else:
            self.out.emit({"type": "protocol_error", "message": f"unknown command type: {kind!r}"})

    def _configure(self, cmd: Dict[str, Any]) -> None:
        if "dangerous" in cmd:
            try:
                patterns = compile_patterns(cmd.get("dangerous") or [])
            except Exception as exc:  # noqa: BLE001 — 규칙을 일부만 받지 않는다(전과 같이 둔다)
                self.out.emit({"type": "protocol_error", "message": f"dangerous patterns rejected: {exc}"})
                return
            self.gate.configure(patterns)
        self.out.emit({"type": "configured", "dangerous": self.gate.pattern_count})

    # ── 턴 ───────────────────────────────────────────────────────────
    def _start_turn(self, cmd: Dict[str, Any]) -> None:
        turn_id = str(cmd.get("id") or "")
        if not turn_id:
            self.out.emit({"type": "protocol_error", "message": "turn needs an id"})
            return
        conversation = str(cmd.get("conversation") or "")
        with self._lock:
            if turn_id in self._turns:
                self.out.emit({"type": "protocol_error", "message": f"turn {turn_id!r} is already running"})
                return
            busy = any(t.conversation == conversation for t in self._turns.values())
            turn = Turn(id=turn_id, conversation=conversation)
            if not busy:
                self._turns[turn_id] = turn
        if busy:
            self._terminal(turn, ("busy", "This conversation already has a turn running."))
            return
        thread = threading.Thread(target=self._run_turn, args=(turn, cmd), name=f"turn-{turn_id}", daemon=True)
        turn.thread = thread
        thread.start()

    def _run_turn(self, turn: Turn, cmd: Dict[str, Any]) -> None:
        self.out.emit({"type": "started", "id": turn.id})
        failure: Optional[tuple[str, str]] = None
        stream: Any = None
        try:
            setup, kwargs = self._prepare(turn, cmd)
            host = XdHostServices(setup, self.gate, lambda command: self._ask(turn, command))
            from xgen_agent_runtime.host.turn_executor import AgentTurnExecutor

            stream = AgentTurnExecutor().run(host, **kwargs)
            first = True
            for item in stream:
                if isinstance(item, str):
                    found = classify_error_chunk(item, first=first)
                    first = False
                    if found is not None:
                        failure = failure or found
                    elif item:
                        self.out.emit({"type": "chunk", "id": turn.id, "text": item})
                    continue
                first = False
                if not isinstance(item, dict):
                    continue
                kind = item.get("type")
                data = item.get("data")
                if kind == "usage":
                    self.out.emit({"type": "usage", "id": turn.id, "usage": data})
                elif kind == "agent_event" and isinstance(data, dict):
                    sub = str(data.get("type") or "")
                    name = "tool" if sub.startswith("tool_") else "progress"
                    self.out.emit({"type": name, "id": turn.id, "event": data})
        except BadRequest as exc:
            failure = ("bad_request", str(exc))
        except Exception as exc:  # noqa: BLE001 — 어떤 실패도 종결 사건 하나로 끝난다
            logger.exception("turn %s failed", turn.id)
            failure = ("internal", f"{type(exc).__name__}: {exc}")
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()  # 제너레이터 정리(파이프라인 닫기·턴 정리)를 여기서 끝낸다
                except Exception:  # noqa: BLE001
                    logger.warning("turn %s teardown failed", turn.id, exc_info=True)
            with self._lock:
                self._turns.pop(turn.id, None)
            self._terminal(turn, failure)

    def _terminal(self, turn: Turn, failure: Optional[tuple[str, str]]) -> None:
        if turn.cancel.is_set():
            self.out.emit({"type": "cancelled", "id": turn.id})
        elif failure is not None:
            self.out.emit({"type": "error", "id": turn.id, "code": failure[0], "message": failure[1]})
        else:
            self.out.emit({"type": "done", "id": turn.id})

    def _prepare(self, turn: Turn, cmd: Dict[str, Any]) -> tuple[TurnSetup, Dict[str, Any]]:
        """명령 → (호스트 설정, 실행기 인자). 틀린 값은 BadRequest — 턴을 시작하지 않는다."""
        agent = cmd.get("agent")
        config = cmd.get("config")
        if not isinstance(agent, dict) or not isinstance(config, dict):
            raise BadRequest("turn needs 'agent' and 'config' objects")
        try:
            agent_id = check_id(agent.get("id"), "agent id")
            conversation = check_id(turn.conversation, "conversation id")
            workspace = check_folder_name(agent.get("workspace"))
            missing: List[str] = []
            linked = self.layout.linked_folders(agent.get("folders") or [], missing)
        except LayoutError as exc:
            raise BadRequest(str(exc)) from exc
        if missing:
            # 없어진 폴더는 빼고 간다 — 화면은 main 이 따로 알린다.
            logger.warning("turn %s: skipping missing linked folders %s", turn.id, missing)

        provider = str(config.get("provider") or "").strip()
        model = str(config.get("model") or "").strip()
        if not provider or not model:
            raise BadRequest("config needs 'provider' and 'model'")
        api_key = str(config.get("api_key") or "")
        cli: Optional[CliSetup] = None
        if provider in CLI_PROVIDERS:
            spec = config.get("cli")
            if not isinstance(spec, dict) or not spec.get("binary") or not spec.get("home"):
                raise BadRequest(f"{provider} needs config.cli with binary and home")
            auth = str(spec.get("auth") or "oauth")
            if auth not in ("oauth", "api_key"):
                raise BadRequest(f"unknown CLI auth {auth!r}")
            if auth == "api_key" and not api_key:
                raise BadRequest(f"no API key for {provider}")
            cli = CliSetup(
                binary=str(spec["binary"]),
                home=str(spec["home"]),
                auth=auth,
                timeout_s=float(spec.get("timeout_s") or 3600.0),
            )
        elif provider in _KEY_REQUIRED and not api_key:
            raise BadRequest(f"no API key for {provider}")
        settings = config.get("settings") or {}
        if not isinstance(settings, dict):
            raise BadRequest("config.settings must be an object")

        setup = TurnSetup(
            layout=self.layout,
            agent_id=agent_id,
            agent_name=str(agent.get("name") or ""),
            workspace_name=workspace,
            conversation_id=conversation,
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=str(config.get("base_url") or "") or None,
            credentials=config.get("credentials") if isinstance(config.get("credentials"), dict) else None,
            linked_folders=linked,
            settings={str(k): str(v) for k, v in settings.items() if v is not None},
            cli=cli,
        )
        history = cmd.get("history")
        kwargs: Dict[str, Any] = {
            "text": cmd.get("text") or "",
            "streaming": True,
            "tool_events": True,
            "provider": provider,
            "model": model,
            "workflow_id": agent_id,
            "workflow_name": setup.agent_name,
            "user_id": "local",
            # 대화 id 가 기억의 대화 칸(STM)과 취소 범위를 정한다.
            "interaction_id": conversation,
            "response_io_id": turn.id,
            "client_surface": "xd",
            "memory": history if isinstance(history, list) else None,
            "enable_memory": bool(agent.get("memory", True)),
            # 자기 워크플로 편집은 서버의 것 — XD 에는 워크플로가 없다.
            "enable_self_evolution": False,
            "cancel_check": turn.cancel.is_set,
        }
        if "system_prompt" in agent and agent.get("system_prompt") is not None:
            kwargs["system_prompt"] = str(agent.get("system_prompt"))
        for key in _OPTION_KEYS:
            if key in config and config[key] is not None:
                kwargs[key] = config[key]
        return setup, kwargs

    # ── 모델 목록 ────────────────────────────────────────────────────
    def _models(self, cmd: Dict[str, Any]) -> None:
        """제공자가 지금 내는 모델 — 런타임의 discover_models 그대로(XGEN 과 같은 코드). 키·주소가 맞는지도 이걸로 본다.

        실패는 예외가 아니라 ``ok: false`` 와 짧은 까닭이다(키가 틀렸다·서버가 꺼졌다).
        """
        request_id = cmd.get("id")
        try:
            import asyncio

            from xgen_agent_runtime.llm_client.model_discovery import discover_models

            result = asyncio.run(
                discover_models(
                    str(cmd.get("provider") or ""),
                    api_key=str(cmd.get("api_key") or "") or None,
                    base_url=str(cmd.get("base_url") or "") or None,
                )
            )
            models = [{"id": m.id, "display_name": m.display_name} for m in result.models]
            event: Dict[str, Any] = {"type": "models_result", "id": request_id, "ok": bool(models), "models": models}
            if not models:
                event["error"] = result.error or "no models"
        except Exception as exc:  # noqa: BLE001 — 목록 조회 실패가 데몬을 흔들지 않는다
            logger.warning("model discovery failed", exc_info=True)
            event = {"type": "models_result", "id": request_id, "ok": False, "models": [], "error": str(exc)}
        self.out.emit(event)

    # ── 승인 ─────────────────────────────────────────────────────────
    def _ask(self, turn: Turn, command: str) -> str:
        """그 턴의 승인 요청을 내보내고 대답을 기다린다. 취소되면 거부."""
        with turn.approvals_lock:
            turn.approval_seq += 1
            request_id = f"{turn.id}:{turn.approval_seq}"
            waiter = [threading.Event(), "deny"]
            turn.approvals[request_id] = waiter
        if turn.cancel.is_set():
            return "deny"
        self.out.emit({"type": "approval_request", "id": turn.id, "request": request_id, "command": command})
        waiter[0].wait()
        with turn.approvals_lock:
            turn.approvals.pop(request_id, None)
        return "deny" if turn.cancel.is_set() else str(waiter[1])

    def _approval_reply(self, cmd: Dict[str, Any]) -> None:
        turn = self._turns.get(str(cmd.get("id") or ""))
        answer = str(cmd.get("answer") or "")
        if turn is None or answer not in ANSWERS:
            self.out.emit({"type": "protocol_error", "message": "approval_reply needs a running turn id and a valid answer"})
            return
        with turn.approvals_lock:
            waiter = turn.approvals.get(str(cmd.get("request") or ""))
        if waiter is None:
            self.out.emit({"type": "protocol_error", "message": f"no pending approval {cmd.get('request')!r}"})
            return
        waiter[1] = answer
        waiter[0].set()

    def _release_approvals(self, turn: Turn) -> None:
        with turn.approvals_lock:
            for waiter in turn.approvals.values():
                waiter[1] = "deny"
                waiter[0].set()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="xd_engine", description="XD local agent engine (stdio JSON lines)")
    parser.add_argument("--root", required=True, help="XD root folder (workspace/ and .xd/ live here)")
    args = parser.parse_args(argv)

    channel = claim_stdout()
    # 로그는 UTF-8 로 — Windows 의 stderr 는 시스템 코드 페이지(cp1252 등)라 런타임의 한국어 로그가
    # "Logging error" 로 깨진다. `-I` 로 띄우므로 PYTHONIOENCODING 으로는 바꿀 수 없다.
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        layout = Layout.at(args.root)
        layout.workspace.mkdir(parents=True, exist_ok=True)
        layout.state.mkdir(parents=True, exist_ok=True)
    except (LayoutError, OSError) as exc:
        channel.emit({"type": "fatal", "message": f"root folder unusable: {exc}"})
        return 2

    from xd_engine import testing

    testing.install_if_requested()
    Daemon(channel, layout).serve(sys.stdin.buffer)
    channel.close()
    return 0
