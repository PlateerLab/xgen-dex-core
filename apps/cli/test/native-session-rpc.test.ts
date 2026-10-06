import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DexEngine, MemoryConfigStore, MemoryCredentialStore, NativeDeviceKeyStore, NativeCliSession, NativeHostSession, defaultConfig } from '@dex/engine';
import { DexRpcServer } from '@dex/rpc/server';
import { nativeKeyThumbprint } from '@dex/engine/native-dpop';

const origin = 'https://app.example.test'; const user = '7';
const device = '018f1240-0000-7000-8000-000000000001'; const sid = '018f1240-0000-7000-8000-000000000002';
const agentSid = '018f1240-0000-7000-8000-000000000003'; const turn = '018f1240-0000-7000-8000-000000000004';
const challenge = Buffer.alloc(32, 5).toString('base64url'); const account = 'e30.e30.c2ln';
async function fixture(enabled = true, expectedUserId?: string, reversePicker = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dex-native-rpc-')); const values = new Map<string, string>();
  const keys = new NativeDeviceKeyStore({ lockDirectory: directory, env: {}, keychain: async () => ({
    getPassword: async (s, n) => values.get(`${s}:${n}`) ?? null, setPassword: async (s, n, v) => { values.set(`${s}:${n}`, v); }, deletePassword: async (s, n) => values.delete(`${s}:${n}`),
  }) });
  const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } } });
  let registered = false; let trusted = false; let publicKey: any; let refreshCount = 0; let socketFactories = 0; let platformSessionId = sid;
  let picker: (signal: AbortSignal, limits: Readonly<{ max_files: number; max_bytes: number }>)
    => Promise<readonly { filename: string; media_type: string; bytes: Uint8Array }[]>
    = async () => [];
  const calls: Array<{ path: string; url: string; init: RequestInit }> = []; const secrets = [account, 'private-password'];
  let custom: ((path: string, init: RequestInit) => Promise<Response> | Response | undefined) | undefined;
  const fetchImpl = (async (input, init: RequestInit = {}) => {
    const url = new URL(String(input)); const path = url.pathname; calls.push({ path, url: url.toString(), init });
    const response = await custom?.(path, init); if (response) return response;
    const body = JSON.parse(String(init.body ?? '{}'));
    if (path === '/api/auth/login') return Response.json({ success: true, user_id: user, access_token: account });
    if (path === '/api/auth/logout') return Response.json({ success: true });
    if (path.includes('/registration/status/')) { assert.ok(path.includes('/native/vscode/')); return Response.json(registered ? { device_id: device, state: trusted ? 'trusted' : 'pending' } : null); }
    if (path.endsWith('/registration/challenge')) { assert.ok(path.includes('/native/vscode/')); publicKey = body.public_key_jwk; return Response.json({ challenge, expires_in_seconds: 300 }); }
    if (path.endsWith('/registration/complete')) { registered = true; return Response.json({ device_id: device, state: 'pending' }); }
    if (path.endsWith('/begin')) return Response.json({ flow_id: sid, device_id: device, challenge, expires_in_seconds: 300 });
    if (path.endsWith('/complete')) {
      const refresh = Buffer.alloc(32, ++refreshCount).toString('base64url'); const exp = Math.floor(Date.now() / 1000) + 600;
      const access = `e30.${Buffer.from(JSON.stringify({ sub: user, sid: platformSessionId, device_id: device, platform_type: 'vscode', token_use: 'platform_access', cnf: { jkt: nativeKeyThumbprint(publicKey) }, exp })).toString('base64url')}.c2ln`;
      secrets.push(refresh, access);
      return Response.json({ session_id: platformSessionId, ...(path.includes('/refresh/') ? { refreshed: true, access_ready: true } : { state: 'active' }),
        refresh_token: refresh, token_type: 'DPoP', access_token: access, access_expires_at: new Date(exp * 1000).toISOString() });
    }
    if (path.endsWith('/agent-state')) { assert.ok((init.headers as any).Authorization.startsWith('DPoP ')); return Response.json({ active_agent_session_id: null, version: 0, event_id: null }); }
    if (path.endsWith('/agent-events')) return Response.json({ events: [], next_cursor: 0, snapshot_version: 0, has_more: false });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    assert.fail('Unexpected fixture request');
  }) as typeof fetch;
  const input = new PassThrough(); const output = new PassThrough(); const logs: string[] = []; const messages: any[] = [];
  const pending = new Map<number, (v: any) => void>(); let buffer = ''; let id = 0;
  const pickerWaiters: Array<(frame: any) => void> = [];
  output.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'); const m = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); messages.push(m);
      const resolve = pending.get(m.id); if (resolve) { pending.delete(m.id); resolve(m); }
      if (m.method === 'host/pick-native-attachments') pickerWaiters.shift()?.(m);
    }
  });
  const rpc = new DexRpcServer(new DexEngine(configs, new MemoryCredentialStore()), { input, output, log: (v) => logs.push(v),
    nativeAttachmentPicker: reversePicker,
    ...(enabled ? { nativeSessions: { configs, keys, fetch: fetchImpl, socket: () => {
      socketFactories++;
      return { assertAvailable() {}, open: async () => {
        let closed = false;
        return { get closed() { return closed; }, next: () => new Promise(() => {}), close: async () => { closed = true; } };
      } };
    }, ...(!reversePicker ? { attachmentPicker: (signal: AbortSignal, limits: Readonly<{ max_files: number; max_bytes: number }>) => picker(signal, limits) } : {}),
      ...(expectedUserId === undefined ? {} : { expectedUserId }) } } : {}) }); rpc.start();
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const current = ++id; const timer = setTimeout(() => reject(new Error('RPC fixture deadline')), 3000);
    pending.set(current, (m) => { clearTimeout(timer); resolve(m); }); input.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`);
  });
  return { send, keys, configs, calls, values, secrets, logs, messages, rpc, trusted: () => { trusted = true; }, custom: (f: typeof custom) => { custom = f; },
    picker: (value: typeof picker) => { picker = value; }, fetch: fetchImpl, sessionId: (value: string) => { platformSessionId = value; },
    socketFactories: () => socketFactories,
    directory, respond: (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`),
    nextPicker: () => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Picker fixture deadline')), 3000);
      pickerWaiters.push((frame) => { clearTimeout(timer); resolve(frame); });
    }),
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
    assert.equal(capability.canonicalTurns, true); assert.equal(capability.canonicalSessions, true);
    for (const params of [{ action: 'status', user_id: user, platform: 'cli' }, { action: 'login', email: 'a', password: 'p', access_token: account }]) {
      assert.equal((await f.send('native/session', params)).error.data.code, 'usage_error');
    }
    assert.equal((await f.send('native/watch-live', { user_id: user, interval_ms: 200, access_token: account })).error.data.code, 'usage_error');
    assert.equal(f.socketFactories(), 0);
    assert.equal(f.calls.length, 0);
  } finally { await old.cleanup(); await f.cleanup(); }
});

