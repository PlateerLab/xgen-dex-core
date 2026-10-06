import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blankDesktopNativeView, createDesktopScopedBridge, expectedDesktopNativeOrigin,
  observedDesktopAgentSession, type DesktopNativeSessionBinding } from '../src/renderer/src/native-session-binding';
import type { DesktopNativeSessionModel } from '../src/renderer/src/native-session-model';
import { CanonicalChat } from '../src/renderer/src/views/CanonicalChat';
import type { DesktopNativeBridge, DesktopNativeNotice } from '../src/native-session-types';

test('Workspace binding blocks foreign scope replies and keeps all dispatched write outcomes unknown', async () => {
  const foreign = { platform_type: 'desktop' as const, profile: 'desktop', server_url: 'https://other.example.test',
    user_id: '8', result: { raw: 'foreign-private-data' } };
  const bridge: DesktopNativeBridge = { request: async () => ({ ok: true, value: foreign as any }), onUpdate: () => () => {} };
  const scoped = createDesktopScopedBridge(bridge, 'https://app.example.test', '7');
  const read = await scoped.request('conversation');
  assert.equal(read.ok, false); assert.equal(JSON.stringify(read).includes('foreign-private-data'), false);
  for (const method of ['submit-turn', 'stop-turn', 'create-agent-session', 'switch-agent-focus', 'pick-attachments',
    'upload-attachment', 'recover-attachment', 'cancel-attachment', 'discard-attachments'] as const) {
    const result = await scoped.request(method);
    assert.ok(!result.ok); assert.equal(result.outcome, 'unknown');
  }
});

test('blank and non-HTTPS workspace state cannot expose a native file choice', () => {
  const blank = blankDesktopNativeView();
  assert.deepEqual(blank.attachments, { items: [], busy: false, notice: '' });
  assert.equal(blank.turn.canSubmit, false);
  assert.equal(expectedDesktopNativeOrigin('http://app.example.test'), null);
  assert.equal(expectedDesktopNativeOrigin('https://app.example.test/path'), null);
  assert.equal(expectedDesktopNativeOrigin('https://app.example.test'), 'https://app.example.test');
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

function canonicalAttachmentBinding(status: 'selected' | 'ready'): DesktopNativeSessionBinding {
  const session = '00000000-0000-4000-8000-000000000001'; const attachment = '00000000-0000-4000-8000-000000000002';
  const view = blankDesktopNativeView();
  view.result = { platform_type: 'desktop', profile: 'desktop', server_url: 'https://app.example.test', user_id: '7',
    result: { state: 'active', user_id: '7', session_id: 'native-session' } as any };
  view.conversation = { snapshot: { id: session, workflow_id: 'flow', title: 'Shared', current_sequence: 0,
    state_version: 1, message_history_complete: true, latest_turn: null }, messages: [], omittedMessages: 0 };
  view.catalog.focus = { active_agent_session_id: session, version: 1, event_id: session };
  view.turn = { status: 'idle', canSubmit: true, canRetry: false, canStop: false, notice: '' };
  const base = { selection_id: 'selection-visible', filename: 'visible-report.bin', size_bytes: 4,
    media_type: 'application/octet-stream', sha256: 'a'.repeat(64), status } as const;
  view.attachments = { busy: false, notice: status === 'selected' ? '파일을 업로드하세요.' : '', items: status === 'ready'
    ? [{ ...base, status: 'ready', attachment_id: attachment, receipt: { origin: 'https://app.example.test', user_id: '7',
      session_id: session, workflow_id: 'flow', attachment_id: attachment, filename: base.filename,
      size_bytes: base.size_bytes, media_type: base.media_type, sha256: base.sha256 } }]
    : [base] };
  return { model: {} as DesktopNativeSessionModel, view, draft: 'send with visible file', setDraft: () => {} };
}

test('Canonical chat shows ready attachment metadata before enabling its visible submit', () => {
  const html = renderToStaticMarkup(createElement(CanonicalChat,
    { binding: canonicalAttachmentBinding('ready'), onOpenSettings: () => {} }));
  assert.match(html, /visible-report\.bin/); assert.match(html, /영수증 확인 완료/);
  assert.match(html, /canonical-chat-attachment-cancel-selection-visible/);
  const submit = html.match(/<button id="canonical-chat-submit"[^>]*>/)?.[0];
  assert.ok(submit); assert.equal(submit.includes('disabled'), false);
});

test('Canonical chat visibly blocks an unready attachment and exposes its upload action and notice', () => {
  const html = renderToStaticMarkup(createElement(CanonicalChat,
    { binding: canonicalAttachmentBinding('selected'), onOpenSettings: () => {} }));
  assert.match(html, /visible-report\.bin/); assert.match(html, /상태 선택됨/);
  assert.match(html, /canonical-chat-attachment-upload-selection-visible/);
  assert.match(html, /선택한 모든 파일의 업로드와 영수증 확인을 완료한 뒤 요청을 보내세요/);
  assert.match(html, /파일을 업로드하세요/);
  const submit = html.match(/<button id="canonical-chat-submit"[^>]*>/)?.[0];
  assert.ok(submit); assert.equal(submit.includes('disabled'), true);
});
