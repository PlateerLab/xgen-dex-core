"""루트 폴더 구조 — main 의 ``src/main/data-root.ts`` (rootLayout)와 같은 모양.

::

    <루트>/workspace/<작업 공간 이름>/   에이전트의 작업 공간(사용자 파일)
    <루트>/.xd/agents/<에이전트 id>/       엔진 상태 — 기억·도구 결과·실행 기록

이름은 main 이 정해서 넘긴다. 여기서는 그 이름이 **한 칸짜리 폴더 이름**인지만 다시 본다 —
``..`` 나 구분자가 섞이면 작업 공간이 루트 밖이나 다른 에이전트의 폴더를 가리킨다.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

#: 에이전트·대화 id — main 이 만드는 값. 경로 한 칸으로 쓰이므로 글자를 좁힌다.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

#: Windows 가 파일 이름으로 받지 않는 글자. 다른 OS 에서도 막는다 — 루트를 다른 OS 로 옮겨도
#: 열리게.
_BAD_NAME_CHARS = set('<>:"/\\|?*')
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class LayoutError(ValueError):
    """main 이 넘긴 이름·경로가 루트 구조에 맞지 않는다."""


def check_id(value: object, what: str) -> str:
    text = str(value or "")
    if not _ID_RE.match(text):
        raise LayoutError(f"{what} must be 1-128 letters, digits, '-' or '_' (got {text!r})")
    return text


def check_folder_name(value: object) -> str:
    """작업 공간 폴더 이름 하나. 한글 등 글자는 그대로 두고, 경로를 바꾸는 것만 막는다."""
    name = str(value or "")
    if not name or name in (".", "..") or name.startswith("."):
        raise LayoutError(f"invalid workspace folder name: {name!r}")
    if any(ch in _BAD_NAME_CHARS or ord(ch) < 32 for ch in name):
        raise LayoutError(f"invalid workspace folder name: {name!r}")
    if name != name.rstrip(" .") or len(name.encode("utf-8")) > 255:
        raise LayoutError(f"invalid workspace folder name: {name!r}")
    if name.split(".", 1)[0].upper() in _WINDOWS_RESERVED:
        raise LayoutError(f"invalid workspace folder name: {name!r}")
    return name


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _strip_long_prefix(text: str) -> str:
    """Windows 의 긴 경로 접두사(``\\\\?\\``)를 걷는다 — realpath 가 그대로 두어 글자 비교를 비껴간다."""
    if text.startswith("\\\\?\\UNC\\"):
        return "\\\\" + text[8:]
    if text.startswith("\\\\?\\"):
        return text[4:]
    return text


def _identity(path: Path) -> Optional[os.stat_result]:
    """폴더의 실체(st_dev·st_ino). 파일 번호를 주지 않는 파일 시스템(FAT·일부 네트워크 공유는 0)에서는 모른다(None)
    — 0 끼리 같다고 보면 그 볼륨의 모든 폴더가 ``.xd`` 와 "같은" 폴더가 된다."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st if st.st_ino else None


def _under(path: Path, parent: Path) -> bool:
    """``path`` 가 ``parent`` 안(같은 곳 포함)인가 — 글자(대소문자는 OS 규칙대로)와 실체(같은 폴더인지) 둘 다 본다.

    글자만 보면 대소문자를 가리지 않는 파일 시스템(macOS 기본·Windows)에서 ``/Users/me/xd/.XD`` 같은 표기가
    비껴간다. 그래서 ``path`` 와 그 위 폴더 가운데 있는 것을 ``parent`` 와 같은 폴더인지(st_dev·st_ino)로도 대조한다
    (``parent`` 는 한 번만 본다).
    """
    if _is_within(Path(os.path.normcase(path)), Path(os.path.normcase(parent))):
        return True
    target = _identity(parent)
    if target is None:
        return False
    for candidate in (path, *path.parents):
        st = _identity(candidate)
        if st is not None and os.path.samestat(st, target):
            return True
    return False


@dataclass(frozen=True)
class Layout:
    root: Path

    @classmethod
    def at(cls, root: str | os.PathLike[str]) -> "Layout":
        path = Path(root).expanduser()
        if not path.is_absolute():
            raise LayoutError(f"root must be an absolute path (got {str(root)!r})")
        return cls(Path(os.path.realpath(path)))

    @property
    def workspace(self) -> Path:
        return self.root / "workspace"

    @property
    def state(self) -> Path:
        return self.root / ".xd"

    def agent_workspace(self, folder_name: str) -> Path:
        return self.workspace / check_folder_name(folder_name)

    def agent_state(self, agent_id: str) -> Path:
        return self.state / "agents" / check_id(agent_id, "agent id")

    def linked_folders(self, paths: Iterable[object], missing: Optional[List[str]] = None) -> List[str]:
        """연결 폴더 — 있는 폴더의 실제 경로만, 순서대로, 겹친 것은 한 번.

        XD 상태 폴더(``.xd``)는 안쪽도, 그것을 **품은** 폴더(루트·홈·``/`` …)도 받지 않는다. 그 안에는
        데이터베이스와 암호문이 있다 — 에이전트 파일 도구가 그걸 고치면 앱이 깨진다(심볼릭 링크로 돌아와도).

        지워졌거나 옮겨진 폴더는 턴을 막지 않는다 — 빼고 간다(``missing`` 을 주면 거기에 적는다). 폴더 하나가
        없어졌다고 그 에이전트의 모든 대화가 멈추면 안 된다.
        """
        out: List[str] = []
        state = Path(os.path.realpath(self.state))
        for raw in paths or ():
            text = str(raw or "").strip()
            if not text:
                continue
            path = Path(_strip_long_prefix(text)).expanduser()
            if not path.is_absolute():
                raise LayoutError(f"linked folder must be an absolute path: {text!r}")
            real = Path(_strip_long_prefix(os.path.realpath(path)))
            if _under(real, state):
                raise LayoutError(f"linked folder cannot be inside XD's own state folder: {text!r}")
            if _under(state, real):
                raise LayoutError(f"linked folder cannot contain XD's own state folder: {text!r}")
            if not real.is_dir():
                if missing is None:
                    raise LayoutError(f"linked folder does not exist: {text!r}")
                missing.append(text)
                continue
            if str(real) not in out:
                out.append(str(real))
        return out
