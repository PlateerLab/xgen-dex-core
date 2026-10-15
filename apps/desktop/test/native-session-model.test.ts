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
const sessionId = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const ownedSession = (value: number, title = `Session ${value}`) => ({ id: sessionId(value), workflow_id: `flow-${value}`, title,
  status: 'active' as const, current_sequence: value, state_version: Math.max(1, value) });
const attachmentId = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const selectedAttachment = (selectionId: string, name: string, digest: string) => ({ selection_id: selectionId, filename: name,
  size_bytes: 4, media_type: 'application/octet-stream', sha256: digest, status: 'selected' as const });
const uncertainAttachment = (selectionId: string, name: string, digest: string, id: string) => ({
  ...selectedAttachment(selectionId, name, digest), status: 'uncertain' as const, attachment_id: id,
});
const readyAttachment = (selectionId: string, name: string, digest: string, id: string) => ({
  ...selectedAttachment(selectionId, name, digest), status: 'ready' as const, attachment_id: id,
  receipt: { origin: context.server_url, user_id: context.user_id, session_id: conversation.snapshot.id,
    workflow_id: conversation.snapshot.workflow_id, attachment_id: id, filename: name, size_bytes: 4,
    media_type: 'application/octet-stream', sha256: digest },
});
const attachmentReply = (attachments: readonly unknown[]): DesktopNativeReply => ({ ok: true, value: { ...context,
  agent_session_id: conversation.snapshot.id, workflow_id: conversation.snapshot.workflow_id, attachments: attachments as any } });
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

test('Desktop recovers an unknown upload and submits every ready receipt in selected order', async () => {
  const f = fixture(); const firstSelection = 'selection-a'; const secondSelection = 'selection-b';
  const firstId = attachmentId(31); const secondId = attachmentId(32);
  const firstDigest = 'a'.repeat(64); const secondDigest = 'b'.repeat(64);
  const selected = [selectedAttachment(firstSelection, 'first.bin', firstDigest),
    selectedAttachment(secondSelection, 'second.bin', secondDigest)];
  const uncertain = [uncertainAttachment(firstSelection, 'first.bin', firstDigest, firstId), selected[1]!];
  const firstReady = [readyAttachment(firstSelection, 'first.bin', firstDigest, firstId), selected[1]!];
  const allReady = [firstReady[0]!, readyAttachment(secondSelection, 'second.bin', secondDigest, secondId)];
  const writes: Record<string, unknown>[] = []; let submitAttempts = 0;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'pick-attachments') return attachmentReply(selected);
    if (method === 'upload-attachment' && params?.selection_id === firstSelection) {
      return { ok: false, code: 'network_error', message: 'private transport details', outcome: 'unknown' };
    }
    if (method === 'attachments') return attachmentReply(uncertain);
    if (method === 'recover-attachment') return attachmentReply(firstReady);
    if (method === 'upload-attachment' && params?.selection_id === secondSelection) return attachmentReply(allReady);
    if (method === 'submit-turn') {
      writes.push(structuredClone(params ?? {})); submitAttempts++;
      if (submitAttempts === 1) return { ok: false, code: 'network_error', message: 'lost acknowledgement', outcome: 'unknown' };
      return { ok: true, value: { ...context, agent_session_id: conversation.snapshot.id,
        mutation: { turn_id: attachmentId(33), status: 'running', accepted_sequence: 2, state_version: 2, replayed: true } } };
    }
    if (method === 'discard-attachments') return attachmentReply([]);
    return { ok: true, value: context };
  });

  await f.model.execute('conversation');
  assert.equal(await f.model.pickAttachments(), true);
  assert.deepEqual(f.model.state.attachments.items.map((item) => item.selection_id), [firstSelection, secondSelection]);
  assert.equal(await f.model.uploadAttachment(firstSelection), false);
  assert.equal(f.model.state.attachments.items[0]?.status, 'uncertain');
  assert.equal(f.model.state.attachments.items[0]?.attachment_id, firstId);
  assert.equal(await f.model.recoverAttachment(firstSelection), true);
  assert.equal(await f.model.uploadAttachment(secondSelection), true);
  assert.ok(f.model.state.attachments.items.every((item) => item.status === 'ready' && Object.isFrozen(item)));
  assert.ok(Object.isFrozen(f.model.state.attachments.items));

  assert.equal(await f.model.submitTurn('attach both'), false);
  assert.equal(f.model.state.turn.status, 'unknown');
  const beforeBlockedAction = f.requests.length;
  assert.equal(await f.model.execute('cancel'), null);
  assert.equal(await f.model.cancelAttachment(firstSelection), false);
  assert.equal(f.requests.length, beforeBlockedAction);
  assert.equal(await f.model.retryTurn(), true);
  assert.equal(submitAttempts, 2); assert.deepEqual(writes[1], writes[0]);
  assert.deepEqual(writes[0]?.attachments, [
    { attachment_id: firstId, sha256: firstDigest }, { attachment_id: secondId, sha256: secondDigest },
  ]);
  assert.deepEqual(f.model.state.attachments.items, []);
  assert.ok(f.requests.some((request) => request.method === 'discard-attachments'));
});

