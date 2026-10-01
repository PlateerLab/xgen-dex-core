import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import test from 'node:test';
import { AgentSessionHttpError, AgentSessionProtocolError, PlatformCredentialUnavailable } from '@dex/protocol/agent-session';
import type { AgentFocusRecoveryResult, ScopedAgentFocus } from '@dex/protocol/agent-session-focus-recovery';
import { NativeAccountChanged, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { createMobileDeviceKeys, mobileKeyThumbprint } from '../src/lib/native-device-key';
import { createMobileSessionVault, mobileVaultScope, MobileVaultError, type MobilePlatformRecord } from '../src/lib/native-session-vault';
import { createMobileAgentFetch } from '../src/lib/native-agent-http';
import { createMobileAgentFocusSource, MobileFocusBusy } from '../src/lib/native-agent-focus';
import { createMobileAgentFocusWatcher, mobileFocusMessage, mobileFocusWait, MobileFocusWatchError, type MobileAgentFocusUpdate } from '../src/lib/native-agent-focus-watch';

const origin = 'https://mobile.example.test'; const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const key = pair.publicKey.export({ format: 'jwk' }); const publicKey = { kty: 'EC', crv: 'P-256', x: key.x!, y: key.y! } as const;
const jwt = (header: object, claims: object) => { const input = [header, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; };
const focus = { active_agent_session_id: null, version: 0, event_id: null };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const initial = { origin, userId: String(Math.floor(Math.random() * 1e12) + 1), authScope: randomUUID(), accessToken: 'legacy-bearer' };
  let account: typeof initial | null = { ...initial }; const metadata = { installId: randomUUID(), publicKey, storage: 'android-tee' };
  const sid = randomUUID(); const deviceId = randomUUID(); const scopeKey = mobileVaultScope(initial); const values = new Map<string, string>();
  const storage = { getItemAsync: async (k: string) => values.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => { values.set(k, v); }, deleteItemAsync: async (k: string) => { values.delete(k); } };
  const makeRecord = (exp = Math.floor(Date.now() / 1000) + 300, sessionId = sid): MobilePlatformRecord => ({
    version: 1, platform: 'mobile', origin, userId: initial.userId, installId: metadata.installId, keyThumbprint: mobileKeyThumbprint(publicKey),
    deviceId, sessionId, generation: randomUUID(), phase: 'ready', refreshToken: Buffer.alloc(32, 2).toString('base64url'),
    accessToken: jwt({ alg: 'ES256' }, { sub: initial.userId, sid: sessionId, device_id: deviceId, platform_type: 'mobile', token_use: 'platform_access',
      cnf: { jkt: mobileKeyThumbprint(publicKey) }, exp }), accessExpiresAt: new Date(exp * 1000).toISOString(),
  });
  let record = makeRecord(); values.set(scopeKey, JSON.stringify(record));
  const calls: { path: string; token: string; dpop: string }[] = [];
  let handle = async (_path: string): Promise<{ status: number; body: string }> => ({ status: 200, body: JSON.stringify(focus) });
  const native = { newRequestId: randomUUID, prepare: async () => metadata,
    signChallenge: async () => assert.fail('Canonical reads never sign enrollment/login/refresh challenges'),
    signDpop: async (_o: string, _u: string, _i: string, _t: string, method: string, htu: string, token: string) =>
      jwt({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicKey }, { jti: randomUUID(), htm: method, htu,
        iat: Math.floor(Date.now() / 1000), ath: createHash('sha256').update(token).digest('base64url') }),
    readRequest: async (_id: string, o: string, path: string, token: string, dpop: string) => {
      assert.equal(o, origin); calls.push({ path, token, dpop }); return handle(path);
    }, cancelRequest: () => undefined,
  };
  const current = () => account ? { ...account } : null; const keys = createMobileDeviceKeys(native, current); const vault = createMobileSessionVault(storage);
  const make = (fetch = createMobileAgentFetch(native, origin)) => createMobileAgentFocusSource({ current, keys, vault, fetch });
  return { source: make(), make, native, keys, vault, initial, current, sid, calls, scopeKey, values, storage, makeRecord,
    record: () => record, put(r: MobilePlatformRecord) { record = r; values.set(scopeKey, JSON.stringify(r)); },
    change(v: typeof account) { account = v; }, handle(v: typeof handle) { handle = v; } };
}
function result(version = 0, source: AgentFocusRecoveryResult['source'] = 'replay', hasMore = false): AgentFocusRecoveryResult {
  return { state: { authScope: 'verified-mobile', focus: { ...focus, version } }, source, hasMore };
}
function page(after: number) { return { events: [], next_cursor: after, snapshot_version: after, has_more: false }; }

test('hardware-provider seam signs fresh real ES256/ath/GET proof for each read, excluding query; replay shares only a token-free scope', async () => {
  const f = fixture(); const first = await f.source.reconcileFocus(null); assert.equal(first.source, 'snapshot');
  f.handle(async () => ({ status: 200, body: JSON.stringify(page(0)) }));
  const second = await f.source.reconcileFocus(first.state); assert.equal(second.source, 'replay'); assert.equal(second.state.authScope, first.state.authScope);
  assert.equal(f.calls[1]!.path, '/api/agentflow/me/agent-events?after_sequence=0&limit=100');
  const jtIs = new Set<string>();
  for (const call of f.calls) {
    assert.equal(call.token, f.record().accessToken); assert.notEqual(call.token, f.initial.accessToken);
    const parts = call.dpop.split('.'); const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    assert.equal(claims.htm, 'GET'); assert.equal(claims.htu, `${origin}${call.path.split('?')[0]}`);
    assert.equal(claims.ath, createHash('sha256').update(call.token).digest('base64url')); jtIs.add(claims.jti);
    assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url')), true);
  }
  assert.equal(jtIs.size, 2); assert.equal(JSON.stringify(first).includes(f.record().accessToken!), false);
});
test('gap/409/invalid replay JSON recover via owner snapshot, while valid ordered replay advances focus', async () => {
  for (const failure of ['gap', '409', 'json']) {
    const f = fixture(); const first = await f.source.reconcileFocus(null); const nextSid = randomUUID(); const eventId = randomUUID();
    f.handle(async (path) => path.includes('agent-state') ? { status: 200, body: JSON.stringify({ active_agent_session_id: nextSid, version: 7, event_id: eventId }) }
      : failure === '409' ? { status: 409, body: 'private' } : failure === 'json' ? { status: 200, body: 'invalid' }
        : { status: 200, body: JSON.stringify({ ...page(1), events: [{ event_id: eventId, sequence: 2, event_type: 'agent_session.focus_changed',
          previous_agent_session_id: null, active_agent_session_id: nextSid, origin_id: null, created_at: new Date().toISOString() }] }) });
    const recovered = await f.source.reconcileFocus(first.state); assert.equal(recovered.source, 'recovered'); assert.equal(recovered.state.focus.version, 7);
    assert.equal(f.calls.length, 3);
  }
  const f = fixture(); const first = await f.source.reconcileFocus(null); const nextSid = randomUUID(); const eventId = randomUUID();
  f.handle(async () => ({ status: 200, body: JSON.stringify({ events: [{ event_id: eventId, sequence: 1, event_type: 'agent_session.focus_changed',
    previous_agent_session_id: null, active_agent_session_id: nextSid, origin_id: null, created_at: new Date().toISOString() }], next_cursor: 1, snapshot_version: 1, has_more: false }) }));
  const replay = await f.source.reconcileFocus(first.state); assert.equal(replay.state.focus.active_agent_session_id, nextSid); assert.equal(replay.source, 'replay');
});
test('credential rotation on same sid retains cursor and uses new token; changed sid or login lifetime resets snapshot', async () => {
  const f = fixture(); const first = await f.source.reconcileFocus(null); const oldToken = f.record().accessToken;
  f.put(f.makeRecord(Math.floor(Date.now() / 1000) + 600)); f.change({ ...f.initial, accessToken: 'normal-legacy-rotation' });
  f.handle(async () => ({ status: 200, body: JSON.stringify(page(0)) })); const rotated = await f.source.reconcileFocus(first.state);
  assert.equal(rotated.state.authScope, first.state.authScope); assert.notEqual(f.calls.at(-1)!.token, oldToken);
  f.put(f.makeRecord(undefined, randomUUID())); f.handle(async () => ({ status: 200, body: JSON.stringify(focus) }));
  const replaced = await f.source.reconcileFocus(rotated.state); assert.equal(replaced.source, 'snapshot'); assert.notEqual(replaced.state.authScope, first.state.authScope);
  f.change({ ...f.initial, authScope: randomUUID() }); await assert.rejects(f.source.reconcileFocus(replaced.state), NativeAccountChanged);
  const fresh = await f.make().reconcileFocus(replaced.state); assert.equal(fresh.source, 'snapshot'); assert.notEqual(fresh.state.authScope, replaced.state.authScope);
});
test('missing, expired, access-unavailable, pending and corrupt vault block before Canonical wire without refresh/fallback', async () => {
  for (const state of ['none', 'expired', 'access-unavailable', 'journal', 'corrupt']) {
    const f = fixture();
    if (state === 'none') f.values.clear();
    if (state === 'expired') f.put(f.makeRecord(Math.floor(Date.now() / 1000) - 5));
    if (state === 'access-unavailable') f.put({ ...f.record(), accessToken: null, accessExpiresAt: null });
    if (state === 'journal') f.values.set(`${f.scopeKey}-journal`, JSON.stringify({ ...f.record(), phase: 'refreshing', accessToken: null, refreshToken: null, accessExpiresAt: null }));
    if (state === 'corrupt') f.values.set(f.scopeKey, '{secret-corruption');
    const before = [...f.values.entries()]; await assert.rejects(f.source.reconcileFocus(null), state === 'corrupt' ? MobileVaultError : PlatformCredentialUnavailable);
    assert.equal(f.calls.length, 0); assert.deepEqual([...f.values.entries()], before);
  }
});
test('account/origin/lifetime/background disposal or cancellation rejects even abort-ignoring late response', async () => {
  for (const change of ['account', 'origin', 'lifetime', 'background', 'abort']) {
    const f = fixture(); const entered = deferred<void>(); const late = deferred<{ status: number; body: string }>(); const control = new AbortController();
    f.handle(async () => { entered.resolve(); return late.promise; }); const reading = f.source.reconcileFocus(null, control.signal); await entered.promise;
    if (change === 'abort') control.abort(); else if (change === 'background') f.source.dispose();
    else f.change({ ...f.initial, ...(change === 'origin' ? { origin: 'https://other.test' } : change === 'account' ? { userId: '999' } : { authScope: randomUUID() }) });
    late.resolve({ status: 200, body: JSON.stringify(focus) }); await assert.rejects(reading); assert.equal(f.calls.length, 1);
  }
});
test('vault lock covers each whole read but releases before polling wait, allowing explicit rotation and a fresh next proof', async () => {
  const f = fixture(); const stop = new AbortController(); let waits = 0; let old: string | null = null;
  f.handle(async (path) => ({ status: 200, body: JSON.stringify(path.includes('agent-state') ? focus : page(0)) }));
  const watcher = createMobileAgentFocusWatcher(f.source, { wait: async () => {
    if (++waits === 1) {
      old = f.record().accessToken; const identity = await f.keys.identity(); const next = f.makeRecord(Math.floor(Date.now() / 1000) + 600);
      await f.vault.withIdentity(f.initial, identity, () => undefined, async (vault) => {
        await vault.begin({ ...f.record(), generation: randomUUID(), phase: 'refreshing', accessToken: null, refreshToken: null, accessExpiresAt: null }); await vault.commit(next);
      });
    } else stop.abort();
  } });
  await watcher.run(() => undefined, stop.signal); assert.equal(f.calls.length, 2); assert.notEqual(f.calls[1]!.token, old);
  assert.ok(f.calls[1]!.path.includes('agent-events'));
});
test('durable interrupted rotation stops a running watcher on its next read without sending a cached token', async () => {
  const f = fixture(); const updates: MobileAgentFocusUpdate[] = []; const stop = new AbortController();
  const watcher = createMobileAgentFocusWatcher(f.source, { wait: async () => {
    f.values.set(`${f.scopeKey}-journal`, JSON.stringify({ ...f.record(), generation: randomUUID(), phase: 'refreshing', accessToken: null, refreshToken: null, accessExpiresAt: null }));
  } });
  await assert.rejects(watcher.run((u) => updates.push(u), stop.signal), MobileFocusWatchError); assert.equal(f.calls.length, 1);
  assert.deepEqual(updates.at(-1), { type: 'stopped', reason: 'authentication' });
});
test('transient failures retain cursor, exponential delay is bounded, unchanged polls are suppressed and recovery is reannounced', async () => {
  const stop = new AbortController(); const updates: MobileAgentFocusUpdate[] = []; const pauses: number[] = []; const previous: Array<ScopedAgentFocus | null> = []; let calls = 0;
  const watcher = createMobileAgentFocusWatcher({ reconcileFocus: async (old) => {
    previous.push(old); calls++; if (calls >= 3 && calls <= 9) throw calls % 2 ? new NativePlatformTransportError() : new AgentSessionHttpError(503);
    return result(calls >= 11 ? 1 : 0, calls === 1 ? 'snapshot' : 'replay');
  } }, { wait: async (ms) => { pauses.push(ms); if (calls === 11) stop.abort(); } });
  await watcher.run((u) => updates.push(u), stop.signal);
  assert.deepEqual(pauses, [2000, 2000, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 2000, 2000]);
  assert.deepEqual(updates.filter((u) => u.type === 'focus').map((u) => u.focus.version), [0, 0, 1]);
  assert.equal(previous[0], null); for (const old of previous.slice(1)) assert.equal(old?.focus.version, 0);
});
test('authentication, key/vault and protocol failures stop once with safe errors; manual read never retries', async () => {
  for (const error of [new AgentSessionHttpError(401), new AgentSessionHttpError(403), new PlatformCredentialUnavailable(), new NativeAccountChanged(),
    new MobileVaultError(), new AgentSessionProtocolError('private-body'), new Error('private-native-secret')]) {
    let calls = 0; const updates: MobileAgentFocusUpdate[] = [];
    const watcher = createMobileAgentFocusWatcher({ reconcileFocus: async () => { calls++; throw error; } }, { wait: async () => assert.fail('must not wait') });
    await assert.rejects(watcher.run((u) => updates.push(u), new AbortController().signal), MobileFocusWatchError);
    assert.equal(calls, 1); assert.equal(updates.at(-1)!.type, 'stopped'); assert.equal(JSON.stringify(updates).includes('private'), false);
    assert.equal(mobileFocusMessage(error).includes('private'), false);
  }
  let calls = 0; const watcher = createMobileAgentFocusWatcher({ reconcileFocus: async () => { calls++; throw new AgentSessionHttpError(503); } });
  await assert.rejects(watcher.run(() => undefined, new AbortController().signal, true)); assert.equal(calls, 1);
});
test('whole-step timeout/cancel settle despite an unresponsive host; late results never update and persistent busy stops', async () => {
  const f = fixture(); const started = deferred<void>(); const late = deferred<unknown>(); const updates: MobileAgentFocusUpdate[] = [];
  const source = f.make((async () => { started.resolve(); return late.promise as Promise<Response>; }) as typeof fetch);
  const watcher = createMobileAgentFocusWatcher(source, { requestTimeoutMs: 100, wait: async () => undefined });
  const running = watcher.run((u) => updates.push(u), new AbortController().signal);
  await started.promise; await assert.rejects(running, MobileFocusWatchError); assert.equal(updates.filter((u) => u.type === 'focus').length, 0);
  late.resolve({ status: 200, ok: true, json: async () => focus }); await new Promise((r) => setImmediate(r));
  assert.equal(updates.at(-1)!.type, 'stopped'); source.dispose();
  const gate = deferred<AgentFocusRecoveryResult>(); const stop = new AbortController(); const cancelUpdates: MobileAgentFocusUpdate[] = [];
  const waiting = createMobileAgentFocusWatcher({ reconcileFocus: async () => gate.promise });
  const cancelled = waiting.run((u) => cancelUpdates.push(u), stop.signal); stop.abort(); await cancelled; gate.resolve(result(999));
  assert.deepEqual(cancelUpdates, [{ type: 'reset' }, { type: 'stopped', reason: 'cancelled' }]);
});
test('concurrent run/source are refused; restarting after stop discards cursor, backlog yields without delay', async () => {
  const f = fixture(); const gate = deferred<{ status: number; body: string }>(); const begun = deferred<void>();
  f.handle(async () => { begun.resolve(); return gate.promise; }); const pending = f.source.reconcileFocus(null); await begun.promise;
  await assert.rejects(f.source.reconcileFocus(null), MobileFocusBusy); gate.resolve({ status: 200, body: JSON.stringify(focus) }); await pending;
  const stop = new AbortController(); const pauses: number[] = []; let calls = 0;
  const watcher = createMobileAgentFocusWatcher({ reconcileFocus: async (old) => { calls++; if (calls === 1 || calls === 3) assert.equal(old, null); return result(calls, 'replay', calls === 1); } },
    { wait: async (ms) => { pauses.push(ms); if (calls === 2) stop.abort(); } });
  await watcher.run(() => undefined, stop.signal); assert.deepEqual(pauses, [0, 2000]);
  await watcher.run(() => undefined, new AbortController().signal, true); assert.equal(calls, 3);
});
test('real timer wait supports already aborted signal and active cancellation without waiting for interval', async () => {
  const first = new AbortController(); first.abort(); await assert.rejects(mobileFocusWait(30000, first.signal));
  const second = new AbortController(); const wait = mobileFocusWait(30000, second.signal); second.abort(); await assert.rejects(wait);
});
