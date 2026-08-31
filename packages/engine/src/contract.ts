/**
 * 엔진이 다루는 값들 — 프로파일 · 저장된 세션 · 채팅 입력.
 *
 * 서버 도메인 타입(Agent · ChatEvent · Conversation …)은 여기서 만들지 않고
 * `@dex/protocol` 에서 **다시 내보낸다**. 예전에는 CLI 와 VSCode 확장이 각자
 * 같은 이름으로 다시 선언했고, 그래서 같은 개념이 세 곳에 있었다. 소비자가
 * `@dex/engine` 하나만 보게 하려면 통로는 필요하지만, 정의는 하나여야 한다.
 */
import type {
  Agent,
  AgentListQuery,
  AgentListResult,
  ChatEvent,
  Conversation,
  CurrentUser,
  HistoryTurn,
  ToolEvent,
} from '@dex/protocol/types';

export interface DexProfile {
  serverUrl: string;
}

import type { LocalToolsConfig } from './local-tools-config';

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

export type {
  Agent,
  AgentListQuery,
  AgentListResult,
  ChatEvent,
  Conversation,
  HistoryTurn,
  ToolEvent,
};
