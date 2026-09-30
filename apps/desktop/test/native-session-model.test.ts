import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopNativeSessionModel } from '../src/renderer/src/native-session-model';
import type { DesktopNativeBridge, DesktopNativeNotice, DesktopNativeReply } from '../src/native-session-types';

const context = { platform_type: 'desktop' as const, profile: 'desktop', server_url: 'https://app.example.test', user_id: '7', watch_id: 'w1' };
const focus = { active_agent_session_id: null, version: 0, event_id: null };
function fixture() {
  let listener!: (n: DesktopNativeNotice) => void; let respond: DesktopNativeBridge['request'] = async () => ({ ok: true, value: context });
  const calls: string[] = []; const rendered: unknown[] = [];
  const bridge: DesktopNativeBridge = { request: (method, params) => { calls.push(method); return respond(method, params); }, onUpdate: (l) => { listener = l; return () => {}; } };
  const model = new DesktopNativeSessionModel(bridge, (v) => rendered.push(v));
  return { model, calls, rendered, notify: (n: DesktopNativeNotice) => listener(n), respond: (f: typeof respond) => { respond = f; } };
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
