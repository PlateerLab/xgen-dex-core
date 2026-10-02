"""XdHostServices — 런타임의 ``HostServices`` 를 이 PC 로 채운다.

턴 하나에 호스트 하나다. 런타임 실행기(``AgentTurnExecutor``)는 인프라에 이 객체로만 닿는다.

이 PC 에는 sandbox 가 없다. ``make_sandbox`` 가 None 이면 런타임의 파일 도구는 이 PC 의 파일 시스템을
경로 가드(``allowed_paths`` = 작업 공간 + 연결 폴더) 안에서 쓰고, 셸 도구는 이 PC 의 셸(Windows 는
PowerShell)로 돈다. 셸은 경로 가드 밖이므로 위험 명령 확인(:mod:`xd_engine.safety`)을 지난다.

서버가 소유하는 것(작업 예약·자기 워크플로 편집·도구 만들기·RAG·기기 도구·파일 저장소)은 XD 에 없다
— 그 자리는 빈 목록이다(apps/xd/DESIGN.md §5 매핑 표).
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from xd_engine.layout import Layout
from xd_engine.safety import ApprovalGate, Ask, gated_shell

logger = logging.getLogger("xd_engine.host")

#: CLI 백엔드 — 도구는 MCP 다리(``connector``)로만 닿는다.
CLI_PROVIDERS = ("claude_code", "codex")

#: XD 가 싣는 내장 도구 묶음. 서버와 같은 이름 규칙(``GENY_TOOLS_<묶음>_ENABLED``)으로 끈다.
_FAMILIES = ("web", "parsing", "workflow", "filesystem", "shell")
_FAMILY_FLAGS = {name: f"GENY_TOOLS_{name.upper()}_ENABLED" for name in _FAMILIES}

_TRUTHY = ("1", "true", "yes", "on")
_FALSY = ("0", "false", "no", "off")


@dataclass
class TurnSetup:
    """main 이 턴마다 넘기는 것 — 이미 검사한 값."""

    layout: Layout
    agent_id: str
    agent_name: str
    #: ``<루트>/workspace/`` 아래 폴더 이름.
    workspace_name: str
    conversation_id: str
    provider: str
    model: str
    api_key: str = ""
    base_url: Optional[str] = None
    credentials: Optional[Dict[str, Any]] = None
    #: 실제 경로로 정리된 연결 폴더.
    linked_folders: List[str] = field(default_factory=list)
    #: 제공자·도구 설정(비밀 아님). 환경 변수로 넘어가지 않는다 — 사용자의 셸 환경이 턴을 바꾸지 않게.
    settings: Dict[str, str] = field(default_factory=dict)


class XdHostServices:
    """이 PC 의 호스트. 메서드 묶음은 런타임 ``host/host.py`` 의 순서를 따른다."""

    def __init__(self, setup: TurnSetup, gate: ApprovalGate, ask: Ask) -> None:
        self._s = setup
        self._gate = gate
        self._ask = ask

    # ── 경로 ──────────────────────────────────────────────────────────
    @property
    def workspace_dir(self) -> Path:
        return self._s.layout.agent_workspace(self._s.workspace_name)

    @property
    def state_dir(self) -> Path:
        return self._s.layout.agent_state(self._s.agent_id)

    def _check_agent(self, workflow_id: str) -> None:
        # 실행기는 workflow_id 로 묻는다. 이 호스트는 한 에이전트의 것 — 다른 id 가 오면 버그다.
        if str(workflow_id or "") != self._s.agent_id:
            raise ValueError(f"host for agent {self._s.agent_id!r} asked about {workflow_id!r}")

    # ── A. 설정·자격 ─────────────────────────────────────────────────
    def setting(self, name: str, default: str = "") -> str:
        value = self._s.settings.get(name)
        return default if value is None else str(value)

    def setting_truthy(self, name: str) -> bool:
        return self.setting(name).strip().lower() in _TRUTHY

    def resolve_model(self, provider: str, params: Mapping[str, Any]) -> str:
        return self._s.model

    def resolve_api_key(self, provider: str, params: Mapping[str, Any]) -> str:
        # 이 턴의 제공자 키만 돌려준다. 다른 채널을 물으면(예: 증류가 anthropic 을 물을 때) 빈 값 —
        # 사용자가 이 에이전트에 주지 않은 키를 섞지 않는다.
        return self._s.api_key if provider == self._s.provider else ""

    def resolve_base_url(self, provider: str, params: Mapping[str, Any]) -> Optional[str]:
        return self._s.base_url if provider == self._s.provider else None

    def resolve_credentials(
        self, provider: str, params: Mapping[str, Any]
    ) -> Optional[Dict[str, Any]]:
        if provider != self._s.provider or not self._s.credentials:
            return None
        return dict(self._s.credentials)

    # ── B. 실행 자리·작업 공간 ───────────────────────────────────────
    def make_sandbox(self, workflow_id: str, user_id: Any) -> None:
        return None

    def agent_workspace_dir(self, workflow_id: str, *, create: bool = True) -> str:
        self._check_agent(workflow_id)
        path = self.workspace_dir
        if create:
            path.mkdir(parents=True, exist_ok=True)
        return str(path)

    def workspace_storage_root(self, workflow_id: str) -> str:
        self._check_agent(workflow_id)
        path = self.state_dir
        path.mkdir(parents=True, exist_ok=True)
        return str(path)

    def hydrate_workspace(self, workflow_id: str, run_dir: str) -> None:
        # 원본이 이 PC 의 폴더 그 자체다 — 복원할 곳이 없다. None 은 "복원 개념 없음"(실행기가 구분한다).
        return None

    def publish_workspace(self, workflow_id: str, run_dir: str, *, origin: str = "agent") -> None:
        return None

    def environment_prompt(self, sandbox: Any, provider: str) -> str:
        return environment_block(
            workspace=str(self.workspace_dir),
            linked_folders=self._s.linked_folders,
            tool_prefix="mcp__connector__" if provider in CLI_PROVIDERS else "",
        )

    def local_device_platform(self) -> str:
        return sys.platform

    # ── C. 기억 ──────────────────────────────────────────────────────
    def build_memory_provider(self, workflow_id: str, interaction_id: str) -> Optional[Any]:
        self._check_agent(workflow_id)
        try:
            from xgen_agent_runtime.memory.factory import MemoryProviderFactory

            config = memory_config(self.state_dir / "memory", interaction_id or "default", workflow_id)
            os.makedirs(config["providers"]["vault"]["root"], exist_ok=True)
            os.makedirs(config["providers"]["session"]["root"], exist_ok=True)
            provider = MemoryProviderFactory().build(config)
            _run_sync(provider.initialize())
            return provider
        except Exception:  # noqa: BLE001 — 기억이 없을 뿐 턴은 산다
            logger.exception("memory provider unavailable — running without memory")
            return None

    def memory_write_available(self, workflow_id: str = "") -> bool:
        return True

    def agent_vault_root(self, workflow_id: str) -> str:
        self._check_agent(workflow_id)
        return str(self.state_dir / "memory" / "vault")

    def build_turn_memory_llm(
        self,
        provider: str,
        model: str,
        api_key: str,
        base_url: Optional[str],
        *,
        cli_auth_mode: str = "",
        cli_oauth_token: str = "",
        cli_binary_path: str = "",
        credentials: Optional[Mapping[str, Any]] = None,
    ) -> Optional[Any]:
        from xd_engine.memory_llm import build_memory_llm

        return build_memory_llm(provider, model, api_key, base_url, credentials)

    def jobs_prompt_block(self) -> str:
        return ""

    # ── E. 도구 ──────────────────────────────────────────────────────
    def build_connector_mcp_tools(self, user_id: Any, client_surface: Any) -> List[Any]:
        return []

    def build_host_skill_tools(self, **kwargs: Any) -> List[Any]:
        return []

    def build_job_tools(self, *args: Any, **kwargs: Any) -> List[Any]:
        return []

    def register_workflow_self_tools(self, registry: Any, **kwargs: Any) -> None:
        return None

    def register_forged_tools(self, registry: Any, **kwargs: Any) -> None:
        return None

    def register_builtin_tools(
        self,
        registry: Any,
        *,
        core: bool,
        user_id: Any,
        anthropic_api_key: str,
        ssh_servers: Sequence[Any],
    ) -> Dict[str, Any]:
        from xgen_agent_runtime.host.tool_exposure import registers_core
        from xgen_agent_runtime.tools.built_in import get_builtin_tools

        families = [f for f in _FAMILIES if self.setting(_FAMILY_FLAGS[f]).strip().lower() not in _FALSY]
        registered: List[str] = []
        for family in families:
            try:
                classes = get_builtin_tools(features=[family])
            except Exception as exc:  # noqa: BLE001 — 그 묶음만 빠진다
                logger.warning("built-in family %s unavailable: %s", family, exc)
                continue
            for name, cls in classes.items():
                if not name or registry.get(name) is not None:
                    continue
                try:
                    tool = cls()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("built-in tool %s unavailable: %s", name, exc)
                    continue
                try:
                    required = list(tool.required_config_keys() or [])
                except Exception:  # noqa: BLE001
                    required = []
                if required:
                    # 설정 토큰을 요구하는 도구(서버 기능 게이트)는 XD 에서 채울 수 없다 — 광고하지 않는다.
                    continue
                if family == "shell":
                    tool = gated_shell(tool, self._gate, self._s.conversation_id, self._ask)
                registry.register(tool, core=registers_core(name, flat=core))
                registered.append(name)
        return {"families": families, "tools": registered, "extras": {}}

    def build_run_tool_context(
        self,
        *,
        interaction_id: str,
        run_dir: str,
        extras: Optional[Dict[str, Any]] = None,
        storage_dir: Optional[str] = None,
        extra_allowed: Optional[List[str]] = None,
        sandbox: Optional[Any] = None,
    ) -> Any:
        from xgen_agent_runtime.tools.base import HOST_IS_EXECUTION_TARGET, ToolContext

        storage = storage_dir or run_dir
        os.makedirs(storage, exist_ok=True)
        allowed = [run_dir]
        for path in [*self._s.linked_folders, *(extra_allowed or [])]:
            if path not in allowed:
                allowed.append(path)
        return ToolContext(
            session_id=interaction_id or "default",
            working_dir=run_dir,
            storage_path=storage,
            allowed_paths=allowed,
            # 이 PC 가 실행 자리다 — 런타임 셸 도구가 "sandbox 없음" 을 장애로 읽지 않게.
            extras={**dict(extras or {}), HOST_IS_EXECUTION_TARGET: True},
            sandbox=None,
        )

    def load_ssh_servers(self) -> List[Any]:
        return []

    def tool_result_filter(self) -> None:
        return None

    # ── H. 보조 ──────────────────────────────────────────────────────
    def rag_context_builder(self, text: str, item: Any) -> Optional[str]:
        return None

    def fetch_vllm_max_model_len(self, base_url: str, model: Optional[str]) -> Optional[int]:
        """OpenAI 호환 서버(vLLM)가 알려 주는 모델 창 크기. 모르면 None(런타임 기본)."""
        try:
            import httpx

            resp = httpx.get(base_url.rstrip("/") + "/models", timeout=3.0)
            resp.raise_for_status()
            for item in resp.json().get("data") or []:
                if model and item.get("id") != model:
                    continue
                value = item.get("max_model_len")
                if value:
                    return int(value)
        except Exception:  # noqa: BLE001
            return None
        return None

    # ── G. 턴 정리 ───────────────────────────────────────────────────
    def finalize_turn(self, **kwargs: Any) -> None:
        # 파일은 처음부터 원본 자리에서 바뀌었다 — 반영할 곳이 없다.
        return None

    # ── F. CLI 제공자 ────────────────────────────────────────────────
    def build_cli_runtime(self, provider: str, params: Mapping[str, Any]) -> Any:
        raise RuntimeError(f"{provider} is not available in this XD build yet")

    def cli_bridge_available(self, provider: str) -> bool:
        return False


def memory_config(root: Path, interaction_id: str, agent_id: str) -> Dict[str, Any]:
    """파일 기억 — 대화 기록(STM)은 대화마다, 오래 가는 기억은 에이전트에 하나.

    서버(xgen-workflow ``memory_vault.build_agent_memory_config``)의 file 백엔드와 같은 구성이다.
    """
    from xgen_agent_runtime.host.ids import _safe_id

    session_id = _safe_id(interaction_id or "default")
    return {
        "provider": "composite",
        "session_id": session_id,
        "user_id": f"workflow:{_safe_id(agent_id)}",
        "providers": {
            "session": {
                "provider": "file",
                "root": str(root / "sessions" / session_id),
                "session_id": session_id,
                "scope": "session",
            },
            "vault": {
                "provider": "file",
                "root": str(root / "vault"),
                "session_id": session_id,
                "scope": "user",
            },
        },
        "layers": {"stm": "session", "ltm": "vault", "notes": "vault", "vector": "vault", "index": "vault"},
        "scope_providers": {"session": "session", "user": "vault"},
    }


def _run_sync(coro: Any) -> Any:
    """돌고 있는 루프가 없는 스레드(턴 스레드)에서 코루틴 하나를 끝까지."""
    return asyncio.run(coro)


def _os_name() -> str:
    if sys.platform == "win32":
        return f"Windows {platform.release()}".strip()
    if sys.platform == "darwin":
        return f"macOS {platform.mac_ver()[0]}".strip()
    return f"Linux ({platform.machine()})"


def environment_block(*, workspace: str, linked_folders: Sequence[str], tool_prefix: str) -> str:
    """에이전트에게 "어디서 도는가" 를 말한다 — 이 PC, 작업 폴더, 연결 폴더, 셸."""
    p = tool_prefix
    tools = "·".join(f"{p}{n}" for n in ("Bash", "Read", "Write", "Edit", "Glob", "Grep"))
    shell = "PowerShell" if sys.platform == "win32" else "sh"
    lines = [
        "## Execution environment",
        "",
        f"You run on the user's own computer ({_os_name()}) inside the XD app — there is no "
        "server and no sandbox. What you do here happens on this computer for real.",
        "",
        f"- **Working folder**: `{workspace}` — {tools} start here and relative paths resolve "
        "against it. Files here persist across conversations; keep your work in this folder.",
    ]
    if linked_folders:
        lines.append(
            "- **Linked folders** — the user connected these to you; you may read and write them: "
            + ", ".join(f"`{f}`" for f in linked_folders)
            + "."
        )
    lines += [
        "- File tools cannot reach anything outside these folders.",
        f"- **Shell** ({p}Bash): {shell} on this computer with the user's permissions. Commands "
        "that are hard to undo ask the user first; if the user refuses, it was not done — do not "
        "try to reach the same effect another way.",
        "- Installing packages changes this computer. Prefer project-local installs (a virtual "
        "environment or `node_modules` inside the working folder) over global ones.",
        "- The user sees your working folder in the app, so mention the paths of files you made.",
    ]
    return "\n".join(lines)
