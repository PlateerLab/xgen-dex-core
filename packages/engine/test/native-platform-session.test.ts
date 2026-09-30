import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { NativeDeviceKeyStore } from '../src/native-device-key-store';
import { NativeCliSession, NativeHostSession } from '../src/native-platform-session';
import { nativeKeyThumbprint } from '../src/native-dpop';
import type { NativeSessionRecord } from '../src/native-session-record';
import { AgentSessionHttpError, type AgentSessionProofSource } from '@dex/protocol/agent-session';
import { NativeAgentFocusWatcher } from '../src/native-agent-focus-watch';
import type { NativeDeviceIdentity } from '@dex/protocol/native-platform-session';
import { DexError } from '../src/errors';

const ORIGIN = 'https://app.example.test';
const DEVICE = '018f1240-0000-7000-8000-000000000001';
const SID = '018f1240-0000-7000-8000-000000000002';
const FLOW = '018f1240-0000-7000-8000-000000000003';
const CHALLENGE = Buffer.alloc(32, 5).toString('base64url');
const REFRESH1 = Buffer.alloc(32, 1).toString('base64url');
const REFRESH2 = Buffer.alloc(32, 2).toString('base64url');
const ACCOUNT = 'e30.e30.c2ln';
const scope = { origin: ORIGIN, platform: 'cli' as const, userId: '7' };
const unavailable = (e: unknown) => e instanceof DexError && ['auth_required', 'credential_store_unavailable'].includes(e.code);
async function fixture(platform: 'cli' | 'desktop' | 'vscode' = 'cli') {
  const accountScope = { ...scope, platform };
  const directory = await mkdtemp(join(tmpdir(), 'dex-native-session-'));
  const records = new Map<string, string>(); const phases: string[] = [];
  const keychain = { getPassword: async (service: string, name: string) => records.get(`${service}:${name}`) ?? null,
    setPassword: async (service: string, name: string, raw: string) => { records.set(`${service}:${name}`, raw); if (service.endsWith('session')) phases.push(JSON.parse(raw).phase); },
    deletePassword: async (service: string, name: string) => records.delete(`${service}:${name}`) };
  const options = { lockDirectory: directory, keychain: async () => keychain, env: {} };
  let identity!: NativeDeviceIdentity;
  await new NativeDeviceKeyStore(options).withIdentity(accountScope, true, async (value) => { identity = value; });
  const stored = () => {
    const raw = [...records].find(([key]) => key.startsWith('xgen-dex-native-session:'))?.[1];
    return raw ? JSON.parse(raw) as NativeSessionRecord : null;
  };
  const access = (changes: Record<string, unknown> = {}) => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const claims = { sub: '7', sid: SID, device_id: DEVICE, platform_type: platform, token_use: 'platform_access',
      cnf: { jkt: nativeKeyThumbprint(identity.publicKey) }, exp, ...changes };
    const input = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'platform-access+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return { token_type: 'DPoP', access_token: `${input}.${createHmac('sha256', 'fixture-only-signing-key').update(input).digest('base64url')}`,
      // Gateway DateTime contains fractional seconds while JWT exp has whole seconds.
      access_expires_at: new Date((claims.exp as number) * 1000 + 123).toISOString() };
  };
  const calls: Array<{ path: string; init: RequestInit; body: any }> = [];
  let custom: ((path: string, init: RequestInit) => Response | Promise<Response> | undefined) | undefined;
  const fetchImpl = (async (input, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname; calls.push({ path, init, body: JSON.parse(String(init.body ?? '{}')) });
    const response = await custom?.(path, init); if (response) return response;
    if (path === '/api/auth/login') return Response.json({ success: true, user_id: '7', access_token: ACCOUNT });
    if (path === '/api/auth/logout') return Response.json({ success: true });
    if (path.includes('/registration/status/')) return Response.json({ device_id: DEVICE, state: 'trusted' });
    if (path.endsWith('/begin')) {
      assert.equal(stored()?.phase, path.includes('/refresh/') ? 'refreshing' : 'login_pending');
      return Response.json({ flow_id: FLOW, device_id: DEVICE, challenge: CHALLENGE, expires_in_seconds: 300 });
    }
    if (path.includes('/login-key/complete')) return Response.json({ session_id: SID, state: 'active', refresh_token: REFRESH1, ...access() });
    if (path.includes('/refresh/complete')) return Response.json({ session_id: SID, refreshed: true, access_ready: true, refresh_token: REFRESH2, ...access() });
    if (path === '/api/agentflow/me/agent-state') return Response.json({ active_agent_session_id: null, version: 0, event_id: null });
    if (init.method === 'DELETE') { assert.equal(stored()?.phase, 'logout_pending'); return new Response(null, { status: 204 }); }
    assert.fail(`unexpected request: ${path}`);
  }) as typeof fetch;
  const keys = () => new NativeDeviceKeyStore(options);
  const client = () => platform === 'cli' ? new NativeCliSession(ORIGIN, keys(), fetchImpl) : new NativeHostSession(ORIGIN, platform, keys(), fetchImpl);
  return { directory, records, phases, keychain, keys, client, stored, access, calls, identity,
    custom: (value: typeof custom) => { custom = value; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('login stores only scoped native credentials; process restart restores the same sid and signs Canonical DPoP', async () => {
  const f = await fixture();
  try {
    const result = await f.client().login('account@example.test', 'private-password');
    assert.equal(result.state, 'active'); assert.equal(result.user_id, '7');
    assert.equal(JSON.stringify(result).includes('Token'), false);
    assert.deepEqual(f.phases, ['login_pending', 'ready']);
    assert.deepEqual(await f.client().status('7'), result);
    assert.equal(f.stored()?.refreshToken, REFRESH1); assert.equal(f.stored()?.installId, f.identity.installId);
    assert.equal(f.calls.at(-1)?.path, '/api/auth/logout');
    await f.client().focus('7');
    const read = f.calls.at(-1)!; const headers = read.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `DPoP ${f.stored()!.accessToken}`);
    const [h, p, s] = headers.DPoP.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.equal(claims.htm, 'GET'); assert.equal(claims.htu, `${ORIGIN}${read.path}`);
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;
    const key = await subtle.importKey('jwk', f.identity.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`)), true);
    assert.equal(read.init.credentials, 'omit'); assert.equal(read.init.redirect, 'error');
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.cleanup(); }
});

test('VSCode/Desktop hosts use platform-specific keys, registration routes and access bindings; CLI cannot borrow them', async () => {
  for (const platform of ['vscode', 'desktop'] as const) {
    const f = await fixture(platform);
    try {
      await f.client().login('a', 'p'); await f.client().reconcileFocus('7', null); await f.client().refresh('7');
      assert.equal(f.stored()!.platform, platform);
      assert.ok(f.calls.some((e) => e.path.includes(`/native/${platform}/registration/`)));
      for (const call of f.calls.filter((e) => e.path.includes('/platform-sessions/native/'))) assert.equal(call.body.device_id, DEVICE);
      const count = f.calls.length;
      await assert.rejects(new NativeCliSession(ORIGIN, f.keys(), (async () => assert.fail()) as typeof fetch).status('7'), DexError);
      assert.equal(f.calls.length, count);
      assert.equal((await f.client().logout('7', 'p')).state, 'signed_out');
    } finally { await f.cleanup(); }
  }
});

test('host-bound sessions reject other account credentials and local reads before key access', async () => {
  const f = await fixture('desktop');
  try {
    const session = new NativeHostSession(ORIGIN, 'desktop', f.keys(), (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/auth/login') return Response.json({ success: true, user_id: '7', access_token: ACCOUNT });
      assert.equal(path, '/api/auth/logout'); return Response.json({ success: true });
    }) as typeof fetch, '8');
    await assert.rejects(session.login('a', 'p'), DexError);
    await assert.rejects(session.status('7'), DexError);
    assert.equal(f.stored(), null);
  } finally { await f.cleanup(); }
});

test('refresh persists a token-free journal before requests and saves rotated credentials before future reads', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    await f.client().refresh('7');
    assert.deepEqual(f.phases, ['login_pending', 'ready', 'refreshing', 'ready']);
    assert.equal(f.stored()?.refreshToken, REFRESH2);
    const refresh = f.calls.filter(({ path }) => path.includes('/native/refresh/'));
    assert.equal(refresh.length, 2);
    for (const call of refresh) {
      assert.equal((call.init.headers as Record<string, string>).Authorization, undefined);
      assert.equal(call.body.refresh_token, REFRESH1); assert.equal(JSON.stringify(call.body).includes('password'), false);
    }
  } finally { await f.cleanup(); }
});

test('lost refresh completion blocks all old credentials after restart and never retries', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    f.custom((path) => { if (path.endsWith('/refresh/complete')) throw new Error('private-server-secret'); return undefined; });
    await assert.rejects(f.client().refresh('7'), (e: unknown) => e instanceof Error && !e.message.includes('private-server-secret'));
    assert.equal(f.stored()?.phase, 'refreshing'); assert.equal(f.stored()?.refreshToken, null); assert.equal(f.stored()?.accessToken, null);
    const count = f.calls.length;
    await assert.rejects(f.client().refresh('7'), unavailable); await assert.rejects(f.client().focus('7'), unavailable);
    assert.equal(f.calls.length, count); assert.equal((await f.client().status('7')).state, 'refreshing');
  } finally { await f.cleanup(); }
});

test('journal write failure prevents any rotation request; result storage failure never restores the old refresh', async () => {
  for (const phase of ['refreshing', 'ready']) {
    const f = await fixture();
    try {
      await f.client().login('a', 'p'); const count = f.calls.length; const save = f.keychain.setPassword;
      f.keychain.setPassword = async (service, name, raw) => {
        if (service.endsWith('session') && JSON.parse(raw).phase === phase) throw new Error('private-store-secret');
        return save(service, name, raw);
      };
      await assert.rejects(f.client().refresh('7'), unavailable);
      if (phase === 'refreshing') { assert.equal(f.calls.length, count); assert.equal(f.stored()?.refreshToken, REFRESH1); }
      else { assert.equal(f.stored()?.refreshToken, null); await assert.rejects(f.client().refresh('7'), unavailable); }
    } finally { await f.cleanup(); }
  }
});

test('wrong account, sid, device, platform, key binding or expiry in login access is never exposed', async () => {
  for (const changes of [{ sub: '8' }, { sid: FLOW }, { device_id: FLOW }, { platform_type: 'desktop' }, { cnf: { jkt: 'wrong' } }, { token_use: 'legacy' }, { expiry_mismatch: true }]) {
    const f = await fixture();
    try {
      f.custom((path) => {
        if (!path.endsWith('/login-key/complete')) return undefined;
        const access = f.access(changes);
        if ('expiry_mismatch' in changes) access.access_expires_at = new Date(Date.parse(access.access_expires_at) + 1000).toISOString();
        return Response.json({ session_id: SID, state: 'active', refresh_token: REFRESH1, ...access });
      });
      await assert.rejects(f.client().login('a', 'p'), unavailable);
      assert.equal(f.stored()?.phase, 'login_pending'); assert.equal(f.stored()?.accessToken, null);
      assert.equal(f.calls.at(-1)?.path, '/api/auth/logout');
    } finally { await f.cleanup(); }
  }
});

test('pending takeover stores no access or refresh credential and cannot refresh or read Canonical data', async () => {
  const f = await fixture();
  try {
    f.custom((path) => path.endsWith('/login-key/complete') ? Response.json({ session_id: SID, state: 'pending_takeover',
      refresh_token: null, access_token: null, access_expires_at: null, token_type: null }) : undefined);
    assert.equal((await f.client().login('a', 'p')).state, 'pending_takeover');
    assert.equal(f.stored()?.refreshToken, null);
    await assert.rejects(f.client().refresh('7'), unavailable); await assert.rejects(f.client().focus('7'), unavailable);
  } finally { await f.cleanup(); }
});

test('refresh-only issuance stays in keychain and cannot create an access provider until explicitly refreshed', async () => {
  const f = await fixture();
  try {
    f.custom((path) => path.endsWith('/login-key/complete') ? Response.json({ session_id: SID, state: 'active',
      refresh_token: REFRESH1, access_token: null, access_expires_at: null, token_type: null }) : undefined);
    assert.equal((await f.client().login('a', 'p')).state, 'access_unavailable');
    await assert.rejects(f.client().focus('7'), unavailable);
    assert.equal((await f.client().refresh('7')).state, 'active');
  } finally { await f.cleanup(); }
});

test('expired access does not silently refresh; account/origin switches cannot use another slot', async () => {
  const f = await fixture();
  try {
    f.custom((path) => path.endsWith('/login-key/complete') ? Response.json({ session_id: SID, state: 'active', refresh_token: REFRESH1,
      ...f.access({ exp: Math.floor(Date.now() / 1000) - 5 }) }) : undefined);
    assert.equal((await f.client().login('a', 'p')).state, 'access_expired'); const count = f.calls.length;
    await assert.rejects(f.client().focus('7'), unavailable); assert.equal(f.calls.length, count);
    await assert.rejects(f.client().status('8'), DexError);
    await assert.rejects(new NativeCliSession('https://other.test', f.keys(), (async () => assert.fail()) as typeof fetch).status('7'), DexError);
  } finally { await f.cleanup(); }
});

test('proof provider cannot escape the lock, use a different token/origin, or overlap with session rotation', async () => {
  const f = await fixture(); let escaped!: AgentSessionProofSource;
  try {
    await f.client().login('a', 'p');
    await f.client().withProofSource('7', async (proof) => {
      escaped = proof; const token = (await proof.accessToken())!;
      await assert.rejects(proof.signProof('GET', 'https://other.test/api/agentflow/me/agent-state', token), DexError);
      await assert.rejects(proof.signProof('GET', `${ORIGIN}/api/agentflow/me/agent-state`, ACCOUNT), DexError);
      await assert.rejects(proof.signProof('GET', `${ORIGIN}/api/auth/login`, token), DexError);
      await assert.rejects(f.client().refresh('7'), unavailable);
    });
    await assert.rejects(escaped.accessToken(), unavailable);
  } finally { await f.cleanup(); }
});

test('cancellation after server rotation leaves a non-reusable journal; pre-abort leaves ready credentials alone', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    const before = new AbortController(); before.abort(); await assert.rejects(f.client().refresh('7', before.signal));
    assert.equal(f.stored()?.phase, 'ready');
    const controller = new AbortController();
    f.custom((path) => {
      if (path.endsWith('/refresh/complete')) { controller.abort(); return Response.json({ session_id: SID, refreshed: true, access_ready: true, refresh_token: REFRESH2, ...f.access() }); }
    });
    await assert.rejects(f.client().refresh('7', controller.signal));
    assert.equal(f.stored()?.phase, 'refreshing'); assert.equal(f.stored()?.refreshToken, null);
  } finally { await f.cleanup(); }
});

test('logout sends current-device DELETE DPoP and password step-up, then deletes only session credentials', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    assert.equal((await f.client().logout('7', 'current-password')).state, 'signed_out');
    const call = f.calls.at(-1)!;
    assert.equal(call.path, `/api/me/platform-sessions/${SID}`); assert.equal(call.init.method, 'DELETE');
    assert.deepEqual(call.body, { password: 'current-password' });
    const headers = call.init.headers as Record<string, string>;
    assert.ok(headers.Authorization.startsWith('DPoP '));
    assert.equal(JSON.parse(Buffer.from(headers.DPoP.split('.')[1], 'base64url').toString()).htm, 'DELETE');
    assert.equal(f.stored(), null); assert.equal(f.records.size, 1);
    assert.equal((await f.client().status('7')).state, 'signed_out');
  } finally { await f.cleanup(); }
});

test('failed server logout preserves a token-free marker; explicit local forgetting makes no request', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p'); f.custom((_path, init) => init.method === 'DELETE' ? new Response('private-server-secret', { status: 503 }) : undefined);
    await assert.rejects(f.client().logout('7', 'p'));
    assert.equal(f.stored()?.phase, 'logout_pending'); assert.equal(f.stored()?.accessToken, null);
    const count = f.calls.length; await f.client().forgetLocal('7'); assert.equal(f.calls.length, count);
    assert.equal(f.stored(), null); assert.equal(f.records.size, 1);
  } finally { await f.cleanup(); }
});

test('corrupt or foreign keychain session records fail before network and are never overwritten automatically', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p'); const [slot, raw] = [...f.records].find(([key]) => key.startsWith('xgen-dex-native-session:'))!;
    const count = f.calls.length;
    for (const bad of ['private-store-secret', JSON.stringify({ ...JSON.parse(raw), userId: '8' }), JSON.stringify({ ...JSON.parse(raw), installId: FLOW })]) {
      f.records.set(slot, bad); await assert.rejects(f.client().refresh('7'), unavailable);
      assert.equal(f.records.get(slot), bad); assert.equal(f.calls.length, count);
    }
    await f.client().forgetLocal('7'); assert.equal(f.records.has(slot), false);
  } finally { await f.cleanup(); }
});

test('Canonical transport/body errors never expose server data or reuse a legacy credential', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    for (const broken of [() => { throw new Error(`private-server-secret ${ACCOUNT}`); }, () => new Response(`private-server-secret ${ACCOUNT}`)]) {
      f.custom((path) => path === '/api/agentflow/me/agent-state' ? broken() : undefined);
      await assert.rejects(f.client().focus('7'), (e: unknown) => e instanceof Error && !e.message.includes('private-server-secret') && !e.message.includes(ACCOUNT));
    }
    const requests = f.calls.filter(({ path }) => path === '/api/agentflow/me/agent-state');
    assert.equal(requests.length, 2);
    for (const { init } of requests) assert.equal((init.headers as Record<string, string>).Authorization?.startsWith('DPoP '), true);
  } finally { await f.cleanup(); }
});

test('bounded focus replay restores fresh credentials but preserves its cursor on rotation; a new sid snapshots', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    const initial = await f.client().reconcileFocus('7', null); assert.equal(initial.source, 'snapshot');
    assert.equal(initial.state.authScope.includes(f.stored()!.accessToken!), false);
    await f.client().refresh('7');
    f.custom((path) => path.endsWith('/agent-events') ? Response.json({ events: [], next_cursor: 0, snapshot_version: 0, has_more: false }) : undefined);
    const replay = await f.client().reconcileFocus('7', initial.state);
    assert.equal(replay.source, 'replay'); assert.equal(replay.state.authScope, initial.state.authScope);
    assert.equal((f.calls.at(-1)!.init.headers as Record<string, string>).Authorization, `DPoP ${f.stored()!.accessToken}`);
    await f.keys().withSession(scope, async (_identity, _sign, vault) => {
      const old = (await vault.read())!; const access = f.access({ sid: FLOW });
      await vault.write({ ...old, sessionId: FLOW, accessToken: access.access_token, accessExpiresAt: access.access_expires_at });
    });
    const changed = await f.client().reconcileFocus('7', replay.state);
    assert.equal(changed.source, 'snapshot'); assert.notEqual(changed.state.authScope, initial.state.authScope);
    assert.equal(f.calls.at(-1)!.path, '/api/agentflow/me/agent-state');
  } finally { await f.cleanup(); }
});

test('409, invalid replay JSON and event gaps recover through authenticated snapshot; invalid snapshot fails safely', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p'); const initial = await f.client().reconcileFocus('7', null);
    for (const broken of [new Response('private-server-secret', { status: 409 }), new Response('private-server-secret'),
      Response.json({ events: [], next_cursor: 2, snapshot_version: 2, has_more: false })]) {
      f.custom((path) => path.endsWith('/agent-events') ? broken : undefined);
      assert.equal((await f.client().reconcileFocus('7', initial.state)).source, 'recovered');
      assert.equal(f.calls.at(-1)!.path, '/api/agentflow/me/agent-state');
    }
    f.custom(() => new Response('private-server-secret'));
    await assert.rejects(f.client().reconcileFocus('7', initial.state), (e: unknown) => e instanceof DexError && e.code === 'protocol_mismatch' && !e.message.includes('private-server-secret'));
  } finally { await f.cleanup(); }
});

test('watch delay releases keychain lock for another process refresh and logout; no credential fallback after deletion', async () => {
  const f = await fixture(); let waits = 0; const sources: string[] = [];
  try {
    await f.client().login('a', 'p');
    f.custom((path) => path.endsWith('/agent-events') ? Response.json({ events: [], next_cursor: 0, snapshot_version: 0, has_more: false }) : undefined);
    const watcher = new NativeAgentFocusWatcher(f.client(), '7', { wait: async () => {
      waits++; if (waits === 1) await f.client().refresh('7'); else await f.client().logout('7', 'p');
    } });
    await assert.rejects(watcher.run((e) => { if (e.type === 'focus') sources.push(e.source); }), unavailable);
    assert.deepEqual(sources, ['snapshot']); assert.equal(waits, 2); assert.equal(f.stored(), null);
    assert.equal(f.calls.filter((e) => e.path.endsWith('/agent-state')).length, 1);
    assert.equal(f.calls.filter((e) => e.path.endsWith('/agent-events')).length, 1);
    const count = f.calls.length; await assert.rejects(f.client().reconcileFocus('7', null), unavailable); assert.equal(f.calls.length, count);
  } finally { await f.cleanup(); }
});

test('focus reconciliation preserves HTTP permission errors for fatal watcher handling', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    for (const status of [401, 403]) {
      f.custom(() => new Response('private-server-secret', { status }));
      await assert.rejects(f.client().reconcileFocus('7', null), (e: unknown) => e instanceof AgentSessionHttpError && e.status === status);
    }
  } finally { await f.cleanup(); }
});