test('Desktop rejects malformed attachment receipts without losing the selected draft or exposing raw values', async () => {
  const f = fixture(); const selection = selectedAttachment('selection-malformed', 'safe.bin', 'c'.repeat(64));
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'pick-attachments') return attachmentReply([selection]);
    if (method === 'upload-attachment') return attachmentReply([{ ...readyAttachment(selection.selection_id, selection.filename,
      selection.sha256, attachmentId(40)), receipt: { raw_path: '/private/secret', token: 'server-secret' } }]);
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.pickAttachments();
  assert.equal(await f.model.uploadAttachment(selection.selection_id), false);
  assert.equal(f.model.state.attachments.items[0]?.status, 'selected');
  assert.equal(f.model.state.attachments.notice, '첨부 응답을 확인할 수 없습니다. 파일을 다시 선택해 주세요.');
  assert.equal(JSON.stringify(f.model.state).includes('/private/secret'), false);
  assert.equal(JSON.stringify(f.model.state).includes('server-secret'), false);
});

test('Desktop clears attachment handles before a changed account can apply a late upload callback', async () => {
  const f = fixture(); const selection = selectedAttachment('selection-late', 'late.bin', 'd'.repeat(64));
  let resolveUpload!: (reply: DesktopNativeReply) => void; let started!: () => void;
  const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'pick-attachments') return attachmentReply([selection]);
    if (method === 'upload-attachment') {
      started(); return new Promise<DesktopNativeReply>((resolve) => { resolveUpload = resolve; });
    }
    if (method === 'cancel') return { ok: true, value: { watching: false } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.pickAttachments();
  const pending = f.model.uploadAttachment(selection.selection_id); await uploadStarted;
  f.notify({ type: 'cleared' });
  assert.deepEqual(f.model.state.attachments.items, []);
  assert.equal(f.requests.at(-1)?.method, 'cancel');
  resolveUpload(attachmentReply([readyAttachment(selection.selection_id, selection.filename, selection.sha256, attachmentId(41))]));
  assert.equal(await pending, false);
  assert.deepEqual(f.model.state.attachments.items, []); assert.equal(f.model.state.result, null);
});

test('Desktop suppresses an old-scope attachment read-back after account clear', async () => {
  const f = fixture(); const selection = selectedAttachment('selection-readback', 'readback.bin', 'e'.repeat(64));
  const uncertain = uncertainAttachment(selection.selection_id, selection.filename, selection.sha256, attachmentId(42));
  let resolveRead!: (reply: DesktopNativeReply) => void; let reading!: () => void;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'pick-attachments') return attachmentReply([selection]);
    if (method === 'upload-attachment') return { ok: false, code: 'network_error', message: 'unknown', outcome: 'unknown' };
    if (method === 'attachments') {
      reading(); return new Promise<DesktopNativeReply>((resolve) => { resolveRead = resolve; });
    }
    if (method === 'cancel') return { ok: true, value: { watching: false } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.pickAttachments();
  const pending = f.model.uploadAttachment(selection.selection_id); await readStarted;
  f.notify({ type: 'cleared' }); resolveRead(attachmentReply([uncertain]));
  assert.equal(await pending, false);
  assert.equal(f.model.state.result, null); assert.deepEqual(f.model.state.attachments.items, []);
  assert.equal(JSON.stringify(f.model.state).includes(selection.filename), false);
});

