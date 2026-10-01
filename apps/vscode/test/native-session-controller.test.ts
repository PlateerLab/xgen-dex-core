import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InitializeResult, RpcNotification, NativeRpcResult } from '@dex/rpc';
import { NativeSessionController, type NativeSessionViewState } from '../src/native-session-controller';

const focus = { active_agent_session_id: null, version: 0, event_id: null };
const context: NativeRpcResult = { platform_type: 'vscode', profile: 'corp', server_url: 'https://app.example.test', user_id: '7', watch_id: 'w1' };
const conversation = { snapshot: { id: '00000000-0000-4000-8000-000000000001', workflow_id: 'flow', title: 'Shared', current_sequence: 1,
  state_version: 1, message_history_complete: false, latest_turn: { id: '00000000-0000-4000-8000-000000000002', status: 'completed' as const, accepted_sequence: 1 } },
messages: [{ turn_id: '00000000-0000-4000-8000-000000000002', sequence: 1, status: 'completed' as const, input_text: 'hello', output_text: 'world', content_complete: true, source: 'user' as const }], omittedMessages: 2 };
function fixture(capable = true, canonical = true) {
  let notify!: (n: RpcNotification) => void; let change!: (s: any) => void;
  let respond: (m: string, p: Record<string, unknown>) => Promise<any> = async () => context;
  const calls: string[] = []; const requests: Array<{ method: string; params: Record<string, unknown> }> = []; const states: NativeSessionViewState[] = [];
  const rpc = { state: 'ready' as const, start: async () => ({ capabilities: capable ? { nativePlatformSession: { platform: 'vscode', storage: 'os-keychain-software', ...(canonical ? { canonicalConversation: true as const } : {}) } } : {} }) as InitializeResult,
    request: async <T>(m: string, p: Record<string, unknown> = {}) => { calls.push(m); requests.push({ method: m, params: p }); return respond(m, p) as Promise<T>; },
    onNotification: (f: typeof notify) => { notify = f; return () => {}; }, onStateChange: (f: typeof change) => { change = f; return () => {}; } };
  const controller = new NativeSessionController(rpc, (v) => states.push(v));
  const update = (value: unknown) => notify({ jsonrpc: '2.0', method: 'native/focus', params: value });
  const conversationUpdate = (value: unknown) => notify({ jsonrpc: '2.0', method: 'native/conversation', params: value });
  return { controller, calls, requests, states, update, conversationUpdate, change, respond: (f: typeof respond) => { respond = f; } };
}
test('old engines are rejected without sending native requests', async () => {
  const f = fixture(false);
  await assert.rejects(f.controller.perform('native/session', { action: 'status' }), /지원하는 CLI/);
  assert.deepEqual(f.calls, []); assert.equal(f.states.at(-1)!.focus, null);
});
test('notifications buffered in the response chunk are applied only after matching the acknowledged scope', async () => {
  const f = fixture();
  f.respond(async () => { f.update({ ...context, update: { type: 'focus', user_id: '7', focus } }); return context; });
  await f.controller.watch('corp', '7'); assert.deepEqual(f.states.at(-1), { status: 'connected', focus, conversation: null, hasMore: false });
  for (const changed of [{ watch_id: 'old' }, { profile: 'elsewhere' }, { server_url: 'https://other.test' }, { platform_type: 'cli' }, { update: { type: 'focus', user_id: '8', focus } }]) {
    const count = f.states.length; f.update({ ...context, update: { type: 'focus', user_id: '7', focus }, ...changed }); assert.equal(f.states.length, count);
  }
  f.update({ ...context, update: { type: 'reconnecting', user_id: '7' } }); assert.deepEqual(f.states.at(-1), { status: 'reconnecting', focus: null, conversation: null, hasMore: false });
  f.update({ ...context, update: { type: 'stopped', user_id: '7' } }); assert.deepEqual(f.states.at(-1), { status: 'stopped', focus: null, conversation: null, hasMore: false });
});
test('profile/account reset suppresses delayed results and clears focus immediately', async () => {
  const f = fixture(); let resolve!: (v: NativeRpcResult) => void; let entered!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  f.respond((method) => method === 'native/cancel' ? Promise.resolve(null) : new Promise((r) => { resolve = r; entered(); }));
  const pending = f.controller.perform('native/session', { action: 'login' }); await ready;
  const before = f.controller.connectionVersion; f.controller.reset(); assert.equal(f.controller.connectionVersion, before + 1);
  resolve(context); assert.equal(await pending, null); assert.equal(f.controller.account('corp', context.server_url), null);
  assert.deepEqual(f.states.at(-1), { status: 'idle', focus: null, conversation: null, hasMore: false });
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
  assert.deepEqual(f.states.at(-1), { status: 'stopped', focus: null, conversation: null, hasMore: false }); assert.equal(JSON.stringify(f.states).includes('private-server-secret'), false);
  assert.equal(f.calls.at(-1), 'native/unwatch');
  f.update({ ...context, update: { type: 'focus', user_id: '7', focus } });
  assert.equal(f.states.at(-1)!.status, 'stopped');
});
test('canonical conversation capability gates read and polling without a focus fallback', async () => {
  const f = fixture(true, false);
  await assert.rejects(f.controller.conversation('corp', '7'), /공유 대화/);
  await assert.rejects(f.controller.watchConversation('corp', '7'), /공유 대화/);
  assert.deepEqual(f.calls, []);
});
test('conversation read and buffered polling publish only validated display fields', async () => {
  const f = fixture();
  f.respond(async (method) => method === 'native/conversation'
    ? { ...context, view: 'conversation', conversation: { ...conversation, authScope: 'hidden' }, has_more: true, access_token: 'top-secret' }
    : context);
  const read = await f.controller.conversation('corp', '7');
  assert.deepEqual(read?.conversation, conversation); assert.equal(JSON.stringify(read).includes('top-secret'), false);
  assert.equal('authScope' in (read?.conversation as any), false);
  f.respond(async () => {
    f.conversationUpdate({ ...context, view: 'conversation', update: { type: 'conversation', user_id: '7', conversation, source: 'snapshot', has_more: false } });
    return { ...context, view: 'conversation' };
  });
  await f.controller.watchConversation('corp', '7');
  assert.deepEqual(f.states.at(-1), { status: 'connected', focus: null, conversation, hasMore: false });
  await f.controller.stopWatch(); assert.equal(f.calls.at(-1), 'native/unwatch');
  assert.deepEqual(f.states.at(-1), { status: 'idle', focus: null, conversation: null, hasMore: false });
});
test('stopping a pending conversation watch cancels it and an exact stale ACK cleanup leaves a newer watch active', async () => {
  const f = fixture(); let resolveOld!: (value: NativeRpcResult) => void; let entered!: () => void; let first = true;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.respond(async (method) => {
    if (method === 'native/watch-conversation' && first) {
      first = false; entered(); return new Promise<NativeRpcResult>((resolve) => { resolveOld = resolve; });
    }
    if (method === 'native/watch-conversation') return { ...context, watch_id: 'new-watch', view: 'conversation' };
    return context;
  });
  const stale = f.controller.watchConversation('corp', '7'); await started;
  await f.controller.stopWatch();
  assert.deepEqual(f.requests.at(-1), { method: 'native/cancel', params: {} });
  await f.controller.watchConversation('corp', '7');
  resolveOld({ ...context, watch_id: 'stale-watch', view: 'conversation' }); await stale;
  assert.deepEqual(f.requests.at(-1), { method: 'native/unwatch', params: { watch_id: 'stale-watch' } });
  f.conversationUpdate({ ...context, watch_id: 'new-watch', view: 'conversation',
    update: { type: 'conversation', user_id: '7', conversation, source: 'snapshot', has_more: false } });
  assert.deepEqual(f.states.at(-1), { status: 'connected', focus: null, conversation, hasMore: false });
});
test('malformed conversation stops its watch without exposing rejected data', async () => {
  const f = fixture(); f.respond(async () => ({ ...context, view: 'conversation' }));
  await f.controller.watchConversation('corp', '7');
  f.conversationUpdate({ ...context, view: 'conversation', update: { type: 'conversation', user_id: '7',
    conversation: { ...conversation, omittedMessages: -1, secret: 'private-conversation-secret' }, source: 'snapshot', has_more: false } });
  assert.equal(f.states.at(-1)!.status, 'stopped'); assert.equal(f.calls.at(-1), 'native/unwatch');
  assert.equal(JSON.stringify(f.states).includes('private-conversation-secret'), false);
});