test('real native RPC scopes a negotiated reverse file chooser and ignores forged, duplicate and cancelled responses', async () => {
  const f = await fixture(true, undefined, true);
  const scope = { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' };
  try {
    assert.equal((await initialize(f)).result.capabilities.nativePlatformSession.canonicalAttachments, undefined);
    await login(f);
    assert.ok((await f.send('native/pick-attachments', scope)).error);
    const capability = await f.send('initialize', { protocolVersion: 1, client: { capabilities: { nativeAttachmentPicker: true } } });
    assert.equal(capability.result.capabilities.nativePlatformSession.canonicalAttachments, true);
    assert.ok((await f.send('native/pick-attachments', { ...scope, paths: ['/private/webview-file'] })).error);
    assert.equal(f.messages.some((frame) => frame.method === 'host/pick-native-attachments'), false);
    const path = join(f.directory, 'chosen.bin'); await writeFile(path, new Uint8Array([1, 2, 3]));
    const issuedPromise = f.nextPicker();
    const selected = f.send('native/pick-attachments', scope);
    const issued = await issuedPromise; assert.ok(issued);
    assert.deepEqual(issued.params, { max_files: 10, max_bytes: 104857600 });
    f.respond({ jsonrpc: '2.0', id: `${issued.id}-forged`, result: { paths: ['/private/never-read'] } });
    f.respond({ jsonrpc: '2.0', id: issued.id, result: { paths: [path] } });
    const result = await selected; assert.equal(result.error, undefined);
    assert.equal(result.result.attachments[0].filename, 'chosen.bin');
    assert.equal(result.result.attachments[0].size_bytes, 3);
    f.respond({ jsonrpc: '2.0', id: issued.id, result: { paths: ['/private/never-read'] } });
    assert.equal((await f.send('native/attachments', scope)).result.attachments.length, 1);
    const secondPromise = f.nextPicker();
    const next = f.send('native/pick-attachments', scope);
    const second = await secondPromise; assert.ok(second);
    await f.send('native/cancel'); assert.ok((await next).error);
    f.respond({ jsonrpc: '2.0', id: second.id, result: { paths: [path] } });
    assert.deepEqual((await f.send('native/attachments', scope)).result.attachments, []);
    assert.equal(JSON.stringify([f.messages, f.logs]).includes(f.directory), false);
    assert.equal(JSON.stringify([f.messages, f.logs]).includes('"bytes":'), false);
  } finally { await f.cleanup(); }
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

test('an immediate catalog or create replaces a scheduled live watch before it can use wire or notify', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f); const before = f.calls.length;
    f.custom((path, init) => {
      if (path.endsWith('/agent-sessions') && init.method === 'GET') return Response.json({
        items: [], next_cursor: null, has_more: false,
      });
      if (path === '/api/agentflow/agent-sessions' && init.method === 'POST') return Response.json({
        id: agentSid, workflow_id: 'flow',
        focus: { active_agent_session_id: agentSid, version: 1, event_id: turn },
      }, { status: 201 });
      return undefined;
    });

    const catalogWatch = await f.send('native/watch-live', { user_id: user, interval_ms: 200 });
    const catalog = await f.send('native/agent-sessions', { user_id: user, limit: 17 });
    assert.equal(catalog.error, undefined); assert.deepEqual(catalog.result.sessions, {
      items: [], next_cursor: null, has_more: false,
    });

    const createWatch = await f.send('native/watch-live', { user_id: user, interval_ms: 200 });
    const created = await f.send('native/create-agent-session', {
      user_id: user, workflow_id: 'flow', expected_version: 0,
    });
    assert.equal(created.error, undefined); assert.equal(created.result.created.id, agentSid);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const wire = f.calls.slice(before).filter(({ path }) => path.startsWith('/api/agentflow/'));
    assert.deepEqual(wire.map(({ path, init }) => [init.method, path]), [
      ['GET', '/api/agentflow/me/agent-state'],
      ['GET', '/api/agentflow/me/agent-sessions'],
      ['POST', '/api/agentflow/agent-sessions'],
    ]);
    for (const watch of [catalogWatch, createWatch]) {
      assert.equal(f.messages.some((message) => message.method === 'native/conversation'
        && message.params?.watch_id === watch.result.watch_id), false);
    }
  } finally { await f.cleanup(); }
});

test('replacement waits for an aborted live read to finish before opening the key scope', { timeout: 3000 }, async () => {
  const f = await fixture();
  let entered!: () => void; let aborted!: () => void; let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => {
      if (path.endsWith('/agent-state') && init.method === 'GET') return new Promise<Response>((_resolve, reject) => {
        entered();
        init.signal!.addEventListener('abort', () => {
          aborted(); void released.then(() => reject(init.signal!.reason));
        }, { once: true });
      });
      if (path === '/api/agentflow/agent-sessions' && init.method === 'POST') return Response.json({
        id: agentSid, workflow_id: 'flow',
        focus: { active_agent_session_id: agentSid, version: 1, event_id: turn },
      }, { status: 201 });
      return undefined;
    });
    const watch = await f.send('native/watch-live', { user_id: user, interval_ms: 200 });
    await reading;
    let settled = false;
    const creating = f.send('native/create-agent-session', {
      user_id: user, workflow_id: 'flow', expected_version: 0,
    }).finally(() => { settled = true; });
    await cancelled;
    const noticesAtCancel = f.messages.filter((message) => message.method === 'native/conversation'
      && message.params?.watch_id === watch.result.watch_id).length;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.calls.filter(({ path, init }) => path === '/api/agentflow/agent-sessions'
      && init.method === 'POST').length, 0);
    release();
    const created = await creating;
    assert.equal(created.error, undefined); assert.equal(created.result.created.id, agentSid);
    assert.equal(f.messages.filter((message) => message.method === 'native/conversation'
      && message.params?.watch_id === watch.result.watch_id).length, noticesAtCancel);
  } finally { release?.(); await f.cleanup(); }
});

