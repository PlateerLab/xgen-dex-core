import { AgentSessionProtocolError, PlatformCredentialUnavailable, applyAgentSessionEventPage, parseAgentSessionEventPage, type AgentEventCursor } from '@dex/protocol/agent-session';
import type { AgentConversationRecoveryResult, ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { createMobileAgentConversationWatcher, type MobileConversationView } from './native-agent-conversation-watch';
import { mobileFocusWait, type MobileCanonicalUpdate, type MobileCanonicalWatchOptions } from './native-agent-focus-watch';
import { MobileFocusBusy } from './native-agent-focus';
import { MobileSocketBusy, MobileSocketCursorConflict, MobileSocketInvalid, MobileSocketUnavailable, type MobileAgentSocket } from './native-agent-socket';

interface LiveSource {
  reconcileConversation(previous: ScopedAgentConversation | null, signal?: AbortSignal): Promise<AgentConversationRecoveryResult>;
  openConversationSocket(state: ScopedAgentConversation, signal: AbortSignal): Promise<MobileAgentSocket>;
}
/** WSS wakes the existing owner-scoped HTTP reconciliation; periodic reads also check focus/vault changes. */
export function createMobileAgentLiveWatcher(source: LiveSource, options: MobileCanonicalWatchOptions = {}) {
  let running = false;
  return { async run(onUpdate: (u: MobileCanonicalUpdate<MobileConversationView>) => void, signal: AbortSignal, once = false) {
    if (running) throw new MobileFocusBusy(); running = true;
    type Connection = { socket: MobileAgentSocket; control: AbortController; scope: string; sid: string; cursor: AgentEventCursor; wake: Promise<void> | null };
    let current: Connection | null = null; let error: unknown = null; let conflicts = 0; let authenticationChecks = 0;
    let snapshotRecoveryPending = false;
    let position: { scope: string; sid: string; sequence: number } | null = null;
    const observe = (scope: string, sid: string, sequence: number) => {
      if (!position || position.scope !== scope || position.sid !== sid || sequence > position.sequence) {
        conflicts = 0; authenticationChecks = 0; position = { scope, sid, sequence };
      }
    };
    const close = () => { const old = current; current = null; if (old) { old.control.abort(); void old.socket.close().catch(() => undefined); } };
    const stop = () => close(); signal.addEventListener('abort', stop, { once: true });
    const arm = (selected: Connection) => {
      if (selected.wake) return;
      selected.wake = selected.socket.next().then((frame) => {
        if (current !== selected || signal.aborted || selected.control.signal.aborted) return;
        if (!frame || typeof frame !== 'object' || !('type' in frame) || frame.type !== 'agent_session.events') throw new MobileSocketInvalid();
        const page = parseAgentSessionEventPage(frame);
        if (page.has_more && page.events.length === 0) throw new MobileSocketInvalid();
        try {
          const applied = applyAgentSessionEventPage(selected.cursor, page, selected.cursor.sequence);
          selected.cursor = applied.cursor;
          observe(selected.scope, selected.sid, applied.cursor.sequence); authenticationChecks = 0;
        } catch (e) { if (e instanceof AgentSessionProtocolError) throw new MobileSocketCursorConflict(); throw e; }
      }).catch((e: unknown) => {
        if (current === selected && !signal.aborted && !selected.control.signal.aborted) error = e instanceof AgentSessionProtocolError ? new MobileSocketInvalid() : e;
      });
    };
    const wait = async (ms: number, waitSignal: AbortSignal) => {
      const selected = current; const timer = new AbortController(); const cancel = () => timer.abort(waitSignal.reason);
      waitSignal.addEventListener('abort', cancel, { once: true }); if (waitSignal.aborted) cancel();
      try {
        const paused = (options.wait ?? mobileFocusWait)(ms, timer.signal);
        const wake = selected?.wake;
        const result = await Promise.race([paused.then(() => 'timer'), ...(wake ? [wake.then(() => 'socket')] : [])]);
        waitSignal.throwIfAborted();
        if (result === 'socket' && current === selected) selected!.wake = null;
      } finally { timer.abort(); waitSignal.removeEventListener('abort', cancel); }
    };
    const live: LiveSource = { ...source,
      async reconcileConversation(previous, readSignal) {
        try {
          if (error) { const failed = error; error = null; close();
            if (failed instanceof MobileSocketCursorConflict) { if (++conflicts > 1) throw new MobileSocketInvalid(); snapshotRecoveryPending = true; }
            else if (failed instanceof PlatformCredentialUnavailable) {
              // The old socket may expire after another owner rotated the vault. Recheck
              // existing credentials once; this does not refresh or issue any session.
              if (++authenticationChecks > 1) throw failed;
            }
            else throw failed;
          }
          const result = await source.reconcileConversation(snapshotRecoveryPending ? null : previous, readSignal); readSignal?.throwIfAborted();
          const state = result.state; const sid = state.snapshot?.id;
          if (sid && state.eventCursor) observe(state.authScope, sid, state.eventCursor.sequence);
          else { position = null; conflicts = 0; authenticationChecks = 0; }
          if (current && (current.socket.closed || result.hasMore || current.scope !== state.authScope || current.sid !== sid)) close();
          if (!once && sid && state.eventCursor && !result.hasMore && !current) {
            const control = new AbortController(); const cancelled = () => control.abort();
            signal.addEventListener('abort', cancelled, { once: true }); readSignal?.addEventListener('abort', cancelled, { once: true });
            if (signal.aborted || readSignal?.aborted) cancelled();
            try {
              let socket: MobileAgentSocket;
              try { socket = await source.openConversationSocket(state, control.signal); }
              catch (e) {
                // Upgrade errors need the same recovery path as errors from next().
                // Leave the attempt and its close acknowledgement before retrying.
                if (e instanceof MobileSocketCursorConflict || e instanceof PlatformCredentialUnavailable) { error = e; throw new MobileSocketUnavailable(); }
                throw e;
              }
              if (signal.aborted || readSignal?.aborted) { control.abort(); void socket.close().catch(() => undefined); readSignal?.throwIfAborted(); signal.throwIfAborted(); }
              current = { socket, control, scope: state.authScope, sid, cursor: { ...state.eventCursor }, wake: null };
            } catch (e) { control.abort(); throw e; }
            finally { signal.removeEventListener('abort', cancelled); readSignal?.removeEventListener('abort', cancelled); }
          }
          if (current) arm(current);
          // Preserve snapshot intent across an OS close latch or failed upgrade. The
          // canonical watcher commits this new state only when we return successfully.
          snapshotRecoveryPending = false;
          return result;
        } catch (e) { close(); if (e instanceof MobileSocketBusy) throw new MobileFocusBusy(); throw e; }
      },
    };
    try { await createMobileAgentConversationWatcher(live, { ...options, wait }).run(onUpdate, signal, once); }
    finally { close(); signal.removeEventListener('abort', stop); error = null; running = false; }
  } };
}
