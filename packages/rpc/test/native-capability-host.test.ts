import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  getLocalToolProvider,
  validateNativeCapabilityOptions,
  MemoryConfigStore,
  NativeDeviceKeyStore,
  NativeHostSession,
  defaultConfig,
  type NativeCapabilityController,
  type NativeCapabilityOptions,
  type NativeCapabilitySnapshot,
} from '@dex/engine';
import { nativeKeyThumbprint } from '@dex/engine/native-dpop';
import { normalizeLocalFolders } from '@dex/engine/local-folders';
import { NativeCapabilityRpcHost } from '../src/native-capability-host';
import { NativeSessionRpcHost } from '../src/native-session-host';

const origin = 'https://app.example.test';
const confirmation = {
  requestId: '018f1240-0000-7000-8000-000000000001',
  agentSessionId: '018f1240-0000-7000-8000-000000000002',
  server: 'local',
  tool: 'ReadFile',
  args: Object.freeze({ path: 'README.md' }),
  expiresAt: Math.floor(Date.now() / 1000) + 60,
  argsSha256: 'a'.repeat(64),
};

async function sessionHostFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-native-capability-'));
  const values = new Map<string, string>();
  const keys = new NativeDeviceKeyStore({ env: {}, lockDirectory: dir, keychain: async () => ({
    getPassword: async (service, account) => values.get(`${service}:${account}`) ?? null,
    setPassword: async (service, account, value) => { values.set(`${service}:${account}`, value); },
    deletePassword: async (service, account) => values.delete(`${service}:${account}`),
  }) });
  const deviceId = '018f1240-0000-7000-8000-000000000021';
  const sessionId = '018f1240-0000-7000-8000-000000000022';
  const challenge = Buffer.alloc(32, 7).toString('base64url');
  let publicKey!: Parameters<typeof nativeKeyThumbprint>[0];
  let trusted = false;
  let custom: ((path: string, init: RequestInit) => Promise<Response> | undefined) | undefined;
  const fetchImpl = (async (input, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const intercepted = custom?.(path, init);
    if (intercepted) return intercepted;
    const body = JSON.parse(String(init.body ?? '{}'));
    if (path === '/api/auth/login') return Response.json({ success: true, user_id: '7', access_token: 'e30.e30.c2ln' });
    if (path === '/api/auth/logout') return Response.json({ success: true });
    if (path.includes('/registration/status/')) {
      return Response.json(publicKey ? { device_id: deviceId, state: trusted ? 'trusted' : 'pending' } : null);
    }
    if (path.endsWith('/registration/challenge')) {
      publicKey = body.public_key_jwk as Parameters<typeof nativeKeyThumbprint>[0];
      return Response.json({ challenge, expires_in_seconds: 300 });
    }
    if (path.endsWith('/registration/complete')) return Response.json({ device_id: deviceId, state: 'pending' });
    if (path.endsWith('/begin')) return Response.json({ flow_id: sessionId, device_id: deviceId, challenge, expires_in_seconds: 300 });
    if (path.endsWith('/complete')) {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const access = `e30.${Buffer.from(JSON.stringify({ sub: '7', sid: sessionId, device_id: deviceId,
        platform_type: 'desktop', token_use: 'platform_access', exp,
        cnf: { jkt: nativeKeyThumbprint(publicKey) } })).toString('base64url')}.c2ln`;
      return Response.json({ session_id: sessionId, state: 'active', token_type: 'DPoP', access_token: access,
        refresh_token: Buffer.alloc(32, 8).toString('base64url'), access_expires_at: new Date(exp * 1000).toISOString() });
    }
    assert.fail(`Unexpected native session fixture request: ${path}`);
  }) as typeof fetch;
  const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } } });
  const host = new NativeSessionRpcHost(configs, () => {}, { keys, fetch: fetchImpl, expectedUserId: '7' }, 'desktop');
  await host.request('native/device', { profile: 'corp', action: 'register', email: 'person@example.test',
    password: 'private-password', device_name: 'Desktop' });
  trusted = true;
  await host.request('native/session', { profile: 'corp', action: 'login', email: 'person@example.test',
    password: 'private-password' });
  return { host, setFetch: (next: typeof custom) => { custom = next; }, cleanup: async () => {
    host.close(); await rm(dir, { recursive: true, force: true });
  } };
}

