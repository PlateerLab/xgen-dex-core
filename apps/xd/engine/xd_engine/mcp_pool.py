"""사용자 MCP 서버 — 에이전트마다 사용자가 붙인 MCP 서버(stdio 명령·http/sse 주소)에 붙어 있는 곳.

턴은 턴마다 새 이벤트 루프에서 돌고 끝나면 닫힌다. MCP 연결은 턴을 넘어 살아야 하므로(stdio 서버를 턴마다 다시
띄우면 첫 응답까지 몇 초) 데몬이 **자기 루프 스레드 하나**를 두고 모든 연결을 거기서 연다. 서버마다 연결한 작업 하나가
끝까지 맡는다 — anyio 는 연 작업에서 닫아야 하고, 다른 작업에서 닫으면 서버 프로세스가 남는다.

- ``ensure``: 이 에이전트의 서버 목록에 맞춘다(새 것은 띄우고, 바뀐 것은 다시, 빠진 것은 닫는다). 에이전트마다 한
  번에 하나씩(두 대화가 같이 맞추면 프로세스가 고아가 된다). 붙어 있다고 적힌 서버도 ping 으로 살아 있는지 본다.
- ``call``: 도구 하나 — 턴의 루프에서 이 루프로 넘겨 기다린다(``asyncio.wrap_future``, 취소도 넘어간다). 그 사이
  서버가 닫히면 시간 제한까지 매달리지 않고 곧바로 실패한다.
- 붙은 서버는 몇 초마다 ping 으로 본다 — 프로세스가 죽으면 실패로 적고, 다음 턴에 바로 다시 붙는다.
- 오래 안 쓴 서버는 닫는다. 단 도는 턴이 빌려 간(lease) 에이전트의 서버는 닫지 않는다(긴 턴의 뒷부분이 쓴다).

런타임의 ``MCPManager`` 는 쓰지 않는다 — 하나가 실패하면 모두를 내리고(connect_all), 연결을 다른 작업에서 닫고,
초기화 시간 제한이 10초다. SDK(``mcp``)를 바로 쓴다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import threading
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger("xd_engine.mcp")

#: 서버 이름표(도구 이름 앞)의 규칙 — 짧게, 밑줄 없이(런타임이 `mcp_<서버>_<도구>` 를 밑줄로 가른다).
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,11}$")
#: 런타임이 기기 도구로 다루는 이름표 — 쓰지 않는다.
RESERVED_SLUGS = frozenset({"local", "mobile", "web", "connector"})
TRANSPORTS = frozenset({"stdio", "http", "sse"})

#: 연결(프로세스 띄우기·주소 붙기)부터 초기화·도구 목록까지 — 첫 실행의 ``npx``·``uvx`` 는 설치까지 하므로 넉넉히.
INIT_TIMEOUT_S = 120.0
#: 실패한 서버를 다시 붙어 보기까지.
RETRY_AFTER_S = 30.0
#: 이만큼 안 쓰면 닫는다.
IDLE_CLOSE_S = 600.0
#: 붙은 서버가 살아 있는지 보는 간격과 대답을 기다리는 시간. 죽음은 끊긴 연결(오류)로 안다 — 대답이 늦기만 한
#: 것은 이만큼 이어져야 죽은 것으로 본다.
PING_EVERY_S = 15.0
PING_TIMEOUT_S = 10.0
PING_TIMEOUTS_DEAD = 3


class McpSpecError(ValueError):
    """main 이 넘긴 서버 설정이 틀렸다."""


@dataclass(frozen=True)
class McpServerSpec:
    slug: str
    label: str
    transport: str
    command: str = ""
    args: Tuple[str, ...] = ()
    env: Tuple[Tuple[str, str], ...] = ()
    url: str = ""
    headers: Tuple[Tuple[str, str], ...] = ()

    @classmethod
    def parse(cls, raw: Any) -> "McpServerSpec":
        if not isinstance(raw, dict):
            raise McpSpecError("mcp server must be an object")
        slug = str(raw.get("slug") or "")
        if not SLUG_RE.match(slug) or slug in RESERVED_SLUGS:
            raise McpSpecError(f"bad mcp server slug: {slug!r}")
        transport = str(raw.get("transport") or "stdio")
        if transport not in TRANSPORTS:
            raise McpSpecError(f"unknown mcp transport: {transport!r}")

        def pairs(value: Any, what: str) -> Tuple[Tuple[str, str], ...]:
            if value is None:
                return ()
            if not isinstance(value, dict):
                raise McpSpecError(f"mcp {what} must be an object")
            return tuple(sorted((str(k), str(v)) for k, v in value.items()))

        args = raw.get("args") or []
        if not isinstance(args, list):
            raise McpSpecError("mcp args must be a list")
        spec = cls(
            slug=slug,
            label=str(raw.get("label") or slug)[:80],
            transport=transport,
            command=str(raw.get("command") or "").strip(),
            args=tuple(str(a) for a in args),
            env=pairs(raw.get("env"), "env"),
            url=str(raw.get("url") or "").strip(),
            headers=pairs(raw.get("headers"), "headers"),
        )
        if transport == "stdio" and not spec.command:
            raise McpSpecError(f"mcp server {slug!r} needs a command")
        # main 의 규칙과 같다(대소문자 무시) — 갈리면 그 서버를 쓸 수 없다.
        if transport != "stdio" and not spec.url.lower().startswith(("http://", "https://")):
            raise McpSpecError(f"mcp server {slug!r} needs an http(s) url")
        return spec

    def fingerprint(self) -> str:
        """설정이 바뀌었는지 — 비밀(env·headers) 값까지 넣어 셈한다(값이 바뀌면 다시 붙는다)."""
        body = json.dumps(
            [self.transport, self.command, list(self.args), list(self.env), self.url, list(self.headers)],
            ensure_ascii=False,
        )
        return hashlib.sha256(body.encode("utf-8")).hexdigest()


@dataclass
class ServerView:
    """한 서버의 지금 — 턴이 도구를 만들고, 화면이 상태를 보이는 데 쓴다(비밀은 싣지 않는다)."""

    slug: str
    label: str
    state: str  # connecting | connected | failed
    error: str = ""
    tools: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class _Server:
    spec: McpServerSpec
    fingerprint: str
    cwd: Optional[str]
    state: str = "connecting"
    error: str = ""
    tools: List[Dict[str, Any]] = field(default_factory=list)
    session: Any = None
    task: Optional["asyncio.Task[None]"] = None
    #: 닫으라는 신호이자 "이 서버는 끝났다" 는 신호 — 기다리던 호출이 곧바로 깨어난다.
    stop: Optional[asyncio.Event] = None
    ready: Optional[asyncio.Event] = None
    failed_at: float = 0.0
    last_used: float = field(default_factory=time.monotonic)
    #: 지금 도는 도구 호출 수 — 그동안은 ping 하지 않는다(요청을 하나씩 처리하는 서버는 긴 호출 중에 ping 에 답하지
    #: 못한다. 그걸 죽음으로 읽으면 멀쩡한 호출을 끊는다).
    inflight: int = 0
    #: 대답 없이 시간만 넘긴 ping 이 이어진 수.
    ping_timeouts: int = 0

    def view(self) -> ServerView:
        return ServerView(self.spec.slug, self.spec.label, self.state, self.error, list(self.tools))


_URL = re.compile(r"(https?://)(?:[^/@\s'\"]+@)?([^\s?#'\"]+)(?:\?[^\s#'\"]*)?", re.IGNORECASE)


def short_error(exc: BaseException) -> str:
    """예외 → 한 줄(묶인 예외는 첫 잎). 화면·모델에게 보이므로 짧게, 주소의 쿼리·사용자 정보(비밀이 든다)는 지운다."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    text = _URL.sub(r"\1\2", text)
    return (f"{type(exc).__name__}: {text}" if text else type(exc).__name__)[:300]


