"""턴 끝 기억 증류에 쓰는 LLM — 그 턴이 쓴 제공자·모델 그대로.

런타임의 증류(FactExtraction·MemoryRollup)는 ``complete``·``complete_structured`` 두 메서드를 가진
객체를 받는다. 서버(xgen-workflow ``memory_llm``)와 같은 계약이고, 시스템 문구도 같은 것(런타임의
``MEMORY_ENGINE_SYSTEM_PROMPT``)을 쓴다 — 어시스턴트 페르소나로 부르면 모델이 기록에 "답변" 하고 그
답변이 기억으로 저장된다.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

logger = logging.getLogger("xd_engine.memory_llm")


def _system_prompt() -> str:
    from xgen_agent_runtime.memory import MEMORY_ENGINE_SYSTEM_PROMPT

    return MEMORY_ENGINE_SYSTEM_PROMPT


def _parse_json_text(text: str) -> Optional[Dict[str, Any]]:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            return None
        cleaned = cleaned[start : end + 1]
    try:
        data = json.loads(cleaned)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


@dataclass
class MemoryLLM:
    client: Any
    model_config: Any
    #: 증류 작업이 끝나면 부르는 정리 함수(없으면 None) — 런타임 증류 worker 가 본다.
    cleanup: Any = None

    async def complete(
        self, prompt: str, *, system: Optional[str] = None, purpose: str = "memory.curation"
    ) -> str:
        response = await self.client.create_message(
            model_config=self.model_config,
            messages=[{"role": "user", "content": prompt}],
            system=_system_prompt() if system is None else system,
            purpose=purpose,
        )
        return response.text

    async def complete_structured(
        self, prompt: str, schema: Dict[str, Any], *, purpose: str = "memory.structured"
    ) -> Optional[Dict[str, Any]]:
        """스키마에 맞는 dict, 못 얻으면 None(호출자는 이전 상태를 유지한다)."""
        response_format = {"type": "json_schema", "json_schema": schema}
        messages = [{"role": "user", "content": prompt}]
        for attempt in (0, 1):
            try:
                response = await self.client.create_message(
                    model_config=self.model_config,
                    messages=messages,
                    system=_system_prompt(),
                    purpose=purpose,
                    response_format=response_format,
                )
            except Exception:  # noqa: BLE001 — 전송 실패는 상태 유지
                logger.warning("memory distill: structured call failed", exc_info=True)
                return None
            structured = getattr(response, "structured", None)
            if isinstance(structured, dict):
                return structured
            parsed = _parse_json_text(response.text)
            if parsed is not None:
                return parsed
            if attempt == 0:
                messages = messages + [
                    {"role": "assistant", "content": response.text or ""},
                    {
                        "role": "user",
                        "content": (
                            "Invalid output. Return ONLY a JSON object matching the provided "
                            "schema — no prose, no code fences."
                        ),
                    },
                ]
        logger.warning("memory distill: structured output unparseable after retry")
        return None


def build_memory_llm(
    provider: str,
    model: str,
    api_key: str,
    base_url: Optional[str],
    credentials: Optional[Mapping[str, Any]] = None,
) -> Optional[MemoryLLM]:
    """API 제공자의 증류 LLM. CLI 제공자(claude_code·codex)는 아직 None — 증류만 건너뛴다."""
    if provider in ("claude_code", "codex"):
        return None
    try:
        from xgen_agent_runtime.core.config import ModelConfig
        from xgen_agent_runtime.host.runner import build_client

        client = build_client(provider, api_key, base_url, credentials=dict(credentials or {}))
        config = ModelConfig(model=model, max_tokens=2048, temperature=0.0, thinking_enabled=False)
        return MemoryLLM(client=client, model_config=config)
    except Exception as exc:  # noqa: BLE001 — 증류가 없을 뿐 턴은 산다
        logger.warning("memory distill LLM unavailable (%s/%s): %s", provider, model, exc)
        return None
