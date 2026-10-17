import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InitializeResult, NativeCapabilitySnapshot, NativeRpcResult, RpcNotification } from '@dex/rpc';
import { NativeCapabilityController, nativeCapabilityArgumentDisplay,
  type NativeCapabilityConfirmation } from '../src/native-capability-controller';

const envelope = {
  platform_type: 'vscode' as const,
  profile: 'corp',
  server_url: 'https://app.example.test',
  user_id: '7',
};
const confirmation = {
  requestId: '018f1240-0000-7000-8000-000000000001',
  server: 'local',
  tool: 'ReadFile',
  args: { path: 'README.md' },
  expiresAt: Math.floor(Date.now() / 1000) + 60,
  argsSha256: 'a'.repeat(64),
};
const pending = { state: 'confirmation_required' as const, confirmation } satisfies NativeCapabilitySnapshot;
const ready = { state: 'ready' as const, confirmation: null } satisfies NativeCapabilitySnapshot;

test('capability argument display never returns truncated approvable JSON', () => {
  assert.equal(nativeCapabilityArgumentDisplay({ command: '\u001b[31m' })?.includes('\\u001b'), true);
  assert.equal(nativeCapabilityArgumentDisplay({ value: 'x'.repeat(7000) }), null);
});

function fixture(prompt: (value: NativeCapabilityConfirmation) => Promise<boolean | undefined>) {
  let notification!: (value: RpcNotification) => void;
  let state!: (value: any) => void;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let initialized = ({ capabilities: { nativePlatformSession: { platform: 'vscode' as const,
    storage: 'os-keychain-software' as const, canonicalCapabilities: true as const } } }) as InitializeResult;
  let response: (method: string) => NativeRpcResult = (method) => ({ ...envelope,
    capability_connection: method === 'native/connect-capabilities' ? pending : ready });
  const rpc = {
    state: 'ready' as const,
    start: async () => initialized,
    request: async <T>(method: string, params: Record<string, unknown> = {}) => {
      requests.push({ method, params }); return response(method) as T;
    },
    onNotification: (listener: typeof notification) => { notification = listener; return () => {}; },
    onStateChange: (listener: typeof state) => { state = listener; return () => {}; },
  };
  const snapshots: Array<NativeCapabilitySnapshot | null> = [];
  const controller = new NativeCapabilityController(rpc, prompt, (snapshot) => snapshots.push(snapshot));
  return { controller, requests, snapshots, notification, state,
    initialized(value: InitializeResult) { initialized = value; },
    response(value: typeof response) { response = value; } };
}

test('old engines cannot start a local capability connection', async () => {
  const f = fixture(async () => true);
  f.initialized({ capabilities: {} } as InitializeResult);
  await assert.rejects(f.controller.connect('corp', '7'), /지원하는 CLI/);
  assert.equal(f.requests.length, 0);
});

test('a dismissed capability confirmation is denied exactly once, including duplicate notices', async () => {
  const f = fixture(async () => undefined);
  await f.controller.connect('corp', '7');
  f.notification({ jsonrpc: '2.0', method: 'native/capabilities', params: {
    ...envelope, view: 'capabilities', snapshot: pending,
  } });
  await new Promise((resolve) => setImmediate(resolve));
  const confirms = f.requests.filter((request) => request.method === 'native/confirm-capability');
  assert.equal(confirms.length, 1);
  assert.deepEqual(confirms[0]?.params, { request_id: confirmation.requestId, confirmed: false });
});

test('a delayed prompt cannot confirm after account reset or consume a newer owner request', async () => {
  let decide!: (value: boolean) => void;
  const f = fixture(() => new Promise<boolean>((resolve) => { decide = resolve; }));
  await f.controller.connect('corp', '7');
  f.controller.reset(false);
  decide(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.some((request) => request.method === 'native/confirm-capability'), false);
  assert.equal(f.controller.current(), null);
});

test('capability notices from another profile, account or origin are ignored', async () => {
  const f = fixture(async () => false);
  f.response(() => ({ ...envelope, capability_connection: ready }));
  await f.controller.connect('corp', '7');
  const before = f.snapshots.length;
  for (const changed of [{ profile: 'other' }, { user_id: '8' }, { server_url: 'https://other.example.test' }]) {
    f.notification({ jsonrpc: '2.0', method: 'native/capabilities', params: {
      ...envelope, ...changed, view: 'capabilities', snapshot: pending,
    } });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.snapshots.length, before);
  assert.equal(f.requests.some((request) => request.method === 'native/confirm-capability'), false);
});