test('a request after cancelling one conversation waits for its proof operation to settle', { timeout: 3000 }, async () => {
  const f = await fixture();
  let entered!: () => void; let aborted!: () => void; let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => {
      if (path.endsWith('/agent-state') && init.method === 'GET') return new Promise<Response>((_resolve, reject) => {
        entered();
        init.signal!.addEventListener('abort', () => {
          aborted(); void released.then(() => reject(init.signal!.reason));
        }, { once: true });
      });
      if (path === '/api/agentflow/agent-sessions' && init.method === 'POST') return Response.json({
        id: agentSid, workflow_id: 'flow',
        focus: { active_agent_session_id: agentSid, version: 1, event_id: turn },
      }, { status: 201 });
      return undefined;
    });
    const conversation = f.send('native/conversation', { user_id: user });
    await reading;
    await f.send('native/cancel'); await cancelled;
    const stopped = await conversation;
    assert.equal(stopped.error.data.code, 'cancelled');

    let settled = false;
    const creating = f.send('native/create-agent-session', {
      user_id: user, workflow_id: 'flow', expected_version: 0,
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.calls.filter(({ path, init }) => path === '/api/agentflow/agent-sessions'
      && init.method === 'POST').length, 0);
    release();
    const created = await creating;
    assert.equal(created.error, undefined); assert.equal(created.result.created.id, agentSid);
  } finally { release?.(); await f.cleanup(); }
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

test('Canonical session catalog uses an exact bounded query and projects owned schema only', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f);
    f.custom((path) => {
      if (path.endsWith('/agent-state')) return Response.json({ active_agent_session_id: agentSid,
        version: 1, event_id: turn, private_server_field: 'private-server-secret' });
      if (path.endsWith('/agent-sessions')) return Response.json({ items: [{ id: agentSid, workflow_id: 'flow',
        title: 'Owned', status: 'active', current_sequence: 2, state_version: 3,
        private_server_field: 'private-server-secret' }], next_cursor: agentSid, has_more: true,
      private_server_field: 'private-server-secret' });
      return undefined;
    });
    const response = await f.send('native/agent-sessions', {
      profile: 'corp', user_id: user, limit: 17, before_id: agentSid,
    });
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, {
      platform_type: 'vscode', profile: 'corp', server_url: origin, user_id: user,
      focus: { active_agent_session_id: agentSid, version: 1, event_id: turn },
      sessions: { items: [{ id: agentSid, workflow_id: 'flow', title: 'Owned', status: 'active',
        current_sequence: 2, state_version: 3 }], next_cursor: agentSid, has_more: true },
    });
    const reads = f.calls.filter(({ path }) => path.endsWith('/agent-state') || path.endsWith('/agent-sessions'));
    assert.deepEqual(reads.map(({ url }) => url), [
      `${origin}/api/agentflow/me/agent-state`,
      `${origin}/api/agentflow/me/agent-sessions?limit=17&before_id=${agentSid}`,
    ]);
    for (const { init } of reads) {
      const headers = new Headers(init.headers);
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      assert.equal(headers.get('authorization')?.startsWith('DPoP '), true); assert.ok(headers.get('dpop'));
      assert.equal(headers.has('cookie'), false); assert.equal(headers.has('origin'), false);
    }
    assert.equal(JSON.stringify([response, f.logs]).includes('private-server-secret'), false);
  } finally { await f.cleanup(); }
});

test('Canonical lifecycle RPC creates and switches with exact flat bodies and accepts a same-target no-op', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => {
      if (path === '/api/agentflow/agent-sessions' && init.method === 'POST') return Response.json({
        id: agentSid, workflow_id: 'flow', focus: { active_agent_session_id: agentSid, version: 1, event_id: turn },
        private_server_field: 'private-server-secret',
      }, { status: 201 });
      if (path === '/api/agentflow/me/agent-state' && init.method === 'PUT') return Response.json({
        active_agent_session_id: agentSid, version: 1, event_id: turn,
        private_server_field: 'private-server-secret',
      });
      return undefined;
    });
    const created = await f.send('native/create-agent-session', {
      profile: 'corp', user_id: user, workflow_id: 'flow', expected_version: 0, origin_id: 'vscode-1',
    });
    assert.deepEqual(created.result, {
      platform_type: 'vscode', profile: 'corp', server_url: origin, user_id: user,
      created: { id: agentSid, workflow_id: 'flow',
        focus: { active_agent_session_id: agentSid, version: 1, event_id: turn } },
    });
    const switched = await f.send('native/switch-agent-focus', {
      profile: 'corp', user_id: user, active_agent_session_id: agentSid,
      expected_version: 1, origin_id: 'vscode-1',
    });
    assert.deepEqual(switched.result, {
      platform_type: 'vscode', profile: 'corp', server_url: origin, user_id: user,
      focus: { active_agent_session_id: agentSid, version: 1, event_id: turn },
    });

    const writes = f.calls.filter(({ path, init }) => (path === '/api/agentflow/agent-sessions'
      || path === '/api/agentflow/me/agent-state') && (init.method === 'POST' || init.method === 'PUT'));
    assert.deepEqual(writes.map(({ path, init }) => [init.method, path]), [
      ['POST', '/api/agentflow/agent-sessions'], ['PUT', '/api/agentflow/me/agent-state'],
    ]);
    assert.deepEqual(writes.map(({ init }) => JSON.parse(String(init.body))), [
      { workflow_id: 'flow', expected_version: 0, title: '', origin_id: 'vscode-1' },
      { active_agent_session_id: agentSid, expected_version: 1, origin_id: 'vscode-1' },
    ]);
    for (const { init } of writes) {
      const headers = new Headers(init.headers);
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      assert.equal(headers.get('authorization')?.startsWith('DPoP '), true); assert.ok(headers.get('dpop'));
      assert.equal(headers.has('cookie'), false); assert.equal(headers.has('origin'), false);
    }
    assert.equal(JSON.stringify([created, switched, f.logs]).includes('private-server-secret'), false);
  } finally { await f.cleanup(); }
});

test('Canonical lifecycle RPC exposes only allowlisted 409 current focus fields', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f);
    f.custom((path) => path === '/api/agentflow/agent-sessions' ? Response.json({ detail: {
      code: 'FOCUS_VERSION_CONFLICT', current: { active_agent_session_id: agentSid,
        version: 1, event_id: turn, private_server_field: 'private-server-secret' },
      raw_request: 'private-user-input',
    } }, { status: 409 }) : undefined);
    const response = await f.send('native/create-agent-session', {
      user_id: user, workflow_id: 'flow', expected_version: 0,
    });
    assert.equal(response.error.data.code, 'usage_error');
    assert.deepEqual(response.error.data.details, {
      outcome: 'rejected', status: 409, operation: 'create_agent_session', expected_version: 0,
      conflict: { code: 'FOCUS_VERSION_CONFLICT',
        current: { active_agent_session_id: agentSid, version: 1, event_id: turn } },
    });
    assert.equal(JSON.stringify([response, f.logs]).includes('private-server-secret'), false);
    assert.equal(JSON.stringify([response, f.logs]).includes('private-user-input'), false);
  } finally { await f.cleanup(); }
});

