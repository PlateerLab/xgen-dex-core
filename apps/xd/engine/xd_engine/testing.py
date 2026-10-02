"""시험용 가짜 LLM — 정해 둔 응답을 차례로 내는 제공자 ``xd_fake``.

``XD_ENGINE_FAKE_LLM`` 에 각본(JSON 파일 경로)을 주고 데몬을 띄울 때만 등록된다. 앱은 이 변수를
설정하지 않는다. 동봉본에서도 같은 방법으로 "도구가 든 턴이 끝까지 도는가" 를 확인한다(키·네트워크
없이).

각본::

    {"responses": [
        {"text": "목록을 봅니다.", "tools": [{"name": "Bash", "input": {"command": "ls"}}]},
        {"text": "끝났습니다."}
    ]}

응답은 턴(클라이언트)마다 처음부터 쓴다. 다 쓰면 "(script finished)" 로 끝낸다. ``{"error": "…"}`` 인
응답은 제공자 실패(예외)를 흉내 낸다.
``XD_ENGINE_FAKE_LOG`` 를 주면 받은 요청마다 마지막 메시지를 JSON 줄로 적는다 — 도구 결과가 모델에게
돌아갔는지 시험이 확인한다.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

PROVIDER = "xd_fake"
SCRIPT_ENV = "XD_ENGINE_FAKE_LLM"
LOG_ENV = "XD_ENGINE_FAKE_LOG"


def install_if_requested() -> bool:
    path = os.environ.get(SCRIPT_ENV, "").strip()
    if not path:
        return False
    with open(path, "r", encoding="utf-8") as fh:
        script = json.load(fh)
    install(script.get("responses") or [], log_path=os.environ.get(LOG_ENV, "").strip() or None)
    return True


def install(responses: List[Dict[str, Any]], *, log_path: str | None = None) -> None:
    from xgen_agent_runtime.llm_client.base import BaseClient, ClientCapabilities
    from xgen_agent_runtime.llm_client.registry import ClientRegistry
    from xgen_agent_runtime.llm_client.types import APIResponse, ContentBlock, TokenUsage

    class FakeClient(BaseClient):
        provider = PROVIDER
        capabilities = ClientCapabilities()

        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self._next = 0

        async def _send(self, request: Any, *, purpose: str = "") -> Any:
            if log_path:
                last = request.messages[-1] if request.messages else {}
                with open(log_path, "a", encoding="utf-8") as fh:
                    entry = {"purpose": purpose, "count": len(request.messages), "last": last}
                    fh.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
            usage = TokenUsage(input_tokens=10, output_tokens=5)
            if self._next >= len(responses):
                return APIResponse(
                    content=[ContentBlock(type="text", text="(script finished)")],
                    stop_reason="end_turn",
                    usage=usage,
                    model=request.model,
                )
            step = responses[self._next]
            self._next += 1
            if step.get("error"):
                raise RuntimeError(str(step["error"]))
            blocks = []
            if step.get("text"):
                blocks.append(ContentBlock(type="text", text=str(step["text"])))
            for i, call in enumerate(step.get("tools") or []):
                blocks.append(
                    ContentBlock(
                        type="tool_use",
                        tool_use_id=f"call_{self._next}_{i}",
                        tool_name=str(call["name"]),
                        tool_input=dict(call.get("input") or {}),
                    )
                )
            return APIResponse(
                content=blocks,
                stop_reason="tool_use" if step.get("tools") else "end_turn",
                usage=usage,
                model=request.model,
            )

    ClientRegistry.register(PROVIDER, lambda: FakeClient)