function fixture() {
  const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } } });
  const notices: unknown[] = [];
  let options!: NativeCapabilityOptions;
  let snapshot: NativeCapabilitySnapshot = { state: 'ready', confirmation: null };
  let confirms = 0;
  let closeEntered = 0;
  let finishClose: (() => void) | null = null;
  let connectImpl: (userId: string, next: NativeCapabilityOptions, signal?: AbortSignal) => Promise<NativeCapabilityController>
    = async (_userId, next) => { options = next; next.onChange(snapshot); return controller; };
  const controller: NativeCapabilityController = {
    snapshot: () => snapshot,
    confirm: async (requestId, confirmed) => {
      assert.equal(requestId, confirmation.requestId); assert.equal(confirmed, true); confirms++;
      snapshot = { state: 'ready', confirmation: null };
    },
    close: async () => { closeEntered++; await new Promise<void>((resolve) => { finishClose = resolve; }); },
  };
  const socket = { assertAvailable() {}, open: async () => { throw new Error('unused'); },
    openCapabilities: async () => { throw new Error('owned by fake session'); } };
  const host = new NativeCapabilityRpcHost(configs, (notice) => notices.push(notice), {
    keys: new NativeDeviceKeyStore(), socket: () => socket,
    capabilityTools: { tools: [{ server: 'local', name: 'ReadFile', inputSchema: { type: 'object' } }],
      call: async () => ({ ok: true }) },
  }, 'vscode', () => ({
    connectCapabilities: (userId, next, signal) => connectImpl(userId, next, signal),
    settleProofOperations: async () => {},
  }));
  return { host, configs, notices, controller, get options() { return options; },
    pending() { snapshot = { state: 'confirmation_required', confirmation }; options.onChange(snapshot); },
    connect(value: typeof connectImpl) { connectImpl = value; },
    confirms: () => confirms, closeEntered: () => closeEntered,
    finishClose: () => { finishClose?.(); finishClose = null; } };
}

test('native capability confirmation consumes only the exact current request once', async () => {
  const f = fixture();
  const connected = await f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  assert.equal(connected.capability_connection?.state, 'ready');
  assert.equal((f.notices[0] as any).view, 'capabilities');
  f.pending();
  const confirmed = await f.host.request('native/confirm-capability', {
    request_id: confirmation.requestId, confirmed: true,
  });
  assert.equal(confirmed.capability_connection?.state, 'ready'); assert.equal(f.confirms(), 1);
  await assert.rejects(f.host.request('native/confirm-capability', {
    request_id: confirmation.requestId, confirmed: true,
  }));
  assert.equal(f.confirms(), 1);
  const closing = f.host.stop(); await new Promise((resolve) => setImmediate(resolve)); f.finishClose(); await closing;
});

test('concurrent capability confirmations latch before account revalidation', async () => {
  const f = fixture();
  await f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  f.pending();
  const decisions = await Promise.allSettled([
    f.host.request('native/confirm-capability', { request_id: confirmation.requestId, confirmed: true }),
    f.host.request('native/confirm-capability', { request_id: confirmation.requestId, confirmed: true }),
  ]);
  assert.equal(decisions.filter((decision) => decision.status === 'fulfilled').length, 1);
  assert.equal(f.confirms(), 1);
  const closing = f.host.stop(); await new Promise((resolve) => setImmediate(resolve)); f.finishClose(); await closing;
});

test('disconnect waits for the owned capability socket to drain and returns closed', async () => {
  const f = fixture();
  await f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  let settled = false;
  const disconnect = f.host.request('native/disconnect-capabilities', { profile: 'corp', user_id: '7' })
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.closeEntered(), 1); assert.equal(settled, false);
  f.finishClose();
  assert.equal((await disconnect).capability_connection?.state, 'closed');
});

test('cancel waits for an aborted in-flight capability connection to settle', async () => {
  const f = fixture();
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.connect(async (_userId, _options, signal) => {
    entered();
    await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { release = resolve; }, { once: true }); });
    throw new DOMException('cancelled', 'AbortError');
  });
  const connecting = f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' }).catch(() => null);
  await started;
  let settled = false;
  const stopping = f.host.stop().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release(); await Promise.all([connecting, stopping]);
  assert.equal(settled, true);
});

