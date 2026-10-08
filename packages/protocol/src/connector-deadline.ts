/**
 * 커넥터 호출(mcp_call) 하나를 기기가 기다리는 시간 — 데스크톱·휴대폰·브라우저가 같은 규칙을 쓴다.
 *
 * 서버는 호출마다 `deadline_ms` 를 싣고, 그 시간이 지나면 기기에 `mcp_cancel` 을 보낸 뒤 턴을 이어 간다.
 * 기기는 그보다 조금 먼저 스스로 멈추고 사유를 돌려준다 — 서버가 "응답 없음" 으로만 아는 일이 없게.
 */

export class LocalDeadlineError extends Error {
  constructor(tool: string, ms: number) {
    super(`[LOCAL_TIMEOUT] ${tool} 가 이 기기에서 ${Math.round(ms / 1000)}초 안에 끝나지 않아 멈췄습니다.`);
  }
}

/**
 * 이 기기에서 호출 하나를 기다리는 시간(ms). 서버가 `deadline_ms` 를 주면 그보다 조금 짧게(서버보다 먼저
 * 사유를 보내도록), 없으면(옛 서버) 도구 종류로 정한다. 외부 MCP 서버는 자기 시한(120초)이 있다.
 */
export function localDeadlineMs(tool: string, deadline: unknown, isLocal: boolean): number {
  const given = Number(deadline);
  if (Number.isFinite(given) && given > 0) return Math.max(1_000, given - 1_000);
  if (!isLocal) return 130_000;
  if (tool === 'Shell' || tool === 'ShellJob' || tool === 'CopyToWorkspace' || tool === 'CopyFromWorkspace') {
    return 595_000;
  }
  return 120_000;
}
