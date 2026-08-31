/**
 * MCP 서버 한 대의 설정 — **엔진의 도메인 타입**이다.
 *
 * 예전에는 데스크톱의 config.ts 안에 있었다. 그래서 MCP 매니저가 "설정 파일"을
 * import 해야 했고, 그 한 줄 때문에 MCP 전체가 Electron 앱에 묶여 있었다.
 * 타입이 있어야 할 자리는 그 타입을 쓰는 곳이지 그 타입을 저장하는 곳이 아니다.
 */

/** A local MCP server the connector hosts + proxies to the user's XGEN agents. */
export interface McpServerConfig {
  /** Unique, stable id used to namespace the server's tools. */
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** stdio: 실행 명령. `args` 가 없으면 따옴표 인식 분해로 argv 를 만든다
   *  (사람이 한 줄로 적는 경로), `args` 가 있으면 이 값은 **실행 파일**이다. */
  command?: string;
  /** stdio: 표준 MCP 설정(JSON)에서 가져온 argv. 문자열로 합쳤다 다시 쪼개면
   *  공백·따옴표가 든 인자가 깨지므로 분리 보존한다. */
  args?: string[];
  /** stdio: extra environment merged over the connector's env (e.g. API tokens). */
  env?: Record<string, string>;
  /** http: the MCP endpoint URL (Streamable HTTP). */
  url?: string;
  /** http: extra request headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** http/sse: 'oauth' runs an OAuth 2.1 (PKCE) browser flow and attaches the
   *  access token automatically (tokens stored encrypted). Default 'none'. */
  auth?: 'none' | 'oauth';
  /** Off servers are never connected/advertised. Default true. */
  enabled?: boolean;
}

/** 서버에 붙을 때만 풀어 쓰는 비밀. 설정 파일에는 절대 평문으로 남지 않는다. */
export interface McpServerSecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** OAuth 진행 상태 — 토큰 · 클라이언트 등록 정보 · PKCE verifier. */
export interface McpOAuthState {
  tokens?: unknown;
  clientInformation?: unknown;
  codeVerifier?: string;
}
