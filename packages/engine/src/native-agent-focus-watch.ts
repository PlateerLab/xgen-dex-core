import { setTimeout as delay } from 'node:timers/promises';
import { AgentSessionHttpError, type AgentFocus } from '@dex/protocol/agent-session';
import type { AgentFocusRecoveryResult, ScopedAgentFocus } from '@dex/protocol/agent-session-focus-recovery';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { DexError } from './errors';

export interface NativeAgentFocusSource {
  reconcileFocus(userId: string, previous: ScopedAgentFocus | null, signal?: AbortSignal): Promise<AgentFocusRecoveryResult>;
}
export type NativeAgentFocusUpdate =
  | { type: 'reset'; user_id: string }
  | { type: 'focus'; user_id: string; focus: AgentFocus; source: AgentFocusRecoveryResult['source'] }
  | { type: 'reconnecting'; user_id: string; retry_in_ms: number; reason: 'transport' | 'server' | 'timeout' }
  | { type: 'stopped'; user_id: string; reason: 'cancelled' | 'authentication' | 'failed' };
export interface NativeAgentFocusWatchOptions {
  intervalMs?: number;
  requestTimeoutMs?: number;
  /** Host scheduling adapter. It must settle on cancellation and must not retain credentials. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DexError('usage_error', 'watch 간격 또는 요청 제한 시간이 허용 범위를 벗어났습니다.');
  return value;
}
function fatal(error: unknown): DexError {
  if (error instanceof DexError) return error;
  if (error instanceof AgentSessionHttpError && [401, 403].includes(error.status)) {
    return new DexError('auth_required', 'CLI 인증이 만료되었거나 세션·기기 접근이 폐기되었습니다. 세션 상태를 확인하세요.');
  }
  return new DexError('protocol_mismatch', 'Canonical 포커스 구독을 계속할 수 없습니다.');
}

/** Read-only polling. No credentials in state/output, automatic refresh, or legacy fallback. */
export class NativeAgentFocusWatcher {
  private target: { source: NativeAgentFocusSource; userId: string; epoch: number };
  private interrupt: AbortController | null = null;
  private running = false;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly wait: NonNullable<NativeAgentFocusWatchOptions['wait']>;
  constructor(source: NativeAgentFocusSource, userId: string, options: NativeAgentFocusWatchOptions = {}) {
    this.target = { source, userId: this.account(userId), epoch: 0 };
    this.interval = bounded(options.intervalMs ?? 2000, 200, 60000);
    this.timeout = bounded(options.requestTimeoutMs ?? 10000, 100, 60000);
    this.wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  }
  private account(userId: string): string {
    if (!/^[1-9][0-9]{0,9}$/.test(userId) || Number(userId) > 2147483647) throw new DexError('usage_error', '실제 계정 ID가 필요합니다.');
    return userId;
  }
  /** Also use this for origin/profile changes. Even selecting the same account starts a fresh snapshot. */
  select(source: NativeAgentFocusSource, userId: string): void {
    this.target = { source, userId: this.account(userId), epoch: this.target.epoch + 1 };
    this.interrupt?.abort();
  }
  async run(onUpdate: (update: NativeAgentFocusUpdate) => void, signal?: AbortSignal): Promise<void> {
    if (this.running) throw new DexError('usage_error', '이미 실행 중인 포커스 구독입니다.');
    this.running = true;
    let previous: ScopedAgentFocus | null = null;
    let epoch = -1;
    let failures = 0;
    let reconnecting = false;
    const stop = () => this.interrupt?.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      while (!signal?.aborted) {
        const target = this.target;
        const control = new AbortController(); this.interrupt = control;
        if (epoch !== target.epoch) {
          epoch = target.epoch; previous = null; failures = 0; reconnecting = false;
          onUpdate({ type: 'reset', user_id: target.userId });
        }
        if (signal?.aborted || control.signal.aborted) continue;
        let pause = this.interval;
        let timedOut = false;
        // One deadline covers all pages, signatures and response bodies, not each individual request.
        const timer = setTimeout(() => { timedOut = true; control.abort(); }, this.timeout);
        try {
          const result = await target.source.reconcileFocus(target.userId, previous, control.signal);
          if (target !== this.target || signal?.aborted) continue;
          if (timedOut) throw new NativePlatformTransportError();
          if (!previous || previous.authScope !== result.state.authScope || result.source === 'recovered' || reconnecting
            || JSON.stringify(previous.focus) !== JSON.stringify(result.state.focus)) {
            onUpdate({ type: 'focus', user_id: target.userId, focus: { ...result.state.focus }, source: result.source });
          }
          previous = result.state; failures = 0; reconnecting = false;
          // Yield without an interval delay when a bounded page batch has more work.
          pause = result.hasMore ? 0 : this.interval;
        } catch (error) {
          if (target !== this.target || signal?.aborted) continue;
          const server = error instanceof AgentSessionHttpError && (error.status === 408 || error.status === 429 || error.status >= 500);
          if (!timedOut && !server && !(error instanceof NativePlatformTransportError)) {
            previous = null;
            const exposed = fatal(error);
            onUpdate({ type: 'stopped', user_id: target.userId, reason: exposed.code === 'auth_required' ? 'authentication' : 'failed' });
            throw exposed;
          }
          pause = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
          if (!reconnecting) onUpdate({ type: 'reconnecting', user_id: target.userId, retry_in_ms: pause,
            reason: timedOut ? 'timeout' : server ? 'server' : 'transport' });
          reconnecting = true;
        } finally { clearTimeout(timer); }
        if (target !== this.target || signal?.aborted) continue;
        // The source has returned and released its OS keychain lock before waiting.
        const waiting = new AbortController(); this.interrupt = waiting;
        try { await this.wait(pause, waiting.signal); }
        catch (error) { if (!waiting.signal.aborted) throw fatal(error); }
      }
      onUpdate({ type: 'stopped', user_id: this.target.userId, reason: 'cancelled' });
    } finally {
      signal?.removeEventListener('abort', stop);
      this.interrupt?.abort(); this.interrupt = null; previous = null; this.running = false;
    }
  }
}
