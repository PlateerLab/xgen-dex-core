"""루트 구조 — 이름이 경로를 바꾸지 못한다, 연결 폴더는 있는 폴더의 실제 경로만."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from xd_engine.layout import Layout, LayoutError, check_folder_name, check_id


@pytest.mark.parametrize("value", ["a1", "agent_01", "x-y", "A" * 128])
def test_ids_accepted(value):
    assert check_id(value, "id") == value


@pytest.mark.parametrize("value", ["", "a/b", "../a", "a b", "한글", "A" * 129, None])
def test_ids_refused(value):
    with pytest.raises(LayoutError):
        check_id(value, "id")


@pytest.mark.parametrize("value", ["리서치 도우미", "My Agent", "agent.v2", "a-b_c (1)"])
def test_folder_names_accepted(value):
    assert check_folder_name(value) == value


@pytest.mark.parametrize(
    "value",
    ["", ".", "..", ".hidden", "a/b", "a\\b", "a:b", "what?", "trail.", "trail ", "CON", "con.txt", "LPT1", "a\x01b", "가" * 90],
)
def test_folder_names_refused(value):
    with pytest.raises(LayoutError):
        check_folder_name(value)


def test_layout_paths(tmp_path):
    layout = Layout.at(tmp_path / "XD")
    assert layout.workspace == layout.root / "workspace"
    assert layout.state == layout.root / ".xd"
    assert layout.agent_workspace("리서치") == layout.root / "workspace" / "리서치"
    assert layout.agent_state("a1") == layout.root / ".xd" / "agents" / "a1"
    with pytest.raises(LayoutError):
        layout.agent_workspace("../x")
    with pytest.raises(LayoutError):
        layout.agent_state("../x")


def test_root_must_be_absolute():
    with pytest.raises(LayoutError):
        Layout.at("relative/XD")


def test_linked_folders_are_real_existing_directories(tmp_path):
    layout = Layout.at(tmp_path / "XD")
    layout.state.mkdir(parents=True)
    a = tmp_path / "a"
    a.mkdir()
    assert layout.linked_folders([str(a), str(a), "", None]) == [os.path.realpath(a)]
    with pytest.raises(LayoutError):
        layout.linked_folders([str(tmp_path / "missing")])
    with pytest.raises(LayoutError):
        layout.linked_folders(["relative"])
    f = tmp_path / "file.txt"
    f.write_text("x")
    with pytest.raises(LayoutError):
        layout.linked_folders([str(f)])
    with pytest.raises(LayoutError):
        layout.linked_folders([str(layout.state)])
    inner = layout.state / "agents"
    inner.mkdir()
    with pytest.raises(LayoutError):
        layout.linked_folders([str(inner)])


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")
def test_linked_folder_symlink_into_state_is_refused(tmp_path):
    layout = Layout.at(tmp_path / "XD")
    layout.state.mkdir(parents=True)
    sneaky = tmp_path / "sneaky"
    sneaky.symlink_to(layout.state, target_is_directory=True)
    with pytest.raises(LayoutError):
        layout.linked_folders([str(sneaky)])
