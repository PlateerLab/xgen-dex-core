import type { ProfileSummary } from '@dex/engine';
import type { ConversationModelState, ThinkingValue } from '@dex/protocol';
import type {
  AgentCreateOptions,
  AgentListQuery,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  ChatInput,
  ChatAttachmentDescriptor,
  ChatStopResult,
  Conversation,
  ConversationPage,
  ConversationSearchPage,
  ConversationSnapshot,
  HistoryTurn,
  CreateAgentInput,
  ResolvedChatInput,
} from '@dex/engine';

export interface TuiEngine {
  listProfiles(): Promise<ProfileSummary[]>;
  setProfile(name: string, serverUrl: string): Promise<ProfileSummary>;
  useProfile(name: string): Promise<ProfileSummary>;
  login(email: string, password: string, profile?: string): Promise<AuthStatus>;
  authStatus(profile?: string): Promise<AuthStatus>;
  /** 이 PC 브리지 — 로그인 완료 시 자동 기동한다 (선택 구현). 쓸 수 있는 범위는
   *  대화를 시작한 폴더가 정한다. */
  startLocalTools?(profile?: string, waitMs?: number): Promise<{
    bridge: { connected: boolean; catalogSynced: boolean; serverToolCount: number; error?: string };
    tools: unknown[];
  }>;
  logout(profile?: string): Promise<void>;
  listAgents(query?: AgentListQuery, profile?: string): Promise<AgentListResult>;
  /** 만들기 화면이 그릴 것 — 서버가 Agent Geny 노드에서 읽어 내려 준다. */
  agentCreateOptions(profile?: string): Promise<AgentCreateOptions>;
  /** 에이전트 하나를 세운다 — 노드 하나짜리 워크플로우. */
  createAgent(
    input: CreateAgentInput,
    profile?: string,
  ): Promise<{ workflowId: string; workflowName: string }>;
  /** 이 이름의 에이전트가 이미 있는가(시작 화면이 적는 대로, 그리고 만들기 직전에 묻는다). */
  agentNameTaken(name: string, profile?: string): Promise<boolean>;
  /** 대화 목록 전부(쪽을 따라간다, 상한 있음). 기록 화면이 쓴다. */
  listConversations(profile?: string): Promise<Conversation[]>;
  /** 대화 목록 한 쪽: 마지막으로 말한 순서, 커서로 이어 받는다(사이드바). */
  conversationPage(
    opts: { limit?: number; cursor?: string | null },
    profile?: string,
  ): Promise<ConversationPage>;
  /** 채팅 검색: 제목·에이전트 이름·대화 내용, 마지막으로 말한 순서. */
  searchConversations(query: string, opts: { limit?: number }, profile?: string): Promise<ConversationSearchPage>;
  /** 대화 이름 바꾸기. 빈 이름이면 첫 메시지 제목으로 돌아간다. */
  renameConversation(
    workflowId: string,
    interactionId: string,
    title: string,
    profile?: string,
  ): Promise<{ title: string; customTitle: boolean }>;
  /** 대화 지우기(비교 채팅의 딸린 대화까지 서버가 함께 지운다). */
  deleteConversation(
    workflowId: string,
    interactionId: string,
    workflowName?: string,
    profile?: string,
  ): Promise<void>;
  /** 에이전트가 사라진 내 대화를 모두 지운다. 지운 수. */
  purgeDeletedAgentConversations(profile?: string): Promise<number>;
  historyTurns(
    workflowId: string,
    interactionId: string,
    workflowName?: string,
    profile?: string,
  ): Promise<HistoryTurn[]>;
  /** 지난 턴 + **지금 도는 턴이 있는가** — 다른 기기에서 시작한 턴도 보인다. */
  historySnapshot(
    workflowId: string,
    interactionId: string,
    workflowName?: string,
    profile?: string,
  ): Promise<ConversationSnapshot>;
  /**
   * 사람이 누른 [정지]. 스트림 abort 만으로는 서버가 멈추지 않는다 — 서버는
   * 연결 끊김을 취소로 읽지 않기 때문에(화면 잠금·기기 이동이 실행 중단이 되던
   * 시절의 교훈), 이것을 부르지 않으면 버려진 턴이 끝까지 돌아 답을 적는다.
   */
  stopChat(interactionId: string, profile?: string): Promise<ChatStopResult>;
  resolveChatInput(input: ChatInput): Promise<ResolvedChatInput>;
  uploadChatAttachment(input: {
    profile?: string; workflowId: string; interactionId: string; path: string;
  }): Promise<ChatAttachmentDescriptor>;
  chat(input: ChatInput, signal?: AbortSignal): AsyncGenerator<ChatEvent, ResolvedChatInput>;
  /** 대화 소켓 감시 — 서버 주입 턴(트리거 반응)의 실시간 수신 (선택 구현). */
  watchConversation?(
    workflowId: string,
    workflowName: string,
    interactionId: string,
    profile?: string,
  ): Promise<void>;
  unwatchConversation?(interactionId: string): void;
  /**
   * 대화 **목록** 소켓(선택 구현). 다른 기기의 새 대화·방금 말한 대화·지운 대화·바뀐 이름이 곧바로
   * onConversationListChange 로 흐르고, 목록이 할 일은 @dex/protocol conversationListChange 가 정한다.
   */
  watchConversationList?(profile?: string): Promise<void>;
  unwatchConversationList?(): void;
  onConversationListChange?:
    | ((event: {
        kind: string;
        interactionId: string;
        workflowId: string;
        running?: boolean;
        data?: Record<string, unknown>;
      }) => void)
    | null;
  onConversationTurn?:
    | ((turn: {
        interactionId: string;
        ioId: number;
        input: string;
        output: string;
        source: string;
        updatedAt: string;
      }) => void)
    | null;
  /**
   * 이 대화에 **지금 도는 턴이 있는가**, 그리고 돌고 있다면 그 턴의 여기까지.
   * 구독 확립과 하트비트마다 온다 — 폴링이 필요 없다.
   *
   * 이 신호가 없던 동안 CLI 는 히스토리를 부르는 순간의 running 만 알았고,
   * 그 뒤 다른 기기(웹·앱·모바일)에서 시작된 턴은 완결까지 못 봤다.
   */
  onConversationRunning?:
    | ((event: {
        interactionId: string;
        running: boolean;
        live?: { text: string; events: unknown[] } | null;
      }) => void)
    | null;
  /** 이 대화의 모델 — 지금 모델(맨 앞)·고를 수 있는 것 (선택 구현, Ctrl+O). */
  conversationModel?(workflowId: string, interactionId: string, profile?: string): Promise<ConversationModelState>;
  /** 이 대화의 모델을 바꾼다 — 다음 답변부터, 세션 재시작 없음. */
  setConversationModel?(
    workflowId: string,
    interactionId: string,
    choice: { provider: string; model: string },
    profile?: string,
  ): Promise<ConversationModelState>;
  /** 이 대화의 생각(추론) 값을 바꾼다 — 지금 모델이 받는 값만(/thinking), 다음 답변부터. */
  setConversationThinking?(
    workflowId: string,
    interactionId: string,
    thinking: ThinkingValue,
    profile?: string,
  ): Promise<ConversationModelState>;
  /** 다른 화면(웹·앱·VS Code)에서 이 대화의 모델을 바꿨다. */
  onConversationModel?:
    | ((event: { interactionId: string; notice: Record<string, unknown> }) => void)
    | null;
}

export interface TuiSession {
  profile: string;
  serverUrl: string;
  username: string;
  agents: AgentListResult['items'];
}
