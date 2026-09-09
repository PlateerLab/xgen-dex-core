/**
 * Shared types for the XGen Dex transport layer.
 *
 * These mirror the real XGEN gateway/workflow API (see docs/PROTOCOL.md). The
 * transport layer is framework-agnostic (no Electron/React imports) so it can
 * be unit-tested and reused by the renderer, the main process, or headless
 * tooling.
 */

import type { XgenErrorInfo } from './errors';

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
  /**
   * 에이전트가 **자기 워크플로 그래프를 고쳤다**(WorkflowSelf 자기진화). 캔버스를
   * 열어 둔 화면은 이걸 받아 즉시 다시 그린다.
   *
   * @dex/protocol 이 이 이름을 몰라서, 서버는 보내는데 앱·CLI·VSCode 는 조용히
   * 버리고 있었다(2026-09-09 실측 — 모바일만 알고 있었다).
   */
  | { kind: 'canvas_command'; command: Record<string, unknown> }
  /**
   * 계약 기반 자동화의 증빙 — 모델·temperature·prompt·usage 를 검증한 진행/완료.
   *
   * **세 표면 모두** 이 셋을 몰랐다. 서버의 WS 직렬화도 같이 버리고 있었으니,
   * 이 이벤트는 만들어진 뒤 아무 데도 닿지 못한 채였다.
   */
  | { kind: 'llm_contract'; phase: 'progress' | 'end' | 'error'; data: Record<string, unknown> }
  | { kind: 'summary'; text: string; data: Record<string, unknown> }
  // detail 은 **원문 그대로** 유지한다(로그·디버깅). info 는 사용자에게 보여줄
  // 형태(코드·제목·안내) — 화면은 info 를, 로그는 detail 을 본다.
  | { kind: 'error'; detail: string; info?: XgenErrorInfo }
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
  | { kind: 'end' }
  /**
   * 스트림이 **터미널 프레임 없이** 끊겼다 — 실패가 아니라 **분리(detach)** 다.
   *
   * 서버 실행은 연결이 아니라 대화에 매여 있어서, 이 시점에도 그 턴은 계속
   * 돌고 있다. 끊는 쪽은 대개 우리가 아니다: 게이트웨이가 스트리밍 응답을
   * 1시간에 자르고, 프록시·절전·네트워크 전환도 같은 모양으로 끊는다.
   *
   * 예전에는 이것을 구분할 방법이 없었다. 본문이 그냥 끝나면 `end` 와 똑같이
   * 보였고(그래서 받다 만 텍스트가 최종 답이 됐다), 예외로 떨어지면 오류로
   * 보였다(그래서 멀쩡히 도는 턴이 실패로 표시됐다). 2026-09-08 의 76분짜리
   * 턴이 정확히 그렇게 화면에서 사라졌다.
   *
   * 받는 쪽이 할 일: **진행 중을 유지하고 이어받는다.** 완결된 턴은 대화
   * 소켓의 완결 push 로 오고, 히스토리(`running`)가 그 사이를 메운다.
   */
  | { kind: 'detached'; reason: 'stream_closed' | 'network' };

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
  /** 이 대화 표면의 커넥터 기기 id — 서버가 멀티 디바이스에서 "그 기기의
   *  도구"를 우선 주입한다 (없으면 최근 활동 기기 폴백). */
  clientDeviceId?: string;
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

/**
 * 한 대화의 지금 상태 — 지난 턴들과 **지금 도는 턴이 있는가**.
 *
 * 실행은 연결이 아니라 대화에 매여 있으므로, 다른 기기에서 시작한 턴도 여기서
 * 보인다. 이 값이 없으면 앱을 옮겨 들어온 사용자에게 대화가 끝난 것처럼 보이고,
 * 그 위에 새 턴을 보내 같은 대화에서 두 실행이 겹친다.
 */
export interface ConversationSnapshot {
  turns: HistoryTurn[];
  /** 이 대화에서 지금 도는 턴이 있는가 (어느 기기·어느 파드에서든). */
  running: boolean;
}

/** [정지] 요청의 결과. `stopped=false` 는 실패가 아니라 사실의 종류다. */
export interface ChatStopResult {
  stopped: boolean;
  /**
   * - `not_running` — 멈출 것이 없었다 (이미 끝났다).
   * - `elsewhere` — 다른 서버 파드가 돌리는 턴이라 여기서 못 멈춘다.
   * - `error` — 서버에 닿지 못했다.
   */
  reason?: 'not_running' | 'elsewhere' | 'error';
  detail?: string;
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

/**
 * 에이전트 만들기 — 이름과 모델만으로 XGeny 노드 하나짜리 워크플로우.
 *
 * 프로바이더·모델·설정 목록을 여기 적지 않는다. 노드에는 파라미터가 28개 있고 같은
 * 화면이 웹·커넥터·CLI 세 곳에 있다. 세 곳이 각자 적어 두면 노드가 바뀔 때마다 세
 * 곳이 조용히 낡는다 — 서버가 노드에서 읽어 내려 준다.
 */
export interface AgentCreateProviderOption {
  value: string;
  label: string;
  models: Array<{ value: string; label: string }>;
  defaultModel?: string;
  needsBaseUrl?: boolean;
}

export interface AgentCreateSetting {
  id: string;
  label: string;
  /** 노드 파라미터 타입 — 'STR' | 'BOOL' | 'INT' | 'FLOAT' 등. */
  type: string;
  default: unknown;
  options?: Array<{ value: string; label: string }>;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface AgentCreateOptions {
  providers: AgentCreateProviderOption[];
  defaultProvider: string;
  settings: AgentCreateSetting[];
  defaults: Record<string, unknown>;
}

export interface CreateAgentInput {
  name: string;
  provider: string;
  model?: string;
  /** [세부설정]. 서버가 목록 밖의 키는 버린다 — 자격증명은 이 경로로 가지 않는다. */
  settings?: Record<string, unknown>;
}
