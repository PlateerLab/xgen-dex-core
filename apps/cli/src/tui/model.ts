import type { ProfileSummary } from '@dex/engine';
import type {
  AgentCreateOptions,
  AgentListQuery,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  ChatInput,
  Conversation,
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