test('Desktop suppresses an old-scope attachment read-back rejection after account clear', async () => {
  const f = fixture(); const selection = selectedAttachment('selection-readback-error', 'readback-error.bin', '1'.repeat(64));
  let rejectRead!: (error: Error) => void; let reading!: () => void;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'pick-attachments') return attachmentReply([selection]);
    if (method === 'upload-attachment') return { ok: false, code: 'network_error', message: 'unknown', outcome: 'unknown' };
    if (method === 'attachments') {
      reading(); return new Promise<DesktopNativeReply>((_resolve, reject) => { rejectRead = reject; });
    }
    if (method === 'cancel') return { ok: true, value: { watching: false } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.pickAttachments();
  const pending = f.model.uploadAttachment(selection.selection_id); await readStarted;
  f.notify({ type: 'cleared' }); rejectRead(new Error('old private transport detail'));
  assert.equal(await pending, false);
  assert.equal(f.model.state.result, null); assert.deepEqual(f.model.state.attachments.items, []);
  assert.equal(JSON.stringify(f.model.state).includes(selection.filename), false);
});

test('Desktop resyncs a handle-only unknown upload before deciding whether recovery is possible', async () => {
  const f = fixture(); const selection = selectedAttachment('selection-resync', 'resync.bin', 'f'.repeat(64));
  let attachmentReads = 0; let uploads = 0; let recoveries = 0;
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'pick-attachments') return attachmentReply([selection]);
    if (method === 'upload-attachment') {
      uploads++; return { ok: false, code: 'network_error', message: 'unknown', outcome: 'unknown' };
    }
    if (method === 'attachments') {
      attachmentReads++;
      return attachmentReads === 1
        ? { ok: false, code: 'network_error', message: 'unavailable' }
        : attachmentReply([selection]);
    }
    if (method === 'recover-attachment') { recoveries++; return attachmentReply([selection]); }
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.pickAttachments();
  assert.equal(await f.model.uploadAttachment(selection.selection_id), false);
  assert.equal(f.model.state.attachments.items[0]?.status, 'uncertain');
  assert.equal(f.model.state.attachments.items[0]?.attachment_id, undefined);
  assert.equal(await f.model.recoverAttachment(selection.selection_id), true);
  assert.equal(f.model.state.attachments.items[0]?.status, 'selected');
  assert.equal(attachmentReads, 2); assert.equal(uploads, 1); assert.equal(recoveries, 0);
});

test('Desktop never opens the native picker without an available canonical conversation', async () => {
  const f = fixture();
  assert.equal(await f.model.pickAttachments(), false);
  assert.equal(f.requests.length, 0);
});

test('Desktop discards a visible attachment before rendering a different session and workflow', async () => {
  const f = fixture(); const selection = selectedAttachment('selection-session-change', 'old-session.bin', '2'.repeat(64));
  const replacement = { ...conversation, snapshot: { ...conversation.snapshot, id: attachmentId(90), workflow_id: 'other-flow' } };
  let reads = 0;
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation',
      conversation: reads++ < 2 ? conversation : replacement, has_more: false } };
    if (method === 'pick-attachments') return attachmentReply([selection]);
    if (method === 'discard-attachments') return attachmentReply([]);
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.pickAttachments();
  assert.equal(f.model.state.attachments.items[0]?.filename, selection.filename);
  await f.model.execute('conversation');
  assert.equal(f.model.state.conversation?.snapshot?.id, replacement.snapshot.id);
  assert.deepEqual(f.model.state.attachments.items, []);
  assert.ok(f.requests.some((request) => request.method === 'discard-attachments'
    && request.params?.agent_session_id === conversation.snapshot.id && request.params?.workflow_id === conversation.snapshot.workflow_id));
  assert.ok(f.rendered.filter((state) => (state as any).conversation?.snapshot?.id === replacement.snapshot.id)
    .every((state) => !JSON.stringify(state).includes(selection.filename)));
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

