import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import test from 'node:test';
import { MobileAgentLifecycleFailure, type MobileAgentLifecycleRequest } from '../src/lib/native-agent-lifecycle';
import { createMobileAgentFetch } from '../src/lib/native-agent-http';
import { createMobileAgentLifecycleSource } from '../src/lib/native-agent-lifecycle';
import { createMobileAgentLifecycleFetch } from '../src/lib/native-agent-lifecycle-http';
import { createMobileDeviceKeys, mobileKeyThumbprint } from '../src/lib/native-device-key';
import { mobileAgentScope } from '../src/lib/native-agent-scope';
import { createMobileSessionVault, mobileVaultScope, type MobilePlatformRecord } from '../src/lib/native-session-vault';

const origin = 'https://mobile.example.test'; const sid = randomUUID(); const turnId = randomUUID();
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture(timeoutMs = 1000) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const jwk = pair.publicKey.export({ format: 'jwk' });
  const publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as const;
  const initial = { origin, userId: String(Math.floor(Math.random() * 1e9) + 1), authScope: randomUUID(), accessToken: 'legacy-token' };
  let account: typeof initial | null = initial;
  const metadata = { installId: randomUUID(), publicKey, storage: 'android-tee' };
  const jwt = (header: object, claims: object) => {
    const input = [header, claims].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const exp = Math.floor(Date.now() / 1000) + 300; const deviceId = randomUUID(); const platformSid = randomUUID();
  const record: MobilePlatformRecord = { version: 1, platform: 'mobile', origin, userId: initial.userId,
    installId: metadata.installId, keyThumbprint: mobileKeyThumbprint(publicKey), deviceId, sessionId: platformSid,
    generation: randomUUID(), phase: 'ready', refreshToken: Buffer.alloc(32, 2).toString('base64url'),
    accessToken: jwt({ alg: 'ES256' }, { sub: initial.userId, sid: platformSid, device_id: deviceId, platform_type: 'mobile',
      token_use: 'platform_access', cnf: { jkt: mobileKeyThumbprint(publicKey) }, exp }), accessExpiresAt: new Date(exp * 1000).toISOString() };
  const vaultKey = mobileVaultScope(initial); const values = new Map([[vaultKey, JSON.stringify(record)]]);
  const vault = createMobileSessionVault({ getItemAsync: async (k) => values.get(k) ?? null,
    setItemAsync: async (k, v) => { values.set(k, v); }, deleteItemAsync: async (k) => { values.delete(k); } });
  const calls: { path: string; method: string; token: string; dpop: string; body: string }[] = []; const proofs: string[] = []; const cancelled: string[] = [];
  let handler = async (_body: string): Promise<unknown> => ({ status: 201, body: JSON.stringify({ id: sid, workflow_id: 'wf', focus: { active_agent_session_id: sid, version: 1, event_id: turnId } }) });
  const native = { newRequestId: randomUUID, newTurnKey: randomUUID, prepare: async () => metadata,
    signChallenge: async () => assert.fail('No enrollment/refresh proof during a turn'),
    signDpop: async (_o: string, _u: string, _i: string, _t: string, method: string, htu: string, token: string) => {
      const proof = jwt({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicKey }, { jti: randomUUID(), htm: method, htu,
        iat: Math.floor(Date.now() / 1000), ath: createHash('sha256').update(token).digest('base64url') }); proofs.push(proof); return proof;
    },
    lifecycleRequest: async (_id: string, o: string, path: string, method: string, token: string, dpop: string, body: string) => {
      assert.equal(o, origin); calls.push({ path, method, token, dpop, body }); return handler(body);
    }, cancelRequest: (id: string) => { cancelled.push(id); },
  };
  const current = () => account; const keys = createMobileDeviceKeys(native, current); const identity = await keys.identity();
  const source = createMobileAgentLifecycleSource({ current, keys, vault, fetch: createMobileAgentLifecycleFetch(native, origin), timeoutMs });
  const request: MobileAgentLifecycleRequest = { operation: 'create',
    scope: { platform_type: 'mobile', profile: mobileAgentScope(initial, identity, record), server_url: origin, user_id: initial.userId },
    input: { workflow_id: 'wf', title: '  끝\n', expected_version: 0 } };
  return { source, request, calls, proofs, cancelled, values, record, vaultKey, native, initial, pair,
    handle(next: typeof handler) { handler = next; }, change(next: typeof account) { account = next; } };
}
const outcome = (expected: string) => (e: unknown) => e instanceof MobileAgentLifecycleFailure && e.outcome === expected && !e.message.includes('private');
test('ready vault signs exact create POST and focus PUT with fresh ES256; caller input copied before await', async () => {
  const f = await fixture(); const original = structuredClone(f.request); const sending = f.source.send(f.request);
  f.request.input.expected_version = 99; if (f.request.operation === 'create') f.request.input.workflow_id = 'changed';
  const value = await sending as Record<string, unknown>; assert.equal(value.profile, original.scope.profile);
  assert.deepEqual(JSON.parse(f.calls[0].body), original.input); assert.equal(f.calls[0].method, 'POST');
  const claims = JSON.parse(Buffer.from(f.calls[0].dpop.split('.')[1], 'base64url').toString());
  assert.equal(claims.htm, 'POST'); assert.equal(claims.htu, `${origin}/api/agentflow/agent-sessions`);
  assert.equal(claims.ath, createHash('sha256').update(f.record.accessToken!).digest('base64url'));
  const parts = f.calls[0].dpop.split('.'); assert(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: f.pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')));
  f.handle(async () => ({ status: 200, body: JSON.stringify({ active_agent_session_id: null, version: 2, event_id: turnId }) }));
  await f.source.send({ operation: 'switch', scope: original.scope, input: { active_agent_session_id: null, expected_version: 1 } });
  assert.equal(f.calls[1].method, 'PUT'); assert.equal(f.calls[1].path, '/api/agentflow/me/agent-state'); assert.notEqual(f.proofs[0], f.proofs[1]);
  assert.equal(JSON.stringify(value).includes(f.record.accessToken!), false); f.source.dispose();
});
test('journal/expired/missing/foreign scope/account/key blocks before signing or wire', async () => {
  for (const state of ['journal', 'expired', 'missing', 'scope', 'account', 'key']) {
    const f = await fixture();
    if (state === 'journal') f.values.set(`${f.vaultKey}-journal`, JSON.stringify({ ...f.record, phase: 'refreshing', accessToken: null, refreshToken: null, accessExpiresAt: null }));
    if (state === 'expired') f.values.set(f.vaultKey, JSON.stringify({ ...f.record, accessExpiresAt: new Date(0).toISOString() }));
    if (state === 'missing') f.values.clear(); if (state === 'scope') f.request.scope.profile = 'foreign';
    if (state === 'account') f.change({ ...f.initial, authScope: randomUUID() });
    if (state === 'key') f.native.prepare = async () => { throw new Error('private-key'); };
    await assert.rejects(f.source.send(f.request), outcome('unavailable')); assert.equal(f.proofs.length, 0); assert.equal(f.calls.length, 0); f.source.dispose();
  }
});
test('lost/invalid/timeout ACK never retries; cancellation holds native latch before another proof', async () => {
  for (const mode of ['lost', 'invalid', 'timeout']) {
    const f = await fixture(100); const late = deferred<unknown>();
    f.handle(async () => { if (mode === 'lost') throw new Error('private-loss'); if (mode === 'invalid') return { status: 201, body: '{}' }; return late.promise; });
    await assert.rejects(f.source.send(f.request), outcome('unknown')); assert.equal(f.calls.length, 1);
    if (mode === 'timeout') {
      await assert.rejects(f.source.send(f.request), outcome('unavailable')); assert.equal(f.proofs.length, 1);
      late.resolve({ status: 201, body: '{}' }); await new Promise((r) => setImmediate(r));
    }
    f.source.dispose();
  }
});
test('409 conflict is sanitized; changed account after dispatch discards late valid ACK as unknown', async () => {
  const f = await fixture(); f.handle(async () => ({ status: 409, body: JSON.stringify({ detail: { code: 'FOCUS_VERSION_CONFLICT',
    current: { active_agent_session_id: sid, version: 3, event_id: turnId }, private: 'secret' } }) }));
  await assert.rejects(f.source.send(f.request), (e: unknown) => e instanceof MobileAgentLifecycleFailure && e.outcome === 'rejected'
    && e.conflict?.current.version === 3 && !JSON.stringify(e).includes('secret')); f.source.dispose();
  const next = await fixture(); const entered = deferred<void>(); const late = deferred<unknown>();
  next.handle(async () => { entered.resolve(); return late.promise; }); const sending = next.source.send(next.request); await entered.promise;
  next.change({ ...next.initial, authScope: randomUUID() }); late.resolve({ status: 201, body: JSON.stringify({ id: sid, workflow_id: 'wf', focus: { active_agent_session_id: sid, version: 1, event_id: turnId } }) });
  await assert.rejects(sending, outcome('unknown')); next.source.dispose();
});
test('cancelled GET and known native preenqueue failures block lifecycle before credentials/proof', async () => {
  const f = await fixture(); const late = deferred<unknown>(); const module = Object.assign(f.native, { readRequest: async () => late.promise });
  const read = createMobileAgentFetch(module, origin); const control = new AbortController();
  const reading = read(`${origin}/api/agentflow/me/agent-state`, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: control.signal,
    headers: { Accept: 'application/json', Authorization: 'DPoP access.jwt.signature', DPoP: 'proof.jwt.signature' } });
  control.abort(); await assert.rejects(reading); await assert.rejects(f.source.send(f.request), outcome('unavailable'));
  assert.equal(f.proofs.length, 0); assert.equal(f.calls.length, 0); late.resolve({ status: 200, body: '{}' }); await new Promise((r) => setImmediate(r));
  await f.source.send(f.request); f.source.dispose();
  for (const code of ['mobile_transport_invalid', 'mobile_transport_busy']) { const next = await fixture(); next.native.newRequestId = () => { throw { code }; };
    await assert.rejects(next.source.send(next.request), outcome('unavailable')); assert.equal(next.calls.length, 0); next.source.dispose(); }
});
