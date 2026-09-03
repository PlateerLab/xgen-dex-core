/**
 * @dex/engine — 이 기기에서 실제로 무언가를 하는 것.
 *
 * 셸을 띄우고, 파일을 읽고, MCP 서버를 붙이고, 그 도구들을 XGEN 서버에 광고한다.
 * Node 를 쓰지만 **Electron 은 모른다** — 그래서 데스크톱에서도 터미널에서도
 * 같은 코드가 돈다.
 *
 * 쓰는 법: 앱이 시작할 때 포트를 한 번 붙이고, 그 뒤로는 그냥 부른다.
 *
 * ```ts
 * bindHost({ secrets, config, paths });
 * const bridge = getMcpBridge();
 * ```
 */

export * from './ports/index';
export {
  bindHost,
  unbindHost,
  isHostBound,
  hostPorts,
  mcpSecretStore,
  mcpOAuthStore,
} from './host';
export type { McpServerConfig, McpServerSecrets, McpOAuthState } from './mcp-types';
export { createMcpSecretStore, createMcpOAuthStore } from './secret-stores';
export type { McpSecretStore, McpOAuthStore } from './secret-stores';

// ── 로컬 도구 — 에이전트가 이 기기에서 부를 수 있는 것 ──
export * from './local-tools';
export * from './exec-resolve';

// ── MCP ──
export * from './mcp-manager';
export * from './mcp-secrets';
export * from './mcp-oauth';
export * from './mcp-runtime-log';

// ── 서버로 도구를 광고하는 유일한 통로 ──
export * from './mcp-bridge';

// ── 헤드리스 애플리케이션 코어 — 프로파일·인증·채팅·이력 ──
// CLI 와 RPC 서버가 이것을 그대로 쓴다. 데스크톱은 아직 자기 배선을 쓰지만
// 같은 자리에 있다 (다음 단계에서 합류).
export * from './dex-engine';
export * from './contract';
export * from './config-store';
export * from './credential-store';
export * from './errors';
export * from './local-tools-config';

// ── 연결 보안 (사내 인증서 · SSO) ──
export * from './connection-security';
export * from './deployment-defaults';
export * from './conversation-watch';
