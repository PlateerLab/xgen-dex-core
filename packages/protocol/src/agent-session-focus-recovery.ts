/** One bounded reconciliation step for an authenticated account focus watcher. */

import {
  AgentSessionHttpError, AgentSessionProtocolError, applyAccountEventPage,
  type AgentFocus, type AgentSessionReadClient,
} from './agent-session';

const PAGE_SIZE = 100;
const MAX_PAGES_PER_STEP = 10;

export interface ScopedAgentFocus {
  /** Opaque identifier that changes with the verified account or Platform Session. Never a token. */
  authScope: string;
  focus: AgentFocus;
}

export interface AgentFocusRecoveryResult {
  state: ScopedAgentFocus;
  source: 'snapshot' | 'replay' | 'recovered';
  /** True when the caller should schedule another step to finish the backlog. */
  hasMore: boolean;
}

export type AgentFocusReader = Pick<AgentSessionReadClient, 'focus' | 'accountEvents'>;

/**
 * The caller supplies an authScope from its verified login state and discards it
 * when that account or Platform Session changes. No cursor crosses that boundary.
 * Network/auth errors propagate; only a 409 or invalid replay page uses a fresh
 * owner-scoped snapshot. The caller owns polling and cancellation.
 */
export async function reconcileAgentFocus(
  client: AgentFocusReader, authScope: string, previous: ScopedAgentFocus | null,
  signal?: AbortSignal,
): Promise<AgentFocusRecoveryResult> {
  if (typeof authScope !== 'string' || !authScope || authScope.length > 256
    || authScope.trim() !== authScope) {
    throw new TypeError('A verified Platform Session scope is required');
  }

  const snapshot = async (source: 'snapshot' | 'recovered'): Promise<AgentFocusRecoveryResult> => ({
    state: { authScope, focus: await client.focus(signal) }, source, hasMore: false,
  });
  if (previous?.authScope !== authScope) return snapshot('snapshot');

  let focus = previous.focus;
  try {
    for (let i = 0; i < MAX_PAGES_PER_STEP; i++) {
      const afterSequence = focus.version;
      const page = await client.accountEvents(afterSequence, PAGE_SIZE, signal);
      focus = applyAccountEventPage(focus, page, afterSequence);
      if (!page.has_more) {
        return { state: { authScope, focus }, source: 'replay', hasMore: false };
      }
    }
    return { state: { authScope, focus }, source: 'replay', hasMore: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof AgentSessionProtocolError
      || (error instanceof AgentSessionHttpError && error.status === 409)) {
      return snapshot('recovered');
    }
    throw error;
  }
}
