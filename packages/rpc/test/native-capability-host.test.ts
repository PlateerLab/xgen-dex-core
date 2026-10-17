import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateNativeCapabilityOptions,
  MemoryConfigStore,
  NativeDeviceKeyStore,
  defaultConfig,
  type NativeCapabilityController,
  type NativeCapabilityOptions,
  type NativeCapabilitySnapshot,
} from '@dex/engine';
import { NativeCapabilityRpcHost } from '../src/native-capability-host';

const origin = 'https://app.example.test';
const confirmation = {
  requestId: '018f1240-0000-7000-8000-000000000001',
  server: 'local',
  tool: 'ReadFile',
  args: Object.freeze({ path: 'README.md' }),
  expiresAt: Math.floor(Date.now() / 1000) + 60,
  argsSha256: 'a'.repeat(64),
};

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