def _tool_dict(tool: Any) -> Dict[str, Any]:
    annotations = getattr(tool, "annotations", None)
    return {
        "name": str(getattr(tool, "name", "") or ""),
        "description": str(getattr(tool, "description", "") or ""),
        "input_schema": getattr(tool, "inputSchema", None),
        "read_only": bool(getattr(annotations, "readOnlyHint", False)) if annotations else False,
        "destructive": bool(getattr(annotations, "destructiveHint", False)) if annotations else False,
        "idempotent": bool(getattr(annotations, "idempotentHint", False)) if annotations else False,
    }


def _is_closed(exc: BaseException) -> bool:
    """연결이 끊겼다는 실패인가(서버 프로세스가 죽었다) — 도구가 낸 실패와 가른다(글이 아니라 종류·코드로)."""
    if type(exc).__name__ in ("ClosedResourceError", "BrokenResourceError", "EndOfStream"):
        return True
    try:
        from mcp.shared.exceptions import McpError
        from mcp.types import CONNECTION_CLOSED
    except ImportError:  # pragma: no cover
        return False
    return isinstance(exc, McpError) and getattr(exc.error, "code", None) == CONNECTION_CLOSED


class McpPool:
    def __init__(
        self,
        *,
        idle_close_s: float = IDLE_CLOSE_S,
        retry_after_s: float = RETRY_AFTER_S,
        ping_every_s: float = PING_EVERY_S,
        ping_timeout_s: float = PING_TIMEOUT_S,
        log_dir: Optional[str] = None,
    ) -> None:
        #: stdio 서버의 stderr 를 서버마다 따로 적는 곳(없으면 엔진 로그) — 어떤 서버는 요청마다 한 줄을 쓴다(ping 포함).
        self.log_dir = log_dir
        self.idle_close_s = idle_close_s
        self.retry_after_s = retry_after_s
        self.ping_every_s = ping_every_s
        self.ping_timeout_s = ping_timeout_s
        self.loop = asyncio.new_event_loop()
        self._servers: Dict[Tuple[str, str], _Server] = {}
        self._locks: Dict[str, asyncio.Lock] = {}
        #: 에이전트마다 지금 도는 턴 수 — 그동안은 오래 안 썼어도 닫지 않는다.
        self._leases: Dict[str, int] = {}
        self._reaper: Optional["asyncio.Task[None]"] = None
        self._thread = threading.Thread(target=self._run, name="mcp-pool", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self._reaper = self.loop.create_task(self._reap())
        self.loop.run_forever()

    def _sync(self, coro: Any, timeout: float) -> Any:
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        try:
            return fut.result(timeout)
        except BaseException:
            fut.cancel()  # 시간을 넘겼으면 그 일도 멈춘다(뒤늦게 상태를 바꾸지 않게)
            raise

    # ── 다른 스레드에서 부르는 것 ───────────────────────────────────────
    def ensure(self, agent_id: str, specs: Sequence[McpServerSpec], *, cwd: Optional[str], wait_s: float) -> List[ServerView]:
        """맞추고 붙기를 ``wait_s`` 까지 기다린다."""
        return self._sync(self._ensure(agent_id, list(specs), cwd, wait_s), wait_s + 60)

    def acquire(self, agent_id: str) -> None:
        """턴이 이 에이전트의 서버를 빌린다 — 턴이 끝날 때 ``release`` 한다(그동안은 오래 안 써도 닫지 않는다).
        ``ensure`` 보다 먼저 부른다: ``ensure`` 가 시간을 넘겨 실패해도 빌린 것은 언제나 돌려줄 수 있게."""

        def add() -> None:
            self._leases[agent_id] = self._leases.get(agent_id, 0) + 1

        self.loop.call_soon_threadsafe(add)

    def release(self, agent_id: str) -> None:
        def drop() -> None:
            left = self._leases.get(agent_id, 0) - 1
            if left > 0:
                self._leases[agent_id] = left
            else:
                self._leases.pop(agent_id, None)

        self.loop.call_soon_threadsafe(drop)

    def snapshot(self, agent_id: str, slugs: Sequence[str]) -> List[ServerView]:
        """지금 상태(기다리지 않는다)."""

        async def take() -> List[ServerView]:
            return [self._servers[(agent_id, s)].view() for s in slugs if (agent_id, s) in self._servers]

        return self._sync(take(), 10)

    def has_agent(self, agent_id: str) -> bool:
        return any(key[0] == agent_id for key in list(self._servers))

    def close_agent(self, agent_id: str, timeout: float = 15.0) -> None:
        self._sync(self._locked(agent_id, lambda: self._close(lambda key: key[0] == agent_id)), timeout)

    def close_all(self, timeout: float = 15.0) -> None:
        if self.loop.is_closed():
            return
        try:
            self._sync(self._shutdown(), timeout)
        except Exception:  # noqa: BLE001 — 끄는 길이다
            logger.warning("mcp pool close timed out", exc_info=True)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout)

    def test(self, spec: McpServerSpec, *, cwd: Optional[str], timeout_s: float = INIT_TIMEOUT_S) -> ServerView:
        """붙어 보고 도구 목록만 받고 닫는다 — [연결 확인]."""
        return self._sync(self._test(spec, cwd, timeout_s), timeout_s + 30)

    # ── 이 루프에서 도는 것 ─────────────────────────────────────────────
    async def call(self, agent_id: str, slug: str, tool: str, arguments: Dict[str, Any], timeout_s: float) -> Dict[str, Any]:
        """도구 하나 — MCP 결과(content 블록·isError)를 dict 로. 서버가 그 사이 닫히면 곧바로 실패한다."""
        server = self._servers.get((agent_id, slug))
        if server is None or server.session is None or server.stop is None:
            raise RuntimeError(f"the MCP server {slug!r} is not connected")
        server.last_used = time.monotonic()
        call = asyncio.ensure_future(server.session.call_tool(tool, arguments))
        # 서버 쪽 호출이 끝날 때까지 "도는 중" — 턴이 그만둬도 서버는 그 도구를 계속 돈다(SDK 는 취소를 알리지 않는다).
        server.inflight += 1

        def finished(_task: Any) -> None:
            server.inflight -= 1

        call.add_done_callback(finished)
        closed = asyncio.ensure_future(server.stop.wait())
        try:
            done, _ = await asyncio.wait({call, closed}, timeout=timeout_s, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            # 턴이 그만뒀다 — 대답은 기다리되 시간 제한이 지나면 놓는다(끝없이 "도는 중" 으로 남지 않게).
            self.loop.call_later(timeout_s, call.cancel)
            raise
        finally:
            closed.cancel()
        server.last_used = time.monotonic()
        if call not in done:
            call.cancel()
            if closed in done:
                raise RuntimeError(f"the MCP server {slug!r} stopped while the tool was running")
            raise asyncio.TimeoutError()
        try:
            result = call.result()
        except Exception as exc:
            if _is_closed(exc):
                self._mark_dead(server, exc)
            raise RuntimeError(short_error(exc)) from exc
        content = [c.model_dump(mode="json", exclude_none=True) for c in (result.content or [])]
        return {"content": content, "isError": bool(getattr(result, "isError", False))}

    async def _locked(self, agent_id: str, fn: Callable[[], Any]) -> Any:
        lock = self._locks.setdefault(agent_id, asyncio.Lock())
        async with lock:
            return await fn()

    async def _ensure(self, agent_id: str, specs: List[McpServerSpec], cwd: Optional[str], wait_s: float) -> List[ServerView]:
        wanted = {s.slug: s for s in specs}

        async def reconcile() -> None:
            await self._close(lambda key: key[0] == agent_id and key[1] not in wanted)
            now = time.monotonic()
            for slug, spec in wanted.items():
                key = (agent_id, slug)
                current = self._servers.get(key)
                fp = spec.fingerprint()
                if current is not None and current.fingerprint == fp and current.cwd == cwd:
                    if current.state == "connecting":
                        current.last_used = now
                        continue
                    if current.state == "connected" and await self._alive(current):
                        current.last_used = now
                        continue
                    if current.state == "failed" and current.failed_at and now - current.failed_at < self.retry_after_s:
                        continue
                if current is not None:
                    await self._stop(key)
                self._start(key, spec, fp, cwd)

        await self._locked(agent_id, reconcile)
        pending = [s.ready for slug in wanted if (s := self._servers.get((agent_id, slug))) and s.state == "connecting" and s.ready]
        if pending and wait_s > 0:
            await asyncio.wait([asyncio.ensure_future(e.wait()) for e in pending], timeout=wait_s)
        return [s.view() for slug in wanted if (s := self._servers.get((agent_id, slug)))]

    async def _alive(self, server: _Server) -> bool:
        """붙어 있다고 적힌 서버가 정말 대답하는가(죽은 stdio 프로세스는 ping 에 오류로 답한다). 다른 턴의 호출이
        도는 중이면 묻지 않는다(그 호출에 막혀 늦을 수 있다)."""
        if server.session is None:
            return False
        if server.inflight:
            return True
        try:
            await asyncio.wait_for(server.session.send_ping(), self.ping_timeout_s)
            server.ping_timeouts = 0
            return True
        except asyncio.TimeoutError as exc:
            server.ping_timeouts += 1
            if server.ping_timeouts < PING_TIMEOUTS_DEAD:
                return True
            self._mark_dead(server, exc)
            return False
        except Exception as exc:  # noqa: BLE001
            self._mark_dead(server, exc)
            return False

    def _mark_dead(self, server: _Server, exc: BaseException) -> None:
        if server.state == "connected":
            server.state = "failed"
            server.error = short_error(exc)
            server.failed_at = 0.0  # 곧바로 다시 붙어 본다(설정이 틀린 것이 아니라 죽은 것이다)
        if server.stop is not None:
            server.stop.set()

    def _start(self, key: Tuple[str, str], spec: McpServerSpec, fp: str, cwd: Optional[str]) -> None:
        server = _Server(spec=spec, fingerprint=fp, cwd=cwd, stop=asyncio.Event(), ready=asyncio.Event())
        self._servers[key] = server
        server.task = asyncio.ensure_future(self._supervise(server))

    async def _supervise(self, server: _Server, *, timeout_s: float = INIT_TIMEOUT_S) -> None:
        """연결 하나를 처음부터 끝까지 — 연 작업이 닫는다."""
        assert server.stop is not None and server.ready is not None
        try:
            async with AsyncExitStack() as stack:
                # 프로세스 띄우기·주소 붙기부터 도구 목록까지 한 시간 제한(같은 작업 안에서 — anyio 가 받는다).
                async with asyncio.timeout(timeout_s):
                    # stdio·sse 는 (읽기, 쓰기), streamable http 는 세 번째로 세션 id 함수가 따라온다.
                    streams = await stack.enter_async_context(self._transport(server.spec, server.cwd, stack))
                    from mcp import ClientSession

                    session = await stack.enter_async_context(ClientSession(streams[0], streams[1]))
                    await session.initialize()
                    tools: List[Dict[str, Any]] = []
                    cursor = None
                    while True:
                        page = await (session.list_tools(cursor) if cursor else session.list_tools())
                        tools += [_tool_dict(t) for t in page.tools]
                        cursor = getattr(page, "nextCursor", None)
                        if not cursor:
                            break
                server.tools = tools
                server.session = session
                server.state = "connected"
                server.error = ""
                server.ready.set()
                logger.info("mcp %s connected (%d tools)", server.spec.slug, len(tools))
                await self._watch(server, session)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 — 서버 하나의 실패가 다른 것을 막지 않는다
            if server.state != "failed":
                server.state = "failed"
                server.error = short_error(exc)
                server.failed_at = time.monotonic()
            logger.warning("mcp %s failed: %s", server.spec.slug, server.error)
        finally:
            server.session = None
            server.stop.set()  # 기다리던 호출을 깨운다
            server.ready.set()

    async def _watch(self, server: _Server, session: Any) -> None:
        """닫으라는 신호가 올 때까지 — 몇 초마다 ping 해서 죽은 서버를 알아챈다(죽으면 예외로 나간다).

        끊긴 연결(오류)은 바로 죽음이다. 대답이 늦기만 하면 몇 번 이어져야 죽음으로 본다. 도구 호출이 도는 동안은 묻지
        않는다 — 요청을 하나씩 처리하는 서버는 긴 호출 중에 ping 에 답하지 못한다.
        """
        assert server.stop is not None
        while not server.stop.is_set():
            try:
                await asyncio.wait_for(server.stop.wait(), self.ping_every_s)
                return
            except asyncio.TimeoutError:
                pass
            if server.inflight:
                continue
            try:
                await asyncio.wait_for(session.send_ping(), self.ping_timeout_s)
                server.ping_timeouts = 0
            except asyncio.TimeoutError:
                server.ping_timeouts += 1
                if server.ping_timeouts >= PING_TIMEOUTS_DEAD:
                    server.state = "failed"
                    server.error = "the server stopped answering"
                    server.failed_at = 0.0
                    return
            except Exception as exc:
                server.state = "failed"
                server.error = short_error(exc)
                server.failed_at = 0.0
                raise

    def _transport(self, spec: McpServerSpec, cwd: Optional[str], stack: AsyncExitStack) -> Any:
        if spec.transport == "stdio":
            from mcp import StdioServerParameters
            from mcp.client.stdio import stdio_client

            # 이 PC 의 환경 그대로(로그인 셸의 PATH 로 뜬 엔진의 것) + 서버의 env. SDK 기본은 몇 개만 물려준다.
            env = {**os.environ, **dict(spec.env)}
            params = StdioServerParameters(command=spec.command, args=list(spec.args), env=env, cwd=cwd)
            errlog: Any = sys.stderr
            if self.log_dir:
                try:
                    os.makedirs(self.log_dir, exist_ok=True)
                    # 붙을 때마다 새로 — 서버가 요청마다 쓰는 줄이 엔진 로그를 밀어내지 않게.
                    errlog = stack.enter_context(open(os.path.join(self.log_dir, f"{spec.slug}.log"), "w", encoding="utf-8", errors="replace"))
                except OSError:
                    errlog = sys.stderr
            return stdio_client(params, errlog=errlog)
        headers = dict(spec.headers) or None
        if spec.transport == "sse":
            from mcp.client.sse import sse_client

            return sse_client(spec.url, headers=headers)
        from mcp.client.streamable_http import streamablehttp_client

        return streamablehttp_client(spec.url, headers=headers)

    async def _stop(self, key: Tuple[str, str], timeout: float = 10.0) -> None:
        server = self._servers.pop(key, None)
        if server is None or server.task is None:
            return
        assert server.stop is not None
        server.stop.set()
        try:
            await asyncio.wait_for(asyncio.shield(server.task), timeout)
        except Exception:  # noqa: BLE001 — 닫는 길이다
            server.task.cancel()

    async def _close(self, which: Callable[[Tuple[str, str]], bool]) -> None:
        keys = [k for k in self._servers if which(k)]
        await asyncio.gather(*(self._stop(k) for k in keys), return_exceptions=True)

    async def _shutdown(self) -> None:
        await self._close(lambda key: True)
        if self._reaper is not None:
            self._reaper.cancel()
            try:
                await self._reaper
            except asyncio.CancelledError:
                pass

    async def _reap(self) -> None:
        while True:
            await asyncio.sleep(min(60.0, self.idle_close_s))
            for key in list(self._servers):
                agent_id = key[0]
                if self._leases.get(agent_id):
                    continue  # 도는 턴이 쓰는 중이다
                server = self._servers.get(key)
                if server is None or server.state == "connecting":
                    continue
                if time.monotonic() - server.last_used > self.idle_close_s:

                    async def close_if_still_idle(k: Tuple[str, str] = key, seen: _Server = server) -> None:
                        # 락을 기다리는 사이 턴이 빌려 갔거나 썼을 수 있다 — 락 안에서 다시 본다.
                        now_server = self._servers.get(k)
                        if now_server is not seen or self._leases.get(k[0]) or time.monotonic() - seen.last_used <= self.idle_close_s:
                            return
                        logger.info("mcp %s idle — closing", k[1])
                        await self._stop(k)

                    await self._locked(agent_id, close_if_still_idle)

    async def _test(self, spec: McpServerSpec, cwd: Optional[str], timeout_s: float) -> ServerView:
        server = _Server(spec=spec, fingerprint=spec.fingerprint(), cwd=cwd, stop=asyncio.Event(), ready=asyncio.Event())
        task = asyncio.ensure_future(self._supervise(server, timeout_s=timeout_s))
        assert server.ready is not None and server.stop is not None
        try:
            await asyncio.wait_for(server.ready.wait(), timeout_s + 5)
        except asyncio.TimeoutError:
            server.state, server.error = "failed", "timed out"
        view = server.view()
        server.stop.set()
        try:
            await asyncio.wait_for(asyncio.shield(task), 10)
        except Exception:  # noqa: BLE001
            task.cancel()
        return view