test('lost lifecycle acknowledgement is unknown, safe and attempted once', async () => {
  const f = await fixture();
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => path === '/api/agentflow/me/agent-state' && init.method === 'PUT'
      ? (() => { throw new Error('private-server-secret'); })() : undefined);
    const response = await f.send('native/switch-agent-focus', {
      user_id: user, active_agent_session_id: null, expected_version: 1,
    });
    assert.equal(response.error.data.code, 'network_error');
    assert.deepEqual(response.error.data.details, {
      outcome: 'unknown', operation: 'switch_agent_focus', expected_version: 1,
      target_agent_session_id: null,
    });
    assert.equal(f.calls.filter(({ path, init }) => path === '/api/agentflow/me/agent-state'
      && init.method === 'PUT').length, 1);
    assert.equal(JSON.stringify([response, f.logs]).includes('private-server-secret'), false);
  } finally { await f.cleanup(); }
});

test('Canonical session RPC rejects wrong account, profile and fields before wire access', async () => {
  const f = await fixture();
  try {
    await initialize(f); const before = f.calls.length;
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['native/agent-sessions', { user_id: user, limit: 0 }],
      ['native/agent-sessions', { user_id: user, limit: 1, before_id: agentSid.toUpperCase() }],
      ['native/agent-sessions', { user_id: user, private_token: 'private-secret' }],
      ['native/create-agent-session', { user_id: user, workflow_id: '', expected_version: 0 }],
      ['native/create-agent-session', { user_id: user, workflow_id: 'flow', expected_version: -1 }],
      ['native/create-agent-session', { user_id: user, workflow_id: 'flow', expected_version: 0, password: 'private-secret' }],
      ['native/switch-agent-focus', { user_id: user, active_agent_session_id: agentSid.toUpperCase(), expected_version: 0 }],
      ['native/switch-agent-focus', { user_id: user, active_agent_session_id: null, expected_version: 0, origin_id: '' }],
      ['native/switch-agent-focus', { profile: 'missing', user_id: user, active_agent_session_id: null, expected_version: 0 }],
    ];
    for (const [method, params] of invalid) {
      const response = await f.send(method, params);
      assert.ok(['usage_error', 'not_found'].includes(response.error.data.code), method);
      assert.equal(JSON.stringify(response).includes('private-secret'), false);
      assert.equal(f.calls.length, before, method);
    }
  } finally { await f.cleanup(); }

  const bound = await fixture(true, '8');
  try {
    await initialize(bound);
    const response = await bound.send('native/create-agent-session', {
      user_id: user, workflow_id: 'flow', expected_version: 0,
    });
    assert.equal(response.error.data.code, 'auth_required'); assert.equal(bound.calls.length, 0);
  } finally { await bound.cleanup(); }
});

test('Canonical turn RPC methods pass flat named bodies and return safe scoped acknowledgements', async () => {
  const f = await fixture(); const longInput = 'h'.repeat(1025);
  const references = [turn, agentSid].map((attachment_id, index) => ({ attachment_id,
    sha256: createHash('sha256').update(new Uint8Array([index + 1])).digest('hex') }));
  const metadata = new Map<string, any>();
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => {
      const collection = `/api/agentflow/agent-sessions/${agentSid}/attachments`;
      if (path === collection) {
        const body = JSON.parse(String(init.body)); const id = body.filename === 'first.bin' ? turn : agentSid;
        metadata.set(id, body);
        return Response.json({ attachment_id: id, status: 'reserved', expires_at: '2030-01-01T00:00:00Z' }, { status: 201 });
      }
      const uploaded = references.find((reference) => path === `${collection}/${reference.attachment_id}/content`);
      if (uploaded) { const body = metadata.get(uploaded.attachment_id);
        return Response.json({ origin, user_id: user, session_id: agentSid, workflow_id: 'flow',
          attachment_id: uploaded.attachment_id, filename: body.filename, size_bytes: body.size_bytes,
          media_type: body.media_type, sha256: body.sha256 }); }
      if (path.endsWith('/turns')) return Response.json({ turn_id: turn, status: 'accepted', accepted_sequence: 3,
        state_version: 2, replayed: false, private_server_field: 'private-server-secret' }, { status: 202 });
      if (path.endsWith('/stop')) return Response.json({ turn_id: turn, state_version: 2, requested: true,
        private_server_field: 'private-server-secret' }, { status: 202 });
      return undefined;
    });
    const original = { profile: 'corp', user_id: user, agent_session_id: agentSid,
      input_text: longInput, expected_state_version: 1, idempotency_key: 'rpc-request-1', origin_id: 'vscode-1' };
    assert.equal((await f.send('native/submit-turn', { ...original, attachments: references })).error.data.code, 'usage_error');
    assert.equal(f.calls.some(({ path }) => path.endsWith('/turns')), false);
    f.picker(async () => ['first.bin', 'second.bin'].map((filename, index) => ({ filename,
      media_type: 'application/octet-stream', bytes: new Uint8Array([index + 1]) })));
    const chosen = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    assert.equal((await f.send('native/submit-turn', original)).error.data.code, 'usage_error');
    for (const item of chosen.result.attachments) {
      await f.send('native/upload-attachment', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: item.selection_id });
    }
    assert.equal((await f.send('native/submit-turn', { ...original, attachments: references.slice(0, 1) })).error.data.code, 'usage_error');
    assert.equal((await f.send('native/submit-turn', { ...original, attachments: [references[0], { attachment_id: device, sha256: 'a'.repeat(64) }] })).error.data.code, 'usage_error');
    assert.equal(f.calls.some(({ path }) => path.endsWith('/turns')), false);
    const submitted = await f.send('native/submit-turn', { ...original, attachments: references });
    assert.equal(submitted.error, undefined); assert.equal(submitted.result.platform_type, 'vscode');
    assert.equal(submitted.result.profile, 'corp'); assert.equal(submitted.result.server_url, origin);
    assert.equal(submitted.result.user_id, user); assert.equal(submitted.result.agent_session_id, agentSid);
    assert.deepEqual(submitted.result.mutation, { turn_id: turn, status: 'accepted', accepted_sequence: 3, state_version: 2, replayed: false });

    const stopped = await f.send('native/stop-turn', { profile: 'corp', user_id: user, agent_session_id: agentSid,
      turn_id: turn, expected_state_version: 2 });
    assert.equal(stopped.error, undefined); assert.equal(stopped.result.platform_type, 'vscode');
    assert.equal(stopped.result.profile, 'corp'); assert.equal(stopped.result.server_url, origin);
    assert.equal(stopped.result.user_id, user); assert.equal(stopped.result.agent_session_id, agentSid);
    assert.deepEqual(stopped.result.mutation, { turn_id: turn, state_version: 2, requested: true });

    const writes = f.calls.filter(({ path, init }) => init.method === 'POST' && (path.endsWith('/turns') || path.endsWith('/stop')));
    assert.equal(writes.length, 2); assert.deepEqual(writes.map(({ path }) => path), [
      `/api/agentflow/agent-sessions/${agentSid}/turns`, `/api/agentflow/agent-sessions/${agentSid}/stop`,
    ]);
    assert.deepEqual(writes.map(({ init }) => JSON.parse(String(init.body))), [
      { input_text: longInput, expected_state_version: 1, idempotency_key: 'rpc-request-1', origin_id: 'vscode-1', attachments: references },
      { turn_id: turn, expected_state_version: 2 },
    ]);
    for (const write of writes) {
      const headers = new Headers(write.init.headers);
      assert.equal(headers.get('authorization')?.startsWith('DPoP '), true); assert.ok(headers.get('dpop'));
      assert.equal(headers.has('cookie'), false); assert.equal(headers.has('origin'), false);
    }
    assert.equal(JSON.stringify([submitted, stopped, f.logs]).includes('private-server-secret'), false);
  } finally { await f.cleanup(); }
});