test('Desktop session lifecycle blocks unknown follow-up writes until an explicit catalog recheck', async () => {
  const f = fixture(); const event = '00000000-0000-4000-8000-000000000010'; let creates = 0; let catalogs = 0;
  const catalog = { focus: { active_agent_session_id: conversation.snapshot.id, version: 3, event_id: event }, sessions: { items: [{
    id: conversation.snapshot.id, workflow_id: 'flow', title: 'Shared', status: 'active' as const, current_sequence: 1, state_version: 1,
  }], next_cursor: null, has_more: false } };
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'agent-sessions') { catalogs++; return { ok: true, value: { ...context, ...catalog } }; }
    if (method === 'create-agent-session') { creates++; return { ok: false, code: 'network_error', message: 'unknown', outcome: 'unknown' }; }
    if (method === 'switch-agent-focus') {
      assert.deepEqual(params, { active_agent_session_id: conversation.snapshot.id, expected_version: 3 });
      return { ok: true, value: { ...context, focus: catalog.focus } };
    }
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); assert.equal(await f.model.refreshAgentSessions(), true);
  assert.equal(await f.model.switchAgentFocus('00000000-0000-4000-8000-000000000099'), false);
  assert.equal(await f.model.createAgentSession('flow', 'New'), false);
  assert.equal(creates, 1); assert.equal(f.model.state.catalog.writeBlocked, true);
  assert.equal(await f.model.switchAgentFocus(conversation.snapshot.id), false);
  assert.equal(f.requests.filter((request) => request.method === 'switch-agent-focus').length, 0);
  assert.equal(await f.model.refreshAgentSessions(), true); assert.equal(catalogs, 2);
  assert.equal(await f.model.switchAgentFocus(conversation.snapshot.id), true);
});

test('Desktop applies only a validated lifecycle CAS conflict and does not retry', async () => {
  const f = fixture(); const event = '00000000-0000-4000-8000-000000000010';
  const current = { active_agent_session_id: null, version: 4, event_id: '00000000-0000-4000-8000-000000000011' };
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'agent-sessions') return { ok: true, value: { ...context,
      focus: { active_agent_session_id: conversation.snapshot.id, version: 3, event_id: event },
      sessions: { items: [{ id: conversation.snapshot.id, workflow_id: 'flow', title: 'Shared', status: 'active', current_sequence: 1, state_version: 1 }], next_cursor: null, has_more: false } } };
    if (method === 'switch-agent-focus') return { ok: false, code: 'usage_error', message: 'conflict', outcome: 'rejected', status: 409,
      conflict: { code: 'FOCUS_VERSION_CONFLICT', current } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.refreshAgentSessions();
  assert.equal(await f.model.switchAgentFocus(null), false); assert.deepEqual(f.model.state.catalog.focus, current);
  assert.equal(f.model.state.catalog.writeBlocked, true); assert.equal(f.model.state.conversation, null);
  assert.equal(await f.model.switchAgentFocus(null), false);
  assert.equal(f.requests.filter((request) => request.method === 'switch-agent-focus').length, 1);
});

test('Desktop catalog refresh clears an old transcript when authoritative focus is null', async () => {
  const f = fixture();
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus,
      sessions: { items: [], next_cursor: null, has_more: false } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); assert.ok(f.model.state.conversation?.snapshot);
  assert.equal(await f.model.refreshAgentSessions(), true);
  assert.equal(f.model.state.catalog.focus?.active_agent_session_id, null);
  assert.equal(f.model.state.conversation, null);
  f.notify({ type: 'cleared' }); assert.equal(f.model.state.catalog.focus, null);
});

