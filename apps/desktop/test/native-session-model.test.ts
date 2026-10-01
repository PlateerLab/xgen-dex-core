import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopNativeSessionModel } from '../src/renderer/src/native-session-model';
import type { DesktopNativeBridge, DesktopNativeNotice, DesktopNativeReply } from '../src/native-session-types';

const context = { platform_type: 'desktop' as const, profile: 'desktop', server_url: 'https://app.example.test', user_id: '7', watch_id: 'w1' };
const focus = { active_agent_session_id: null, version: 0, event_id: null };
const conversation = { snapshot: { id: '00000000-0000-4000-8000-000000000001', workflow_id: 'flow', title: 'Shared', current_sequence: 1,
  state_version: 1, message_history_complete: false, latest_turn: { id: '00000000-0000-4000-8000-000000000002', status: 'completed' as const, accepted_sequence: 1 } },
messages: [{ turn_id: '00000000-0000-4000-8000-000000000002', sequence: 1, status: 'completed' as const, input_text: 'hello', output_text: 'world', content_complete: true, source: 'user' as const }], omittedMessages: 2 };
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