test('Canonical turn RPC validation, unknown fields and host account binding fail before HTTP', async () => {
  const f = await fixture();
  try {
    await initialize(f);
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['native/submit-turn', { user_id: user, agent_session_id: agentSid, input_text: '', expected_state_version: 1, idempotency_key: 'request' }],
      ['native/submit-turn', { user_id: user, agent_session_id: 'not-a-session', input_text: 'x', expected_state_version: 1, idempotency_key: 'request' }],
      ['native/submit-turn', { user_id: user, agent_session_id: agentSid, input_text: 'x', expected_state_version: 0, idempotency_key: 'request' }],
      ['native/submit-turn', { user_id: user, agent_session_id: agentSid, input_text: 'x', expected_state_version: 1, idempotency_key: '', private_token: 'private-secret' }],
      ['native/submit-turn', { user_id: user, agent_session_id: agentSid, input_text: 'x', expected_state_version: 1, idempotency_key: 'request', origin_id: '' }],
      ['native/submit-turn', { user_id: user, agent_session_id: agentSid, input_text: 'x', expected_state_version: 1, idempotency_key: 'request', attachments: [{ attachment_id: turn, sha256: 'a'.repeat(64), path: '/private-secret' }] }],
      ['native/submit-turn', { user_id: user, agent_session_id: agentSid, input_text: 'x', expected_state_version: 1, idempotency_key: 'request', attachments: [{ attachment_id: turn, sha256: 'a'.repeat(64) }, { attachment_id: turn, sha256: 'a'.repeat(64) }] }],
      ['native/submit-turn', { user_id: user, agent_session_id: agentSid, input_text: 'x', expected_state_version: 1, idempotency_key: 'request', attachments: [{ attachment_id: turn, sha256: 'A'.repeat(64) }] }],
      ['native/stop-turn', { user_id: user, agent_session_id: agentSid, turn_id: 'not-a-turn', expected_state_version: 1 }],
      ['native/stop-turn', { user_id: user, agent_session_id: agentSid, turn_id: turn, expected_state_version: 0 }],
      ['native/stop-turn', { user_id: user, agent_session_id: agentSid, turn_id: turn, expected_state_version: 1, password: 'private-secret' }],
      ['native/unknown-turn', { user_id: user }],
    ];
    for (const [method, params] of invalid) {
      const response = await f.send(method, params);
      assert.equal(response.error.data.code, 'usage_error', method);
      assert.equal(JSON.stringify(response).includes('private-secret'), false);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }

  const bound = await fixture(true, '8');
  try {
    await initialize(bound);
    const response = await bound.send('native/submit-turn', { user_id: user, agent_session_id: agentSid,
      input_text: 'hello', expected_state_version: 1, idempotency_key: 'request' });
    assert.equal(response.error.data.code, 'auth_required'); assert.equal(bound.calls.length, 0);
  } finally { await bound.cleanup(); }
});

test('RPC cancel after turn dispatch reports an unknown outcome and never emits a late success or private input', async () => {
  const f = await fixture(); let started!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>((resolve) => { started = resolve; });
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => path.endsWith('/turns') ? new Promise((_resolve, reject) => {
      started(init.signal!); init.signal!.addEventListener('abort', () => reject(new Error('private-server-secret')), { once: true });
    }) : undefined);
    const mutation = f.send('native/submit-turn', { user_id: user, agent_session_id: agentSid,
      input_text: 'private-user-input', expected_state_version: 1, idempotency_key: 'rpc-request-1' });
    const signal = await entered; await f.send('native/cancel'); assert.equal(signal.aborted, true);
    const response = await mutation;
    assert.equal(response.error.data.code, 'network_error');
    assert.deepEqual(response.error.data.details, { outcome: 'unknown', agent_session_id: agentSid,
      idempotency_key: 'rpc-request-1', expected_state_version: 1 });
    assert.equal(f.calls.filter(({ path }) => path.endsWith('/turns')).length, 1);
    assert.equal(JSON.stringify([response, f.messages, f.logs]).includes('private-user-input'), false);
    assert.equal(JSON.stringify([response, f.messages, f.logs]).includes('private-server-secret'), false);
  } finally { await f.cleanup(); }
});

