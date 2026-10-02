"""시험용 MCP 서버(stdio) — 동봉 인터프리터의 mcp SDK(FastMCP)로 뜬다."""

import os
import sys

from mcp.server.fastmcp import FastMCP

server = FastMCP("demo")


@server.tool()
def echo(text: str) -> str:
    """Echo the text back."""
    return f"echo: {text}"


@server.tool()
def where() -> str:
    """Where this server runs — its working folder, pid and one env value."""
    return f"{os.getcwd()}|{os.getpid()}|{os.environ.get('DEMO_TOKEN', '')}"


@server.tool()
def slow(seconds: float) -> str:
    """Sleep, then answer."""
    import time

    time.sleep(seconds)
    return "slept"


@server.tool()
def boom() -> str:
    """Always fails."""
    raise RuntimeError("boom from the server")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--crash":
        sys.exit(3)
    # 시험이 띄운 프로세스를 모두 찾을 수 있게(고아가 남지 않는지).
    if os.environ.get("DEMO_PIDS"):
        with open(os.environ["DEMO_PIDS"], "a", encoding="utf-8") as fh:
            fh.write(f"{os.getpid()}\n")
    server.run()
