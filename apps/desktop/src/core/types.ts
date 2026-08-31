/**
 * Shared types for the XGen Dex transport layer.
 *
 * These mirror the real XGEN gateway/workflow API (see docs/PROTOCOL.md). The
 * transport layer is framework-agnostic (no Electron/React imports) so it can
 * be unit-tested and reused by the renderer, the main process, or headless
 * tooling.
 */

export interface ServerConfig {
  /** Gateway origin, e.g. "https://xgen.example.com" or "http://localhost:8000". */
  baseUrl: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string; // "bearer"
}

export interface CurrentUser {
  userId: string;
  username: string;
  isSuperuser: boolean;
  roles: string[];
  permissions: string[];
}

export interface LoginResult extends AuthTokens {
  userId: string;
  username: string;
}

/** One agent (agentflow) as shown in the "Agent 목록" grid. */
export interface Agent {
  id: number;
  workflowId: string;
  workflowName: string;
  nodeCount: number;
  isShared: boolean; // false=개인(personal), true=공유(shared)
  isDeployed: boolean; // false=미배포, true=배포
  isCompleted: boolean;
  workflowType: string; // "canvas" | "harness"
  description: string;
  username: string;
  fullName: string;
  createdAt: string;
  updatedAt: string;
  /** True when this workflow contains the server-runtime agents/geny node. */
  hasAgentGeny?: boolean;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface AgentListResult {
  items: Agent[];
  pagination: Pagination;
}

export interface AgentListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  /** active | draft | unactive | active_or_draft | archived */
  status?: string;
  /** "personal" (개인) | "shared" (공유) */
  owner?: 'personal' | 'shared';
  includeHarness?: boolean;
}

/** A citation attached to a tool result (RAG source). */
export interface Citation {
  fileName?: string;
  pageNumber?: number;
  score?: number;
  chunkText?: string;
  [k: string]: unknown;
}

/** A tool / agent activity event surfaced during a chat turn. */
export interface ToolEvent {
  eventType: 'tool_call' | 'tool_start' | 'tool_result' | 'tool_error' | string;
  toolName?: string;
  toolInput?: unknown;
  result?: string;
  resultLength?: number;
  error?: string;
  citations?: Citation[];
  runId?: string;
  indicator?: unknown;
  durationMs?: number;
  timestamp?: string;
  [k: string]: unknown;
}

export interface NodeStatusEvent {
  nodeId: string;
  status: string;
  [k: string]: unknown;
}

/**
 * Normalized chat stream events delivered to the caller. The raw SSE protocol
 * (named `event:` frames + default `data:` frames carrying a `type`) is
 * flattened into this single discriminated union.
 */
export type ChatEvent =
  | { kind: 'text'; content: string } // streamed assistant text chunk
  | { kind: 'tool'; event: ToolEvent } // tool / agent activity
  | { kind: 'node_status'; event: NodeStatusEvent }
  | { kind: 'log'; data: unknown }
  | { kind: 'execution_io'; executionIoId: number }
  | { kind: 'download'; data: Record<string, unknown> }
  | { kind: 'ui_command'; surface: 'a2ui' | 'floui'; command: Record<string, unknown> }
  | { kind: 'quota'; level: 'warning' | 'exceeded'; data: Record<string, unknown> }
  | { kind: 'summary'; text: string; data: Record<string, unknown> }
  | { kind: 'error'; detail: string }
  // 실행 환경 안내(커넥터 전용) — 이 턴이 어디서 도는지. connector_local = 이 PC 의
  // 사이드카, server_sandbox = 서버 sandbox(로컬 불가 사유 reason 포함),
  // blocked = 실행 자체가 차단됨(reason: 'quota_exceeded' 등 — 서버 폴백 없이 턴 종료).
  | {
      kind: 'status';
      surface: 'connector_local' | 'server_sandbox' | 'blocked';
      provider?: string;
      workspaceDir?: string;
      reason?: string;
      detail?: string;
    }
  | { kind: 'end' };

