import { setTimeout as delay } from 'node:timers/promises';
import { AgentSessionHttpError, PlatformCredentialUnavailable } from '@dex/protocol/agent-session';
import { parseAgentConversationView, type AgentConversationView, type AgentConversationRecoveryResult, type ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { DexError } from './errors';
import { NativeDeviceOperationBusy } from './native-device-key-store';
import type { NativeAgentFocusWatchOptions } from './native-agent-focus-watch';

export type NativeConversationView = AgentConversationView;
export interface NativeAgentConversationSource {
  reconcileConversation(userId: string, previous: ScopedAgentConversation | null, signal?: AbortSignal): Promise<AgentConversationRecoveryResult>;
}
export type NativeAgentConversationUpdate =
  | { type: 'reset'; user_id: string }
  | { type: 'conversation'; user_id: string; conversation: NativeConversationView; source: AgentConversationRecoveryResult['source']; has_more: boolean }
  | { type: 'reconnecting'; user_id: string; retry_in_ms: number; reason: 'transport' | 'server' | 'timeout' | 'busy' }
  | { type: 'stopped'; user_id: string; reason: 'cancelled' | 'authentication' | 'failed' };
function account(userId: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(userId) || Number(userId) > 2147483647) throw new DexError('usage_error', '실제 계정 ID가 필요합니다.'); return userId;
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DexError('usage_error', '구독 간격 또는 요청 시간이 허용 범위를 벗어났습니다.'); return value;
}
function fatal(error: unknown): DexError {
  if (error instanceof DexError) return error;
  if (error instanceof PlatformCredentialUnavailable || (error instanceof AgentSessionHttpError && [401, 403].includes(error.status))) {
    return new DexError('auth_required', '네이티브 세션이 만료되었거나 접근이 폐기되었습니다. 세션을 확인하세요.');
  }
  return new DexError('protocol_mismatch', '공유 대화를 확인할 수 없습니다.');
}
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let reject!: (e: unknown) => void; const cancelled = new Promise<never>((_, r) => { reject = r; });
  const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  try { return await Promise.race([operation, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
/** Up to ten bounded reads, with one deadline. Returns display fields only and reports partial history. */
export async function readNativeAgentConversation(source: NativeAgentConversationSource, userId: string, signal?: AbortSignal): Promise<{ conversation: NativeConversationView; has_more: boolean }> {
  account(userId); signal?.throwIfAborted(); const control = new AbortController(); const abort = () => control.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(() => control.abort(), 10000); let previous: ScopedAgentConversation | null = null;
  try {
    for (let i = 0; i < 10; i++) {
      control.signal.throwIfAborted(); const result: AgentConversationRecoveryResult = await cancellable(source.reconcileConversation(userId, previous, control.signal), control.signal);
      control.signal.throwIfAborted(); previous = result.state;
      if (!result.hasMore || i === 9) return { conversation: parseAgentConversationView(result.state), has_more: result.hasMore };
    }
    throw fatal(null);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); control.abort(); }
}
/** Explicit foreground polling. Every step reloads the OS vault; waits hold no keychain lock. */
export class NativeAgentConversationWatcher {
  private target: { source: NativeAgentConversationSource; userId: string; epoch: number };
  private interrupt: AbortController | null = null;
  private running = false;
  private notify: ((value: NativeAgentConversationUpdate) => void) | null = null;
  private announcedEpoch = -1;
  private readonly interval: number; private readonly timeout: number;
  private readonly wait: NonNullable<NativeAgentFocusWatchOptions['wait']>;
  constructor(source: NativeAgentConversationSource, userId: string, options: NativeAgentFocusWatchOptions = {}) {
    this.target = { source, userId: account(userId), epoch: 0 };
    this.interval = bounded(options.intervalMs ?? 2000, 200, 60000); this.timeout = bounded(options.requestTimeoutMs ?? 10000, 100, 60000);
    this.wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  }
  select(source: NativeAgentConversationSource, userId: string): void {
    this.target = { source, userId: account(userId), epoch: this.target.epoch + 1 }; this.interrupt?.abort();
    if (this.notify) { this.announcedEpoch = this.target.epoch; this.notify({ type: 'reset', user_id: userId }); }
  }
  async run(onUpdate: (value: NativeAgentConversationUpdate) => void, signal?: AbortSignal): Promise<void> {
    if (this.running) throw new DexError('usage_error', '이미 실행 중인 대화 구독입니다.'); this.running = true; this.notify = onUpdate; this.announcedEpoch = -1;
    let previous: ScopedAgentConversation | null = null; let previousHasMore = false; let epoch = -1; let failures = 0; let busyAttempts = 0; let reconnecting = false;
    const stop = () => this.interrupt?.abort(signal?.reason); signal?.addEventListener('abort', stop, { once: true });
    const signature = (state: ScopedAgentConversation) => JSON.stringify([state.focus, state.snapshot, state.eventCursor, state.messageCursor, state.messages.length, state.omittedMessages]);
    try {
      while (!signal?.aborted) {
        const target = this.target; const control = new AbortController(); this.interrupt = control;
        if (epoch !== target.epoch) {
          epoch = target.epoch; previous = null; previousHasMore = false; failures = 0; busyAttempts = 0; reconnecting = false;
          if (this.announcedEpoch !== epoch) { this.announcedEpoch = epoch; onUpdate({ type: 'reset', user_id: target.userId }); }
        }
        if (signal?.aborted || control.signal.aborted) continue;
        let timedOut = false; let pause = this.interval; const timer = setTimeout(() => { timedOut = true; control.abort(); }, this.timeout);
        try {
          const result: AgentConversationRecoveryResult = await cancellable(target.source.reconcileConversation(target.userId, previous, control.signal), control.signal);
          if (target !== this.target || signal?.aborted) continue; control.signal.throwIfAborted();
          if (!previous || previous.authScope !== result.state.authScope || result.source === 'recovered' || reconnecting
            || previousHasMore !== result.hasMore || signature(previous) !== signature(result.state)) {
            onUpdate({ type: 'conversation', user_id: target.userId, conversation: parseAgentConversationView(result.state), source: result.source, has_more: result.hasMore });
          }
          previous = result.state; previousHasMore = result.hasMore; failures = 0; busyAttempts = 0; reconnecting = false; pause = result.hasMore ? 0 : this.interval;
        } catch (error) {
          if (target !== this.target || signal?.aborted) continue;
          const server = error instanceof AgentSessionHttpError && (error.status === 408 || error.status === 429 || error.status >= 500);
          const busy = error instanceof NativeDeviceOperationBusy; busyAttempts = busy ? busyAttempts + 1 : 0;
          if ((busy && busyAttempts > 3) || (!timedOut && !server && !busy && !(error instanceof NativePlatformTransportError))) {
            previous = null; const exposed = fatal(error); onUpdate({ type: 'stopped', user_id: target.userId, reason: exposed.code === 'auth_required' ? 'authentication' : 'failed' }); throw exposed;
          }
          pause = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
          onUpdate({ type: 'reconnecting', user_id: target.userId, retry_in_ms: pause, reason: timedOut ? 'timeout' : busy ? 'busy' : server ? 'server' : 'transport' }); reconnecting = true;
        } finally { clearTimeout(timer); }
        if (target !== this.target || signal?.aborted) continue;
        const waiting = new AbortController(); this.interrupt = waiting; if (signal?.aborted) stop();
        try { await cancellable(this.wait(pause, waiting.signal), waiting.signal); }
        catch (error) { if (!waiting.signal.aborted) { onUpdate({ type: 'stopped', user_id: target.userId, reason: 'failed' }); throw fatal(error); } }
      }
      onUpdate({ type: 'stopped', user_id: this.target.userId, reason: 'cancelled' });
    } finally { signal?.removeEventListener('abort', stop); this.interrupt?.abort(); this.interrupt = null; previous = null; this.notify = null; this.running = false; }
  }
}
