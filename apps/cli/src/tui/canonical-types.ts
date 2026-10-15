import type { NativeAgentConversationUpdate } from '@dex/engine';
import type { AgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';

export interface CanonicalTuiAccount {
  profile: string;
  origin: string;
  userId: string;
}

/** The host owns the CLI vault, signer and reconnect cursors. Only display values reach Ink. */
export interface CanonicalTuiSource {
  read(signal: AbortSignal): Promise<{ conversation: AgentConversationView; has_more: boolean }>;
  watch(update: (value: NativeAgentConversationUpdate) => void, signal: AbortSignal): Promise<void>;
  settle(): Promise<void>;
}

export interface CanonicalTuiView {
  status: 'idle' | 'reading' | 'connected' | 'reconnecting' | 'stopped';
  busy: boolean;
  watching: boolean;
  conversation: AgentConversationView | null;
  hasMore: boolean;
  notice: string;
  error: string;
}

export const emptyCanonicalTuiView = (): CanonicalTuiView => ({
  status: 'idle', busy: false, watching: false, conversation: null, hasMore: false,
  notice: 'R로 현재 공유 대화를 조회하거나 W로 실시간 연결을 시작하세요.', error: '',
});
