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
    # 없어진 폴더는 missing 을 주면 빼고 간다
    gone: list = []
    assert layout.linked_folders([str(tmp_path / "missing"), str(a)], gone) == [os.path.realpath(a)]
    assert gone == [str(tmp_path / "missing")]
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


def test_linked_folder_that_contains_state_is_refused(tmp_path):
    """루트·그 위(홈 등)를 연결하면 파일 도구가 .xd(데이터베이스·암호문)에 닿는다 — 받지 않는다."""
    layout = Layout.at(tmp_path / "XD")
    layout.state.mkdir(parents=True)
    for parent in (layout.root, tmp_path, Path(tmp_path.anchor)):
        with pytest.raises(LayoutError, match="contain"):
            layout.linked_folders([str(parent)], [])
    # 작업 공간(.xd 의 형제)은 괜찮다
    layout.workspace.mkdir()
    assert layout.linked_folders([str(layout.workspace)]) == [os.path.realpath(layout.workspace)]


def test_case_variant_of_state_is_caught_where_the_filesystem_ignores_case(tmp_path):
    """대소문자를 가리지 않는 파일 시스템(macOS 기본·Windows)에서 ``.XD`` 는 ``.xd`` 와 같은 폴더다 — 실체로 대조한다."""
    layout = Layout.at(tmp_path / "XD")
    layout.state.mkdir(parents=True)
    variant = layout.root / ".XD"
    if variant.exists():  # 대소문자를 가리지 않는다
        with pytest.raises(LayoutError, match="inside"):
            layout.linked_folders([str(variant)], [])
    else:  # 가리는 곳에서는 다른(없는) 폴더다
        gone: list = []
        assert layout.linked_folders([str(variant)], gone) == [] and gone == [str(variant)]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows long-path prefix")
def test_long_path_prefix_does_not_hide_state(tmp_path):
    layout = Layout.at(tmp_path / "XD")
    layout.state.mkdir(parents=True)
    with pytest.raises(LayoutError, match="contain"):
        layout.linked_folders(["\\\\?\\" + str(layout.root)], [])


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")
def test_linked_folder_symlink_into_state_is_refused(tmp_path):
    layout = Layout.at(tmp_path / "XD")
    layout.state.mkdir(parents=True)
    sneaky = tmp_path / "sneaky"
    sneaky.symlink_to(layout.state, target_is_directory=True)
    with pytest.raises(LayoutError):
        layout.linked_folders([str(sneaky)])