test('Desktop replaces bounded catalog pages, preserves same-focus turn intent, and returns to latest explicitly', async () => {
  const f = fixture(); const active = conversation.snapshot.id; const event = sessionId(20);
  const currentFocus = { active_agent_session_id: active, version: 3, event_id: event };
  const latest = [{ ...ownedSession(1, 'Shared'), workflow_id: 'flow' }, ownedSession(2)];
  const older = [ownedSession(3), ownedSession(4)];
  let submitAttempts = 0;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'submit-turn') {
      submitAttempts++;
      return { ok: false, code: 'network_error', message: 'unknown private transport detail', outcome: 'unknown' };
    }
    if (method === 'agent-sessions' && params?.before_id === latest.at(-1)!.id) return { ok: true, value: { ...context,
      focus: currentFocus, sessions: { items: older, next_cursor: null, has_more: false } } };
    if (method === 'agent-sessions') return { ok: true, value: { ...context,
      focus: currentFocus, sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation');
  assert.equal(await f.model.refreshAgentSessions(), true);
  await f.model.submitTurn('private retry intent');
  assert.equal(f.model.state.turn.status, 'unknown'); assert.equal(f.model.state.turn.canRetry, true);

  assert.equal(await f.model.loadOlderAgentSessions(), true);
  assert.deepEqual(f.requests.filter((request) => request.method === 'agent-sessions').at(-1), {
    method: 'agent-sessions', params: { limit: 100, before_id: latest.at(-1)!.id },
  });
  assert.deepEqual(f.model.state.catalog.items, older); assert.equal(f.model.state.catalog.olderPage, true);
  assert.equal(f.model.state.catalog.items.length, 2); assert.equal(f.model.state.catalog.hasMore, false);
  assert.equal(f.model.state.catalog.focus?.active_agent_session_id, active);
  assert.equal(f.model.state.conversation?.snapshot?.id, active);
  assert.equal(f.model.state.turn.status, 'unknown'); assert.equal(f.model.state.turn.canRetry, true);
  assert.equal(submitAttempts, 1);
  const readsAtEnd = f.requests.filter((request) => request.method === 'agent-sessions').length;
  assert.equal(await f.model.loadOlderAgentSessions(), false);
  assert.equal(f.requests.filter((request) => request.method === 'agent-sessions').length, readsAtEnd);

  assert.equal(await f.model.refreshAgentSessions(), true);
  assert.deepEqual(f.model.state.catalog.items, latest); assert.equal(f.model.state.catalog.olderPage, false);
  assert.equal(f.model.state.catalog.hasMore, true);
});

test('Desktop older reads retain lifecycle outcome locks until a valid explicit latest refresh', async () => {
  const f = fixture(); const active = conversation.snapshot.id; const event = sessionId(30);
  const currentFocus = { active_agent_session_id: active, version: 3, event_id: event };
  const latest = [ownedSession(1), ownedSession(2)]; const older = [ownedSession(3)];
  let creates = 0;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'create-agent-session') { creates++; return { ok: false, code: 'network_error', message: 'secret', outcome: 'unknown' }; }
    if (method === 'agent-sessions' && params?.before_id) return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: older, next_cursor: null, has_more: false } } };
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.refreshAgentSessions();
  assert.equal(await f.model.createAgentSession('flow-new'), false); assert.equal(creates, 1);
  assert.equal(f.model.state.catalog.writeBlocked, true);
  assert.equal(await f.model.loadOlderAgentSessions(), true);
  assert.equal(f.model.state.catalog.writeBlocked, true);
  assert.equal(await f.model.createAgentSession('flow-new'), false); assert.equal(creates, 1);
  assert.equal(await f.model.refreshAgentSessions(), true);
  assert.equal(f.model.state.catalog.writeBlocked, false); assert.equal(f.model.state.catalog.olderPage, false);
});

