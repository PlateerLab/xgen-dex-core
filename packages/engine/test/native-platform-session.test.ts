import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { NativeDeviceKeyStore } from '../src/native-device-key-store';
import { NativeCliSession, NativeHostSession } from '../src/native-platform-session';
import { nativeKeyThumbprint } from '../src/native-dpop';
import type { NativeSessionRecord } from '../src/native-session-record';
import { AgentSessionHttpError, type AgentSessionProofSource } from '@dex/protocol/agent-session';
import { NativeAgentFocusWatcher } from '../src/native-agent-focus-watch';
import { NativeAgentConversationWatcher } from '../src/native-agent-conversation-watch';
import { nativeConversationFetch } from '../src/native-agent-conversation-http';
import type { NativeDeviceIdentity } from '@dex/protocol/native-platform-session';
import { DexError } from '../src/errors';
import type { NativeAgentSocket, NativeAgentSocketTransport } from '../src/native-agent-socket';

const ORIGIN = 'https://app.example.test';
const DEVICE = '018f1240-0000-7000-8000-000000000001';
const SID = '018f1240-0000-7000-8000-000000000002';
const FLOW = '018f1240-0000-7000-8000-000000000003';
const EVENT = '018f1240-0000-7000-8000-000000000004';
const TURN1 = '018f1240-0000-7000-8000-000000000005';
const TURN2 = '018f1240-0000-7000-8000-000000000006';
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
  const calls: Array<{ url: URL; path: string; init: RequestInit; body: any }> = [];
  let custom: ((path: string, init: RequestInit) => Response | Promise<Response> | undefined) | undefined;
  const fetchImpl = (async (input, init: RequestInit = {}) => {
    const url = new URL(String(input)); const path = url.pathname; calls.push({ url, path, init, body: JSON.parse(String(init.body ?? '{}')) });
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
  const client = (socketTransport?: NativeAgentSocketTransport) => platform === 'cli'
    ? new NativeCliSession(ORIGIN, keys(), fetchImpl, socketTransport)
    : new NativeHostSession(ORIGIN, platform, keys(), fetchImpl, undefined, socketTransport);
  return { directory, records, phases, keychain, keys, client, stored, access, calls, identity,
    custom: (value: typeof custom) => { custom = value; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function serveConversation(f: Awaited<ReturnType<typeof fixture>>, title = 'live') {
  f.custom((path) => {
    if (path === '/api/agentflow/me/agent-state') return Response.json({ active_agent_session_id: SID, version: 1, event_id: EVENT });
    if (path.endsWith('/agent-events')) return Response.json({ events: [], next_cursor: 1, snapshot_version: 1, has_more: false });
    if (path.endsWith('/events')) return Response.json({ events: [], next_cursor: 2, snapshot_sequence: 2, state_version: 1, has_more: false });
    if (path.endsWith('/snapshot')) return Response.json({ id: SID, workflow_id: FLOW, title, current_sequence: 2,
      state_version: 1, message_history_complete: true });
    if (path.endsWith('/messages')) {
      const after = Number(f.calls.at(-1)!.url.searchParams.get('after_sequence'));
      return Response.json({ messages: [], next_cursor: after, snapshot_sequence: 2, state_version: 1, has_more: false });
    }
    return undefined;
  });
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
    await assert.rejects(session.conversation('7'), DexError);
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
    await assert.rejects(f.client().reconcileConversation('7', null), unavailable);
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
    await assert.rejects(f.client().conversation('7'), unavailable);
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
    await assert.rejects(f.client().focus('7'), unavailable); await assert.rejects(f.client().conversation('7'), unavailable);
    assert.equal(f.calls.length, count);
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

test('conversation watch releases the vault lock between bounded reads and cannot continue after logout', async () => {
  const f = await fixture(); let waits = 0; const updates: string[] = [];
  try {
    await f.client().login('a', 'p');
    f.custom((path) => path.endsWith('/agent-events')
      ? Response.json({ events: [], next_cursor: 0, snapshot_version: 0, has_more: false }) : undefined);
    const watcher = new NativeAgentConversationWatcher(f.client(), '7', { wait: async () => {
      waits++; if (waits === 1) await f.client().refresh('7'); else await f.client().logout('7', 'p');
    } });
    await assert.rejects(watcher.run((update) => updates.push(update.type)), unavailable);
    assert.deepEqual(updates, ['reset', 'conversation', 'stopped']);
    assert.equal(waits, 2); assert.equal(f.stored(), null);
    assert.equal(f.calls.filter(({ path }) => path === '/api/agentflow/me/agent-state').length, 1);
    assert.equal(f.calls.filter(({ path }) => path === '/api/agentflow/me/agent-events').length, 1);
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

test('native conversation reads exact Canonical routes with query-free P-256 DPoP and projects display data only', async () => {
  const f = await fixture('desktop');
  try {
    await f.client().login('a', 'p');
    const messages = [
      { turn_id: TURN1, sequence: 2, status: 'completed', input_text: 'question', output_text: 'answer', content_complete: true, source: 'user' },
      { turn_id: TURN2, sequence: 5, status: 'failed', input_text: null, output_text: 'failure', content_complete: false, source: 'unknown' },
    ];
    const snapshot = { id: SID, workflow_id: FLOW, title: 'Native conversation', current_sequence: 5,
      state_version: 2, message_history_complete: false, latest_turn: { id: TURN2, status: 'failed', accepted_sequence: 4 } };
    f.custom((path) => {
      if (path === '/api/agentflow/me/agent-state') return Response.json({ active_agent_session_id: SID, version: 1, event_id: EVENT });
      if (path.endsWith('/snapshot')) return Response.json(snapshot);
      if (path.endsWith('/messages')) {
        const after = Number(f.calls.at(-1)!.url.searchParams.get('after_sequence'));
        const message = messages.find((value) => value.sequence > after);
        return Response.json({ messages: message ? [{ ...message, execution_io: 'private', tools: ['private'] }] : [],
          next_cursor: message?.sequence ?? after, snapshot_sequence: 5, state_version: 2,
          has_more: Boolean(message && message.sequence < 5) });
      }
      return undefined;
    });
    const result = await f.client().reconcileConversation('7', null);
    assert.equal(result.source, 'snapshot'); assert.equal(result.hasMore, false);
    assert.deepEqual(result.state.messages, messages);
    assert.equal(JSON.stringify(result.state).includes('private'), false);

    const reads = f.calls.filter(({ path }) => path.startsWith('/api/agentflow/'));
    assert.deepEqual(reads.map(({ url }) => `${url.pathname}${url.search}`), [
      '/api/agentflow/me/agent-state',
      `/api/agentflow/agent-sessions/${SID}/snapshot`,
      `/api/agentflow/agent-sessions/${SID}/messages?after_sequence=0&limit=1`,
      `/api/agentflow/agent-sessions/${SID}/messages?after_sequence=2&limit=1`,
      `/api/agentflow/agent-sessions/${SID}/snapshot`,
      '/api/agentflow/me/agent-state',
    ]);
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;
    const key = await subtle.importKey('jwk', f.identity.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    for (const { url, init } of reads) {
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      const headers = init.headers as Record<string, string>; const token = f.stored()!.accessToken!;
      assert.equal(headers.Authorization, `DPoP ${token}`);
      const [head, payload, signature] = headers.DPoP.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, string>;
      assert.equal(claims.htm, 'GET'); assert.equal(claims.htu, `${ORIGIN}${url.pathname}`);
      assert.equal(claims.ath, createHash('sha256').update(token).digest('base64url'));
      assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
        Buffer.from(signature, 'base64url'), Buffer.from(`${head}.${payload}`)), true);
    }
    const current = await f.client().conversation('7');
    assert.deepEqual(Object.keys(current).sort(), ['conversation', 'has_more']);
    assert.deepEqual(Object.keys(current.conversation).sort(), ['messages', 'omittedMessages', 'snapshot']);
    assert.equal(JSON.stringify(current).includes('authScope'), false);
    assert.equal(JSON.stringify(current).includes('eventCursor'), false);
    assert.equal(JSON.stringify(current).includes(f.stored()!.accessToken!), false);
  } finally { await f.cleanup(); }
});

test('conversation keeps its independent cursor across token rotation and resets it for a different sid', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    let active = SID; const seen: number[] = [];
    f.custom((path) => {
      if (path === '/api/agentflow/me/agent-state') return Response.json({ active_agent_session_id: active, version: active === SID ? 1 : 2, event_id: EVENT });
      if (path.endsWith('/agent-events')) return Response.json({ events: [], next_cursor: 1, snapshot_version: 1, has_more: false });
      if (path.endsWith('/events')) return Response.json({ events: [], next_cursor: 2, snapshot_sequence: 2, state_version: 1, has_more: false });
      if (path.endsWith('/snapshot')) return Response.json({ id: active, workflow_id: FLOW, title: active,
        current_sequence: 2, state_version: 1, message_history_complete: false });
      if (path.endsWith('/messages')) {
        const after = Number(f.calls.at(-1)!.url.searchParams.get('after_sequence')); seen.push(after);
        return Response.json({ messages: after === 0 ? [{ turn_id: active === SID ? TURN1 : TURN2, sequence: 2,
          status: 'completed', input_text: 'in', output_text: active, content_complete: true, source: 'user' }] : [],
        next_cursor: after === 0 ? 2 : after, snapshot_sequence: 2, state_version: 1, has_more: false });
      }
      return undefined;
    });
    const first = await f.client().reconcileConversation('7', null);
    await f.client().refresh('7');
    const rotated = await f.client().reconcileConversation('7', first.state);
    assert.equal(rotated.state.authScope, first.state.authScope);
    assert.equal(rotated.state.messageCursor, 2); assert.deepEqual(seen, [0, 2]);

    await f.keys().withSession(scope, async (_identity, _sign, vault) => {
      const old = (await vault.read())!; const access = f.access({ sid: FLOW });
      await vault.write({ ...old, sessionId: FLOW, accessToken: access.access_token, accessExpiresAt: access.access_expires_at });
    });
    active = FLOW;
    const moved = await f.client().reconcileConversation('7', rotated.state);
    assert.notEqual(moved.state.authScope, first.state.authScope);
    assert.equal(moved.state.snapshot?.id, FLOW); assert.equal(moved.state.messages[0]?.turn_id, TURN2);
    assert.deepEqual(seen, [0, 2, 0]);
  } finally { await f.cleanup(); }
});

test('native conversation socket uses scoped query-free P-256 proof, releases the vault lock and retains the same-sid cursor across rotation', async () => {
  const f = await fixture('desktop');
  const opened: Array<{ sid: string; after: number; token: string; proof: string; signal: AbortSignal }> = [];
  const sockets: Array<NativeAgentSocket & { closeCalls: number }> = [];
  let assertions = 0;
  const transport: NativeAgentSocketTransport = {
    assertAvailable: () => { assertions++; },
    open: async (sid, after, token, proof, signal) => {
      opened.push({ sid, after, token, proof, signal });
      let closed = false;
      const socket: NativeAgentSocket & { closeCalls: number } = {
        get closed() { return closed; }, closeCalls: 0,
        next: async () => new Promise<unknown>(() => {}),
        async close() { this.closeCalls++; closed = true; },
      };
      sockets.push(socket); return socket;
    },
  };
  try {
    const session = f.client(transport);
    await session.login('a', 'p');
    serveConversation(f);
    const first = await session.reconcileConversation('7', null);
    const socket = await session.openConversationSocket('7', first.state, new AbortController().signal);
    assert.equal(socket.closed, false); assert.equal(assertions, 1);
    assert.equal(opened[0]!.sid, SID); assert.equal(opened[0]!.after, 2); assert.equal(opened[0]!.signal.aborted, false);
    assert.equal(opened[0]!.token, f.stored()!.accessToken);
    const [head, payload, signature] = opened[0]!.proof.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, string>;
    assert.equal(claims.htm, 'GET');
    assert.equal(claims.htu, `${ORIGIN}/api/agentflow/agent-sessions/${SID}/events`);
    assert.equal(new URL(claims.htu).search, '');
    assert.equal(claims.ath, createHash('sha256').update(opened[0]!.token).digest('base64url'));
    const key = await (webcrypto.subtle as unknown as SubtleCrypto).importKey(
      'jwk', f.identity.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await (webcrypto.subtle as unknown as SubtleCrypto).verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
      Buffer.from(signature, 'base64url'), Buffer.from(`${head}.${payload}`)), true);

    // An open socket holds no vault lock; explicit rotation closes its old generation without resetting the sid cursor.
    await session.refresh('7');
    assert.equal(sockets[0]!.closeCalls, 1);
    const rotated = await session.reconcileConversation('7', first.state);
    assert.equal(sockets[0]!.closeCalls, 1); assert.equal(sockets[0]!.closed, true);
    assert.equal(rotated.state.authScope, first.state.authScope);
    assert.equal(rotated.state.eventCursor?.sequence, 2);
    const rotatedSocket = await session.openConversationSocket('7', rotated.state, new AbortController().signal);
    assert.equal(opened[1]!.after, 2); assert.equal(opened[1]!.token, f.stored()!.accessToken);
    await rotatedSocket.close();
  } finally { await f.cleanup(); }
});

test('logout and local forgetting close an active conversation socket before the session mutation completes', async () => {
  for (const operation of ['logout', 'forgetLocal'] as const) {
    const f = await fixture(); let closeCalls = 0; let closed = false;
    let release!: () => void; const closeGate = new Promise<void>((resolve) => { release = resolve; });
    let closing!: () => void; const closeStarted = new Promise<void>((resolve) => { closing = resolve; });
    const transport: NativeAgentSocketTransport = {
      assertAvailable: () => {},
      open: async () => ({
        get closed() { return closed; },
        next: async () => new Promise<unknown>(() => {}),
        close: async () => { closeCalls++; closing(); await closeGate; closed = true; },
      }),
    };
    try {
      const session = f.client(transport); await session.login('a', 'p'); serveConversation(f, operation);
      const state = await session.reconcileConversation('7', null);
      await session.openConversationSocket('7', state.state, new AbortController().signal);
      const changing = operation === 'logout' ? session.logout('7', 'p') : session.forgetLocal('7');
      await closeStarted;
      assert.equal(closeCalls, 1, operation);
      release();
      assert.equal((await changing).state, 'signed_out'); assert.equal(closed, true); assert.equal(closeCalls, 1);
    } finally { release(); await f.cleanup(); }
  }
});

test('socket binding rejects foreign internal state, account, expiry and token-free journals before transport use', async () => {
  const f = await fixture(); let assertions = 0; let opens = 0;
  const transport: NativeAgentSocketTransport = {
    assertAvailable: () => { assertions++; },
    open: async () => { opens++; throw new Error('must not reach native transport'); },
  };
  const failures: unknown[] = [];
  try {
    const session = f.client(transport); await session.login('a', 'p');
    const record = f.stored()!;
    const authScope = createHash('sha256').update(JSON.stringify([record.origin, record.platform, record.userId,
      record.installId, record.deviceId, record.sessionId])).digest('hex');
    const valid = {
      authScope, focus: { active_agent_session_id: SID, version: 1, event_id: EVENT },
      snapshot: { id: SID, workflow_id: FLOW, title: 'internal', current_sequence: 2,
        state_version: 1, message_history_complete: true },
      eventCursor: { sequence: 2, stateVersion: 1, eventId: EVENT }, messageCursor: 0, messages: [], omittedMessages: 0,
    };
    const invalid = [
      { ...valid, authScope: 'foreign-private-scope' },
      { ...valid, snapshot: null, eventCursor: null },
      { ...valid, focus: { ...valid.focus, active_agent_session_id: FLOW } },
      { ...valid, eventCursor: { ...valid.eventCursor, sequence: 3 } },
    ];
    for (const state of invalid) {
      try { await session.openConversationSocket('7', state, new AbortController().signal); }
      catch (error) { failures.push(error); }
    }
    const wrongAccount = new NativeHostSession(ORIGIN, 'cli', f.keys(), (async () => assert.fail()) as typeof fetch, '8', transport);
    try { await wrongAccount.openConversationSocket('7', valid, new AbortController().signal); }
    catch (error) { failures.push(error); }

    await f.keys().withSession(scope, async (_identity, _sign, vault) => {
      const current = (await vault.read())!;
      const expired = f.access({ exp: Math.floor(Date.now() / 1000) - 5 });
      await vault.write({ ...current, accessToken: expired.access_token, accessExpiresAt: expired.access_expires_at });
    });
    try { await session.openConversationSocket('7', valid, new AbortController().signal); }
    catch (error) { failures.push(error); }
    await f.keys().withSession(scope, async (_identity, _sign, vault) => {
      await vault.write({ ...record, phase: 'refreshing',
        refreshToken: null, accessToken: null, accessExpiresAt: null });
    });
    try { await session.openConversationSocket('7', valid, new AbortController().signal); }
    catch (error) { failures.push(error); }

    assert.equal(failures.length, invalid.length + 3);
    for (const error of failures) assert.equal(error instanceof DexError && error.code === 'auth_required', true);
    assert.equal(assertions, 0); assert.equal(opens, 0);
    const exposed = JSON.stringify(failures.map((error) => error instanceof Error ? error.message : error));
    assert.equal(exposed.includes(record.accessToken!), false); assert.equal(exposed.includes(record.refreshToken!), false);
  } finally { await f.cleanup(); }
});

test('native conversation rejects malformed, invalid UTF-8 and oversized response bodies without replay fallback', async () => {
  const cases: Array<{ name: string; response: () => Response }> = [
    { name: 'malformed JSON', response: () => new Response('{') },
    { name: 'invalid UTF-8', response: () => new Response(Uint8Array.from([0xc3, 0x28])) },
    { name: 'oversized metadata', response: () => new Response('x'.repeat(64 * 1024 + 1)) },
  ];
  for (const item of cases) {
    const f = await fixture();
    try {
      await f.client().login('a', 'p'); let attempts = 0;
      f.custom((path) => path === '/api/agentflow/me/agent-state' ? (attempts++, item.response()) : undefined);
      await assert.rejects(f.client().reconcileConversation('7', null), (error: unknown) =>
        error instanceof DexError && error.code === 'protocol_mismatch' && !error.message.includes('private'));
      assert.equal(attempts, 1, item.name);
    } finally { await f.cleanup(); }
  }

  const f = await fixture();
  try {
    await f.client().login('a', 'p'); let messages = 0; let snapshots = 0;
    f.custom((path) => {
      if (path === '/api/agentflow/me/agent-state') return Response.json({ active_agent_session_id: SID, version: 1, event_id: EVENT });
      if (path.endsWith('/snapshot')) { snapshots++; return Response.json({ id: SID, workflow_id: FLOW, title: 'x', current_sequence: 1,
        state_version: 1, message_history_complete: false }); }
      if (path.endsWith('/messages')) { messages++; return new Response('x'.repeat(1024 * 1024 + 1)); }
      return undefined;
    });
    await assert.rejects(f.client().reconcileConversation('7', null), (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch');
    assert.equal(messages, 1); assert.equal(snapshots, 1);
  } finally { await f.cleanup(); }
});

test('conversation preserves HTTP classification and aborts late response bodies without publishing partial state', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p');
    for (const status of [401, 403, 408, 429, 500]) {
      f.custom((path) => path === '/api/agentflow/me/agent-state' ? new Response('private', { status }) : undefined);
      await assert.rejects(f.client().reconcileConversation('7', null),
        (error: unknown) => error instanceof AgentSessionHttpError && error.status === status);
    }
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const late = new Promise<void>((resolve) => { release = resolve; });
    f.custom((path) => path === '/api/agentflow/me/agent-state' ? new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        started(); await late;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ active_agent_session_id: null, version: 0, event_id: null })));
        controller.close();
      },
    })) : undefined);
    const control = new AbortController(); const reading = f.client().reconcileConversation('7', null, control.signal);
    await entered; control.abort(); release();
    await assert.rejects(reading, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  } finally { await f.cleanup(); }
});