test('native attachment selection is trusted-host-only, bounded, copied and invalidated by auth changes', async () => {
  const f = await fixture(); let picks = 0;
  try {
    await initialize(f); await login(f);
    const callsBeforeValidation = f.calls.length;
    const privateBytes = new Uint8Array([1, 2, 3]); let firstLimits: any;
    f.picker(async (_signal, limits) => { picks++; firstLimits = limits;
      return [{ filename: 'report.txt', media_type: 'text/plain', bytes: privateBytes }]; });
    for (const [method, params] of [
      ['native/pick-attachments', { user_id: user, agent_session_id: 'not-a-session', workflow_id: 'flow' }],
      ['native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'bad\nflow' }],
      ['native/upload-attachment', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: 'not-a-selection' }],
    ] as const) {
      assert.equal((await f.send(method, params)).error.data.code, 'usage_error');
    }
    assert.equal(picks, 0); assert.equal(f.calls.length, callsBeforeValidation);
    const injected = await f.send('native/pick-attachments', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow', path: '/private/secret.txt', bytes: [9],
    });
    assert.equal(injected.error.data.code, 'usage_error'); assert.equal(picks, 0);

    const picked = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    assert.equal(picked.error, undefined); assert.equal(picks, 1); assert.equal(picked.result.attachments.length, 1);
    assert.deepEqual(firstLimits, { max_files: 10, max_bytes: 100 * 1024 * 1024 });
    assert.deepEqual(Object.keys(picked.result.attachments[0]).sort(),
      ['filename', 'media_type', 'selection_id', 'sha256', 'size_bytes', 'status']);
    assert.equal(picked.result.attachments[0].status, 'selected');
    assert.equal(JSON.stringify(picked).includes('/private/secret.txt'), false);
    assert.equal(JSON.stringify(picked).includes('bytes'), true); // size_bytes only; no raw byte field.
    assert.equal(Object.prototype.hasOwnProperty.call(picked.result.attachments[0], 'bytes'), false);
    assert.deepEqual([...privateBytes], [0, 0, 0]);
    privateBytes[0] = 99;

    class OversizedClaim extends Uint8Array { override get byteLength() { return 100 * 1024 * 1024 + 1; } }
    const oversized = new OversizedClaim(1); let remainingLimits: any;
    f.picker(async (_signal, limits) => { remainingLimits = limits;
      return [{ filename: 'too-large.txt', media_type: 'text/plain', bytes: oversized }]; });
    const overBytes = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    assert.equal(overBytes.error.data.code, 'usage_error');
    assert.deepEqual(remainingLimits, { max_files: 9, max_bytes: 100 * 1024 * 1024 - 3 });
    assert.equal(oversized[0], 0);

    const countSources = Array.from({ length: 10 }, () => new Uint8Array([5]));
    f.picker(async () => countSources.map((bytes, index) => ({
      filename: `bounded-${index}.txt`, media_type: 'text/plain', bytes,
    })));
    const overCount = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    assert.equal(overCount.error.data.code, 'usage_error');
    assert.equal(countSources.every((bytes) => bytes[0] === 0), true);
    assert.equal((await f.send('native/attachments', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow',
    })).result.attachments.length, 1);

    f.picker(async () => Array.from({ length: 9 }, (_, index) => ({
      filename: `retained-${index}.txt`, media_type: 'text/plain', bytes: new Uint8Array(),
    })));
    assert.equal((await f.send('native/pick-attachments', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow',
    })).result.attachments.length, 10);
    let openedAtLimit = false; f.picker(async () => { openedAtLimit = true; return []; });
    assert.equal((await f.send('native/pick-attachments', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow',
    })).error.data.code, 'usage_error');
    assert.equal(openedAtLimit, false);

    const changedAccount = await f.send('native/attachments', {
      user_id: '8', agent_session_id: agentSid, workflow_id: 'flow',
    });
    assert.equal(changedAccount.error.data.code, 'auth_required');
    assert.deepEqual((await f.send('native/attachments', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow',
    })).result.attachments, []);

    f.picker(async () => [{ filename: 'scope.txt', media_type: 'text/plain', bytes: new Uint8Array([4]) }]);
    await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    const changedSession = await f.send('native/attachments', {
      user_id: user, agent_session_id: turn, workflow_id: 'flow',
    });
    assert.deepEqual(changedSession.result.attachments, []);

    let cancelOpened!: () => void; let cancelFinish!: () => void;
    const cancelOpen = new Promise<void>((resolve) => { cancelOpened = resolve; });
    const cancelWait = new Promise<void>((resolve) => { cancelFinish = resolve; });
    const cancelledSource = new Uint8Array([6]);
    f.picker(async () => { cancelOpened(); await cancelWait; return [{
      filename: 'cancelled-late.txt', media_type: 'text/plain', bytes: cancelledSource,
    }]; });
    const cancelledPick = f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    await cancelOpen; await f.send('native/cancel'); cancelFinish();
    assert.equal((await cancelledPick).error.data.code, 'cancelled');
    assert.equal(cancelledSource[0], 0);
    assert.deepEqual((await f.send('native/attachments', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow',
    })).result.attachments, []);

    let opened!: () => void; let finish!: () => void;
    const open = new Promise<void>((resolve) => { opened = resolve; });
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const authChangedSource = new Uint8Array([7]);
    f.picker(async () => { opened(); await wait; return [{ filename: 'late.txt', media_type: 'text/plain', bytes: authChangedSource }]; });
    const pendingPick = f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    await open;
    await new NativeHostSession(origin, 'vscode', f.keys, f.fetch).forgetLocal(user);
    finish();
    const changedAuth = await pendingPick;
    assert.equal(changedAuth.error.data.code, 'auth_required');
    assert.equal(authChangedSource[0], 0);
    assert.equal(JSON.stringify([changedAuth, f.messages, f.logs]).includes('/private/secret.txt'), false);
  } finally { await f.cleanup(); }
});

test('native attachment upload re-reserves stably, recovers uncertain PUT without replay, rejects foreign receipts and releases after ACK', async () => {
  const f = await fixture();
  const attachmentA = '018f1240-0000-7000-8000-000000000005';
  const attachmentB = '018f1240-0000-7000-8000-000000000006';
  const reservations: any[] = []; let reserveCalls = 0; let putA = 0; let putB = 0; let foreignB = true;
  const metadata = new Map<string, any>();
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => {
      const collection = `/api/agentflow/agent-sessions/${agentSid}/attachments`;
      if (path === collection && init.method === 'POST') {
        const body = JSON.parse(String(init.body)); reservations.push(body); reserveCalls++;
        if (reserveCalls === 1) throw new Error('private reserve path /Users/private/file');
        const id = reserveCalls === 2 ? attachmentA : attachmentB; metadata.set(id, body);
        return Response.json({ attachment_id: id, status: 'reserved', expires_at: '2030-01-01T00:00:00Z' }, { status: 201 });
      }
      if (path === `${collection}/${attachmentA}/content` && init.method === 'PUT') {
        putA++; assert.deepEqual([...init.body as Uint8Array], [1, 2, 3]);
        const body = metadata.get(attachmentA); return Response.json({ origin, user_id: user, session_id: agentSid,
          workflow_id: 'flow', attachment_id: attachmentA, filename: body.filename, size_bytes: body.size_bytes,
          media_type: body.media_type, sha256: body.sha256 });
      }
      if (path === `${collection}/${attachmentB}/content` && init.method === 'PUT') {
        putB++; throw new Error('private PUT response /Users/private/file');
      }
      if (path === `${collection}/${attachmentB}` && init.method === 'GET') {
        const body = metadata.get(attachmentB); return Response.json({ origin, user_id: user, session_id: agentSid,
          workflow_id: 'flow', attachment_id: attachmentB, filename: foreignB ? 'foreign-private-name.txt' : body.filename,
          size_bytes: body.size_bytes, media_type: body.media_type, sha256: body.sha256 });
      }
      if (path.endsWith('/turns') && init.method === 'POST') return Response.json({
        turn_id: turn, status: 'accepted', accepted_sequence: 1, state_version: 2, replayed: false,
      }, { status: 202 });
      return undefined;
    });

    const sourceA = new Uint8Array([1, 2, 3]);
    f.picker(async () => [{ filename: 'a.txt', media_type: 'text/plain', bytes: sourceA }]);
    const pickedA = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    const selectionA = pickedA.result.attachments[0].selection_id;
    sourceA.fill(99);
    const firstReserve = await f.send('native/upload-attachment', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionA,
    });
    assert.equal(firstReserve.error.data.code, 'network_error'); assert.equal(firstReserve.error.data.details.outcome, 'unknown');
    const uploadedA = await f.send('native/upload-attachment', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionA,
    });
    assert.equal(uploadedA.result.attachments[0].status, 'ready'); assert.equal(putA, 1);
    assert.equal(reservations[0].upload_key, reservations[1].upload_key);
    assert.equal(JSON.stringify([firstReserve, f.messages, f.logs]).includes('/Users/private/file'), false);

    f.picker(async () => [{ filename: 'b.txt', media_type: 'text/plain', bytes: new Uint8Array([4, 5]) }]);
    const pickedB = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    const selectionB = pickedB.result.attachments[1].selection_id;
    const unknownPut = await f.send('native/upload-attachment', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionB,
    });
    assert.equal(unknownPut.error.data.details.outcome, 'unknown'); assert.equal(putB, 1);
    const noReplay = await f.send('native/upload-attachment', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionB,
    });
    assert.equal(noReplay.error.data.details.outcome, 'unknown'); assert.equal(putB, 1); assert.equal(reserveCalls, 3);

    const foreign = await f.send('native/recover-attachment', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionB,
    });
    assert.equal(foreign.error.data.code, 'protocol_mismatch');
    assert.equal(JSON.stringify([foreign, f.messages, f.logs]).includes('foreign-private-name.txt'), false);
    foreignB = false;
    const recovered = await f.send('native/recover-attachment', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionB,
    });
    assert.equal(recovered.result.attachments[1].status, 'ready'); assert.equal(putB, 1);

    const refs = recovered.result.attachments.map((item: any) => ({ attachment_id: item.attachment_id, sha256: item.sha256 })).reverse();
    const submitted = await f.send('native/submit-turn', { user_id: user, agent_session_id: agentSid,
      input_text: 'with attachments', expected_state_version: 1, idempotency_key: 'attachment-order', attachments: refs });
    assert.equal(submitted.error, undefined);
    const turnWrites = f.calls.filter(({ path, init }) => path.endsWith('/turns') && init.method === 'POST');
    const turnBody = JSON.parse(String(turnWrites[turnWrites.length - 1].init.body));
    assert.deepEqual(turnBody.attachments, refs);
    assert.deepEqual((await f.send('native/attachments', {
      user_id: user, agent_session_id: agentSid, workflow_id: 'flow',
    })).result.attachments, []);
  } finally { await f.cleanup(); }
});