test('Desktop creation from an older page invalidates the pagination boundary until latest refresh', async () => {
  const f = fixture(); const initialFocus = { active_agent_session_id: null, version: 0, event_id: null };
  const createdId = sessionId(70); const createdFocus = { active_agent_session_id: createdId, version: 1, event_id: sessionId(71) };
  const latest = [ownedSession(30), ownedSession(31)]; const older = [ownedSession(32)];
  const createdConversation = { ...conversation, snapshot: { ...conversation.snapshot, id: createdId,
    workflow_id: 'created-flow', title: 'Created', current_sequence: 0, state_version: 1, latest_turn: null },
    messages: [], omittedMessages: 0 };
  f.respond(async (method, params) => {
    if (method === 'agent-sessions' && params?.before_id) return { ok: true, value: { ...context, focus: initialFocus,
      sessions: { items: older, next_cursor: null, has_more: false } } };
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus: initialFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    if (method === 'create-agent-session') return { ok: true, value: { ...context,
      created: { id: createdId, workflow_id: 'created-flow', focus: createdFocus } } };
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation',
      conversation: createdConversation, has_more: false } };
    return { ok: true, value: context };
  });
  await f.model.execute('session', { action: 'status' }); await f.model.refreshAgentSessions();
  assert.equal(await f.model.loadOlderAgentSessions(), true); assert.equal(f.model.state.catalog.olderPage, true);
  assert.equal(await f.model.createAgentSession('created-flow', 'Created'), true);
  assert.equal(f.model.state.catalog.pageKnown, false); assert.equal(f.model.state.catalog.olderPage, false);
  assert.equal(f.model.state.catalog.nextCursor, null); assert.equal(f.model.state.catalog.hasMore, false);
  assert.ok(f.model.state.catalog.items.some((item) => item.id === createdId));
});

test('Desktop rejects failed, foreign, repeated, and overlapping older pages without replacing the current page', async () => {
  const f = fixture(); const currentFocus = { active_agent_session_id: null, version: 1, event_id: sessionId(40) };
  const latest = [ownedSession(10), ownedSession(11)]; const before = latest.at(-1)!.id;
  let mode: 'latest' | 'failed' | 'foreign' | 'repeat' | 'overlap' = 'latest';
  f.respond(async (method) => {
    if (method !== 'agent-sessions') return { ok: true, value: context };
    if (mode === 'latest') return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: latest, next_cursor: before, has_more: true } } };
    if (mode === 'failed') return { ok: false, code: 'network_error', message: 'raw private failure' };
    if (mode === 'foreign') return { ok: true, value: { ...context, user_id: '8', focus: currentFocus,
      sessions: { items: [ownedSession(12)], next_cursor: null, has_more: false }, private_value: 'foreign secret' } as any };
    if (mode === 'repeat') return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: [ownedSession(12), { ...ownedSession(13), id: before }], next_cursor: before, has_more: true } } };
    return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: [latest[0]], next_cursor: null, has_more: false } } };
  });
  await f.model.execute('session', { action: 'status' }); await f.model.refreshAgentSessions();
  for (const invalid of ['failed', 'foreign', 'repeat', 'overlap'] as const) {
    mode = invalid;
    assert.equal(await f.model.loadOlderAgentSessions(), false);
    assert.deepEqual(f.model.state.catalog.items, latest);
    assert.equal(f.model.state.catalog.nextCursor, before); assert.equal(f.model.state.catalog.olderPage, false);
  }
  assert.equal(JSON.stringify(f.model.state).includes('raw private failure'), false);
  assert.equal(JSON.stringify(f.model.state).includes('foreign secret'), false);
});

test('Desktop discards an older page when focus changes and requires a latest catalog refresh', async () => {
  const f = fixture(); const active = conversation.snapshot.id;
  const initialFocus = { active_agent_session_id: active, version: 3, event_id: sessionId(50) };
  const changedFocus = { active_agent_session_id: sessionId(99), version: 4, event_id: sessionId(51) };
  const latest = [ownedSession(1), ownedSession(2)]; let changed = false;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'agent-sessions' && params?.before_id) return { ok: true, value: { ...context,
      focus: changedFocus, sessions: { items: [ownedSession(3)], next_cursor: null, has_more: false } } };
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus: changed ? changedFocus : initialFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.refreshAgentSessions();
  const beforeReads = f.requests.filter((request) => request.method === 'agent-sessions').length;
  assert.equal(await f.model.loadOlderAgentSessions(), false);
  assert.equal(f.requests.filter((request) => request.method === 'agent-sessions').length, beforeReads + 1);
  assert.deepEqual(f.model.state.catalog.items, []); assert.equal(f.model.state.catalog.nextCursor, null);
  assert.equal(f.model.state.catalog.olderPage, false); assert.equal(f.model.state.catalog.writeBlocked, true);
  assert.deepEqual(f.model.state.catalog.focus, changedFocus); assert.equal(f.model.state.conversation, null);
  assert.equal(await f.model.loadOlderAgentSessions(), false);
  assert.equal(f.requests.filter((request) => request.method === 'agent-sessions').length, beforeReads + 1);
  changed = true; assert.equal(await f.model.refreshAgentSessions(), true);
  assert.equal(f.model.state.catalog.writeBlocked, false); assert.equal(f.model.state.catalog.olderPage, false);
});

