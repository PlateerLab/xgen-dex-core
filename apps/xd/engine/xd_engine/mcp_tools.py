"""사용자 MCP 서버의 도구 → 런타임 도구(``Tool``).

이름: ``mcp_<서버 이름표>_<도구>`` — 48자 안. 런타임의 상한(``MAX_TOOL_NAME`` 48)은 API 의 64자에서 Claude Code 가
앞에 붙이는 ``mcp__connector__``(16자)를 뺀 것이다 — 넘으면 API 가 요청 전체를 거절한다. 도구 이름이 그대로 맞으면
그대로, 아니면 다듬은 앞부분 + 원래 이름의 해시 6자(같은 도구는 언제나 같은 이름 — 지난 턴에 쓴 도구를 다시 연다).

실행은 MCP 연결이 사는 루프(``McpPool.loop``)로 넘겨 기다린다 — 턴의 루프는 턴이 끝나면 닫힌다. 결과는 글·그림
블록과 ``isError`` 를 그대로 살린다(런타임 기기 도구의 블록 변환을 쓰되, 기기 도구의 "사용자 거절" 해석은 하지
않는다 — 사용자가 붙인 서버의 실패 글이 우연히 그 말을 담아도 거절로 바뀌지 않게).
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from typing import Any, Dict, List, Sequence

from .mcp_pool import McpPool, ServerView, short_error

MAX_TOOL_NAME = 48
#: 도구 하나의 시간 제한 — 걸리면 턴이 멈추지 않고 실패 결과로 돌아온다.
TOOL_TIMEOUT_S = 120.0
_SAFE = re.compile(r"^[A-Za-z0-9_-]+$")


def tool_name(slug: str, raw: str) -> str:
    prefix = f"mcp_{slug}_"
    if _SAFE.match(raw) and len(prefix) + len(raw) <= MAX_TOOL_NAME:
        return prefix + raw
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", raw) or "tool"
    room = MAX_TOOL_NAME - len(prefix) - 7
    return f"{prefix}{cleaned[:room]}_{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:6]}"


def _schema(raw: Any) -> Dict[str, Any]:
    """서버의 inputSchema 그대로(``$defs``·``$ref`` 는 런타임이 푼다). 없거나 객체가 아니면 빈 객체 스키마."""
    if not isinstance(raw, dict) or not raw:
        return {"type": "object", "properties": {}}
    schema = dict(raw)
    schema.setdefault("type", "object")
    return schema


def _result(payload: Dict[str, Any]) -> Any:
    from xgen_agent_runtime.host.device_tools import _as_content, _blocks
    from xgen_agent_runtime.tools.base import ToolResult

    blocks = _blocks(payload.get("content") or [])
    content = _as_content(blocks)
    if payload.get("isError"):
        return ToolResult(content=content or "(the MCP tool reported a failure with no message)", is_error=True)
    return ToolResult(content=content)


def build_mcp_tools(pool: McpPool, agent_id: str, servers: Sequence[ServerView]) -> List[Any]:
    from xgen_agent_runtime.tools.base import ToolCapabilities, ToolResult, build_tool, with_origin

    tools: List[Any] = []
    seen: set[str] = set()
    for server in servers:
        if server.state != "connected":
            continue
        for spec in server.tools:
            raw = str(spec.get("name") or "")
            if not raw:
                continue
            name = tool_name(server.slug, raw)
            if name in seen:
                continue
            seen.add(name)
            read_only = bool(spec.get("read_only"))

            def make_execute(slug: str = server.slug, raw_name: str = raw):
                async def execute(tool_input: Dict[str, Any], ctx: Any) -> Any:
                    fut = asyncio.run_coroutine_threadsafe(
                        pool.call(agent_id, slug, raw_name, dict(tool_input or {}), TOOL_TIMEOUT_S), pool.loop
                    )
                    try:
                        result = await asyncio.wrap_future(fut)
                    except asyncio.TimeoutError:
                        return ToolResult(content=f"Error: the MCP tool did not answer within {int(TOOL_TIMEOUT_S)}s", is_error=True)
                    except Exception as exc:  # noqa: BLE001 — 도구 하나의 실패는 결과로 돌려준다
                        return ToolResult(content=f"Error: {short_error(exc)}", is_error=True)
                    return _result(result)

                return execute

            description = str(spec.get("description") or "").strip()
            tool = build_tool(
                name=name,
                description=f"[MCP {server.label}] {description}"[:2000],
                input_schema=_schema(spec.get("input_schema")),
                execute=make_execute(),
                capabilities=ToolCapabilities(
                    read_only=read_only,
                    concurrency_safe=read_only,
                    destructive=bool(spec.get("destructive")),
                    idempotent=bool(spec.get("idempotent")),
                    timeout_s=TOOL_TIMEOUT_S + 5,
                ),
            )
            tools.append(with_origin(tool, "mcp"))
    return tools


def mcp_environment(servers: Sequence[ServerView], tool_prefix: str) -> str:
    """에이전트에게 붙은 MCP 서버를 알린다 — 붙은 것과 이번에 못 붙은 것."""
    if not servers:
        return ""
    lines = ["", "## MCP servers", ""]
    for s in servers:
        if s.state == "connected":
            lines.append(f"- **{s.label}** — tools named `{tool_prefix}mcp_{s.slug}_…` ({len(s.tools)} tools).")
        elif s.state == "connecting":
            lines.append(f"- **{s.label}** — still starting; its tools are not available in this turn.")
        else:
            lines.append(f"- **{s.label}** — could not connect ({s.error}); its tools are not available.")
    return "\n".join(lines)
