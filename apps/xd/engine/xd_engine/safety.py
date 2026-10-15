"""위험 명령 확인 — 셸 도구가 되돌리기 어려운 명령을 돌리기 전에 사용자에게 묻는다.

판정 규칙은 Dex 의 것(``@dex/engine`` ``DANGEROUS_PATTERNS``)과 **같아야** 한다. 사본을 두면 갈라진다
— 그래서 규칙은 main 이 ``configure`` 명령으로 넘겨 주고, 여기에는 규칙이 없다. 규칙을 아직 못 받았으면
**모든** 셸 명령을 묻는다(모르는 채로 돌리지 않는다).

보안 경계가 아니라 실수 방지 문이다 — 에이전트는 어차피 이 PC 사용자의 권한으로 돈다.
"""

from __future__ import annotations

import asyncio
import re
import threading
from typing import Any, Callable, Dict, Iterable, List, Optional

#: 사용자의 대답. ``session`` 은 그 대화에서 다시 묻지 않는다(Dex 와 같다).
ANSWERS = ("once", "session", "deny")

#: 거부했을 때 모델에게 가는 사유 — 런타임이 ``user_denied`` 머리말로 거부를 알아보고 같은 턴에
#: 같은 일을 다시 시도하지 않게 한다(stages/s10_tool/denial_guard).
DENIED_REASON = "The user refused to run this command on their computer."


def compile_patterns(specs: Iterable[Dict[str, Any]]) -> List[re.Pattern[str]]:
    """``{source, flags}`` (JavaScript RegExp 의 source·flags) → 파이썬 정규식.

    규칙 글자는 두 언어에서 같은 뜻으로 쓰이는 부분만 쓴다(``\\b``·``[^\\n]``·묶음·``^``). 받을 수
    없는 플래그나 문법이면 예외 — 일부만 받아 들고 조용히 덜 묻는 것보다 낫다.
    """
    out: List[re.Pattern[str]] = []
    for spec in specs:
        source = str(spec.get("source") or "")
        flags = str(spec.get("flags") or "")
        if not source:
            raise ValueError("empty pattern")
        unknown = set(flags) - {"i"}
        if unknown:
            raise ValueError(f"unsupported RegExp flags {sorted(unknown)} in /{source}/{flags}")
        out.append(re.compile(source, re.IGNORECASE if "i" in flags else 0))
    return out


#: 사용자에게 묻는 함수 — 턴마다 묶여 온다(그 턴의 승인 요청을 내보내고 대답을 기다린다). **막힌다.**
Ask = Callable[[str], str]


class ApprovalGate:
    """셸 명령마다 "물어야 하나 → 물어보기 → 대답 기억" 을 한 곳에서. 데몬에 하나.

    묻기(``ask``)는 막히는 함수라 턴의 이벤트 루프를 막지 않게 스레드에서 부른다.
    """

    def __init__(self) -> None:
        self._patterns: Optional[List[re.Pattern[str]]] = None
        self._approved_scopes: set[str] = set()
        self._lock = threading.Lock()

    def configure(self, patterns: Optional[List[re.Pattern[str]]]) -> None:
        with self._lock:
            self._patterns = patterns

    @property
    def configured(self) -> bool:
        return self._patterns is not None

    @property
    def pattern_count(self) -> int:
        with self._lock:
            return len(self._patterns or [])

    def needs_approval(self, command: str) -> bool:
        with self._lock:
            patterns = self._patterns
        if patterns is None:
            return True
        return any(p.search(command) for p in patterns)

    def allow_sync(self, command: str, scope: str, ask: Ask) -> bool:
        if not self.needs_approval(command):
            return True
        with self._lock:
            if scope and scope in self._approved_scopes:
                return True
        try:
            answer = ask(command)
        except Exception:  # noqa: BLE001 — 물을 수 없으면 거부한다
            return False
        if answer == "session":
            if scope:
                with self._lock:
                    self._approved_scopes.add(scope)
            return True
        return answer == "once"

    async def allow(self, command: str, scope: str, ask: Ask) -> bool:
        if not self.needs_approval(command):
            return True
        return await asyncio.to_thread(self.allow_sync, command, scope, ask)


def gated_shell(inner: Any, gate: ApprovalGate, scope: str, ask: Ask) -> Any:
    """런타임 Bash 도구를 감싼다 — 실행 전에 문을 지나고, 설명은 이 PC 의 사실로 바꾼다.

    ``scope`` 는 "이 대화에서 계속 허용" 을 기억하는 단위(대화 id)다.
    """
    return _GatedShell(inner, gate, scope, ask)


class _GatedShell:
    def __init__(self, inner: Any, gate: ApprovalGate, scope: str, ask: Ask) -> None:
        self._inner = inner
        self._gate = gate
        self._scope = scope
        self._ask = ask

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    @property
    def description(self) -> str:
        # 런타임의 설명은 서버 sandbox 를 말한다("your own isolated workspace on the server").
        # 여기서는 사용자의 PC 다 — 장소를 틀리게 말하면 모델이 결과를 틀리게 읽는다.
        return (
            "Run a shell command on the user's own computer (this is not a sandbox). Commands "
            "start in your working folder and run with the user's permissions; on Windows the "
            "shell is PowerShell, elsewhere it is sh. Commands that are hard to undo (recursive "
            "deletes, formatting disks, force-pushing, piping downloads into a shell, …) ask the "
            "user first. Returns stdout, stderr, and exit code; a configurable timeout applies."
        )

    def to_api_format(self) -> Dict[str, Any]:
        # 감싼 도구의 to_api_format 은 **안쪽** 설명을 읽는다 — 모델에게 가는 스키마도 여기서 만든다.
        return {
            "name": self._inner.name,
            "description": self.description,
            "input_schema": self._inner.input_schema,
        }

    async def execute(self, input: Dict[str, Any], context: Any) -> Any:  # noqa: A002 — 도구 계약
        command = str((input or {}).get("command") or "")
        if command.strip() and not await self._gate.allow(command, self._scope, self._ask):
            from xgen_agent_runtime.host.tools import _denied_result

            return _denied_result(getattr(self._inner, "name", "Bash"), DENIED_REASON, None)
        return await self._inner.execute(input, context)