test('attached turn retry guard survives cancel, accepts only the exact intent and rejects a replaced native login before wire', async () => {
  const f = await fixture();
  const ids = ['018f1240-0000-7000-8000-000000000008', '018f1240-0000-7000-8000-000000000009'];
  const metadata = new Map<string, any>(); let reserves = 0;
  const turnAttempts = new Map<string, number>();
  try {
    await initialize(f); await login(f);
    f.custom((path, init) => {
      const collection = `/api/agentflow/agent-sessions/${agentSid}/attachments`;
      if (path === collection && init.method === 'POST') {
        const id = ids[reserves++]; const body = JSON.parse(String(init.body)); metadata.set(id, body);
        return Response.json({ attachment_id: id, status: 'reserved', expires_at: '2030-01-01T00:00:00Z' }, { status: 201 });
      }
      const contentId = ids.find((id) => path === `${collection}/${id}/content` && init.method === 'PUT');
      if (contentId) {
        const body = metadata.get(contentId); return Response.json({ origin, user_id: user, session_id: agentSid,
          workflow_id: 'flow', attachment_id: contentId, filename: body.filename, size_bytes: body.size_bytes,
          media_type: body.media_type, sha256: body.sha256 });
      }
      if (path.endsWith('/turns') && init.method === 'POST') {
        const body = JSON.parse(String(init.body)); const attempt = (turnAttempts.get(body.idempotency_key) ?? 0) + 1;
        turnAttempts.set(body.idempotency_key, attempt);
        if (attempt === 1) throw new Error('private lost turn response');
        return Response.json({ turn_id: turn, status: 'accepted', accepted_sequence: 1,
          state_version: 2, replayed: true }, { status: 202 });
      }
      return undefined;
    });

    const readyIntent = async (name: string, key: string) => {
      f.picker(async () => [{ filename: name, media_type: 'text/plain', bytes: new Uint8Array([reserves + 1]) }]);
      const picked = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
      const selectionId = picked.result.attachments[0].selection_id;
      const uploaded = await f.send('native/upload-attachment', {
        user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionId,
      });
      const item = uploaded.result.attachments[0];
      return { user_id: user, agent_session_id: agentSid, input_text: `intent-${key}`,
        expected_state_version: 1, idempotency_key: key,
        attachments: [{ attachment_id: item.attachment_id, sha256: item.sha256 }] };
    };

    const sameIntent = await readyIntent('same.txt', 'retry-same');
    assert.equal((await f.send('native/submit-turn', sameIntent)).error.data.details.outcome, 'unknown');
    await f.send('native/cancel');
    const different = await f.send('native/submit-turn', { ...sameIntent, input_text: 'different-private-intent' });
    assert.equal(different.error.data.details.outcome, 'unknown');
    assert.equal(turnAttempts.get('retry-same'), 1);
    assert.equal((await f.send('native/submit-turn', sameIntent)).error, undefined);
    assert.equal(turnAttempts.get('retry-same'), 2);

    const replacedIntent = await readyIntent('replaced.txt', 'retry-replaced');
    assert.equal((await f.send('native/submit-turn', replacedIntent)).error.data.details.outcome, 'unknown');
    await f.send('native/cancel');
    await new NativeHostSession(origin, 'vscode', f.keys, f.fetch).forgetLocal(user);
    f.sessionId('018f1240-0000-7000-8000-000000000010');
    assert.equal((await new NativeHostSession(origin, 'vscode', f.keys, f.fetch).login(
      'a@example.test', 'private-password')).state, 'active');
    const replaced = await f.send('native/submit-turn', replacedIntent);
    assert.equal(replaced.error.data.code, 'auth_required');
    assert.equal(turnAttempts.get('retry-replaced'), 1);
    assert.equal(JSON.stringify([different, replaced, f.messages, f.logs]).includes('different-private-intent'), false);
  } finally { await f.cleanup(); }
});

