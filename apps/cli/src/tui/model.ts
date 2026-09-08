import type { ProfileSummary } from '@dex/engine';
import type {
  AgentCreateOptions,
  AgentListQuery,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  ChatInput,
  ChatStopResult,
  Conversation,
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
  /** 로컬 컨트롤 — 로그인 완료 시 켜져 있으면 자동 기동한다 (선택 구현). */
  startLocalTools?(profile?: string, waitMs?: number): Promise<{
    config: { enabled: boolean };
    bridge: { connected: boolean; catalogSynced: boolean; serverToolCount: number; error?: string };
    tools: unknown[];
  }>;
  logout(profile?: string): Promise<void>;
  listAgents(query?: AgentListQuery, profile?: string): Promise<AgentListResult>;
  /** 만들기 화면이 그릴 것 — 서버가 Agent XGeny 노드에서 읽어 내려 준다. */
  agentCreateOptions(profile?: string): Promise<AgentCreateOptions>;
  /** 에이전트 하나를 세운다 — 노드 하나짜리 워크플로우. */
  createAgent(
    input: CreateAgentInput,
    profile?: string,
  ): Promise<{ workflowId: string; workflowName: string }>;
  listConversations(profile?: string): Promise<Conversation[]>;
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
  chat(input: ChatInput, signal?: AbortSignal): AsyncGenerator<ChatEvent, ResolvedChatInput>;
  /** 대화 소켓 감시 — 서버 주입 턴(트리거 반응)의 실시간 수신 (선택 구현). */
  watchConversation?(
    workflowId: string,
    workflowName: string,
    interactionId: string,
    profile?: string,
  ): Promise<void>;
  unwatchConversation?(interactionId: string): void;
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
}

export interface TuiSession {
  profile: string;
  serverUrl: string;
  username: string;
  agents: AgentListResult['items'];
}
