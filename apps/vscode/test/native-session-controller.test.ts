import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InitializeResult, RpcNotification, NativeRpcResult } from '@dex/rpc';
import { DexRpcError } from '@dex/rpc/client';
import { NativeSessionController, type NativeSessionViewState } from '../src/native-session-controller';

const focus = { active_agent_session_id: null, version: 0, event_id: null };
const context: NativeRpcResult = { platform_type: 'vscode', profile: 'corp', server_url: 'https://app.example.test', user_id: '7', watch_id: 'w1' };
const conversation = { snapshot: { id: '00000000-0000-4000-8000-000000000001', workflow_id: 'flow', title: 'Shared', current_sequence: 1,
  state_version: 1, message_history_complete: false, latest_turn: { id: '00000000-0000-4000-8000-000000000002', status: 'completed' as const, accepted_sequence: 1 } },
messages: [{ turn_id: '00000000-0000-4000-8000-000000000002', sequence: 1, status: 'completed' as const, input_text: 'hello', output_text: 'world', content_complete: true, source: 'user' as const }], omittedMessages: 2 };
const session = (value: NativeSessionViewState) => {
  const { turn: _turn, scope: _scope, connectionVersion: _connectionVersion, ...state } = value;
  return state;
};
function fixture(capable = true, canonical = true, live = true, turns = true) {
  let notify!: (n: RpcNotification) => void; let change!: (s: any) => void;
  let respond: (m: string, p: Record<string, unknown>) => Promise<any> = async () => context;
  const calls: string[] = []; const requests: Array<{ method: string; params: Record<string, unknown> }> = []; const states: NativeSessionViewState[] = [];
  const rpc = { state: 'ready' as const, start: async () => ({ capabilities: capable ? { nativePlatformSession: { platform: 'vscode', storage: 'os-keychain-software', canonicalSessions: true as const, ...(canonical ? { canonicalConversation: true as const } : {}), ...(live ? { canonicalLive: true as const } : {}), ...(turns ? { canonicalTurns: true as const } : {}) } } : {} }) as InitializeResult,
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
  await f.controller.watch('corp', '7'); assert.deepEqual(session(f.states.at(-1)!), { status: 'connected', focus, conversation: null, hasMore: false });
  for (const changed of [{ watch_id: 'old' }, { profile: 'elsewhere' }, { server_url: 'https://other.test' }, { platform_type: 'cli' }, { update: { type: 'focus', user_id: '8', focus } }]) {
    const count = f.states.length; f.update({ ...context, update: { type: 'focus', user_id: '7', focus }, ...changed }); assert.equal(f.states.length, count);
  }
  f.update({ ...context, update: { type: 'reconnecting', user_id: '7' } }); assert.deepEqual(session(f.states.at(-1)!), { status: 'reconnecting', focus: null, conversation: null, hasMore: false });
  f.update({ ...context, update: { type: 'stopped', user_id: '7' } }); assert.deepEqual(session(f.states.at(-1)!), { status: 'stopped', focus: null, conversation: null, hasMore: false });
});
test('profile/account reset suppresses delayed results and clears focus immediately', async () => {
  const f = fixture(); let resolve!: (v: NativeRpcResult) => void; let entered!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  f.respond((method) => method === 'native/cancel' ? Promise.resolve(null) : new Promise((r) => { resolve = r; entered(); }));
  const pending = f.controller.perform('native/session', { action: 'login' }); await ready;
  const before = f.controller.connectionVersion; f.controller.reset(); assert.equal(f.controller.connectionVersion, before + 1);
  resolve(context); assert.equal(await pending, null); assert.equal(f.controller.account('corp', context.server_url), null);
  assert.deepEqual(session(f.states.at(-1)!), { status: 'idle', focus: null, conversation: null, hasMore: false });
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
  assert.deepEqual(session(f.states.at(-1)!), { status: 'stopped', focus: null, conversation: null, hasMore: false }); assert.equal(JSON.stringify(f.states).includes('private-server-secret'), false);
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
test('canonical live capability gates WSS setup before an RPC request', async () => {
  const f = fixture(true, true, false);
  await assert.rejects(f.controller.watchLive('corp', '7'), /실시간 연결/);
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
  assert.deepEqual(session(f.states.at(-1)!), { status: 'connected', focus: null, conversation, hasMore: false });
  await f.controller.stopWatch(); assert.equal(f.calls.at(-1), 'native/unwatch');
  assert.deepEqual(session(f.states.at(-1)!), { status: 'idle', focus: null, conversation: null, hasMore: false });
});
test('stopping a pending live watch cancels it and exact stale ACK cleanup leaves a newer live watch active', async () => {
  const f = fixture(); let resolveOld!: (value: NativeRpcResult) => void; let entered!: () => void; let first = true;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.respond(async (method) => {
    if (method === 'native/watch-live' && first) {
      first = false; entered(); return new Promise<NativeRpcResult>((resolve) => { resolveOld = resolve; });
    }
    if (method === 'native/watch-live') {
      f.conversationUpdate({ ...context, watch_id: 'new-watch', view: 'conversation',
        update: { type: 'conversation', user_id: '7', conversation, source: 'snapshot', has_more: false } });
      return { ...context, watch_id: 'new-watch', view: 'conversation' };
    }
    return context;
  });
  const stale = f.controller.watchLive('corp', '7'); await started;
  await f.controller.stopWatch();
  assert.deepEqual(f.requests.at(-1), { method: 'native/cancel', params: {} });
  await f.controller.watchLive('corp', '7');
  assert.deepEqual(session(f.states.at(-1)!), { status: 'connected', focus: null, conversation, hasMore: false });
  resolveOld({ ...context, watch_id: 'stale-watch', view: 'conversation' }); await stale;
  assert.deepEqual(f.requests.at(-1), { method: 'native/unwatch', params: { watch_id: 'stale-watch' } });
  assert.deepEqual(session(f.states.at(-1)!), { status: 'connected', focus: null, conversation, hasMore: false });
});
test('malformed conversation stops its watch without exposing rejected data', async () => {
  const f = fixture(); f.respond(async () => ({ ...context, view: 'conversation' }));
  await f.controller.watchConversation('corp', '7');
  f.conversationUpdate({ ...context, view: 'conversation', update: { type: 'conversation', user_id: '7',
    conversation: { ...conversation, omittedMessages: -1, secret: 'private-conversation-secret' }, source: 'snapshot', has_more: false } });
  assert.equal(f.states.at(-1)!.status, 'stopped'); assert.equal(f.calls.at(-1), 'native/unwatch');
  assert.equal(JSON.stringify(f.states).includes('private-conversation-secret'), false);
});

test('canonical turn capability and verified host metadata gate writes while preserving exact input', async () => {
  const unavailable = fixture(true, true, true, false);
  unavailable.respond(async (method) => method === 'native/conversation'
    ? { ...context, view: 'conversation', conversation, has_more: false }
    : { ...context, view: 'conversation' });
  await unavailable.controller.conversation('corp', '7');
  await unavailable.controller.submitTurn('must stay local');
  assert.equal(unavailable.calls.includes('native/submit-turn'), false);
  assert.equal(unavailable.states.at(-1)?.turn?.status, 'unavailable');

  const f = fixture();
  const submittedTurn = '00000000-0000-4000-8000-000000000003';
  let resolveMutation!: (value: NativeRpcResult) => void;
  let submitEntered!: () => void;
  const entered = new Promise<void>((resolve) => { submitEntered = resolve; });
  let watch = 0;
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/submit-turn') {
      submitEntered();
      return new Promise<NativeRpcResult>((resolve) => { resolveMutation = resolve; });
    }
    if (method === 'native/watch-live') {
      const watchId = `turn-watch-${++watch}`;
      f.conversationUpdate({ ...context, watch_id: watchId, view: 'conversation',
        update: { type: 'conversation', user_id: '7', conversation, source: 'snapshot', has_more: false } });
      return { ...context, watch_id: watchId, view: 'conversation' };
    }
    return context;
  });
  await f.controller.conversation('corp', '7');
  await assert.rejects(f.controller.submitTurn('😀'.repeat(65_537)), TypeError);
  assert.equal(f.requests.some((request) => request.method === 'native/submit-turn'), false);
  const raw = '  first line\nsecond line  ';
  const first = f.controller.submitTurn(raw);
  await entered;
  const duplicate = f.controller.submitTurn('must not dispatch');
  resolveMutation({ ...context, agent_session_id: conversation.snapshot!.id, mutation: {
    turn_id: submittedTurn, status: 'accepted', accepted_sequence: 2, state_version: 2, replayed: false,
  } });
  await Promise.all([first, duplicate]);
  const writes = f.requests.filter((request) => request.method === 'native/submit-turn');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.params.input_text, raw);
  assert.equal(writes[0]!.params.profile, 'corp');
  assert.equal(writes[0]!.params.user_id, '7');
  assert.equal(writes[0]!.params.agent_session_id, conversation.snapshot!.id);
  assert.equal(typeof writes[0]!.params.idempotency_key, 'string');
  assert.equal(f.states.at(-1)?.turn?.status, 'accepted');
});

