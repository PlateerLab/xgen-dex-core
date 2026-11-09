/**
 * 커넥터 브리지(mcp_call) 프로토콜 버전 — 데스크톱·CLI·VSCode(엔진)와 휴대폰이 같은 규칙을 쓴다.
 *
 * 기기는 v2 만 실행한다: 서버의 `ready` 가 `protocol_version: 2` 와 연결 세대 번호를 주고, 호출마다
 * 같은 세대와 nonce 가 붙어야 한다(1.102.0, 인증된 연결에만 실행을 묶은 보안 수정).
 *
 * 그 수정 전의 서버(v1)는 이 칸들을 모른다. 기기가 v1 호출을 **답 없이 버리면** 서버는 자기 시한까지
 * 기다리고, 사용자에게는 에이전트가 이유 없이 멈춘 것으로 보인다(2026-11-06 체험존: BrowserNavigate·
 * BrowserTabs 가 결과 없이 멈춤). 그래서 v1 호출에는 **아무것도 실행하지 않고** 실패로 바로 답한다 —
 * 실행하지 않으니 보안 수정의 취지와 어긋나지 않고, 에이전트는 이유를 받아 사용자에게 알린다.
 */

export const CONNECTOR_PROTOCOL_VERSION = 2;

/** 브리지 상태의 `error` 코드 — 서버가 v2 를 모른다. */
export const UNSUPPORTED_CONNECTOR_PROTOCOL = 'unsupported_mcp_protocol';

/**
 * 사람에게 보여 줄 안내(채팅 화면·설정). `tools` 는 쓸 수 없게 된 도구 — 데스크톱은 기본값,
 * 휴대폰은 '이 휴대폰의 도구'.
 */
export function unsupportedConnectorProtocolNotice(tools = '이 PC 의 도구(브라우저·파일·명령)'): string {
  return (
    `연결한 XGEN 서버가 이 DeX 버전과 맞지 않아, 에이전트가 ${tools}를 쓸 수 없습니다. ` +
    '서버 관리자에게 XGEN 서버 업데이트를 요청해 주세요.'
  );
}

/**
 * v1 호출에 돌려줄 오류 — 에이전트가 읽는다. 다른 도구로 같은 시도를 되풀이하지 않고 사용자에게
 * 그대로 알리도록 이유와 할 일을 함께 싣는다.
 */
export const UNSUPPORTED_CONNECTOR_PROTOCOL_ERROR =
  '[UNSUPPORTED_SERVER] 이 XGEN 서버가 이 기기 DeX 의 도구 연결 방식(커넥터 프로토콜 v2)을 지원하지 않아 ' +
  '도구를 실행하지 않았습니다. 이 기기의 다른 도구도 같은 이유로 모두 실패하니 다시 시도하지 말고, ' +
  '사용자에게 XGEN 서버 업데이트가 필요하다고 알려 주세요.';

/**
 * v1 서버가 보낸 `mcp_call` 이면 돌려줄 실패 프레임(v1 형식), 아니면 null.
 *
 * v2 프레임은 세대·nonce 가 어긋나도 여기서 답하지 않는다 — 지난 세대의 늦은 프레임이고, v2 서버는
 * 자기 시한과 `mcp_cancel` 로 정리한다(답하면 새 세대에 옛 호출의 답이 섞일 수 있다).
 */
export function legacyCallRejection(msg: {
  type?: unknown;
  request_id?: unknown;
  protocol_version?: unknown;
}): { type: 'mcp_result'; request_id: string; ok: false; error: string } | null {
  if (msg.type !== 'mcp_call') return null;
  if (msg.protocol_version === CONNECTOR_PROTOCOL_VERSION) return null;
  const requestId = typeof msg.request_id === 'string' ? msg.request_id.trim() : '';
  if (!requestId) return null;
  return { type: 'mcp_result', request_id: requestId, ok: false, error: UNSUPPORTED_CONNECTOR_PROTOCOL_ERROR };
}