test('Desktop accepts an older page across same-session live turn updates', async () => {
  const f = fixture(); const active = conversation.snapshot.id;
  const currentFocus = { active_agent_session_id: active, version: 3, event_id: sessionId(80) };
  const latest = [{ ...ownedSession(1), workflow_id: 'flow', title: 'Shared' }, ownedSession(2)];
  let release!: (reply: DesktopNativeReply) => void;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'watch-live') return { ok: true, value: { ...context, view: 'conversation' } };
    if (method === 'agent-sessions' && params?.before_id) return new Promise<DesktopNativeReply>((resolve) => { release = resolve; });
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.refreshAgentSessions(); await f.model.execute('watch-live');
  const pending = f.model.loadOlderAgentSessions(); await Promise.resolve();
  f.notify({ type: 'update', value: { ...context, view: 'conversation', update: { type: 'conversation', user_id: '7',
    conversation: runningConversation, source: 'snapshot', has_more: false } } });
  release({ ok: true, value: { ...context, focus: currentFocus,
    sessions: { items: [ownedSession(3)], next_cursor: null, has_more: false } } });
  assert.equal(await pending, true); assert.equal(f.model.state.catalog.pageKnown, true);
  assert.equal(f.model.state.catalog.olderPage, true); assert.equal(f.model.state.catalog.writeBlocked, false);
  assert.equal(f.model.state.conversation?.snapshot?.id, active);
});

test('Desktop invalidates a late older page when live conversation selects another session', async () => {
  const f = fixture(); const active = conversation.snapshot.id; const replacementId = sessionId(90);
  const currentFocus = { active_agent_session_id: active, version: 3, event_id: sessionId(81) };
  const latest = [{ ...ownedSession(1), workflow_id: 'flow', title: 'Shared' }, ownedSession(2)];
  const replacementConversation = { ...conversation, snapshot: { ...conversation.snapshot, id: replacementId,
    workflow_id: 'replacement-flow', title: 'Replacement' } };
  let release!: (reply: DesktopNativeReply) => void;
  f.respond(async (method, params) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'watch-live') return { ok: true, value: { ...context, view: 'conversation' } };
    if (method === 'agent-sessions' && params?.before_id) return new Promise<DesktopNativeReply>((resolve) => { release = resolve; });
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.refreshAgentSessions(); await f.model.execute('watch-live');
  const pending = f.model.loadOlderAgentSessions(); await Promise.resolve();
  f.notify({ type: 'update', value: { ...context, view: 'conversation', update: { type: 'conversation', user_id: '7',
    conversation: replacementConversation, source: 'snapshot', has_more: false } } });
  release({ ok: true, value: { ...context, focus: currentFocus,
    sessions: { items: [ownedSession(3)], next_cursor: null, has_more: false } } });
  assert.equal(await pending, false);
  assert.equal(f.model.state.conversation?.snapshot?.id, replacementId);
  assert.equal(f.model.state.catalog.focus, null); assert.deepEqual(f.model.state.catalog.items, []);
  assert.equal(f.model.state.catalog.pageKnown, false); assert.equal(f.model.state.catalog.writeBlocked, true);
  assert.equal(f.model.state.catalog.nextCursor, null); assert.equal(f.model.state.catalog.olderPage, false);
});