test('unknown mutation keeps one host-owned request for explicit same-request retry and reset clears it', async () => {
  const f = fixture();
  const submittedTurn = '00000000-0000-4000-8000-000000000003';
  let attempts = 0;
  let watch = 0;
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/watch-live') {
      const watchId = `retry-watch-${++watch}`;
      f.conversationUpdate({ ...context, watch_id: watchId, view: 'conversation',
        update: { type: 'conversation', user_id: '7', conversation, source: 'snapshot', has_more: false } });
      return { ...context, watch_id: watchId, view: 'conversation' };
    }
    if (method === 'native/watch') {
      f.update({ ...context, update: { type: 'focus', user_id: '7', focus: {
        active_agent_session_id: conversation.snapshot!.id, version: 1, event_id: null,
      } } });
      return context;
    }
    if (method === 'native/submit-turn') {
      attempts++;
      if (attempts === 1) throw new DexRpcError('private transport detail', -32603, {
        code: 'network_error', details: { outcome: 'unknown', private: 'must not render' },
      });
      return { ...context, agent_session_id: conversation.snapshot!.id, mutation: {
        turn_id: submittedTurn, status: 'running', accepted_sequence: 2, state_version: 2, replayed: true,
      } };
    }
    return context;
  });
  await f.controller.conversation('corp', '7');
  await f.controller.submitTurn('same request');
  assert.equal(f.states.at(-1)?.turn?.status, 'unknown');
  assert.equal(f.states.at(-1)?.turn?.canRetry, true);
  assert.equal(JSON.stringify(f.states).includes('private transport detail'), false);
  assert.equal(JSON.stringify(f.states).includes('must not render'), false);
  const first = f.requests.find((request) => request.method === 'native/submit-turn')!;
  f.conversationUpdate({ ...context, watch_id: 'retry-watch-1', view: 'conversation',
    update: { type: 'conversation', user_id: '7', conversation: { ...conversation, omittedMessages: -1 }, source: 'snapshot', has_more: false } });
  assert.equal(f.states.at(-1)?.conversation, null);
  assert.equal(f.states.at(-1)?.turn?.status, 'unknown');
  assert.equal(f.states.at(-1)?.turn?.canRetry, false);
  assert.deepEqual(f.states.at(-1)?.turn?.request, first.params.idempotency_key ? {
    operation: 'submit', agent_session_id: conversation.snapshot!.id, expected_state_version: 1,
    idempotency_key: first.params.idempotency_key,
  } : undefined);
  await f.controller.conversation('corp', '7');
  assert.equal(f.states.at(-1)?.turn?.canRetry, true);
  await f.controller.stopWatch();
  assert.equal(f.states.at(-1)?.conversation, null);
  assert.equal(f.states.at(-1)?.turn?.status, 'unknown');
  assert.equal(f.states.at(-1)?.turn?.canRetry, false);
  await f.controller.watchLive('corp', '7');
  assert.equal(f.states.at(-1)?.turn?.canRetry, true);
  await f.controller.perform('native/session', { profile: 'corp', user_id: '7', action: 'status' });
  assert.equal(f.states.at(-1)?.conversation, null);
  assert.equal(f.states.at(-1)?.turn?.status, 'unknown');
  assert.equal(f.states.at(-1)?.turn?.canRetry, false);
  assert.equal(f.states.at(-1)?.turn?.request?.idempotency_key, first.params.idempotency_key);
  await f.controller.watch('corp', '7');
  assert.equal(f.states.at(-1)?.focus?.active_agent_session_id, conversation.snapshot!.id);
  assert.equal(f.states.at(-1)?.turn?.status, 'unknown');
  assert.equal(f.states.at(-1)?.turn?.request?.idempotency_key, first.params.idempotency_key);
  await f.controller.conversation('corp', '7');
  assert.equal(f.states.at(-1)?.turn?.canRetry, true);
  await f.controller.retryTurn();
  const writes = f.requests.filter((request) => request.method === 'native/submit-turn');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1]!.params, first.params);
  f.controller.reset(false);
  assert.equal(f.states.at(-1)?.turn?.canRetry, false);
  assert.equal(f.states.at(-1)?.turn?.request, undefined);
});

