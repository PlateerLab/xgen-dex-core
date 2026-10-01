import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import test from 'node:test';
import { AgentTurnComposeFailure, type AgentTurnComposeRequest } from '@dex/protocol/agent-turn-composer';
import { createMobileAgentFetch } from '../src/lib/native-agent-http';
import { createMobileAgentMutationSource } from '../src/lib/native-agent-mutation';
import { createMobileAgentMutationFetch } from '../src/lib/native-agent-mutation-http';
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
  const calls: { path: string; token: string; dpop: string; body: string }[] = []; const proofs: string[] = []; const cancelled: string[] = [];
  let handler = async (_body: string): Promise<unknown> => ({ status: 202, body: JSON.stringify({ turn_id: turnId, status: 'accepted', accepted_sequence: 1, state_version: 5, replayed: false }) });
  const native = { newRequestId: randomUUID, newTurnKey: randomUUID, prepare: async () => metadata,
    signChallenge: async () => assert.fail('No enrollment/refresh proof during a turn'),
    signDpop: async (_o: string, _u: string, _i: string, _t: string, method: string, htu: string, token: string) => {
      const proof = jwt({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicKey }, { jti: randomUUID(), htm: method, htu,
        iat: Math.floor(Date.now() / 1000), ath: createHash('sha256').update(token).digest('base64url') }); proofs.push(proof); return proof;
    },
    turnRequest: async (_id: string, o: string, path: string, token: string, dpop: string, body: string) => {
      assert.equal(o, origin); calls.push({ path, token, dpop, body }); return handler(body);
    }, cancelRequest: (id: string) => { cancelled.push(id); },
  };
  const current = () => account; const keys = createMobileDeviceKeys(native, current); const identity = await keys.identity();
  const source = createMobileAgentMutationSource({ current, keys, vault, fetch: createMobileAgentMutationFetch(native, origin), timeoutMs });
  const request: AgentTurnComposeRequest = { operation: 'submit', agent_session_id: sid,
    scope: { platform_type: 'mobile', profile: mobileAgentScope(initial, identity, record), server_url: origin, user_id: initial.userId },
    input: { input_text: '  keep\n끝\n', expected_state_version: 4, idempotency_key: 'one-logical-write' } };
  return { source, request, calls, proofs, cancelled, values, record, vaultKey, native, initial, pair,
    handle(next: typeof handler) { handler = next; }, change(next: typeof account) { account = next; } };
}
const outcome = (expected: string) => (e: unknown) => e instanceof AgentTurnComposeFailure && e.outcome === expected && !e.message.includes('private');
test('production scoped writer acquires vault token and signs exact POST/ath/ES256; input copied before key await', async () => {
  const f = await fixture(); const original = structuredClone(f.request); const sending = f.source.send(f.request);
  f.request.input.expected_state_version = 99; if (f.request.operation === 'submit') f.request.input.input_text = 'changed';
  const value = await sending as Record<string, unknown>;
  assert.deepEqual(value, { ...original.scope, agent_session_id: sid, mutation: { turn_id: turnId, status: 'accepted', accepted_sequence: 1, state_version: 5, replayed: false } });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, JSON.stringify(original.input)); assert.equal(f.calls[0].token, f.record.accessToken);
  const parts = f.calls[0].dpop.split('.'); const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.equal(claims.htm, 'POST'); assert.equal(claims.htu, `${origin}/api/agentflow/agent-sessions/${sid}/turns`);
  assert.equal(claims.ath, createHash('sha256').update(f.record.accessToken!).digest('base64url'));
  assert(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: f.pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')));
  assert.equal(JSON.stringify(value).includes(f.record.accessToken!), false); f.source.dispose();
});
test('missing/expired/journal/corrupt/foreign scope/key states fail before POST with no refresh or legacy fallback', async () => {
  for (const state of ['missing', 'expired', 'journal', 'corrupt', 'scope', 'key', 'account']) {
    const f = await fixture();
    if (state === 'missing') f.values.clear();
    if (state === 'expired') f.values.set(f.vaultKey, JSON.stringify({ ...f.record, accessExpiresAt: new Date(0).toISOString() }));
    if (state === 'journal') f.values.set(`${f.vaultKey}-journal`, JSON.stringify({ ...f.record, phase: 'refreshing', refreshToken: null, accessToken: null, accessExpiresAt: null }));
    if (state === 'corrupt') f.values.set(f.vaultKey, 'private-corruption');
    if (state === 'scope') f.request.scope.profile = 'other-platform-session';
    if (state === 'key') f.native.prepare = async () => { throw { code: 'mobile_key_locked', message: 'private-key' }; };
    if (state === 'account') f.change({ ...f.initial, authScope: randomUUID() });
    await assert.rejects(f.source.send(f.request), outcome('unavailable')); assert.equal(f.calls.length, 0); assert.equal(f.proofs.length, 0); f.source.dispose();
  }
});
test('lost/invalid/timeout ACK is unknown, never replayed; native settling blocks fresh owners before signing', async () => {
  for (const mode of ['lost', 'invalid', 'cancel']) {
    const f = await fixture(100); const late = deferred<unknown>(); const entered = deferred<void>(); const control = new AbortController();
    f.handle(async () => { entered.resolve(); if (mode === 'lost') throw new Error('private-loss'); if (mode === 'invalid') return { status: 202, body: '{"private":true}' }; return late.promise; });
    const sending = f.source.send(f.request, control.signal); await entered.promise; if (mode === 'cancel') control.abort();
    await assert.rejects(sending, outcome('unknown')); assert.equal(f.calls.length, 1);
    if (mode === 'cancel') {
      await assert.rejects(f.source.send(f.request), outcome('unavailable')); assert.equal(f.proofs.length, 1); assert.equal(f.cancelled.length, 1);
      late.resolve({ status: 202, body: '{}' }); await new Promise((r) => setImmediate(r));
    }
    f.source.dispose();
  }
  const f = await fixture(100); const late = deferred<unknown>(); f.handle(async () => late.promise);
  await assert.rejects(f.source.send(f.request), outcome('unknown')); assert.equal(f.calls.length, 1); late.resolve({ status: 202, body: '{}' }); f.source.dispose();
});
test('safe rejection/409 metadata and exact latest stop preserve request CAS, no body or token errors', async () => {
  const f = await fixture(); f.handle(async () => ({ status: 409, body: JSON.stringify({ detail: { code: 'STATE_VERSION_CONFLICT', current_state_version: 6, private: 'secret' } }) }));
  await assert.rejects(f.source.send(f.request), (e: unknown) => e instanceof AgentTurnComposeFailure && e.outcome === 'rejected'
    && JSON.stringify(e.conflict) === '{"code":"STATE_VERSION_CONFLICT","current_state_version":6}');
  const stop: AgentTurnComposeRequest = { ...f.request, operation: 'stop', input: { turn_id: turnId, expected_state_version: 6 } };
  f.handle(async () => ({ status: 202, body: JSON.stringify({ turn_id: turnId, state_version: 6, requested: true }) }));
  await f.source.send(stop); assert(f.calls[1].path.endsWith('/stop')); assert.deepEqual(JSON.parse(f.calls[1].body), stop.input); f.source.dispose();
});
test('account change after dispatch discards even valid late ACK as unknown; predispatch cancel has no wire', async () => {
  const f = await fixture(); const entered = deferred<void>(); const late = deferred<unknown>();
  f.handle(async () => { entered.resolve(); return late.promise; }); const sending = f.source.send(f.request); await entered.promise;
  f.change({ ...f.initial, origin: 'https://other.test' }); late.resolve({ status: 202, body: JSON.stringify({ turn_id: turnId, status: 'accepted', accepted_sequence: 1, state_version: 5, replayed: false }) });
  await assert.rejects(sending, outcome('unknown')); assert.equal(f.calls.length, 1); f.source.dispose();
  const fresh = await fixture(); const control = new AbortController(); control.abort();
  await assert.rejects(fresh.source.send(fresh.request, control.signal), outcome('unavailable')); assert.equal(fresh.calls.length, 0); fresh.source.dispose();
});
test('known native reservation failures are unavailable before wire; cancelled GET blocks POST before key/proof until native settles', async () => {
  for (const code of ['mobile_transport_busy', 'mobile_transport_invalid']) {
    const f = await fixture(); f.native.newRequestId = () => { throw { code }; };
    await assert.rejects(f.source.send(f.request), outcome('unavailable')); assert.equal(f.calls.length, 0); f.source.dispose();
  }
  const f = await fixture(); const late = deferred<unknown>();
  const module = Object.assign(f.native, { readRequest: async () => late.promise });
  const readFetch = createMobileAgentFetch(module, origin); const control = new AbortController();
  const reading = readFetch(`${origin}/api/agentflow/me/agent-state`, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', Authorization: 'DPoP access.jwt.signature', DPoP: 'proof.jwt.signature' }, signal: control.signal });
  control.abort(); await assert.rejects(reading);
  await assert.rejects(f.source.send(f.request), outcome('unavailable')); assert.equal(f.proofs.length, 0); assert.equal(f.calls.length, 0);
  late.resolve({ status: 200, body: '{}' }); await new Promise((r) => setImmediate(r));
  await f.source.send(f.request); assert.equal(f.calls.length, 1); f.source.dispose();
});