test('native conversation transport cancels an unread body when credentials fail after headers or at JSON entry', async () => {
  for (const failAt of [2, 3]) {
    let checks = 0; let cancellations = 0;
    const failure = new DexError('auth_required', `expired-${failAt}`);
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancellations++; } }));
    const transport = nativeConversationFetch(ORIGIN, (async () => response) as typeof fetch, async () => {
      if (++checks === failAt) throw failure;
    });
    const request = transport(`${ORIGIN}/api/agentflow/me/agent-state`, { method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'DPoP a.b.c', DPoP: 'd.e.f' },
      credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (failAt === 2) await assert.rejects(request, (error: unknown) => error === failure);
    else {
      const guarded = await request;
      await assert.rejects(guarded.json(), (error: unknown) => error === failure);
    }
    await Promise.resolve();
    assert.equal(checks, failAt); assert.equal(cancellations, 1);
  }
});

test('manual conversation read performs at most ten bounded steps and reports an incomplete backlog', async () => {
  const f = await fixture();
  try {
    await f.client().login('a', 'p'); let reads = 0;
    f.custom((path) => {
      if (path === '/api/agentflow/me/agent-state') return Response.json({ active_agent_session_id: SID, version: 1, event_id: EVENT });
      if (path.endsWith('/agent-events')) {
        const after = Number(f.calls.at(-1)!.url.searchParams.get('after_sequence'));
        return Response.json({ events: [], next_cursor: after, snapshot_version: after, has_more: false });
      }
      if (path.endsWith('/snapshot')) return Response.json({ id: SID, workflow_id: FLOW, title: 'bounded', current_sequence: 45,
        state_version: 1, message_history_complete: false });
      if (path.endsWith('/events')) return Response.json({ events: [], next_cursor: 45, snapshot_sequence: 45, state_version: 1, has_more: false });
      if (path.endsWith('/messages')) {
        const after = Number(f.calls.at(-1)!.url.searchParams.get('after_sequence')); reads++;
        const sequence = after + 2;
        return Response.json({ messages: [{ turn_id: `018f1240-0000-7000-8000-${String(sequence).padStart(12, '0')}`, sequence,
          status: 'completed', input_text: 'q', output_text: 'a', content_complete: true, source: 'user' }],
        next_cursor: sequence, snapshot_sequence: 45, state_version: 1, has_more: sequence < 45 });
      }
      return undefined;
    });
    const result = await f.client().conversation('7');
    assert.equal(reads, 20); assert.equal(result.has_more, true); assert.equal(result.conversation.messages.length, 20);
  } finally { await f.cleanup(); }
});
