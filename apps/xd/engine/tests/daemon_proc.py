"""실제 데몬 프로세스를 띄워 stdio 로 말하는 시험 도우미."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

ENGINE_DIR = Path(__file__).resolve().parents[1]

#: Dex 위험 명령 규칙 중 시험에 쓰는 것(진짜 규칙과 같은지는 test_safety 가 본다).
RM_RF = {"source": r"\brm\s+-[a-z]*[rf]", "flags": "i"}


class DaemonProc:
    def __init__(self, root: Path, *, script: Optional[Dict[str, Any]] = None, tmp: Path) -> None:
        env = dict(os.environ)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONPATH"] = str(ENGINE_DIR) + os.pathsep + env.get("PYTHONPATH", "")
        self.log_path = tmp / "fake-requests.jsonl"
        if script is not None:
            script_path = tmp / "script.json"
            script_path.write_text(json.dumps(script, ensure_ascii=False), encoding="utf-8")
            env["XD_ENGINE_FAKE_LLM"] = str(script_path)
            env["XD_ENGINE_FAKE_LOG"] = str(self.log_path)
        self.stderr_path = tmp / "engine-stderr.log"
        self._stderr = open(self.stderr_path, "wb")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "xd_engine", "--root", str(root)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
            env=env,
            cwd=str(ENGINE_DIR),
        )
        self.events: "queue.Queue[Dict[str, Any]]" = queue.Queue()
        self.raw_lines: List[bytes] = []
        self.seen: List[Dict[str, Any]] = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in iter(self.proc.stdout.readline, b""):
            self.raw_lines.append(raw)
            try:
                self.events.put(json.loads(raw.decode("utf-8")))
            except (UnicodeDecodeError, json.JSONDecodeError):
                # stdout 에 프로토콜이 아닌 줄이 섞였다 — 시험이 이걸 잡는다.
                self.events.put({"type": "__garbage__", "raw": raw.decode("utf-8", "replace")})

    def send(self, command: Dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(command, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def send_raw(self, line: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(line)
        self.proc.stdin.flush()

    def until(self, pred: Callable[[Dict[str, Any]], bool], timeout: float = 60.0) -> Dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError(
                    f"timed out; events so far: {self.seen}\nstderr:\n{self.stderr_path.read_text(errors='replace')[-4000:]}"
                )
            try:
                event = self.events.get(timeout=left)
            except queue.Empty:
                continue
            self.seen.append(event)
            if pred(event):
                return event

    def terminal(self, turn_id: str, timeout: float = 60.0) -> Dict[str, Any]:
        return self.until(
            lambda e: e.get("id") == turn_id and e.get("type") in ("done", "error", "cancelled"),
            timeout,
        )

    def of(self, turn_id: str) -> List[Dict[str, Any]]:
        return [e for e in self.seen if e.get("id") == turn_id]

    def requests(self) -> List[Dict[str, Any]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines() if line]

    def close(self, timeout: float = 30.0) -> int:
        try:
            if self.proc.poll() is None:
                self.send({"type": "shutdown"})
        except (BrokenPipeError, OSError):
            pass
        try:
            code = self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            code = self.proc.wait()
        # 남은 사건을 마저 모은다 — 종료 직전 사건(취소 등)을 시험이 본다.
        time.sleep(0.05)
        while True:
            try:
                self.seen.append(self.events.get_nowait())
            except queue.Empty:
                break
        self._stderr.close()
        return code


def turn(turn_id: str, *, conversation: str = "c1", text: str = "go", agent: Optional[Dict[str, Any]] = None,
         config: Optional[Dict[str, Any]] = None, **extra: Any) -> Dict[str, Any]:
    cmd: Dict[str, Any] = {
        "type": "turn",
        "id": turn_id,
        "conversation": conversation,
        "text": text,
        "agent": {"id": "a1", "name": "Tester", "workspace": "Tester", **(agent or {})},
        "config": {"provider": "xd_fake", "model": "fake-1", "memory_distill": False, **(config or {})},
    }
    cmd.update(extra)
    return cmd
