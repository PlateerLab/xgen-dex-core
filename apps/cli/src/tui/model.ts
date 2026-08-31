import type { ProfileSummary } from '@dex/engine';
import type {
  AgentListQuery,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  ChatInput,
  Conversation,
  HistoryTurn,
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
  listConversations(profile?: string): Promise<Conversation[]>;
  historyTurns(
    workflowId: string,
    interactionId: string,
    workflowName?: string,
    profile?: string,
  ): Promise<HistoryTurn[]>;
  resolveChatInput(input: ChatInput): Promise<ResolvedChatInput>;
  chat(input: ChatInput, signal?: AbortSignal): AsyncGenerator<ChatEvent, ResolvedChatInput>;
}

export interface TuiSession {
  profile: string;
  serverUrl: string;
  username: string;
  agents: AgentListResult['items'];
}