test('stop invalidates a connect request still resolving its target', async () => {
  const f = fixture();
  let connects = 0;
  f.connect(async (_userId, next) => { connects++; next.onChange({ state: 'ready', confirmation: null }); return f.controller; });
  const connecting = f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  await f.host.stop();
  await assert.rejects(connecting, /\uc0c1\ud0dc\uac00 \ubcc0\uacbd/);
  assert.equal(connects, 0);
});

test('stop invalidates a replacement connect while its previous controller drains', async () => {
  const f = fixture();
  let connects = 0;
  f.connect(async (_userId, next) => { connects++; next.onChange({ state: 'ready', confirmation: null }); return f.controller; });
  await f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  const replacing = f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  for (let count = 0; count < 20 && f.closeEntered() === 0; count++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.closeEntered(), 1);
  const stopping = f.host.stop();
  f.finishClose();
  await stopping;
  await assert.rejects(replacing, /\uc0c1\ud0dc\uac00 \ubcc0\uacbd/);
  assert.equal(connects, 1);
});

test('session host capability stop aborts active capability REST and waits for its proof drain', async () => {
  const f = await sessionHostFixture();
  let entered!: (signal: AbortSignal) => void;
  let release!: () => void;
  const started = new Promise<AbortSignal>((resolve) => { entered = resolve; });
  try {
    f.setFetch((path, init) => path.endsWith('/capabilities') ? new Promise<Response>((_resolve, reject) => {
      release = () => reject(init.signal?.reason ?? new DOMException('cancelled', 'AbortError'));
      entered(init.signal!);
    }) : undefined);
    const reading = f.host.request('native/capabilities', { profile: 'corp', user_id: '7',
      agent_session_id: confirmation.agentSessionId }).catch((error) => error);
    const signal = await started;
    let stopped = false;
    const stopping = f.host.stopCapabilities().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(stopped, false);
    release();
    const [error] = await Promise.all([reading, stopping]);
    assert.equal(error instanceof Error && error.name === 'AbortError', true);
    assert.equal(stopped, true);
  } finally { await f.cleanup(); }
});

test('session host capability stop waits for every retained capability proof drain', async () => {
  const f = await sessionHostFixture();
  const original = NativeHostSession.prototype.settleProofOperations;
  let entered!: () => void;
  let release!: () => void;
  const settling = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    NativeHostSession.prototype.settleProofOperations = async function () {
      await original.call(this); entered(); await blocked;
    };
    f.setFetch((path) => path.endsWith('/capabilities') ? Promise.resolve(Response.json({
      version: confirmation.agentSessionId, expires_at: Math.floor(Date.now() / 1000) + 60,
      selected_capability_ids: [], capabilities: [],
    })) : undefined);
    await f.host.request('native/capabilities', { profile: 'corp', user_id: '7',
      agent_session_id: confirmation.agentSessionId });
    await settling;
    const next = f.host.request('native/capabilities', { profile: 'corp', user_id: '7',
      agent_session_id: confirmation.agentSessionId }).catch((error) => error);
    let stopped = false;
    const stopping = f.host.stopCapabilities().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await Promise.all([next, stopping]);
    assert.equal(stopped, true);
  } finally {
    NativeHostSession.prototype.settleProofOperations = original;
    release();
    await f.cleanup();
  }
});

test('session host capability stop preserves an ordinary conversation watch', async () => {
  const f = await sessionHostFixture();
  let entered!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => { entered = resolve; });
  try {
    f.setFetch((path, init) => path.endsWith('/agent-state') ? new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered(signal);
    }) : undefined);
    const result = await f.host.request('native/watch', { profile: 'corp', user_id: '7', interval_ms: 200 });
    assert.ok('watch_id' in result && typeof result.watch_id === 'string');
    const signal = await started;
    await f.host.stopCapabilities();
    assert.equal(signal.aborted, false);
    await f.host.request('native/unwatch', { watch_id: result.watch_id });
    assert.equal(signal.aborted, true);
  } finally { await f.cleanup(); }
});