test('Desktop invalidates catalog immediately when live conversation changes before paging', async () => {
  const f = fixture(); const active = conversation.snapshot.id; const replacementId = sessionId(91);
  const currentFocus = { active_agent_session_id: active, version: 3, event_id: sessionId(82) };
  const latest = [{ ...ownedSession(1), workflow_id: 'flow', title: 'Shared' }, ownedSession(2)];
  const replacementConversation = { ...conversation, snapshot: { ...conversation.snapshot, id: replacementId,
    workflow_id: 'replacement-flow', title: 'Replacement' } };
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'watch-live') return { ok: true, value: { ...context, view: 'conversation' } };
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.refreshAgentSessions(); await f.model.execute('watch-live');
  const catalogReads = f.requests.filter((request) => request.method === 'agent-sessions').length;
  f.notify({ type: 'update', value: { ...context, view: 'conversation', update: { type: 'conversation', user_id: '7',
    conversation: replacementConversation, source: 'snapshot', has_more: false } } });
  assert.equal(f.model.state.conversation?.snapshot?.id, replacementId);
  assert.equal(f.model.state.catalog.focus, null); assert.deepEqual(f.model.state.catalog.items, []);
  assert.equal(f.model.state.catalog.pageKnown, false); assert.equal(f.model.state.catalog.writeBlocked, true);
  assert.equal(await f.model.loadOlderAgentSessions(), false);
  assert.equal(f.requests.filter((request) => request.method === 'agent-sessions').length, catalogReads);
});

test('Desktop invalidates catalog immediately on a changed full focus notice', async () => {
  const f = fixture(); const active = conversation.snapshot.id;
  const currentFocus = { active_agent_session_id: active, version: 3, event_id: sessionId(83) };
  const changedFocus = { active_agent_session_id: sessionId(92), version: 4, event_id: sessionId(84) };
  const latest = [{ ...ownedSession(1), workflow_id: 'flow', title: 'Shared' }, ownedSession(2)];
  f.respond(async (method) => {
    if (method === 'conversation') return { ok: true, value: { ...context, view: 'conversation', conversation, has_more: false } };
    if (method === 'watch') return { ok: true, value: context };
    if (method === 'agent-sessions') return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    return { ok: true, value: context };
  });
  await f.model.execute('conversation'); await f.model.refreshAgentSessions(); await f.model.execute('watch');
  f.notify({ type: 'update', value: { ...context, update: { type: 'focus', user_id: '7', focus: changedFocus, source: 'snapshot' } } });
  assert.deepEqual(f.model.state.catalog.focus, changedFocus); assert.deepEqual(f.model.state.catalog.items, []);
  assert.equal(f.model.state.catalog.pageKnown, false); assert.equal(f.model.state.catalog.writeBlocked, true);
  assert.equal(f.model.state.catalog.nextCursor, null); assert.equal(f.model.state.catalog.olderPage, false);
});

test('Desktop older paging guards unavailable, terminal, repeated-click, cleared, and disposed state', async () => {
  const f = fixture(); assert.equal(await f.model.loadOlderAgentSessions(), false); assert.equal(f.requests.length, 0);
  const currentFocus = { active_agent_session_id: null, version: 1, event_id: sessionId(60) };
  const latest = [ownedSession(20), ownedSession(21)]; let release!: (reply: DesktopNativeReply) => void;
  let pending = false;
  f.respond(async (method, params) => {
    if (method !== 'agent-sessions') return { ok: true, value: context };
    if (!params?.before_id) return { ok: true, value: { ...context, focus: currentFocus,
      sessions: { items: latest, next_cursor: latest.at(-1)!.id, has_more: true } } };
    pending = true;
    return new Promise<DesktopNativeReply>((resolve) => { release = resolve; });
  });
  await f.model.execute('session', { action: 'status' }); await f.model.refreshAgentSessions();
  const first = f.model.loadOlderAgentSessions();
  while (!pending) await Promise.resolve();
  assert.equal(await f.model.loadOlderAgentSessions(), false);
  assert.equal(f.requests.filter((request) => request.params?.before_id).length, 1);
  f.notify({ type: 'cleared' });
  release({ ok: true, value: { ...context, focus: currentFocus,
    sessions: { items: [ownedSession(22)], next_cursor: null, has_more: false } } });
  assert.equal(await first, false); assert.equal(f.model.state.catalog.focus, null);
  f.model.dispose(); assert.equal(await f.model.loadOlderAgentSessions(), false);
});