test('definite attachment turn auth rejection clears retained drafts and the pending retry binding', async () => {
  for (const failure of ['rotation', '401', '403']) {
    const f = await fixture(); const attachmentId = '018f1240-0000-7000-8000-000000000008';
    const scope = { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' };
    let metadata: any; let turnCalls = 0; let rejectTurn = failure !== 'rotation';
    try {
      await initialize(f); await login(f);
      f.custom((path, init) => {
        const collection = `/api/agentflow/agent-sessions/${agentSid}/attachments`;
        if (path === collection && init.method === 'POST') {
          metadata = JSON.parse(String(init.body));
          return Response.json({ attachment_id: attachmentId, status: 'reserved', expires_at: '2030-01-01T00:00:00Z' }, { status: 201 });
        }
        if (path === `${collection}/${attachmentId}/content` && init.method === 'PUT') {
          return Response.json({ origin, user_id: user, session_id: agentSid, workflow_id: 'flow',
            attachment_id: attachmentId, filename: metadata.filename, size_bytes: metadata.size_bytes,
            media_type: metadata.media_type, sha256: metadata.sha256 });
        }
        if (path.endsWith('/turns') && init.method === 'POST') {
          turnCalls++;
          if (rejectTurn) return new Response(null, { status: Number(failure) });
          return Response.json({ turn_id: turn, status: 'accepted', accepted_sequence: 1,
            state_version: 2, replayed: false }, { status: 202 });
        }
        return undefined;
      });
      f.picker(async () => [{ filename: 'bound.bin', media_type: 'application/octet-stream', bytes: new Uint8Array([1]) }]);
      const picked = await f.send('native/pick-attachments', scope);
      const uploaded = await f.send('native/upload-attachment', { ...scope, selection_id: picked.result.attachments[0].selection_id });
      const item = uploaded.result.attachments[0];
      if (failure === 'rotation') {
        const replaced = new NativeHostSession(origin, 'vscode', f.keys, f.fetch);
        await replaced.forgetLocal(user); f.sessionId('018f1240-0000-7000-8000-000000000010');
        assert.equal((await replaced.login('a@example.test', 'private-password')).state, 'active');
      }
      const rejected = await f.send('native/submit-turn', { user_id: user, agent_session_id: agentSid,
        input_text: 'bound intent', expected_state_version: 1, idempotency_key: 'bound-key',
        attachments: [{ attachment_id: item.attachment_id, sha256: item.sha256 }] });
      assert.equal(rejected.error.data.code, 'auth_required');
      assert.equal(turnCalls, failure === 'rotation' ? 0 : 1);
      assert.deepEqual((await f.send('native/attachments', scope)).result.attachments, []);
      rejectTurn = false;
      assert.equal((await f.send('native/submit-turn', { user_id: user, agent_session_id: agentSid,
        input_text: 'fresh intent', expected_state_version: 1, idempotency_key: 'fresh-key' })).error, undefined);
      assert.equal(turnCalls, failure === 'rotation' ? 1 : 2);
    } finally { await f.cleanup(); }
  }
});

test('server auth rejection during attachment upload, recovery or cancellation releases the host draft', async () => {
  for (const operation of ['upload', 'recover', 'cancel']) {
    const f = await fixture(); const attachmentId = '018f1240-0000-7000-8000-000000000008';
    const scope = { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' };
    let metadata: any; let reject = operation === 'upload'; let rejected = 0;
    try {
      await initialize(f); await login(f);
      f.custom((path, init) => {
        const collection = `/api/agentflow/agent-sessions/${agentSid}/attachments`;
        if (path === collection && init.method === 'POST') {
          metadata = JSON.parse(String(init.body));
          return Response.json({ attachment_id: attachmentId, status: 'reserved', expires_at: '2030-01-01T00:00:00Z' }, { status: 201 });
        }
        if (path.startsWith(`${collection}/${attachmentId}`)) {
          if (reject) { rejected++; return new Response(null, { status: 403 }); }
          return Response.json({ origin, user_id: user, session_id: agentSid, workflow_id: 'flow', attachment_id: attachmentId,
            filename: metadata.filename, size_bytes: metadata.size_bytes, media_type: metadata.media_type, sha256: metadata.sha256 });
        }
        return undefined;
      });
      f.picker(async () => [{ filename: 'retained.bin', media_type: 'application/octet-stream', bytes: new Uint8Array([3]) }]);
      const selected = await f.send('native/pick-attachments', scope);
      const params = { ...scope, selection_id: selected.result.attachments[0].selection_id };
      if (operation !== 'upload') assert.equal((await f.send('native/upload-attachment', params)).result.attachments[0].status, 'ready');
      reject = true;
      const response = await f.send(`native/${operation}-attachment`, params);
      assert.equal(response.error.data.code, 'auth_required'); assert.equal(rejected, 1);
      assert.deepEqual((await f.send('native/attachments', scope)).result.attachments, []);
    } finally { await f.cleanup(); }
  }
});

test('native attachment cancel removes only after local removal or remote 204; discard never remote-cancels', async () => {
  const f = await fixture(); const attachmentId = '018f1240-0000-7000-8000-000000000007'; let cancels = 0; let acceptCancel = false;
  try {
    await initialize(f); await login(f);
    f.picker(async () => [{ filename: 'cancel.txt', media_type: 'text/plain', bytes: new Uint8Array([8]) }]);
    let state = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    await f.send('native/cancel-attachment', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow',
      selection_id: state.result.attachments[0].selection_id });
    assert.equal(cancels, 0);

    state = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    const selectionId = state.result.attachments[0].selection_id;
    f.custom((path, init) => {
      const collection = `/api/agentflow/agent-sessions/${agentSid}/attachments`;
      if (path === collection && init.method === 'POST') return Response.json({
        attachment_id: attachmentId, status: 'uploading', expires_at: '2030-01-01T00:00:00Z',
      }, { status: 201 });
      if (path === `${collection}/${attachmentId}/cancel` && init.method === 'POST') {
        cancels++; return acceptCancel ? new Response(null, { status: 204 }) : Response.json({ private: 'server-secret' }, { status: 409 });
      }
      return undefined;
    });
    const upload = await f.send('native/upload-attachment', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionId });
    assert.equal(upload.error.data.details.outcome, 'unknown');
    const rejected = await f.send('native/cancel-attachment', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionId });
    assert.equal(rejected.error.data.details.outcome, 'rejected');
    assert.equal((await f.send('native/attachments', { user_id: user, agent_session_id: agentSid,
      workflow_id: 'flow' })).result.attachments.length, 1);
    acceptCancel = true;
    const cancelled = await f.send('native/cancel-attachment', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow', selection_id: selectionId });
    assert.deepEqual(cancelled.result.attachments, []); assert.equal(cancels, 2);

    state = await f.send('native/pick-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    assert.equal(state.result.attachments.length, 1);
    const discarded = await f.send('native/discard-attachments', { user_id: user, agent_session_id: agentSid, workflow_id: 'flow' });
    assert.deepEqual(discarded.result.attachments, []); assert.equal(cancels, 2);
    assert.equal(JSON.stringify([rejected, f.messages, f.logs]).includes('server-secret'), false);
  } finally { await f.cleanup(); }
});
