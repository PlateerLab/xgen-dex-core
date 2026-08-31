import type {
  Agent,
  AgentListQuery,
  AgentListResult,
  ChatEvent,
  Conversation,
  CurrentUser,
  HistoryTurn,
} from '@dex/protocol/types';

export const DEX_PROTOCOL_VERSION = 1;

export interface DexProfile {
  serverUrl: string;
}

export interface LocalToolsConfig {
  /** Explicit opt-in. Local tools are never exposed when false. */
  enabled: boolean;
  /** Default working directory for Shell and relative structured-file paths. */
  cwd: string;
  /** Wall-clock cap for foreground Shell calls. */
  timeoutMs: number;
  /** Structured file tools may only access paths inside these roots. */
  allowedRoots: string[];
  /** First command tokens refused by the Shell tool. */
  blockedCommands: string[];
  /** Destructive command patterns stay blocked unless explicitly enabled. */
  allowDangerous: boolean;
}

export interface DexConfig {
  version: 1;
  currentProfile: string;
  profiles: Record<string, DexProfile>;
  localTools: LocalToolsConfig;
}

export interface StoredSession {
  serverUrl: string;
  accessToken: string;
  refreshToken?: string;
}

export interface AuthStatus {
  profile: string;
  serverUrl: string;
  authenticated: boolean;
  user?: CurrentUser;
  reason?: 'missing_session' | 'invalid_session' | 'network';
}

export interface ChatInput {
  profile?: string;
  workflowId: string;
  workflowName?: string;
  input: string | Record<string, unknown> | unknown[];
  interactionId?: string;
}

export interface ResolvedChatInput {
  profile: string;
  workflowId: string;
  workflowName: string;
  input: ChatInput['input'];
  interactionId: string;
}

export type { Agent, AgentListQuery, AgentListResult, ChatEvent, Conversation, HistoryTurn };