export interface ChatRequest {
  workflowId: string;
  workflowName: string;
  input: string | Record<string, unknown> | unknown[];
  /** Conversation key — reuse across turns to continue a conversation. */
  interactionId: string;
  selectedCollections?: string[];
  selectedFiles?: (string | Record<string, unknown>)[];
  /** 서버에 보내는 실행 환경 지시 — 커넥터가 로컬 실행 불가로 폴백할 때 'sandbox'
   *  (서버는 커넥터 로컬 워크스페이스 프로브를 건너뛰고 서버 sandbox 에서 돌린다). */
  executionTarget?: 'sandbox';
  includeLogs?: boolean;
  includeNodeStatus?: boolean;
  includeToolEvents?: boolean;
}

/**
 * Voice (STT/TTS) preferences — read-only hints surfaced to the connector UI.
 * The authoritative config is edited in the XGEN web 마이페이지; the connector
 * only reflects it. Shapes mirror the stored `preferences.stt` / `preferences.tts`
 * JSON (snake_case on the wire) so no lossy mapping is needed. Secrets
 * (base_url/api_key) NEVER appear here — those stay server-side.
 */
export interface SttPref {
  enabled: boolean;
  provider?: string;
  model_id?: string;
  language?: string;
}

/** One TTS voice profile: a saved named {voice + params} bundle (no cloning). */
export interface TtsProfile {
  id: string;
  name: string;
  provider: string;
  voice_id: string;
  speed: number;
  format: string;
  language: string;
  emotion: string;
}

export interface TtsPref {
  enabled: boolean;
  active_profile_id: string | null;
  profiles: TtsProfile[];
}

/** Voice config as read by the connector (UI hints only). */
export interface VoiceConfig {
  stt: SttPref | null;
  tts: TtsPref | null;
}

/**
 * Per-request overrides for TTS `speak`. All optional — when omitted the backend
 * uses the caller's active TTS profile. Snake_case to match the proxy body
 * `{ text, voice_id?, provider?, speed?, format?, language?, emotion? }`.
 */
export interface TtsSpeakOptions {
  voice_id?: string;
  provider?: string;
  speed?: number;
  format?: string;
  language?: string;
  emotion?: string;
}

/** One past turn from the conversation history (io-logs). */
export interface HistoryAttachment {
  id?: string | number;
  name: string;
  size: number;
  contentType: string;
  type: 'picture' | 'file';
  /** Storage reference returned by the chat history API. */
  path: string;
  bucket: string;
}

export interface HistoryTurn {
  logId: number;
  ioId: number;
  interactionId: string;
  workflowId: string;
  workflowName: string;
  input: string;
  output: string;
  attachments: HistoryAttachment[];
  updatedAt: string;
}

/** A past conversation (interaction) for the sidebar. */
export interface Conversation {
  id: number;
  interactionId: string;
  workflowId: string;
  workflowName: string;
  interactionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// Teams — 사람 사이의 대화 (XGEN Teams, /api/teams/*)
//
// 서버(xgen-workflow/controller/teams)는 방·메시지·멤버·첨부·WebSocket 을 이미
// 제공한다. 커넥터는 그 API 를 그대로 쓰고, snake_case → camelCase 변환은 전부
// core/teams.ts 한 곳에서 끝낸다 (렌더러는 raw 응답을 절대 보지 않는다).
// ─────────────────────────────────────────────────────────────

/**
 * 방의 라우팅 모드 — 에이전트가 언제 끼어드는가.
 *   chat   : 에이전트 침묵, 사람끼리만 대화 (@mention / "!" 는 예외 탈출구)
 *   hybrid : Router LLM 이 chat/task 를 판단해 매칭 에이전트만 실행
 *   manual : 분류 없이 모든 메시지를 방 에이전트에게 전달
 * 커넥터는 1차 목표(사람 사이의 대화)에 맞춰 방을 만들 때 'chat' 을 쓴다.
 */
export type TeamsRouterMode = 'chat' | 'hybrid' | 'manual' | 'auto';

/** 메시지를 보낸 주체. system 은 입장/퇴장 등 서버가 만든 안내. */
export type TeamsSenderType = 'user' | 'agent' | 'router' | 'system';

/** 채팅방 한 개 (목록 카드에 필요한 만큼). */
export interface TeamsRoom {
  id: string;
  name: string;
  description?: string;
  routerMode: TeamsRouterMode;
  /** 1:1 대화방인지. 멤버가 늘면 서버가 자동으로 false 로 바꾼다. */
  isDirect: boolean;
  createdAt: string;
  createdBy: number;
  /** 마지막 메시지 시각 (ISO). 목록 정렬 기준. */
  lastMessageAt?: string;
}

/** 방 멤버 (사람). */
export interface TeamsMember {
  userId: number;
  username: string;
  /** 사용자 프로필의 표시 이름. 없으면 username 을 쓴다. */
  fullName?: string;
  role: 'owner' | 'admin' | 'member';
  isOnline: boolean;
  joinedAt: string;
}

/** 이모지 리액션 집계 한 줄. */
export interface TeamsReaction {
  emoji: string;
  count: number;
  userIds: number[];
}

/**
 * 메시지에 매달린 첨부 파일 메타 — 서버 `attachment_controller` 업로드 응답과
 * 1:1 로 대응한다.
 *
 * `extractedText` 를 들고 다니는 이유: 서버는 업로드 시점에 문서에서 본문을
 * 추출해 돌려주고, **메시지를 보낼 때 그 값을 함께 실어야만** 나중에 에이전트가
 * 그 첨부의 내용을 볼 수 있다 (서버가 워크플로우 입력에 prepend 한다). 업로드
 * 응답을 받아 그대로 되돌려주지 않으면 파일은 붙되 내용은 사라진다.
 */
export interface TeamsAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  storageKey: string;
  /** 서버가 추출한 본문. 이미지처럼 추출 대상이 아니면 없다. */
  extractedText?: string;
  /** 추출 본문이 서버 상한(50만자)에서 잘렸는가. */
  truncated?: boolean;
}

