import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DexEngine, MemoryConfigStore, MemoryCredentialStore, NativeDeviceKeyStore, NativeCliSession, defaultConfig } from '@dex/engine';
import { DexRpcServer } from '@dex/rpc/server';
import { nativeKeyThumbprint } from '@dex/engine/native-dpop';

const origin = 'https://app.example.test'; const user = '7';
const device = '018f1240-0000-7000-8000-000000000001'; const sid = '018f1240-0000-7000-8000-000000000002';
const agentSid = '018f1240-0000-7000-8000-000000000003'; const turn = '018f1240-0000-7000-8000-000000000004';
const challenge = Buffer.alloc(32, 5).toString('base64url'); const account = 'e30.e30.c2ln';
async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dex-native-rpc-')); const values = new Map<string, string>();
  const keys = new NativeDeviceKeyStore({ lockDirectory: directory, env: {}, keychain: async () => ({
    getPassword: async (s, n) => values.get(`${s}:${n}`) ?? null, setPassword: async (s, n, v) => { values.set(`${s}:${n}`, v); }, deletePassword: async (s, n) => values.delete(`${s}:${n}`),
  }) });
  const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } } });
  let registered = false; let trusted = false; let publicKey: any; let refreshCount = 0; let socketFactories = 0;
  const calls: Array<{ path: string; init: RequestInit }> = []; const secrets = [account, 'private-password'];
  let custom: ((path: string, init: RequestInit) => Promise<Response> | Response | undefined) | undefined;
  const fetchImpl = (async (input, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname; calls.push({ path, init }); const response = await custom?.(path, init); if (response) return response;
    const body = JSON.parse(String(init.body ?? '{}'));
    if (path === '/api/auth/login') return Response.json({ success: true, user_id: user, access_token: account });
    if (path === '/api/auth/logout') return Response.json({ success: true });
    if (path.includes('/registration/status/')) { assert.ok(path.includes('/native/vscode/')); return Response.json(registered ? { device_id: device, state: trusted ? 'trusted' : 'pending' } : null); }
    if (path.endsWith('/registration/challenge')) { assert.ok(path.includes('/native/vscode/')); publicKey = body.public_key_jwk; return Response.json({ challenge, expires_in_seconds: 300 }); }
    if (path.endsWith('/registration/complete')) { registered = true; return Response.json({ device_id: device, state: 'pending' }); }
    if (path.endsWith('/begin')) return Response.json({ flow_id: sid, device_id: device, challenge, expires_in_seconds: 300 });
    if (path.endsWith('/complete')) {
      const refresh = Buffer.alloc(32, ++refreshCount).toString('base64url'); const exp = Math.floor(Date.now() / 1000) + 600;
      const access = `e30.${Buffer.from(JSON.stringify({ sub: user, sid, device_id: device, platform_type: 'vscode', token_use: 'platform_access', cnf: { jkt: nativeKeyThumbprint(publicKey) }, exp })).toString('base64url')}.c2ln`;
      secrets.push(refresh, access);
      return Response.json({ session_id: sid, ...(path.includes('/refresh/') ? { refreshed: true, access_ready: true } : { state: 'active' }),
        refresh_token: refresh, token_type: 'DPoP', access_token: access, access_expires_at: new Date(exp * 1000).toISOString() });
    }
    if (path.endsWith('/agent-state')) { assert.ok((init.headers as any).Authorization.startsWith('DPoP ')); return Response.json({ active_agent_session_id: null, version: 0, event_id: null }); }
    if (path.endsWith('/agent-events')) return Response.json({ events: [], next_cursor: 0, snapshot_version: 0, has_more: false });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    assert.fail('Unexpected fixture request');
  }) as typeof fetch;
  const input = new PassThrough(); const output = new PassThrough(); const logs: string[] = []; const messages: any[] = [];
  const pending = new Map<number, (v: any) => void>(); let buffer = ''; let id = 0;
  output.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'); const m = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); messages.push(m);
      const resolve = pending.get(m.id); if (resolve) { pending.delete(m.id); resolve(m); }
    }
  });
  const rpc = new DexRpcServer(new DexEngine(configs, new MemoryCredentialStore()), { input, output, log: (v) => logs.push(v),
    ...(enabled ? { nativeSessions: { configs, keys, fetch: fetchImpl, socket: () => {
      socketFactories++;
      return { assertAvailable() {}, open: async () => {
        let closed = false;
        return { get closed() { return closed; }, next: () => new Promise(() => {}), close: async () => { closed = true; } };
      } };
    } } } : {}) }); rpc.start();
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const current = ++id; const timer = setTimeout(() => reject(new Error('RPC fixture deadline')), 3000);
    pending.set(current, (m) => { clearTimeout(timer); resolve(m); }); input.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`);
  });
  return { send, keys, configs, calls, values, secrets, logs, messages, rpc, trusted: () => { trusted = true; }, custom: (f: typeof custom) => { custom = f; },
    socketFactories: () => socketFactories,
    cleanup: async () => { rpc.close(); input.destroy(); output.destroy(); await rm(directory, { recursive: true, force: true }); } };
}
const initialize = (f: Awaited<ReturnType<typeof fixture>>) => f.send('initialize', { protocolVersion: 1 });
async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const registered = await f.send('native/device', { action: 'register', email: 'a@example.test', password: 'private-password' });
  assert.equal(registered.result.user_id, user); assert.equal(registered.result.platform_type, 'vscode'); f.trusted();
  assert.equal((await f.send('native/session', { action: 'login', email: 'a@example.test', password: 'private-password' })).result.result.state, 'active');
}

test('RPC capability is opt-in and platform override/secret flags are rejected before HTTP', async () => {
  const old = await fixture(false); const f = await fixture();
  try {
    assert.equal((await initialize(old)).result.capabilities.nativePlatformSession, undefined);
    assert.equal((await old.send('native/session', { action: 'status', user_id: user })).error.data.code, 'protocol_mismatch');
    assert.equal((await f.send('native/session', { action: 'status', user_id: user })).error.code, -32002);
    const capability = (await initialize(f)).result.capabilities.nativePlatformSession;
    assert.equal(capability.platform, 'vscode'); assert.equal(capability.canonicalConversation, true); assert.equal(capability.canonicalLive, true);
    for (const params of [{ action: 'status', user_id: user, platform: 'cli' }, { action: 'login', email: 'a', password: 'p', access_token: account }]) {
      assert.equal((await f.send('native/session', params)).error.data.code, 'usage_error');
    }
    assert.equal((await f.send('native/watch-live', { user_id: user, interval_ms: 200, access_token: account })).error.data.code, 'usage_error');
    assert.equal(f.socketFactories(), 0);
    assert.equal(f.calls.length, 0);
  } finally { await old.cleanup(); await f.cleanup(); }
});

test('invalid focus and conversation watch intervals fail before HTTP and leave the RPC process usable', async () => {
  const f = await fixture();
  try {
    await initialize(f); const before = f.calls.length;
    for (const method of ['native/watch', 'native/watch-conversation', 'native/watch-live']) {
      for (const interval_ms of [199, 60001]) {
        const response = await f.send(method, { user_id: user, interval_ms });
        assert.equal(response.error.data.code, 'usage_error'); assert.equal(f.calls.length, before);
      }
    }
    assert.deepEqual((await f.send('health')).result, { ok: true, activeChats: 0 }); assert.equal(f.calls.length, before);
    assert.equal(f.socketFactories(), 0);
  } finally { await f.cleanup(); }
});

test('manual and watched conversations use separate RPC methods and project display-only canonical state', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f);
    f.custom((path) => {
      if (path.endsWith('/agent-state')) return Response.json({ active_agent_session_id: agentSid, version: 1, event_id: turn });
      if (path.endsWith('/snapshot')) return Response.json({ id: agentSid, workflow_id: 'flow', title: 'Shared', current_sequence: 1,
        state_version: 1, message_history_complete: false, latest_turn: { id: turn, status: 'completed', accepted_sequence: 1 }, authScope: 'server-secret' });
      if (path.endsWith('/messages')) return Response.json({ messages: [{ turn_id: turn, sequence: 1, status: 'completed', input_text: 'hello', output_text: 'world',
        content_complete: true, source: 'user', raw_execution: 'server-secret' }], next_cursor: 1, snapshot_sequence: 1, state_version: 1, has_more: false });
      return undefined;
    });
    const read = await f.send('native/conversation', { user_id: user });
    assert.equal(read.result.view, 'conversation'); assert.equal(read.result.has_more, false);
    assert.equal(read.result.conversation.snapshot.id, agentSid); assert.equal(read.result.conversation.messages[0].output_text, 'world');
    assert.equal(JSON.stringify(read.result).includes('server-secret'), false);
    const watching = await f.send('native/watch-conversation', { user_id: user, interval_ms: 200 });
    assert.equal(watching.result.view, 'conversation');
    for (let i = 0; i < 40 && !f.messages.some((m) => m.method === 'native/conversation' && m.params?.watch_id === watching.result.watch_id
      && m.params.update.type === 'conversation'); i++) await new Promise((r) => setTimeout(r, 5));
    const update = f.messages.find((m) => m.method === 'native/conversation' && m.params?.watch_id === watching.result.watch_id
      && m.params.update.type === 'conversation');
    assert.ok(update); assert.equal(update.params.view, 'conversation'); assert.equal(update.params.update.has_more, false);
    assert.equal(f.messages.some((m) => m.method === 'native/focus' && m.params?.watch_id === watching.result.watch_id), false);
    assert.equal(JSON.stringify(update).includes('authScope'), false); assert.equal(JSON.stringify(update).includes('server-secret'), false);
    await f.send('native/unwatch', { watch_id: watching.result.watch_id });
    const live = await f.send('native/watch-live', { user_id: user, interval_ms: 200 });
    assert.equal(live.result.view, 'conversation');
    for (let i = 0; i < 40 && !f.messages.some((m) => m.method === 'native/conversation' && m.params?.watch_id === live.result.watch_id
      && m.params.update.type === 'conversation'); i++) await new Promise((r) => setTimeout(r, 5));
    const liveUpdate = f.messages.find((m) => m.method === 'native/conversation' && m.params?.watch_id === live.result.watch_id
      && m.params.update.type === 'conversation');
    assert.ok(liveUpdate); assert.equal(f.messages.some((m) => m.method === 'native/focus' && m.params?.watch_id === live.result.watch_id), false);
    assert.ok(f.messages.indexOf(live) < f.messages.indexOf(liveUpdate));
    await f.send('native/unwatch', { watch_id: live.result.watch_id });
  } finally { await f.cleanup(); }
});

test('RPC enrollment/login/refresh/logout bind to VSCode and expose no credentials; CLI cannot use the slot', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f);
    await assert.rejects(new NativeCliSession(origin, f.keys).status(user));
    assert.equal((await f.send('native/session', { action: 'refresh', user_id: user })).result.result.state, 'active');
    assert.equal((await f.send('native/session', { action: 'logout', user_id: user, password: 'private-password' })).result.result.state, 'signed_out');
    assert.equal(f.values.size, 1);
    const output = JSON.stringify([f.messages, f.logs]); for (const secret of [...f.secrets, 'privateKeyPkcs8', 'accessToken', 'refreshToken']) assert.equal(output.includes(secret), false);
  } finally { await f.cleanup(); }
});

test('watch acknowledgment precedes scoped notifications; stale unwatch cannot stop its replacement', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f);
    const a = await f.send('native/watch', { user_id: user, interval_ms: 200 });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    const b = await f.send('native/watch', { user_id: user, interval_ms: 200 });
    assert.notEqual(a.result.watch_id, b.result.watch_id);
    await f.send('native/unwatch', { watch_id: a.result.watch_id });
    for (let i = 0; i < 20 && !f.messages.some((m) => m.params?.watch_id === b.result.watch_id && m.params.update.type === 'focus'); i++) await new Promise((r) => setTimeout(r, 5));
    const update = f.messages.find((m) => m.params?.watch_id === b.result.watch_id && m.params.update.type === 'focus'); assert.ok(update);
    assert.ok(f.messages.indexOf(b) < f.messages.indexOf(update)); assert.equal(update.params.platform_type, 'vscode');
    await f.send('native/unwatch', { watch_id: b.result.watch_id });
  } finally { await f.cleanup(); }
});

test('profile change cancels an in-flight Canonical read and prevents old-scope notifications', async () => {
  const f = await fixture(); let started!: (s: AbortSignal) => void; const ready = new Promise<AbortSignal>((r) => { started = r; });
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => path.endsWith('/agent-state') ? new Promise((_resolve, reject) => {
      started(init.signal!); init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }) : undefined);
    await f.send('native/watch', { user_id: user }); const signal = await ready;
    await f.send('profile/set', { name: 'corp', serverUrl: 'https://other.example.test' }); assert.equal(signal.aborted, true);
    await new Promise((r) => setImmediate(r)); assert.equal(f.messages.some((m) => m.params?.update?.type === 'focus'), false);
  } finally { await f.cleanup(); }
});

test('native cancellation/close abort writes, preserve journals and never return a late successful account result', async () => {
  const f = await fixture(); let started!: (s: AbortSignal) => void; const ready = new Promise<AbortSignal>((r) => { started = r; });
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => path.endsWith('/refresh/begin') ? new Promise((_resolve, reject) => {
      started(init.signal!); init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }) : undefined);
    const rotating = f.send('native/session', { action: 'refresh', user_id: user }); const signal = await ready;
    await f.send('native/cancel'); assert.equal(signal.aborted, true); assert.ok((await rotating).error);
    assert.equal((await f.send('native/session', { action: 'status', user_id: user })).result.result.state, 'refreshing');
    const count = f.calls.length; assert.ok((await f.send('native/watch', { user_id: user })).error);
    assert.equal(f.calls.length, count); assert.equal((await f.send('native/session', { action: 'forget-local', user_id: user })).result.server_revoked, false);
    await f.send('shutdown'); assert.equal(f.messages.some((m) => m.params?.update?.type === 'focus'), false);
  } finally { await f.cleanup(); }
});