test('explicit conversation refresh waits for a dispatched mutation and its authoritative recovery', async () => {
  const f = fixture();
  const submittedTurn = '00000000-0000-4000-8000-000000000003';
  const running = { ...conversation, snapshot: { ...conversation.snapshot!, current_sequence: 2, state_version: 2,
    latest_turn: { id: submittedTurn, status: 'running' as const, accepted_sequence: 2 } } };
  let resolveMutation!: (value: NativeRpcResult) => void;
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation',
      conversation: reads++ === 0 ? conversation : running, has_more: false };
    if (method === 'native/submit-turn') {
      entered();
      return new Promise<NativeRpcResult>((resolve) => { resolveMutation = resolve; });
    }
    if (method === 'native/watch-live') {
      f.conversationUpdate({ ...context, watch_id: 'serialized-watch', view: 'conversation',
        update: { type: 'conversation', user_id: '7', conversation: running, source: 'snapshot', has_more: false } });
      return { ...context, watch_id: 'serialized-watch', view: 'conversation' };
    }
    return context;
  });
  await f.controller.conversation('corp', '7');
  const mutation = f.controller.submitTurn('serialized');
  await sending;
  const refresh = f.controller.conversation('corp', '7');
  assert.equal(f.requests.filter((request) => request.method === 'native/conversation').length, 1);
  resolveMutation({ ...context, agent_session_id: conversation.snapshot!.id, mutation: {
    turn_id: submittedTurn, status: 'accepted', accepted_sequence: 2, state_version: 2, replayed: false,
  } });
  await Promise.all([mutation, refresh]);
  assert.deepEqual(f.requests.map((request) => request.method).slice(-3),
    ['native/conversation', 'native/watch-live', 'native/conversation']);
  assert.equal(f.states.at(-1)?.turn?.status, 'accepted');
  assert.equal(f.states.at(-1)?.turn?.canStop, true);
});

