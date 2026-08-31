/**
 * RPC 로 오가는 것의 모양 — 그리고 오지 않는 것.
 *
 * 여기서 **새로 선언하는 것은 배선뿐**이다(초기화 결과 · 알림 봉투 · 채팅 시작
 * 응답). 도메인 타입(Agent · Conversation · ChatEvent …)은 `@dex/engine` 에서
 * 그대로 다시 내보낸다.
 *
 * 예전에는 VSCode 확장이 이 파일에서 그 여덟 개를 **손으로 다시 선언**했다.
 * 서버가 필드를 하나 늘리면 프로토콜·엔진·확장 세 곳을 고쳐야 했고, 확장은 늘
 * 마지막에 잊혔다. 재선언을 지우면 잊을 자리가 없어진다.
 */
import type {
  Agent,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  Conversation,
  HistoryTurn,
  LocalToolsConfig,
  LocalToolSchema,
  LocalToolsStatus,
  McpBridgeStatus,
  ProfileSummary,
  ToolEvent,
} from '@dex/engine';

export type {
  Agent,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  Conversation,
  HistoryTurn,
  LocalToolsConfig,
  LocalToolSchema,
  LocalToolsStatus,
  McpBridgeStatus,
  ProfileSummary,
  ToolEvent,
};

/** RPC 배선의 버전. 서버와 클라이언트가 initialize 에서 맞춰 본다. */
export const DEX_PROTOCOL_VERSION = 1;

/**
 * 브릿지 상태의 이름 — 예전 CLI 는 `LocalToolBridgeStatus`, 데스크톱은
 * `McpBridgeStatus` 라고 불렀다. 같은 것이다. 엔진의 이름을 정본으로 삼고
 * 옛 이름은 별칭으로만 남긴다(확장 코드가 아직 그 이름을 쓴다).
 */
export type LocalToolBridgeStatus = McpBridgeStatus;

export interface InitializeResult {
  protocolVersion: number;
  server: { name: string; version: string };
  capabilities: {
    profiles: boolean;
    authentication: string[];
    agents: boolean;
    chatStreaming: boolean;
    chatCancellation: boolean;
    history: boolean;
    localTools: boolean;
    /** SSH 서버 관리. Teams · 음성은 아직 열지 않았다 — 타입은 있고 표면만 없다. */
    ssh?: boolean;
  };
}

export interface ChatStartResult {
  streamId: string;
  interactionId: string;
  workflowId: string;
  workflowName: string;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface ChatEventNotification {
  streamId: string;
  event: ChatEvent;
}

export interface ChatCompleteNotification {
  streamId: string;
  interactionId: string;
}

export interface ChatErrorNotification {
  streamId: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
