import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankDesktopNativeView, createDesktopScopedBridge, observedDesktopAgentSession } from '../src/renderer/src/native-session-binding';
import type { DesktopNativeBridge, DesktopNativeNotice } from '../src/native-session-types';

test('Workspace binding blocks foreign scope replies and keeps all dispatched write outcomes unknown', async () => {
  const foreign = { platform_type: 'desktop' as const, profile: 'desktop', server_url: 'https://other.example.test',
    user_id: '8', result: { raw: 'foreign-private-data' } };
  const bridge: DesktopNativeBridge = { request: async () => ({ ok: true, value: foreign as any }), onUpdate: () => () => {} };
  const scoped = createDesktopScopedBridge(bridge, 'https://app.example.test', '7');
  const read = await scoped.request('conversation');
  assert.equal(read.ok, false); assert.equal(JSON.stringify(read).includes('foreign-private-data'), false);
  for (const method of ['submit-turn', 'stop-turn', 'create-agent-session', 'switch-agent-focus'] as const) {
    const result = await scoped.request(method);
    assert.ok(!result.ok); assert.equal(result.outcome, 'unknown');
  }
});

test('Workspace binding filters foreign notices while account reset still clears state', () => {
  let receive!: (notice: DesktopNativeNotice) => void;
  let unsubscribed = false; const shown: DesktopNativeNotice[] = [];
  const scoped = createDesktopScopedBridge({ request: async () => ({ ok: true, value: { watching: false } }),
    onUpdate(listener) { receive = listener; return () => { unsubscribed = true; }; } }, 'https://app.example.test', '7');
  const off = scoped.onUpdate((notice) => shown.push(notice));
  const notice = { type: 'update' as const, value: { platform_type: 'desktop', profile: 'desktop',
    server_url: 'https://app.example.test', watch_id: 'w', update: { type: 'reset', user_id: '7' } } };
  for (const change of [{ server_url: 'https://other.example.test' }, { platform_type: 'cli' },
    { profile: 'foreign' }, { update: { type: 'reset', user_id: '8' } }]) {
    receive({ ...notice, value: { ...notice.value, ...change } } as any);
  }
  assert.equal(shown.length, 0);
  receive(notice as DesktopNativeNotice); receive({ type: 'cleared' });
  assert.equal(shown.length, 2); off(); assert.ok(unsubscribed);
});

test('authoritative focus and empty conversation replace stale catalog identity; transient reads retain it', () => {
  const state = blankDesktopNativeView(); const session = '00000000-0000-4000-8000-000000000001';
  state.catalog.focus = { active_agent_session_id: session, version: 1, event_id: session };
  assert.equal(observedDesktopAgentSession(state), session);
  state.focus = { active_agent_session_id: null, version: 2, event_id: session };
  assert.equal(observedDesktopAgentSession(state), null);
  state.focus = null;
  state.conversation = { snapshot: null, messages: [], omittedMessages: 0 };
  assert.equal(observedDesktopAgentSession(state), null);
  assert.equal(observedDesktopAgentSession(blankDesktopNativeView()), undefined);
});
