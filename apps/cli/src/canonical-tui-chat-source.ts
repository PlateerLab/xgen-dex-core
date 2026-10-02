import { NativeAgentLiveWatcher, NativeCliSession, DexError } from '@dex/engine';
import { readNativeAgentConversation } from '@dex/engine/native-agent-conversation-watch';
import type { NativeAgentLiveSource } from '@dex/engine/native-agent-live-watch';
import { AgentTurnComposeFailure } from '@dex/protocol/agent-turn-composer';
import type { AgentSessionMutationConflict } from '@dex/protocol/agent-session-mutation';
import type { CanonicalTuiAccount } from './tui/canonical-types';
import type { CanonicalTuiChatSource } from './tui/canonical-chat-types';

/** All vault/proof/cursor state stays in this CLI host. The model gets only an opaque binding. */
export function createCanonicalTuiChatSource(account: CanonicalTuiAccount, session = new NativeCliSession(account.origin)): CanonicalTuiChatSource {
  const fixed = { ...account };
  let binding: string | null = null;
  const reader: NativeAgentLiveSource = {
    reconcileConversation: async (userId, previous, signal) => {
      const value = await session.reconcileConversation(userId, previous, signal);
      signal?.throwIfAborted(); binding = value.state.authScope;
      return value;
    },
    openConversationSocket: (userId, state, signal) => session.openConversationSocket(userId, state, signal),
  };
  return {
    binding: () => binding,
    read: async (signal) => {
      try { return await readNativeAgentConversation(reader, fixed.userId, signal); }
      catch (error) { binding = null; throw error; }
    },
    watch: (update, signal) => new NativeAgentLiveWatcher(reader, fixed.userId).run((value) => {
      if (value.type === 'stopped' && value.reason !== 'cancelled') binding = null;
      update(value);
    }, signal),
    settle: () => session.settleProofOperations(),
    catalog: async (signal, beforeId) => {
      const value = await session.agentSessionCatalog(fixed.userId, beforeId, signal);
      signal.throwIfAborted(); binding = value.authScope;
      return { binding: value.authScope, focus: value.focus, sessions: value.sessions };
    },
    create: (expected, input, signal) => session.createAgentSession(fixed.userId, input, signal, expected),
    select: (expected, input, signal) => session.switchAgentFocus(fixed.userId, input, signal, expected),
    send: async (expected, request, signal) => {
      if (request.scope.platform_type !== 'cli' || request.scope.profile !== fixed.profile
        || request.scope.server_url !== fixed.origin || request.scope.user_id !== fixed.userId) {
        throw new AgentTurnComposeFailure('unavailable');
      }
      try {
        const mutation = request.operation === 'submit'
          ? await session.submitTurn(fixed.userId, request.agent_session_id, request.input, signal, expected)
          : await session.stopTurn(fixed.userId, request.agent_session_id, request.input, signal, expected);
        return { ...request.scope, agent_session_id: request.agent_session_id, mutation };
      } catch (error) {
        const details = error instanceof DexError ? error.details as { outcome?: unknown; conflict?: AgentSessionMutationConflict } | undefined : undefined;
        throw new AgentTurnComposeFailure(details?.outcome === 'unknown' ? 'unknown'
          : details?.outcome === 'rejected' ? 'rejected' : 'unavailable', details?.conflict);
      }
    },
  };
}
