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
  ChatAttachmentDescriptor,
  ChatStopResult,
  Conversation,
  ConversationSnapshot,
  HistoryTurn,
  LocalToolsConfig,
  LocalToolSchema,
  LocalToolsStatus,
  McpBridgeStatus,
  ProfileSummary,
  ToolEvent,
  NativeSessionSummary,
  NativeEnrollmentResult,
  NativeAgentFocusUpdate,
  NativeAgentConversationUpdate,
  NativeConversationView,
  NativeCapabilitySnapshot,
} from '@dex/engine';
import type { SubmittedAgentTurn, StoppedAgentTurn } from '@dex/protocol/agent-session-mutation';
import type { AgentFocus, parseAgentSessionList } from '@dex/protocol/agent-session';
import type { CreatedAgentSession } from '@dex/protocol/agent-session-lifecycle';
import type { NativeAttachmentDraftView } from './native-attachment-drafts';
import type {
  AdoptedCapabilityApproval,
  CapabilityApprovalPage,
  CapabilityCatalog,
  CapabilitySelection,
} from '@dex/protocol/agent-capabilities';

export type { NativeAttachmentDraftView, NativeAttachmentDraftStatus, NativeAttachmentSelectionLimits,
  TrustedNativeAttachment } from './native-attachment-drafts';

export type {
  Agent,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  ChatAttachmentDescriptor,
  ChatStopResult,
  Conversation,
  ConversationSnapshot,
  HistoryTurn,
  LocalToolsConfig,
  LocalToolSchema,
  LocalToolsStatus,
  McpBridgeStatus,
  ProfileSummary,
  ToolEvent,
  NativeSessionSummary,
  NativeEnrollmentResult,
  NativeConversationView,
  NativeCapabilitySnapshot,
  AdoptedCapabilityApproval,
  CapabilityApprovalPage,
  CapabilityCatalog,
  CapabilitySelection,
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
    /** chat/start 가 localFolders(이 대화에 연결할 이 기기의 폴더)를 받는다. */
    localFolders?: boolean;
    /** SSH 서버 관리. Teams · 음성은 아직 열지 않았다 — 타입은 있고 표면만 없다. */
    ssh?: boolean;
    nativePlatformSession?: { platform: 'vscode'; storage: 'os-keychain-software'; canonicalConversation?: true; canonicalLive?: true; canonicalTurns?: true; canonicalSessions?: true; canonicalAttachments?: true; canonicalCapabilities?: true };
    /** conversation/model(·/set·/reset) — 대화 도중 모델 바꾸기(다음 답변부터). */
    conversationModel?: boolean;
    /** conversation/thinking/set(·/reset) — 대화 도중 생각(추론) 값 바꾸기(지금 모델이 받는 값만). */
    conversationThinking?: boolean;
    /** history/conversationPage · history/rename · history/delete · history/purgeDeletedAgents (대화 목록). */
    conversationList?: boolean;
    /** conversations/watch · conversations/unwatch → conversations/changed 알림(대화 목록 실시간). */
    conversationListWatch?: boolean;
    /** agents/createOptions · agents/nameTaken · agents/create (시작 화면의 새 에이전트). */
    agentCreate?: boolean;
    /** history/search (채팅 검색: 제목·에이전트 이름·대화 내용). */
    conversationSearch?: boolean;
    /** history/conversationAgents · history/conversationPage 의 workflowId (사이드바 [최근 채팅] · [에이전트]). */
    conversationAgents?: boolean;
    /** chat/checkInput {text, workflowId?, profile?} → ChatInputCheck (통제 정책 입력창 사전 검사). */
    chatInputCheck?: boolean;
  };
}

export interface NativeRpcResult {
  focus?: AgentFocus;
  sessions?: ReturnType<typeof parseAgentSessionList>;
  created?: CreatedAgentSession;
  agent_session_id?: string;
  mutation?: SubmittedAgentTurn | StoppedAgentTurn;
  workflow_id?: string;
  attachments?: readonly NativeAttachmentDraftView[];
  capability_catalog?: CapabilityCatalog & { authScope: string };
  capability_approvals?: CapabilityApprovalPage;
  capability_connection?: NativeCapabilitySnapshot;
  capability_selection?: CapabilitySelection;
  capability_adoption?: AdoptedCapabilityApproval;
  platform_type: 'vscode' | 'desktop'; profile: string; server_url: string; user_id: string;
  result?: NativeSessionSummary | NativeEnrollmentResult;
  watch_id?: string;
  view?: 'conversation';
  conversation?: NativeConversationView;
  has_more?: boolean;
  server_revoked?: false;
}
export interface NativeFocusNotification {
  platform_type: 'vscode' | 'desktop'; profile: string; server_url: string; watch_id: string;
  update: NativeAgentFocusUpdate;
}
export interface NativeConversationNotification {
  platform_type: 'vscode' | 'desktop'; profile: string; server_url: string; watch_id: string;
  view: 'conversation';
  update: NativeAgentConversationUpdate;
}
export interface NativeCapabilityNotification {
  platform_type: 'vscode' | 'desktop'; profile: string; server_url: string; user_id: string;
  view: 'capabilities';
  snapshot: NativeCapabilitySnapshot;
}
export type NativeSessionNotification = NativeFocusNotification | NativeConversationNotification | NativeCapabilityNotification;

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