test('profile origin replacement invalidates a pending confirmation owner', async () => {
  const f = fixture();
  await f.host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  f.pending();
  await f.configs.write({ ...defaultConfig(), currentProfile: 'corp',
    profiles: { corp: { serverUrl: 'https://other.example.test' } } });
  await assert.rejects(f.host.request('native/confirm-capability', {
    request_id: confirmation.requestId, confirmed: true,
  }), /현재 소유자/);
  assert.equal(f.confirms(), 0);
  const closing = f.host.stop(); await new Promise((resolve) => setImmediate(resolve)); f.finishClose(); await closing;
});

test('actual built-in catalog can connect within the server description and hello limits', async () => {
  const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } } });
  const snapshot: NativeCapabilitySnapshot = { state: 'ready', confirmation: null };
  const controller: NativeCapabilityController = { snapshot: () => snapshot, confirm: async () => {}, close: async () => {} };
  const socket = { assertAvailable() {}, open: async () => { throw new Error('unused'); },
    openCapabilities: async () => { throw new Error('fake session owns transport'); } };
  let advertised = 0;
  const host = new NativeCapabilityRpcHost(configs, () => {}, {
    keys: new NativeDeviceKeyStore(), socket: () => socket,
  }, 'desktop', () => ({
    connectCapabilities: async (_userId, options) => {
      validateNativeCapabilityOptions(options);
      advertised = options.tools.length;
      assert.ok(Buffer.byteLength(JSON.stringify({ type: 'hello', descriptor_version: 1, tools: options.tools })) <= 65536);
      return controller;
    }, settleProofOperations: async () => {},
  }));
  await host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
  assert.ok(advertised > 0); await host.stop();
});

test('actual built-in provider scopes a native call to the server-attested agent session folder', async () => {
  const agentSessionId = '018f1240-0000-7000-8000-000000000010';
  const otherSessionId = '018f1240-0000-7000-8000-000000000011';
  const root = await mkdtemp(join(tmpdir(), 'xgen-native-context-'));
  const output = join(root, 'native-context.txt');
  const provider = getLocalToolProvider();
  provider.configureFolders((context) => context?.interactionId === agentSessionId ? normalizeLocalFolders([root]) : []);
  const remoteUses: Array<{ interactionId: string; originName: string }> = [];
  const stopRemoteUses = provider.onRemoteUse((use) => remoteUses.push({
    interactionId: use.interactionId, originName: use.originName,
  }));
  const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp',
    profiles: { corp: { serverUrl: origin } } });
  const snapshot: NativeCapabilitySnapshot = { state: 'ready', confirmation: null };
  const controller: NativeCapabilityController = { snapshot: () => snapshot, confirm: async () => {}, close: async () => {} };
  const socket = { assertAvailable() {}, open: async () => { throw new Error('unused'); },
    openCapabilities: async () => { throw new Error('fake session owns transport'); } };
  let options!: NativeCapabilityOptions;
  const host = new NativeCapabilityRpcHost(configs, () => {}, {
    keys: new NativeDeviceKeyStore(), socket: () => socket,
  }, 'desktop', () => ({
    connectCapabilities: async (_userId, value) => { options = value; return controller; },
    settleProofOperations: async () => {},
  }));
  try {
    await host.request('native/connect-capabilities', { profile: 'corp', user_id: '7' });
    await assert.rejects(options.call('local', 'WriteFile', { path: 'native-context.txt', content: 'wrong' },
      new AbortController().signal, { agentSessionId: otherSessionId }), /NO_FOLDER/);
    await assert.rejects(readFile(output, 'utf8'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await options.call('local', 'WriteFile', { path: 'native-context.txt', content: 'session-bound' },
      new AbortController().signal, { agentSessionId });
    assert.equal(await readFile(output, 'utf8'), 'session-bound');
    assert.deepEqual(remoteUses, [{ interactionId: agentSessionId, originName: 'XGEN Agent Session' }]);
  } finally {
    await host.stop();
    stopRemoteUses();
    provider.configureFolders(() => []);
    await rm(root, { recursive: true, force: true });
  }
});
