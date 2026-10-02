"""Opt-in POSIX PTY bridge for the built product CLI. JSON lines stay in the fixture process."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 96, 0, 0))
child = subprocess.Popen(
    [sys.argv[1], sys.argv[2], "ui", "--canonical", "--user-id", sys.argv[3]],
    stdin=slave, stdout=slave, stderr=slave,
    env={**os.environ, "TERM": "xterm-256color", "CI": "false"},
)
os.close(slave)
deadline = time.monotonic() + 25

def terminate_bridge(_signum, _frame):
    raise SystemExit(1)

signal.signal(signal.SIGTERM, terminate_bridge)
signal.signal(signal.SIGINT, terminate_bridge)

def emit(value):
    print(json.dumps(value), flush=True)

try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            emit({"data": base64.b64encode(data).decode("ascii")})
        if sys.stdin in readable:
            line = sys.stdin.readline()
            if not line:
                break
            command = json.loads(line)
            if command.get("signal") == "SIGINT":
                child.send_signal(signal.SIGINT)
            elif command.get("signal") == "SIGTERM":
                child.send_signal(signal.SIGTERM)
            elif isinstance(command.get("key"), str):
                os.write(master, command["key"].encode("utf-8"))
        if child.poll() is not None and not readable:
            break
    if child.poll() is None:
        child.terminate()
    emit({"exit": child.wait(timeout=5)})
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
