import { AgentSessionHttpError, AgentSessionProtocolError, applyAgentSessionEventPage,
  type AgentEventCursor, type AgentSessionMessage, type AgentSessionReadClient, type AgentSessionSnapshot } from './agent-session';
import { reconcileAgentFocus, type ScopedAgentFocus } from './agent-session-focus-recovery';

export interface ScopedAgentConversation extends ScopedAgentFocus {
  snapshot: AgentSessionSnapshot | null;
  eventCursor: AgentEventCursor | null;
  messageCursor: number;
  messages: AgentSessionMessage[];
  omittedMessages: number;
}
export interface AgentConversationRecoveryResult {
  state: ScopedAgentConversation;
  source: 'snapshot' | 'replay' | 'recovered';
  hasMore: boolean;
}
export type AgentConversationReader = Pick<AgentSessionReadClient, 'focus' | 'accountEvents' | 'snapshot' | 'events' | 'messages'>;
const MAX_MESSAGES = 100;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_PAGES = 2;
const MAX_MESSAGE_PAGES = 2;
function invalid(): never { throw new AgentSessionProtocolError('Canonical conversation state diverged'); }
function trim(messages: AgentSessionMessage[], omitted: number) {
  let bytes = messages.reduce((n, m) => n + new TextEncoder().encode(m.input_text ?? '').length + new TextEncoder().encode(m.output_text ?? '').length, 0);
  while (messages.length > MAX_MESSAGES || bytes > MAX_TEXT_BYTES) {
    const old = messages.shift()!; bytes -= new TextEncoder().encode(old.input_text ?? '').length + new TextEncoder().encode(old.output_text ?? '').length; omitted++;
  }
  return omitted;
}
/** Completed journal-linked turns only, never a claim of full legacy history or live stream content. */
export async function reconcileAgentConversation(
  reader: AgentConversationReader, authScope: string, previous: ScopedAgentConversation | null, signal?: AbortSignal,
): Promise<AgentConversationRecoveryResult> {
  const focus = await reconcileAgentFocus(reader, authScope, previous, signal); signal?.throwIfAborted();
  const empty = (): ScopedAgentConversation => ({ ...focus.state, snapshot: null, eventCursor: null, messageCursor: 0, messages: [], omittedMessages: 0 });
  const sid = focus.state.focus.active_agent_session_id;
  // Do not hydrate an intermediate pointer while account replay still has a backlog.
  if (!sid || focus.hasMore) return { state: empty(), source: focus.source, hasMore: focus.hasMore };
  const old = previous?.authScope === authScope && previous.snapshot?.id === sid && focus.source !== 'recovered' ? previous : null;
  const load = async (resume: ScopedAgentConversation | null, source: AgentConversationRecoveryResult['source']) => {
    let snapshot = await reader.snapshot(sid, signal); signal?.throwIfAborted();
    if (snapshot.id !== sid) invalid();
    if (resume && (!resume.eventCursor || snapshot.current_sequence < resume.eventCursor.sequence || snapshot.state_version < resume.snapshot!.state_version)) invalid();
    let eventCursor: AgentEventCursor = resume?.eventCursor ? { ...resume.eventCursor }
      : { sequence: snapshot.current_sequence, stateVersion: snapshot.state_version, eventId: null };
    let eventMore = false;
    if (resume) {
      for (let i = 0; i < MAX_EVENT_PAGES; i++) {
        const after = eventCursor.sequence; const page = await reader.events(sid, after, 100, signal); signal?.throwIfAborted();
        eventCursor = applyAgentSessionEventPage(eventCursor, page, after).cursor;
        eventMore = page.has_more; if (!eventMore) break;
      }
    }
    const messages = resume ? [...resume.messages] : []; let cursor = resume?.messageCursor ?? 0; let omitted = resume?.omittedMessages ?? 0;
    let messageMore = false; let observedSequence = eventCursor.sequence; let observedVersion = Math.max(snapshot.state_version, eventCursor.stateVersion);
    for (let i = 0; i < MAX_MESSAGE_PAGES; i++) {
      const page = await reader.messages(sid, cursor, 1, signal); signal?.throwIfAborted();
      if (page.state_version < observedVersion || page.next_cursor < cursor) invalid();
      for (const message of page.messages) {
        if (message.sequence <= cursor || messages.some((old) => old.turn_id === message.turn_id)) invalid();
        messages.push({ ...message });
      }
      cursor = page.next_cursor; omitted = trim(messages, omitted); messageMore = page.has_more;
      observedSequence = Math.max(observedSequence, page.snapshot_sequence); observedVersion = Math.max(observedVersion, page.state_version);
      if (!messageMore) break;
    }
    snapshot = await reader.snapshot(sid, signal); signal?.throwIfAborted();
    if (snapshot.id !== sid || snapshot.current_sequence < observedSequence || snapshot.state_version < observedVersion) invalid();
    // Focus can change on another platform during hydration. Never publish the old transcript
    // as the current conversation; the next bounded step hydrates the fresh owner pointer.
    const finalFocus = await reader.focus(signal); signal?.throwIfAborted();
    if (finalFocus.version < focus.state.focus.version) invalid();
    if (finalFocus.version === focus.state.focus.version
      && (finalFocus.active_agent_session_id !== sid || finalFocus.event_id !== focus.state.focus.event_id)) invalid();
    if (finalFocus.version !== focus.state.focus.version) return {
      state: { ...empty(), focus: finalFocus }, source, hasMore: true,
    } satisfies AgentConversationRecoveryResult;
    return { state: { ...focus.state, snapshot, eventCursor, messageCursor: cursor, messages, omittedMessages: omitted },
      source, hasMore: eventMore || messageMore } satisfies AgentConversationRecoveryResult;
  };
  try { return await load(old, old ? 'replay' : focus.source); }
  catch (error) {
    signal?.throwIfAborted();
    if (!old || (!(error instanceof AgentSessionProtocolError) && !(error instanceof AgentSessionHttpError && error.status === 409))) throw error;
    // One rehydration attempt. Persistently corrupt responses fail closed, without a retry loop.
    return load(null, 'recovered');
  }
}
