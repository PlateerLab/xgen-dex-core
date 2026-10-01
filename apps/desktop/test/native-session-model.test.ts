import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopNativeSessionModel } from '../src/renderer/src/native-session-model';
import type { DesktopNativeBridge, DesktopNativeNotice, DesktopNativeReply } from '../src/native-session-types';

const context = { platform_type: 'desktop' as const, profile: 'desktop', server_url: 'https://app.example.test', user_id: '7', watch_id: 'w1' };
const focus = { active_agent_session_id: null, version: 0, event_id: null };
const conversation = { snapshot: { id: '00000000-0000-4000-8000-000000000001', workflow_id: 'flow', title: 'Shared', current_sequence: 1,
  state_version: 1, message_history_complete: false, latest_turn: { id: '00000000-0000-4000-8000-000000000002', status: 'completed' as const, accepted_sequence: 1 } },
messages: [{ turn_id: '00000000-0000-4000-8000-000000000002', sequence: 1, status: 'completed' as const, input_text: 'hello', output_text: 'world', content_complete: true, source: 'user' as const }], omittedMessages: 2 };
const runningConversation = { ...conversation, snapshot: { ...conversation.snapshot, current_sequence: 2, state_version: 2,
  latest_turn: { id: '00000000-0000-4000-8000-000000000003', status: 'running' as const, accepted_sequence: 2 } } };
