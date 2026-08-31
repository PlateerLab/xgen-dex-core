// 기동에 실패하는 MCP 서버 흉내 — 진짜 원인은 stderr 에만 남기고 죽는다.
// (실제 사고 재현: uvx 가 패키지를 못 찾거나 서버가 ImportError 로 죽는 경우)
process.stderr.write('ModuleNotFoundError: No module named "mcp_server_thing"\n')
process.stderr.write('  hint: pip install mcp-server-thing\n')
process.exit(1)
