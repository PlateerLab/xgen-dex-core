"""XdHostServices — 런타임이 부르는 자리마다 이 PC 의 답을 하는가."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from xd_engine.host import TurnSetup, XdHostServices, environment_block
from xd_engine.layout import Layout
from xd_engine.safety import ApprovalGate


def _host(tmp_path: Path, **overrides) -> XdHostServices:
    layout = Layout.at(tmp_path / "XD")
    setup = TurnSetup(
        layout=layout,
        agent_id="a1",
        agent_name="리서치",
        workspace_name="리서치",
        conversation_id="c1",
        provider="openai",
        model="gpt-x",
        api_key="sk-test",
        base_url="http://localhost:11434/v1",
        **overrides,
    )
    return XdHostServices(setup, ApprovalGate(), lambda command: "deny")


def test_host_satisfies_the_runtime_protocol(tmp_path):
    from xgen_agent_runtime.host.host import HostServices

    assert isinstance(_host(tmp_path), HostServices)


def test_paths_live_under_the_root(tmp_path):
    host = _host(tmp_path)
    root = Layout.at(tmp_path / "XD").root
    assert host.agent_workspace_dir("a1") == str(root / "workspace" / "리서치")
    assert Path(host.agent_workspace_dir("a1")).is_dir()
    assert host.workspace_storage_root("a1") == str(root / ".xd" / "agents" / "a1")
    assert host.agent_vault_root("a1") == str(root / ".xd" / "agents" / "a1" / "memory" / "vault")
    with pytest.raises(ValueError):
        host.agent_workspace_dir("someone-else")


def test_credentials_only_for_the_turns_provider(tmp_path):
    host = _host(tmp_path, credentials={"region": "x"})
    assert host.resolve_model("openai", {}) == "gpt-x"
    assert host.resolve_api_key("openai", {}) == "sk-test"
    assert host.resolve_api_key("anthropic", {}) == ""
    assert host.resolve_base_url("openai", {}) == "http://localhost:11434/v1"
    assert host.resolve_base_url("anthropic", {}) is None
    assert host.resolve_credentials("openai", {}) == {"region": "x"}
    assert host.resolve_credentials("anthropic", {}) is None


def test_settings_come_from_the_turn_not_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_TOOLS_WEB_ENABLED", "0")
    host = _host(tmp_path, settings={"X_FLAG": "on"})
    assert host.setting("GENY_TOOLS_WEB_ENABLED") == ""
    assert host.setting("MISSING", "dflt") == "dflt"
    assert host.setting_truthy("X_FLAG")
    assert not host.setting_truthy("MISSING")


def test_server_owned_families_are_empty(tmp_path):
    host = _host(tmp_path)
    assert host.make_sandbox("a1", "local") is None
    assert host.hydrate_workspace("a1", "/x") is None
    assert host.build_connector_mcp_tools("local", "xd") == []
    assert host.build_host_skill_tools() == []
    assert host.build_job_tools("a1", "n", "local", in_scheduled_run=False, interaction_id="c1") == []
    assert host.load_ssh_servers() == []
    assert host.jobs_prompt_block() == ""
    assert host.rag_context_builder("q", {}) is None
    assert host.tool_result_filter() is None
    # CLI 턴의 도구는 XD 도구 다리로 닿는다. 계정에 CLI 설정이 없으면 클라이언트를 만들지 않는다.
    assert host.cli_bridge_available("claude_code") is True
    assert host.cli_bridge_available("openai") is False
    with pytest.raises(RuntimeError, match="no CLI"):
        host.build_cli_runtime("claude_code", {})


def test_builtin_tools_and_the_gated_shell(tmp_path):
    from xgen_agent_runtime.tools.registry import ToolRegistry

    host = _host(tmp_path)
    registry = ToolRegistry()
    summary = host.register_builtin_tools(registry, core=False, user_id="local", anthropic_api_key="", ssh_servers=[])
    assert summary["families"] == ["web", "parsing", "workflow", "filesystem", "shell"]
    for name in ("Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "TodoWrite", "ToolBatch", "ParseDocument"):
        assert registry.get(name) is not None, name
    # 서버 sandbox 를 말하는 런타임 설명 대신 이 PC 의 사실이 모델에게 간다.
    from xgen_agent_runtime.tools.definition import api_definition

    bash = api_definition(registry.get("Bash"))
    assert "user's own computer" in bash["description"]
    assert "sandbox — your own isolated workspace on the server" not in bash["description"]
    assert bash["input_schema"]["required"] == ["command"]


def test_families_can_be_switched_off(tmp_path):
    from xgen_agent_runtime.tools.registry import ToolRegistry

    host = _host(tmp_path, settings={"GENY_TOOLS_SHELL_ENABLED": "0", "GENY_TOOLS_WEB_ENABLED": "off"})
    registry = ToolRegistry()
    summary = host.register_builtin_tools(registry, core=False, user_id="local", anthropic_api_key="", ssh_servers=[])
    assert "shell" not in summary["families"] and "web" not in summary["families"]
    assert registry.get("Bash") is None and registry.get("WebSearch") is None
    assert registry.get("Read") is not None


def test_tool_context_allows_workspace_and_linked_folders(tmp_path):
    from xgen_agent_runtime.tools.base import HOST_IS_EXECUTION_TARGET

    linked = tmp_path / "docs"
    linked.mkdir()
    host = _host(tmp_path, linked_folders=[os.path.realpath(linked)])
    run_dir = host.agent_workspace_dir("a1")
    storage = os.path.join(host.workspace_storage_root("a1"), "executor")
    ctx = host.build_run_tool_context(
        interaction_id="c1", run_dir=run_dir, extras={}, storage_dir=storage, extra_allowed=[], sandbox=None
    )
    assert ctx.working_dir == run_dir
    assert ctx.allowed_paths == [run_dir, os.path.realpath(linked)]
    assert ctx.storage_path == storage and Path(storage).is_dir()
    assert ctx.sandbox is None
    assert ctx.extras[HOST_IS_EXECUTION_TARGET] is True


def test_environment_block_names_the_places_and_the_tools():
    block = environment_block(workspace="/r/workspace/a", linked_folders=["/home/me/docs"], tool_prefix="")
    assert "/r/workspace/a" in block and "/home/me/docs" in block
    assert "no server and no sandbox" in block
    assert "Bash·Read" in block
    cli = environment_block(workspace="/r/workspace/a", linked_folders=[], tool_prefix="mcp__connector__")
    assert "mcp__connector__Bash" in cli
    assert "Linked folders" not in cli


def test_memory_provider_lives_in_the_state_folder(tmp_path):
    host = _host(tmp_path)
    provider = host.build_memory_provider("a1", "c1")
    assert provider is not None
    import asyncio

    asyncio.run(provider.close())
    mem = Layout.at(tmp_path / "XD").root / ".xd" / "agents" / "a1" / "memory"
    assert (mem / "vault").is_dir()
    assert (mem / "sessions" / "c1").is_dir()


def test_memory_llm_for_api_providers_only(tmp_path):
    host = _host(tmp_path)
    llm = host.build_turn_memory_llm("openai", "gpt-x", "sk-test", None)
    assert llm is not None and llm.model_config.model == "gpt-x"
    assert host.build_turn_memory_llm("claude_code", "sonnet", "", None) is None
