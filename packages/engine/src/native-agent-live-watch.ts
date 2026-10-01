import { setTimeout as delay } from 'node:timers/promises';
import { AgentSessionProtocolError, PlatformCredentialUnavailable, applyAgentSessionEventPage, parseAgentSessionEventPage, type AgentEventCursor } from '@dex/protocol/agent-session';
import type { AgentConversationRecoveryResult, ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { NativeAgentConversationWatcher, type NativeAgentConversationSource, type NativeAgentConversationUpdate } from './native-agent-conversation-watch';
import type { NativeAgentFocusWatchOptions } from './native-agent-focus-watch';
import { NativeSocketCursorConflict, NativeSocketInvalid, NativeSocketUnavailable, type NativeAgentSocket } from './native-agent-socket';
import { DexError } from './errors';

export interface NativeAgentLiveSource extends NativeAgentConversationSource {
  openConversationSocket(userId: string, state: ScopedAgentConversation, signal: AbortSignal): Promise<NativeAgentSocket>;
}
/** Native WSS is a wakeup source; HTTP remains the authority for displayed conversations. */
export class NativeAgentLiveWatcher {
  private readonly watcher: NativeAgentConversationWatcher;
  private liveWait: ((ms: number, signal: AbortSignal) => Promise<void>) | null = null;
  private running = false;
  constructor(private readonly source: NativeAgentLiveSource, private readonly userId: string, private readonly options: NativeAgentFocusWatchOptions = {}) {
    // Validation precedes RPC acknowledgements. The same bounded watcher owns all retries/deadlines.
    this.watcher = new NativeAgentConversationWatcher(source, userId, { ...options,
      wait: (ms, signal) => this.liveWait ? this.liveWait(ms, signal) : (options.wait ?? (async (n, s) => { await delay(n, undefined, { signal: s }); }))(ms, signal) });
  }
  async run(onUpdate: (update: NativeAgentConversationUpdate) => void, signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.running) throw new DexError('usage_error', '이미 실행 중인 공유 대화 연결입니다.'); this.running = true;
    type Connection = { socket: NativeAgentSocket; control: AbortController; scope: string; sid: string; cursor: AgentEventCursor; wake: Promise<boolean> | null };
    let current: Connection | null = null; let error: unknown = null; let conflicts = 0; let authenticationChecks = 0; let transportFailures = 0;
    const closing = new Set<Promise<void>>();
    let snapshotRecoveryPending = false; let position: { scope: string; sid: string; sequence: number } | null = null;
    const observe = (scope: string, sid: string, sequence: number) => {
      if (!position || position.scope !== scope || position.sid !== sid || sequence > position.sequence) {
        conflicts = 0; authenticationChecks = 0; transportFailures = 0; position = { scope, sid, sequence };
      }
    };
    const closeSocket = (socket: NativeAgentSocket) => {
      const done = socket.close().catch(() => undefined); closing.add(done); void done.then(() => closing.delete(done));
    };
    const close = () => { const old = current; current = null; if (old) { old.control.abort(); closeSocket(old.socket); } };
    const transportFailure = () => { if (++transportFailures > 3) throw new NativeSocketInvalid(); };
    const stop = () => close(); signal.addEventListener('abort', stop, { once: true });
    const arm = (selected: Connection) => {
      if (selected.wake) return;
      selected.wake = selected.socket.next().then((frame) => {
        if (current !== selected || signal.aborted || selected.control.signal.aborted) return false;
        if (!frame || typeof frame !== 'object' || !('type' in frame) || frame.type !== 'agent_session.events') throw new NativeSocketInvalid();
        const page = parseAgentSessionEventPage(frame);
        if (page.has_more && page.events.length === 0) throw new NativeSocketInvalid();
        try {
          const before = selected.cursor;
          const applied = applyAgentSessionEventPage(before, page, before.sequence);
          selected.cursor = applied.cursor; observe(selected.scope, selected.sid, applied.cursor.sequence);
          return applied.cursor.sequence !== before.sequence || applied.cursor.stateVersion !== before.stateVersion;
        } catch (e) { if (e instanceof AgentSessionProtocolError) throw new NativeSocketCursorConflict(); throw e; }
      }).catch((e: unknown) => {
        if (current === selected && !signal.aborted && !selected.control.signal.aborted) error = e instanceof AgentSessionProtocolError ? new NativeSocketInvalid() : e;
        return true;
      });
    };
    this.liveWait = async (ms, waitSignal) => {
      const selected = current; const timer = new AbortController(); const cancel = () => timer.abort(waitSignal.reason);
      waitSignal.addEventListener('abort', cancel, { once: true }); if (waitSignal.aborted) cancel();
      try {
        const paused = (this.options.wait ?? (async (n, s) => { await delay(n, undefined, { signal: s }); }))(ms, timer.signal);
        const wake = selected?.wake;
        const result = await Promise.race([paused.then(() => 'timer'), ...(wake ? [wake.then((changed) => changed ? 'socket' : 'idle')] : [])]);
        waitSignal.throwIfAborted();
        if ((result === 'socket' || result === 'idle') && current === selected) selected!.wake = null;
        // Empty/duplicate frames do not accelerate HTTP polling.
        if (result === 'idle') { await paused; waitSignal.throwIfAborted(); }
      } finally { timer.abort(); waitSignal.removeEventListener('abort', cancel); }
    };
    const live: NativeAgentLiveSource = {
      openConversationSocket: (...args) => this.source.openConversationSocket(...args),
      reconcileConversation: async (userId, previous, readSignal): Promise<AgentConversationRecoveryResult> => {
        try {
          if (error) { const failed = error; error = null; close();
            if (failed instanceof NativeSocketCursorConflict) { if (++conflicts > 1) throw new NativeSocketInvalid(); snapshotRecoveryPending = true; }
            else if (failed instanceof PlatformCredentialUnavailable) {
              // Existing vault credentials may have rotated; recheck once without issuing/refreshing access.
              if (++authenticationChecks > 1) throw failed;
            } else { if (failed instanceof NativeSocketUnavailable) transportFailure(); throw failed; }
          }
          const result = await this.source.reconcileConversation(userId, snapshotRecoveryPending ? null : previous, readSignal); readSignal?.throwIfAborted();
          if (result.source === 'recovered') snapshotRecoveryPending = true;
          const state = result.state; const sid = state.snapshot?.id;
          if (sid && state.eventCursor) observe(state.authScope, sid, state.eventCursor.sequence);
          else { position = null; conflicts = 0; authenticationChecks = 0; transportFailures = 0; }
          if (current && (current.socket.closed || result.hasMore || result.source === 'recovered'
            || current.scope !== state.authScope || current.sid !== sid)) close();
          if (sid && state.eventCursor && !result.hasMore && !current) {
            const control = new AbortController(); const cancelled = () => control.abort();
            signal.addEventListener('abort', cancelled, { once: true }); readSignal?.addEventListener('abort', cancelled, { once: true });
            if (signal.aborted || readSignal?.aborted) cancelled();
            try {
              let socket: NativeAgentSocket;
              try { socket = await this.source.openConversationSocket(userId, state, control.signal); }
              catch (e) {
                if (e instanceof NativeSocketCursorConflict || e instanceof PlatformCredentialUnavailable) { error = e; throw new NativeSocketUnavailable(); }
                if (e instanceof NativeSocketUnavailable) transportFailure();
                throw e;
              }
              if (signal.aborted || readSignal?.aborted) { control.abort(); closeSocket(socket); readSignal?.throwIfAborted(); signal.throwIfAborted(); }
              current = { socket, control, scope: state.authScope, sid, cursor: { ...state.eventCursor }, wake: null };
            } catch (e) { control.abort(); throw e; }
            finally { signal.removeEventListener('abort', cancelled); readSignal?.removeEventListener('abort', cancelled); }
          }
          if (current) arm(current);
          snapshotRecoveryPending = false; return result;
        } catch (e) { close(); throw e; }
      },
    };
    try { this.watcher.select(live, this.userId); await this.watcher.run(onUpdate, signal); }
    finally { close(); signal.removeEventListener('abort', stop); error = null; this.liveWait = null;
      await Promise.all([...closing]); this.running = false; }
  }
}
