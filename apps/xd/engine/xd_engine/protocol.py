"""데몬 프로토콜 v1 — stdio 위의 JSON 줄.

stdout 은 **프로토콜 전용**이다. 라이브러리의 ``print`` 나 자식 프로세스가 물려받은 fd 1 에 한
줄이라도 섞이면 main 은 그 줄을 사건으로 읽다 깨진다. 그래서 시작할 때 진짜 stdout 을 떼어 두고
fd 1 을 stderr 로 돌린다(:func:`claim_stdout`). 그 뒤로 사건은 :class:`Channel` 하나로만 나간다.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any, BinaryIO, Dict, Iterator, Optional, Tuple


class Channel:
    """사건 한 줄씩 내보내기. 턴 스레드 여럿이 같이 쓰므로 줄 단위로 잠근다."""

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self._closed = False

    def emit(self, event: Dict[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=False, default=str, separators=(",", ":"))
        data = (line + "\n").encode("utf-8")
        with self._lock:
            if self._closed:
                return
            try:
                self._stream.write(data)
                self._stream.flush()
            except (BrokenPipeError, ValueError, OSError):
                # main 이 사라졌다 — 더 쓸 곳이 없다. 데몬은 stdin EOF 로 곧 끝난다.
                self._closed = True

    def close(self) -> None:
        with self._lock:
            self._closed = True


def claim_stdout() -> Channel:
    """진짜 stdout 을 프로토콜 채널로 떼어 내고, fd 1 은 stderr 로 돌린다.

    fd 수준에서 돌린다 — ``sys.stdout`` 만 바꾸면 C 확장과 자식 프로세스(셸 도구)는 여전히 fd 1 에
    쓴다.
    """
    sys.stdout.flush()
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return Channel(os.fdopen(proto_fd, "wb", buffering=0))


def read_commands(stream: BinaryIO) -> Iterator[Tuple[Optional[Dict[str, Any]], str]]:
    """stdin 의 줄을 명령으로. 깨진 줄은 (None, 이유) 로 — 데몬은 알리고 다음 줄로 간다."""
    for raw in iter(stream.readline, b""):
        line = raw.strip()
        if not line:
            continue
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            yield None, f"invalid JSON: {exc}"
            continue
        if not isinstance(value, dict):
            yield None, "a command must be a JSON object"
            continue
        yield value, ""