test('an authoritative null focus clears a preserved unknown request for the old session', async () => {
  const f = fixture();
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/submit-turn') throw new DexRpcError('lost', -32603, {
      code: 'network_error', details: { outcome: 'unknown' },
    });
    if (method === 'native/watch-live') {
      f.conversationUpdate({ ...context, view: 'conversation', update: { type: 'conversation', user_id: '7',
        conversation, source: 'snapshot', has_more: false } });
      return { ...context, view: 'conversation' };
    }
    if (method === 'native/watch') {
      f.update({ ...context, update: { type: 'focus', user_id: '7', focus: {
        active_agent_session_id: null, version: 2, event_id: null,
      } } });
      return context;
    }
    return context;
  });
  await f.controller.conversation('corp', '7');
  await f.controller.submitTurn('old session');
  assert.equal(f.states.at(-1)?.turn?.status, 'unknown');
  await f.controller.watch('corp', '7');
  assert.equal(f.states.at(-1)?.focus?.active_agent_session_id, null);
  assert.equal(f.states.at(-1)?.turn?.request, undefined);
  assert.equal(f.states.at(-1)?.turn?.canRetry, false);
});

test('stop targets the exact latest verified running turn and authoritative terminal state re-enables submit', async () => {
  const f = fixture();
  const runningTurn = '00000000-0000-4000-8000-000000000003';
  const running = { ...conversation, snapshot: { ...conversation.snapshot!, current_sequence: 2, state_version: 2,
    latest_turn: { id: runningTurn, status: 'running' as const, accepted_sequence: 2 } } };
  const terminal = { ...running, snapshot: { ...running.snapshot, state_version: 3,
    latest_turn: { id: runningTurn, status: 'cancelled' as const, accepted_sequence: 2 } } };
  let reads = 0;
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation',
      conversation: reads++ === 0 ? running : terminal, has_more: false };
    if (method === 'native/stop-turn') return { ...context, agent_session_id: running.snapshot.id, mutation: {
      turn_id: runningTurn, state_version: 2, requested: true,
    } };
    if (method === 'native/watch-live') {
      f.conversationUpdate({ ...context, watch_id: 'stop-watch', view: 'conversation',
        update: { type: 'conversation', user_id: '7', conversation: terminal, source: 'snapshot', has_more: false } });
      return { ...context, watch_id: 'stop-watch', view: 'conversation' };
    }
    return context;
  });
  await f.controller.conversation('corp', '7');
  assert.equal(f.states.at(-1)?.turn?.canStop, true);
  await f.controller.stopTurn();
  const stop = f.requests.find((request) => request.method === 'native/stop-turn')!;
  assert.equal(stop.params.agent_session_id, running.snapshot.id);
  assert.equal(stop.params.turn_id, runningTurn);
  assert.equal(stop.params.expected_state_version, 2);
  assert.equal(f.states.at(-1)?.turn?.status, 'idle');
  assert.equal(f.states.at(-1)?.turn?.canSubmit, true);
  assert.equal(f.states.at(-1)?.turn?.canStop, false);
});

