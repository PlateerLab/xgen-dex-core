import type { AgentConversationRecoveryResult, ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { createMobileCanonicalWatcher, type MobileCanonicalWatchOptions } from './native-agent-focus-watch';

export type MobileConversationView = Pick<ScopedAgentConversation, 'authScope' | 'snapshot' | 'messages' | 'omittedMessages'>;
export function createMobileAgentConversationWatcher(source: {
  reconcileConversation(previous: ScopedAgentConversation | null, signal?: AbortSignal): Promise<AgentConversationRecoveryResult>;
}, options: MobileCanonicalWatchOptions = {}) {
  return createMobileCanonicalWatcher<ScopedAgentConversation, MobileConversationView>({ reconcile: source.reconcileConversation.bind(source) },
    (state) => ({ authScope: state.authScope, snapshot: state.snapshot ? { ...state.snapshot, ...(state.snapshot.latest_turn ? { latest_turn: { ...state.snapshot.latest_turn } } : {}) } : null,
      messages: state.messages.map((m) => ({ ...m })), omittedMessages: state.omittedMessages }),
    // Completed messages are immutable; compare cursor/metadata without serializing private message bodies.
    (state) => JSON.stringify([state.focus, state.snapshot, state.eventCursor, state.messageCursor, state.messages.length, state.omittedMessages]), { maxReadSteps: 10, ...options });
}
