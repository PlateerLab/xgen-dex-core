import { AgentSessionHttpError, PlatformCredentialUnavailable, type AgentFocus } from '@dex/protocol/agent-session';
import type { AgentFocusRecoveryResult, ScopedAgentFocus } from '@dex/protocol/agent-session-focus-recovery';
import { NativeAccountChanged, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { MobileFocusBusy } from './native-agent-focus';
import { MobileAgentTransportBusy } from './native-agent-http';

export interface MobileAgentFocusSource {
  reconcileFocus(previous: ScopedAgentFocus | null, signal?: AbortSignal): Promise<AgentFocusRecoveryResult>;
}
export type MobileAgentFocusUpdate =
  | { type: 'reset' }
  | { type: 'focus'; focus: AgentFocus; source: AgentFocusRecoveryResult['source'] }
  | { type: 'reconnecting'; retryInMs: number }
  | { type: 'stopped'; reason: 'cancelled' | 'authentication' | 'failed' };
export class MobileFocusWatchError extends Error {
  constructor(readonly code: 'busy' | 'authentication' | 'failed') { super(code); }
}
export function mobileFocusMessage(error: unknown): string {
  if (error instanceof MobileFocusWatchError && error.code === 'authentication') return '세션이 만료되었거나 접근이 변경되었습니다. 휴대폰 세션을 확인·갱신한 뒤 다시 조회하세요.';
  return 'Agent 포커스를 확인하지 못했습니다. 휴대폰의 기기 키·세션과 서버 상태를 확인한 뒤 다시 조회하세요.';
}
export function mobileFocusWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('Aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
  });
}
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let reject!: (e: unknown) => void; const aborted = new Promise<never>((_, r) => { reject = r; });
  const abort = () => reject(signal.reason ?? new Error('Aborted'));
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  try { return await Promise.race([operation, aborted]); } finally { signal.removeEventListener('abort', abort); }
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid Mobile watch interval'); return value;
}
/** Explicit foreground read-only polling. Each step reloads the vault and signs fresh proofs. */
export function createMobileAgentFocusWatcher(source: MobileAgentFocusSource, options: {
  intervalMs?: number; requestTimeoutMs?: number; wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const interval = bounded(options.intervalMs ?? 2000, 200, 60000);
  const timeout = bounded(options.requestTimeoutMs ?? 10000, 100, 60000);
  const wait = options.wait ?? mobileFocusWait; let running = false;
  return {
    async run(onUpdate: (update: MobileAgentFocusUpdate) => void, signal: AbortSignal, once = false): Promise<void> {
      if (running) throw new MobileFocusWatchError('busy'); running = true;
      let previous: ScopedAgentFocus | null = null; let failures = 0; let busyAttempts = 0; let reconnecting = false;
      let step: AbortController | null = null; const abort = () => step?.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        onUpdate({ type: 'reset' });
        while (!signal.aborted) {
          const control = new AbortController(); step = control; if (signal.aborted) abort();
          let timedOut = false; let pause = interval;
          const timer = setTimeout(() => { timedOut = true; control.abort(); }, timeout);
          try {
            const result: AgentFocusRecoveryResult = await cancellable(source.reconcileFocus(previous, control.signal), control.signal);
            if (signal.aborted) break; control.signal.throwIfAborted();
            if (!previous || previous.authScope !== result.state.authScope || result.source === 'recovered' || reconnecting
              || JSON.stringify(previous.focus) !== JSON.stringify(result.state.focus)) {
              onUpdate({ type: 'focus', focus: { ...result.state.focus }, source: result.source });
            }
            previous = result.state; failures = 0; busyAttempts = 0; reconnecting = false;
            if (once) return;
            pause = result.hasMore ? 0 : interval;
          } catch (error) {
            if (signal.aborted) break;
            const server = error instanceof AgentSessionHttpError && (error.status === 408 || error.status === 429 || error.status >= 500);
            const busy = error instanceof MobileFocusBusy || error instanceof MobileAgentTransportBusy; busyAttempts = busy ? busyAttempts + 1 : 0;
            const authentication = error instanceof NativeAccountChanged || error instanceof PlatformCredentialUnavailable
              || (error instanceof AgentSessionHttpError && [401, 403].includes(error.status));
            if (once || authentication || (busy && busyAttempts > 3) || (!timedOut && !server && !busy && !(error instanceof NativePlatformTransportError))) {
              previous = null; onUpdate({ type: 'stopped', reason: authentication ? 'authentication' : 'failed' });
              throw new MobileFocusWatchError(authentication ? 'authentication' : 'failed');
            }
            pause = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
            onUpdate({ type: 'reconnecting', retryInMs: pause }); reconnecting = true;
          } finally { clearTimeout(timer); }
          if (signal.aborted) break;
          // Normal steps release the account lock before waiting. A timed-out OS call may still
          // be settling; the source refuses overlapping work, and repeated busy attempts stop.
          const waiting = new AbortController(); step = waiting; if (signal.aborted) abort();
          try { await cancellable(wait(pause, waiting.signal), waiting.signal); }
          catch { if (!signal.aborted) { onUpdate({ type: 'stopped', reason: 'failed' }); throw new MobileFocusWatchError('failed'); } }
        }
        onUpdate({ type: 'stopped', reason: 'cancelled' });
      } finally { signal.removeEventListener('abort', abort); step?.abort(); previous = null; running = false; }
    },
  };
}