test('switching verified account clears an unknown request before a stale result can render', async () => {
  const f = fixture();
  let reject!: (error: unknown) => void;
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/submit-turn') {
      entered();
      return new Promise((_resolve, fail) => { reject = fail; });
    }
    return context;
  });
  await f.controller.conversation('corp', '7');
  const pending = f.controller.submitTurn('old account request');
  await sending;
  const switched = f.controller.conversation('corp', '8');
  reject(new DexRpcError('lost', -32603, { code: 'network_error', details: { outcome: 'unknown' } }));
  await pending;
  await assert.rejects(switched, /범위를 확인/);
  assert.equal(f.states.at(-1)?.turn?.canRetry, false);
  assert.equal(f.states.at(-1)?.turn?.request, undefined);
});

test('Canonical session lifecycle uses verified focus CAS, blocks arbitrary IDs, and never retries an unknown create', async () => {
  const f = fixture(); const target = conversation.snapshot!.id;
  const event = '00000000-0000-4000-8000-000000000010'; let creates = 0; let catalogs = 0;
  const catalog = { focus: { active_agent_session_id: target, version: 3, event_id: event }, sessions: { items: [{
    id: target, workflow_id: 'flow', title: 'Shared', status: 'active' as const, current_sequence: 1, state_version: 1,
  }], next_cursor: null, has_more: false } };
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/agent-sessions') { catalogs++; return { ...context, ...catalog }; }
    if (method === 'native/create-agent-session') {
      creates++; throw new DexRpcError('lost', -32603, { code: 'network_error', details: { outcome: 'unknown' } });
    }
    if (method === 'native/switch-agent-focus') return { ...context, focus: catalog.focus };
    return context;
  });
  await f.controller.conversation('corp', '7'); await f.controller.refreshAgentSessions('corp', '7');
  await assert.rejects(f.controller.switchAgentFocus('00000000-0000-4000-8000-000000000099'), /내 활성 Agent 세션/);
  assert.equal(f.calls.includes('native/switch-agent-focus'), false);
  await f.controller.createAgentSession('flow', 'New');
  assert.equal(creates, 1); assert.equal(f.states.at(-1)?.catalog?.writeBlocked, true);
  await assert.rejects(f.controller.switchAgentFocus(target), /명시적으로 새로 고쳐/);
  assert.equal(creates, 1);
  await f.controller.refreshAgentSessions('corp', '7');
  assert.equal(catalogs, 2); assert.equal(f.states.at(-1)?.catalog?.writeBlocked, false);
  await f.controller.switchAgentFocus(target);
  const write = f.requests.find((request) => request.method === 'native/switch-agent-focus')!;
  assert.deepEqual(write.params, { profile: 'corp', user_id: '7', active_agent_session_id: target, expected_version: 3 });
});

