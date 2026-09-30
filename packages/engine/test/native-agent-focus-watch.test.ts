import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionHttpError } from '@dex/protocol/agent-session';
import type { AgentFocusRecoveryResult, ScopedAgentFocus } from '@dex/protocol/agent-session-focus-recovery';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { NativeAgentFocusWatcher, type NativeAgentFocusSource, type NativeAgentFocusUpdate } from '../src/native-agent-focus-watch';
import { DexError } from '../src/errors';

const focus = { active_agent_session_id: null, version: 0, event_id: null };
function result(scope = 'verified-a', version = 0, source: AgentFocusRecoveryResult['source'] = 'replay', hasMore = false): AgentFocusRecoveryResult {
  return { state: { authScope: scope, focus: { ...focus, version } }, source, hasMore };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('transient failures retain cursor, back off, suppress unchanged polls and announce resumed focus', async () => {
  const stop = new AbortController(); const updates: NativeAgentFocusUpdate[] = []; const pauses: number[] = [];
  const previous: Array<ScopedAgentFocus | null> = []; let calls = 0;
  const source: NativeAgentFocusSource = { reconcileFocus: async (_user, old) => {
    previous.push(old); calls++;
    if (calls === 3) throw new NativePlatformTransportError();
    if (calls === 4) throw new AgentSessionHttpError(503);
    return result('verified-a', calls >= 6 ? 1 : 0, calls === 1 ? 'snapshot' : 'replay');
  } };
  const watcher = new NativeAgentFocusWatcher(source, '7', { wait: async (ms, signal) => {
    assert.equal(signal.aborted, false); pauses.push(ms); if (calls === 6) stop.abort();
  } });
  await watcher.run((event) => updates.push(event), stop.signal);
  assert.deepEqual(pauses, [2000, 2000, 1000, 2000, 2000, 2000]);
  assert.deepEqual(updates.map((e) => e.type), ['reset', 'focus', 'reconnecting', 'focus', 'focus', 'stopped']);
  assert.deepEqual(updates.filter((e) => e.type === 'focus').map((e) => e.focus.version), [0, 0, 1]);
  assert.equal(previous[0], null); for (const old of previous.slice(1)) assert.equal(old?.focus.version, 0);
});

test('account switch cancels an in-flight source and suppresses even an abort-ignoring stale response', async () => {
  const started = deferred<AbortSignal>(); const old = deferred<AgentFocusRecoveryResult>(); const stop = new AbortController();
  const updates: NativeAgentFocusUpdate[] = [];
  const a: NativeAgentFocusSource = { reconcileFocus: async (_id, _previous, signal) => { started.resolve(signal!); return old.promise; } };
  const b: NativeAgentFocusSource = { reconcileFocus: async (id, previous) => {
    assert.equal(id, '8'); assert.equal(previous, null); return result('verified-b', 22, 'snapshot');
  } };
  const watcher = new NativeAgentFocusWatcher(a, '7');
  const running = watcher.run((e) => { updates.push(e); if (e.type === 'focus') stop.abort(); }, stop.signal);
  const signal = await started.promise; watcher.select(b, '8'); assert.equal(signal.aborted, true);
  old.resolve(result('verified-a', 91)); await running;
  assert.deepEqual(updates, [{ type: 'reset', user_id: '7' }, { type: 'reset', user_id: '8' },
    { type: 'focus', user_id: '8', focus: { ...focus, version: 22 }, source: 'snapshot' },
    { type: 'stopped', user_id: '8', reason: 'cancelled' }]);
});

test('selecting the same account or another origin while waiting discards its cursor and cancels delay', async () => {
  const waiting = deferred<AbortSignal>(); const stop = new AbortController(); let calls = 0; let waits = 0;
  const source: NativeAgentFocusSource = { reconcileFocus: async (_id, previous) => {
    calls++; assert.equal(previous, null); return result('verified-origin', calls, 'snapshot');
  } };
  const watcher = new NativeAgentFocusWatcher(source, '7', { wait: async (_ms, signal) => {
    waits++; if (waits === 1) { waiting.resolve(signal); await untilAborted(signal); } else stop.abort();
  } });
  const updates: NativeAgentFocusUpdate[] = []; const run = watcher.run((e) => updates.push(e), stop.signal);
  const delaySignal = await waiting.promise; watcher.select(source, '7'); assert.equal(delaySignal.aborted, true);
  await run; assert.equal(calls, 2); assert.equal(updates.filter((e) => e.type === 'reset').length, 2);
});

test('authentication, missing keychain and invalid snapshot stop without retry or exposing raw errors', async () => {
  for (const error of [new AgentSessionHttpError(401), new AgentSessionHttpError(403),
    new DexError('auth_required', 'Reauthenticate'), new DexError('credential_store_unavailable', 'Keychain locked'), new Error('private-server-secret')]) {
    let calls = 0; const updates: NativeAgentFocusUpdate[] = [];
    const watcher = new NativeAgentFocusWatcher({ reconcileFocus: async () => { calls++; throw error; } }, '7',
      { wait: async () => assert.fail('fatal error must not wait') });
    await assert.rejects(watcher.run((e) => updates.push(e)), (e: unknown) => e instanceof DexError && !e.message.includes('private-server-secret'));
    assert.equal(calls, 1); assert.deepEqual(updates.map((e) => e.type), ['reset', 'stopped']);
    assert.equal(JSON.stringify(updates).includes('private-server-secret'), false);
  }
});

test('Ctrl+C cancels an HTTP request cleanly and a restarted watcher cannot reuse the old cursor', async () => {
  const started = deferred<AbortSignal>(); const stop = new AbortController(); let calls = 0;
  const source: NativeAgentFocusSource = { reconcileFocus: async (_id, previous, signal) => {
    assert.equal(previous, null); calls++;
    if (calls === 1) { started.resolve(signal!); return untilAborted(signal!); }
    return result('verified-a', 0, 'snapshot');
  } };
  const watcher = new NativeAgentFocusWatcher(source, '7'); const updates: NativeAgentFocusUpdate[] = [];
  const run = watcher.run((e) => updates.push(e), stop.signal);
  await started.promise; stop.abort(); await run;
  assert.deepEqual(updates.map((e) => e.type), ['reset', 'stopped']);
  const second = new AbortController(); await watcher.run((e) => { if (e.type === 'focus') second.abort(); }, second.signal);
  assert.equal(calls, 2);
});

test('whole-step timeout cancels the request and uses a fresh backoff signal before reconnecting', async () => {
  const stop = new AbortController(); const updates: NativeAgentFocusUpdate[] = []; let calls = 0;
  const watcher = new NativeAgentFocusWatcher({ reconcileFocus: async (_id, previous, signal) => {
    calls++; assert.equal(previous, null); return calls === 1 ? untilAborted(signal!) : result('verified-a', 0, 'snapshot');
  } }, '7', { requestTimeoutMs: 100, wait: async (ms, signal) => { assert.equal(ms, 1000); assert.equal(signal.aborted, false); } });
  await watcher.run((e) => { updates.push(e); if (e.type === 'focus') stop.abort(); }, stop.signal);
  assert.equal(calls, 2); assert.deepEqual(updates[1], { type: 'reconnecting', user_id: '7', retry_in_ms: 1000, reason: 'timeout' });
});

test('backlog yields immediately between bounded batches, gap recovery and scope reset publish snapshots', async () => {
  const stop = new AbortController(); const pauses: number[] = []; const updates: NativeAgentFocusUpdate[] = []; let calls = 0;
  const steps = [result('a', 0, 'snapshot'), result('a', 1000, 'replay', true), result('a', 1200, 'recovered'), result('new-sid', 1200, 'snapshot')];
  const watcher = new NativeAgentFocusWatcher({ reconcileFocus: async () => steps[calls++] }, '7', {
    wait: async (ms) => { pauses.push(ms); if (calls === steps.length) stop.abort(); },
  });
  await watcher.run((e) => updates.push(e), stop.signal);
  assert.deepEqual(pauses, [2000, 0, 2000, 2000]);
  assert.deepEqual(updates.filter((e) => e.type === 'focus').map((e) => e.source), ['snapshot', 'replay', 'recovered', 'snapshot']);
});

test('options, pre-cancellation and duplicate run do not open a second source', async () => {
  const source: NativeAgentFocusSource = { reconcileFocus: async () => assert.fail() };
  for (const options of [{ intervalMs: 0 }, { intervalMs: NaN }, { requestTimeoutMs: 60001 }]) assert.throws(() => new NativeAgentFocusWatcher(source, '7', options), DexError);
  assert.throws(() => new NativeAgentFocusWatcher(source, '2147483648'), DexError);
  const controller = new AbortController(); controller.abort(); const updates: NativeAgentFocusUpdate[] = [];
  await new NativeAgentFocusWatcher(source, '7').run((e) => updates.push(e), controller.signal);
  assert.deepEqual(updates, [{ type: 'stopped', user_id: '7', reason: 'cancelled' }]);
  const started = deferred<AbortSignal>(); const stop = new AbortController();
  const watcher = new NativeAgentFocusWatcher({ reconcileFocus: async (_id, _old, signal) => { started.resolve(signal!); return untilAborted(signal!); } }, '7');
  const run = watcher.run(() => {}, stop.signal); await started.promise;
  await assert.rejects(watcher.run(() => {}), DexError); stop.abort(); await run;
});