/** 메시지 한 개. */
export interface TeamsMessage {
  id: string;
  roomId: string;
  senderType: TeamsSenderType;
  /** user 면 user_id 문자열, agent 면 agent id. */
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
  reactions?: TeamsReaction[];
  attachments?: TeamsAttachment[];
  replyToId?: string;
  replyToSenderName?: string;
  replyToContent?: string;
  isEdited?: boolean;
  editedAt?: string;
}

/** 초대 대상 검색 결과 (XGEN 사용자). */
export interface TeamsUser {
  id: number;
  username: string;
  fullName?: string;
  email?: string;
}

/**
 * 메인 프로세스의 WebSocket 이 렌더러로 밀어 주는 이벤트 — 서버 원본 프레임을
 * 그대로 넘기지 않고 커넥터가 쓰는 것만 좁혀 정규화한다.
 *
 * `roomId` 는 어떤 방에서 온 이벤트인지 항상 채워진다 (user WS 의 알림 포함).
 */
export type TeamsEvent =
  /** 방 WS 연결 상태 — 렌더러가 "연결 끊김" 배너를 띄우는 근거. */
  | { kind: 'status'; roomId: string; connected: boolean }
  | { kind: 'message'; roomId: string; message: TeamsMessage }
  /**
   * 메시지 편집. **전체 메시지가 아니라 바뀐 부분만** 온다 — 서버의
   * `message_updated` 프레임이 `{message_id, content, edited_at}` 뿐이기 때문이다
   * (`message_controller.edit_message`). 전체 메시지로 착각해 통째로 갈아끼우면
   * 답장 인용·첨부처럼 프레임에 없는 필드가 지워진다.
   */
  | {
      kind: 'message_edited';
      roomId: string;
      messageId: string;
      content: string;
      editedAt?: string;
    }
  | { kind: 'reactions'; roomId: string; messageId: string; reactions: TeamsReaction[] }
  | { kind: 'typing'; roomId: string; userId: number; username: string; typing: boolean }
  | { kind: 'presence'; roomId: string; onlineUserIds: number[] }
  /**
   * 방의 사람 구성이 바뀜. 구체적인 변경이면 사용자도 함께 전달해 UI가 REST
   * 재조회보다 먼저 인원수와 퇴장 안내를 반영할 수 있다.
   */
  | {
      kind: 'members_changed';
      roomId: string;
      change?: 'joined' | 'left' | 'updated';
      userId?: number;
      username?: string;
      occurredAt?: string;
    }
  /** 내가 보고 있지 않은 방의 새 메시지 (user WS). 목록 배지/알림용. */
  | { kind: 'notify'; roomId: string; message: TeamsMessage }
  /** 방 목록 자체가 바뀜 (초대/강퇴/방 정보 변경) — 목록을 다시 부른다. */
  | {
      kind: 'rooms_changed';
      roomId: string;
      reason?: 'invited' | 'removed' | 'updated';
    };