test('a safe focus CAS conflict updates only verified focus and does not retry', async () => {
  const f = fixture(); const target = conversation.snapshot!.id;
  const event = '00000000-0000-4000-8000-000000000010';
  const current = { active_agent_session_id: null, version: 4, event_id: '00000000-0000-4000-8000-000000000011' };
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/agent-sessions') return { ...context, focus: { active_agent_session_id: target, version: 3, event_id: event },
      sessions: { items: [{ id: target, workflow_id: 'flow', title: 'Shared', status: 'active', current_sequence: 1, state_version: 1 }], next_cursor: null, has_more: false } };
    if (method === 'native/switch-agent-focus') throw new DexRpcError('conflict', -32603, { code: 'usage_error', details: {
      outcome: 'rejected', status: 409, conflict: { code: 'FOCUS_VERSION_CONFLICT', current, private: 'hidden' },
    } });
    return context;
  });
  await f.controller.conversation('corp', '7'); await f.controller.refreshAgentSessions('corp', '7');
  await f.controller.switchAgentFocus(null);
  assert.deepEqual(f.states.at(-1)?.catalog?.focus, current);
  assert.equal(f.states.at(-1)?.catalog?.writeBlocked, true);
  assert.equal(f.states.at(-1)?.conversation, null);
  assert.equal(f.requests.filter((request) => request.method === 'native/switch-agent-focus').length, 1);
  await assert.rejects(f.controller.switchAgentFocus(null), /명시적으로 새로 고쳐/);
  assert.equal(JSON.stringify(f.states).includes('hidden'), false);
});

test('catalog refresh waits for an in-flight canonical read before issuing its request', async () => {
  const f = fixture(); let finish!: (value: NativeRpcResult) => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.respond(async (method) => {
    if (method === 'native/conversation') {
      entered(); return new Promise<NativeRpcResult>((resolve) => { finish = resolve; });
    }
    if (method === 'native/agent-sessions') return { ...context, focus,
      sessions: { items: [], next_cursor: null, has_more: false } };
    return context;
  });
  const read = f.controller.conversation('corp', '7'); await started;
  const refresh = f.controller.refreshAgentSessions('corp', '7');
  assert.deepEqual(f.calls, ['native/conversation']);
  finish({ ...context, view: 'conversation', conversation, has_more: false });
  await Promise.all([read, refresh]);
  assert.deepEqual(f.calls, ['native/conversation', 'native/agent-sessions']);
});

test('catalog focus changes and credential operations clear stale conversation and catalog scope', async () => {
  const f = fixture();
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/agent-sessions') return { ...context, focus,
      sessions: { items: [], next_cursor: null, has_more: false } };
    return context;
  });
  await f.controller.conversation('corp', '7'); assert.ok(f.states.at(-1)?.conversation?.snapshot);
  await f.controller.refreshAgentSessions('corp', '7');
  assert.equal(f.states.at(-1)?.catalog?.focus?.active_agent_session_id, null);
  assert.equal(f.states.at(-1)?.conversation, null);
  await f.controller.perform('native/session', { profile: 'corp', user_id: '7', action: 'logout', password: 'x' });
  assert.equal(f.states.at(-1)?.catalog, undefined);
});

test('lifecycle acknowledgements from a different HTTPS origin are rejected and lock further writes', async () => {
  const f = fixture(); const target = conversation.snapshot!.id;
  const event = '00000000-0000-4000-8000-000000000010';
  f.respond(async (method) => {
    if (method === 'native/conversation') return { ...context, view: 'conversation', conversation, has_more: false };
    if (method === 'native/agent-sessions') return { ...context, focus: { active_agent_session_id: target, version: 3, event_id: event },
      sessions: { items: [{ id: target, workflow_id: 'flow', title: 'Shared', status: 'active', current_sequence: 1, state_version: 1 }], next_cursor: null, has_more: false } };
    if (method === 'native/switch-agent-focus') return { ...context, server_url: 'https://other.example.test',
      focus: { active_agent_session_id: null, version: 4, event_id: '00000000-0000-4000-8000-000000000011' } };
    return context;
  });
  await f.controller.conversation('corp', '7'); await f.controller.refreshAgentSessions('corp', '7');
  await assert.rejects(f.controller.switchAgentFocus(null), /서버 범위/);
  assert.equal(f.states.at(-1)?.catalog?.writeBlocked, true);
  assert.equal(f.states.at(-1)?.catalog?.focus?.active_agent_session_id, target);
});