function fixture() {
  let listener!: (n: DesktopNativeNotice) => void; let respond: DesktopNativeBridge['request'] = async () => ({ ok: true, value: context });
  const calls: string[] = []; const requests: Array<{ method: string; params?: Record<string, unknown> }> = []; const rendered: unknown[] = [];
  const bridge: DesktopNativeBridge = { request: (method, params) => { calls.push(method); requests.push({ method, params }); return respond(method, params); }, onUpdate: (l) => { listener = l; return () => {}; } };
  const model = new DesktopNativeSessionModel(bridge, (v) => rendered.push(v));
  return { model, calls, requests, rendered, notify: (n: DesktopNativeNotice) => listener(n), respond: (f: typeof respond) => { respond = f; } };
}
test('Desktop applies a buffered focus only after its matching watch ACK', async () => {
  const f = fixture(); f.respond(async () => { f.notify({ type: 'update', value: { ...context, update: { type: 'focus', user_id: '7', focus, source: 'snapshot' } } }); return { ok: true, value: context }; });
  await f.model.execute('watch'); assert.deepEqual(f.model.state.focus, focus); assert.equal(f.model.state.connection, 'connected');
  for (const override of [{ watch_id: 'old' }, { platform_type: 'cli' }, { server_url: 'https://other.test' }, { update: { type: 'focus', user_id: '8', focus } }]) {
    const count = f.rendered.length; f.notify({ type: 'update', value: { ...context, update: { type: 'focus', user_id: '7', focus }, ...override } } as any); assert.equal(f.rendered.length, count);
  }
  f.notify({ type: 'update', value: { ...context, update: { type: 'reconnecting', user_id: '7', retry_in_ms: 200, reason: 'transport' } } }); assert.equal(f.model.state.focus, null);
});
test('main reset clears scope and prevents a delayed account reply from restoring stale state', async () => {
  const f = fixture(); let done!: (r: DesktopNativeReply) => void;
  f.respond(() => new Promise((r) => { done = r; })); const pending = f.model.execute('session', { action: 'login' });
  f.notify({ type: 'cleared' }); done({ ok: true, value: context }); assert.equal(await pending, null); assert.equal(f.model.state.result, null);
});
test('malformed focus stops the acknowledged watch and does not render raw server data', async () => {
  const f = fixture(); await f.model.execute('watch');
  f.notify({ type: 'update', value: { ...context, update: { type: 'focus', user_id: '7', focus: { version: -1, active_agent_session_id: 'private-server-secret' } } } } as any);
  assert.equal(f.model.state.connection, 'stopped'); assert.equal(f.calls.at(-1), 'unwatch'); assert.equal(JSON.stringify(f.rendered).includes('private-server-secret'), false);
  f.notify({ type: 'update', value: { ...context, update: { type: 'focus', user_id: '7', focus, source: 'snapshot' } } }); assert.equal(f.model.state.focus, null);
});
test('UI disposal removes listeners, clears state and sends explicit cancellation', () => {
  const f = fixture(); f.model.dispose(); assert.equal(f.calls.at(-1), 'cancel'); assert.equal(f.model.state.result, null);
});
test('Desktop reads and polls only validated canonical conversation display fields', async () => {
  const f = fixture();
  f.respond(async (method) => method === 'conversation' ? { ok: true, value: { ...context, view: 'conversation',
    conversation: { ...conversation, authScope: 'hidden', eventCursor: 'hidden' }, has_more: true, access_token: 'top-secret' } } : { ok: true, value: context });
  const read = await f.model.execute('conversation');
  assert.deepEqual(read?.conversation, conversation); assert.deepEqual(f.model.state.conversation, conversation);
  assert.equal(JSON.stringify(f.model.state).includes('authScope'), false); assert.equal(JSON.stringify(read).includes('top-secret'), false);
  assert.equal(f.model.state.hasMore, true);
  f.respond(async () => {
    f.notify({ type: 'update', value: { ...context, view: 'conversation', update: { type: 'conversation', user_id: '7', conversation, source: 'snapshot', has_more: false } } });
    return { ok: true, value: { ...context, view: 'conversation', access_token: 'raw-watch-secret', arbitrary: { private: true } } as any };
  });
  await f.model.execute('watch-conversation'); assert.deepEqual(f.model.state.conversation, conversation);
  assert.equal(JSON.stringify(f.rendered).includes('raw-watch-secret'), false);
  assert.equal(JSON.stringify(f.rendered).includes('arbitrary'), false);
  await f.model.stopWatch(); assert.equal(f.calls.at(-1), 'unwatch'); assert.equal(f.model.state.conversation, null);
});
test('Desktop cancels a pending live watch and exact stale ACK cleanup does not clear its replacement', async () => {
  const f = fixture(); let resolveOld!: (reply: DesktopNativeReply) => void; let entered!: () => void; let first = true;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.respond(async (method) => {
    if (method === 'watch-live' && first) {
      first = false; entered(); return new Promise<DesktopNativeReply>((resolve) => { resolveOld = resolve; });
    }
    if (method === 'watch-live') {
      f.notify({ type: 'update', value: { ...context, watch_id: 'new-watch', view: 'conversation',
        update: { type: 'conversation', user_id: '7', conversation, source: 'snapshot', has_more: false } } });
      return { ok: true, value: { ...context, watch_id: 'new-watch', view: 'conversation' } };
    }
    if (method === 'cancel' || method === 'unwatch') return { ok: true, value: { watching: false } };
    return { ok: true, value: context };
  });
  const stale = f.model.execute('watch-live'); await started;
  await f.model.stopWatch(); assert.deepEqual(f.requests.at(-1), { method: 'cancel', params: {} });
  await f.model.execute('watch-live'); assert.equal(f.model.state.transport, 'live-wss'); assert.deepEqual(f.model.state.conversation, conversation);
  resolveOld({ ok: true, value: { ...context, watch_id: 'stale-watch', view: 'conversation' } }); await stale;
  assert.deepEqual(f.requests.at(-1), { method: 'unwatch', params: { watch_id: 'stale-watch' } });
  assert.deepEqual(f.model.state.conversation, conversation); assert.equal(f.model.state.connection, 'connected');
});
test('Desktop rejects malformed conversation notifications and clears data on errors', async () => {
  const f = fixture(); f.respond(async () => ({ ok: true, value: { ...context, view: 'conversation' } }));
  await f.model.execute('watch-conversation');
  f.notify({ type: 'update', value: { ...context, view: 'conversation', update: { type: 'conversation', user_id: '7',
    conversation: { ...conversation, omittedMessages: -1, secret: 'private-conversation-secret' }, source: 'snapshot', has_more: false } } } as any);
  assert.equal(f.model.state.connection, 'stopped'); assert.equal(f.model.state.conversation, null);
  assert.equal(f.calls.at(-1), 'unwatch'); assert.equal(JSON.stringify(f.rendered).includes('private-conversation-secret'), false);
});
test('Desktop retries an unknown submit with the exact original private intent and no renderer scope fields', async () => {
  const f = fixture(); const writes: Array<Record<string, unknown>> = []; let attempts = 0;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'submit-turn') {
      writes.push({ ...params }); attempts++;
      if (attempts === 1) return { ok: false, code: 'network_error', message: 'unknown', outcome: 'unknown' };
      return { ok: true, value: { ...context, agent_session_id: conversation.snapshot.id,
        mutation: { turn_id: '00000000-0000-4000-8000-000000000003', status: 'running', accepted_sequence: 2,
          state_version: 2, replayed: true } } };
    }
    return { ok: true, value: context };
  });
  await f.model.execute('conversation');
  await f.model.submitTurn(' first\nsecond ');
  assert.equal(f.model.state.turn.status, 'unknown'); assert.equal(f.model.state.turn.canRetry, true);
  assert.equal(await f.model.retryTurn(), true);
  assert.equal(f.model.state.turn.status, 'accepted'); assert.equal(attempts, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(writes[0].input_text, ' first\nsecond ');
  assert.equal(typeof writes[0].idempotency_key, 'string');
  for (const forbidden of ['profile', 'user_id', 'server_url', 'platform_type', 'origin']) assert.equal(forbidden in writes[0], false);
});
test('Desktop preserves unknown intent through cancel and same-session focus before an explicit retry', async () => {
  const f = fixture(); const writes: Array<Record<string, unknown>> = []; let attempts = 0;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'submit-turn') {
      writes.push({ ...params }); attempts++;
      return attempts === 1
        ? { ok: false, code: 'network_error', message: 'unknown', outcome: 'unknown' }
        : { ok: true, value: { ...context, agent_session_id: conversation.snapshot.id,
          mutation: { turn_id: '00000000-0000-4000-8000-000000000003', status: 'running', accepted_sequence: 2,
            state_version: 2, replayed: true } } };
    }
    if (method === 'watch') {
      f.notify({ type: 'update', value: { ...context, update: { type: 'focus', user_id: '7',
        focus: { ...focus, active_agent_session_id: conversation.snapshot.id }, source: 'snapshot' } } });
      return { ok: true, value: context };
    }
    if (method === 'cancel') return { ok: true, value: { watching: false } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.submitTurn('same private intent');
  const original = { ...writes[0] }; assert.equal(f.model.state.turn.canRetry, true);
  await f.model.execute('cancel'); assert.equal(f.model.state.turn.status, 'unknown');
  await f.model.execute('watch'); assert.equal(f.model.state.turn.status, 'unknown');
  await f.model.execute('conversation'); assert.equal(f.model.state.turn.canRetry, true);
  await f.model.retryTurn(); assert.deepEqual(writes[1], original);
});
test('Desktop exposes stop acknowledgement before authoritative terminal read and serializes repeated clicks', async () => {
  const f = fixture(); let reads = 0; let release!: (reply: DesktopNativeReply) => void; let reading!: () => void; let stops = 0;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  f.respond(async (method, params) => {
    if (method === 'conversation' && reads++ === 0) return { ok: true, value: { ...context, view: 'conversation',
      conversation: runningConversation, has_more: false } };
    if (method === 'stop-turn') {
      stops++; assert.deepEqual(params, { agent_session_id: runningConversation.snapshot.id,
        turn_id: runningConversation.snapshot.latest_turn.id, expected_state_version: 2 });
      return { ok: true, value: { ...context, agent_session_id: runningConversation.snapshot.id,
        mutation: { turn_id: runningConversation.snapshot.latest_turn.id, state_version: 2, requested: true } } };
    }
    if (method === 'conversation') {
      reading(); return new Promise<DesktopNativeReply>((resolve) => { release = resolve; });
    }
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); assert.equal(f.model.state.turn.canStop, true);
  const first = f.model.stopTurn(); const repeated = f.model.stopTurn(); await readStarted;
  assert.equal(stops, 1); assert.equal(f.model.state.turn.status, 'stop-requested');
  assert.ok(f.rendered.some((item) => (item as any).turn?.status === 'stop-requested'));
  release({ ok: true, value: { ...context, view: 'conversation', conversation: { ...runningConversation,
    snapshot: { ...runningConversation.snapshot, latest_turn: { ...runningConversation.snapshot.latest_turn, status: 'cancelled' } } }, has_more: false } });
  await Promise.all([first, repeated]);
  assert.equal(f.model.state.turn.status, 'idle'); assert.equal(f.model.state.turn.canStop, false);
});
test('Desktop reports a terminal replay receipt as success even when authoritative recovery immediately returns idle', async () => {
  const f = fixture(); let reads = 0;
  const replayed = { ...conversation, snapshot: { ...conversation.snapshot, current_sequence: 2, state_version: 2,
    latest_turn: { id: '00000000-0000-4000-8000-000000000003', status: 'completed' as const, accepted_sequence: 2 } } };
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation',
      conversation: reads++ === 0 ? conversation : replayed, has_more: false } };
    if (method === 'submit-turn') return { ok: true, value: { ...context, agent_session_id: conversation.snapshot.id,
      mutation: { turn_id: replayed.snapshot.latest_turn.id, status: 'completed', accepted_sequence: 2,
        state_version: 2, replayed: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation');
  assert.equal(await f.model.submitTurn('terminal replay input'), true);
  assert.equal(f.model.state.turn.status, 'idle'); assert.equal(f.model.state.turn.request, undefined);
});
test('Desktop rejects malformed Unicode before any bridge write or recovery and returns false safely', async () => {
  const f = fixture();
  f.respond(async (method) => method === 'conversation'
    ? { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } }
    : { ok: true, value: context });
  await f.model.execute('conversation'); const before = f.requests.length;
  assert.equal(await f.model.submitTurn('\ud800'), false);
  assert.equal(f.requests.length, before); assert.equal(f.model.state.error, '대화 입력 형식을 확인하세요.');
  assert.equal(f.model.state.turn.status, 'idle'); assert.equal(f.model.state.turn.request, undefined);
});
test('Desktop pending mutation cancellation reports unknown without exposing its private intent', async () => {
  const f = fixture(); let resolveWrite!: (reply: DesktopNativeReply) => void; let writing!: () => void; let cancelled = false;
  const writeStarted = new Promise<void>((resolve) => { writing = resolve; });
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'submit-turn') {
      writing(); return new Promise<DesktopNativeReply>((resolve) => { resolveWrite = resolve; });
    }
    if (method === 'cancel') { cancelled = true; return { ok: true, value: { watching: false } }; }
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); const pending = f.model.submitTurn('keep this intent'); await writeStarted;
  await f.model.execute('cancel'); assert.equal(cancelled, true);
  resolveWrite({ ok: false, code: 'network_error', message: 'unknown', outcome: 'unknown' });
  await pending;
  assert.equal(f.model.state.turn.status, 'unknown'); assert.equal(f.model.state.turn.canRetry, true);
  assert.equal(JSON.stringify(f.model.state).includes('keep this intent'), false);
});
test('Desktop account clear suppresses a late successful mutation acknowledgement', async () => {
  const f = fixture(); let resolveWrite!: (reply: DesktopNativeReply) => void; let writing!: () => void;
  const writeStarted = new Promise<void>((resolve) => { writing = resolve; });
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'submit-turn') {
      writing(); return new Promise<DesktopNativeReply>((resolve) => { resolveWrite = resolve; });
    }
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); const pending = f.model.submitTurn('old account intent'); await writeStarted;
  f.notify({ type: 'cleared' });
  resolveWrite({ ok: true, value: { ...context, agent_session_id: conversation.snapshot.id,
    mutation: { turn_id: '00000000-0000-4000-8000-000000000003', status: 'accepted', accepted_sequence: 2,
      state_version: 2, replayed: false } } });
  assert.equal(await pending, false);
  assert.equal(f.model.state.result, null); assert.equal(f.model.state.turn.status, 'unavailable');
  assert.equal(f.model.state.turn.request, undefined);
});
