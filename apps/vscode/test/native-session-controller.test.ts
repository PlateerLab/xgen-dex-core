import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InitializeResult, RpcNotification, NativeRpcResult } from '@dex/rpc';
import { NativeSessionController, type NativeSessionViewState } from '../src/native-session-controller';

const focus = { active_agent_session_id: null, version: 0, event_id: null };
const context: NativeRpcResult = { platform_type: 'vscode', profile: 'corp', server_url: 'https://app.example.test', user_id: '7', watch_id: 'w1' };
function fixture(capable = true) {
  let notify!: (n: RpcNotification) => void; let change!: (s: any) => void;
  let respond: (m: string, p: Record<string, unknown>) => Promise<any> = async () => context;
  const calls: string[] = []; const states: NativeSessionViewState[] = [];
  const rpc = { state: 'ready' as const, start: async () => ({ capabilities: capable ? { nativePlatformSession: { platform: 'vscode', storage: 'os-keychain-software' } } : {} }) as InitializeResult,
    request: async <T>(m: string, p: Record<string, unknown> = {}) => { calls.push(m); return respond(m, p) as Promise<T>; },
    onNotification: (f: typeof notify) => { notify = f; return () => {}; }, onStateChange: (f: typeof change) => { change = f; return () => {}; } };
  const controller = new NativeSessionController(rpc, (v) => states.push(v));
  const update = (value: unknown) => notify({ jsonrpc: '2.0', method: 'native/focus', params: value });
  return { controller, calls, states, update, change, respond: (f: typeof respond) => { respond = f; } };
}
test('old engines are rejected without sending native requests', async () => {
  const f = fixture(false);
  await assert.rejects(f.controller.perform('native/session', { action: 'status' }), /지원하는 CLI/);
  assert.deepEqual(f.calls, []); assert.equal(f.states.at(-1)!.focus, null);
});
test('notifications buffered in the response chunk are applied only after matching the acknowledged scope', async () => {
  const f = fixture();
  f.respond(async () => { f.update({ ...context, update: { type: 'focus', user_id: '7', focus } }); return context; });
  await f.controller.watch('corp', '7'); assert.deepEqual(f.states.at(-1), { status: 'connected', focus });
  for (const changed of [{ watch_id: 'old' }, { profile: 'elsewhere' }, { server_url: 'https://other.test' }, { platform_type: 'cli' }, { update: { type: 'focus', user_id: '8', focus } }]) {
    const count = f.states.length; f.update({ ...context, update: { type: 'focus', user_id: '7', focus }, ...changed }); assert.equal(f.states.length, count);
  }
  f.update({ ...context, update: { type: 'reconnecting', user_id: '7' } }); assert.deepEqual(f.states.at(-1), { status: 'reconnecting', focus: null });
  f.update({ ...context, update: { type: 'stopped', user_id: '7' } }); assert.deepEqual(f.states.at(-1), { status: 'stopped', focus: null });
});
test('profile/account reset suppresses delayed results and clears focus immediately', async () => {
  const f = fixture(); let resolve!: (v: NativeRpcResult) => void; let entered!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  f.respond((method) => method === 'native/cancel' ? Promise.resolve(null) : new Promise((r) => { resolve = r; entered(); }));
  const pending = f.controller.perform('native/session', { action: 'login' }); await ready;
  const before = f.controller.connectionVersion; f.controller.reset(); assert.equal(f.controller.connectionVersion, before + 1);
  resolve(context); assert.equal(await pending, null); assert.equal(f.controller.account('corp', context.server_url), null);
  assert.deepEqual(f.states.at(-1), { status: 'idle', focus: null });
});
test('account metadata is scoped by both profile and origin; engine shutdown clears it', async () => {
  const f = fixture(); await f.controller.perform('native/device', { action: 'status' });
  assert.equal(f.controller.account('corp', 'https://app.example.test/'), '7');
  assert.equal(f.controller.account('corp', 'https://other.test'), null); assert.equal(f.controller.account('other', context.server_url), null);
  f.change('stopped'); assert.equal(f.controller.account('corp', context.server_url), null);
});
test('an invalid focus frame never renders unvalidated server data', async () => {
  const f = fixture(); await f.controller.watch('corp', '7');
  f.update({ ...context, update: { type: 'focus', user_id: '7', focus: { active_agent_session_id: 'private-server-secret', version: -1 } } });
  assert.deepEqual(f.states.at(-1), { status: 'stopped', focus: null }); assert.equal(JSON.stringify(f.states).includes('private-server-secret'), false);
  assert.equal(f.calls.at(-1), 'native/unwatch');
  f.update({ ...context, update: { type: 'focus', user_id: '7', focus } });
  assert.equal(f.states.at(-1)!.status, 'stopped');
});
