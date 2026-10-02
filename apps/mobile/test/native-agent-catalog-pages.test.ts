import assert from 'node:assert/strict';
import test from 'node:test';
import type { OwnedAgentSession } from '@dex/protocol/agent-session';
import { AgentTurnComposeFailure } from '@dex/protocol/agent-turn-composer';
import { MobileAgentConversationModel } from '../src/lib/native-agent-conversation-model';
import { MobileAgentLifecycleFailure } from '../src/lib/native-agent-lifecycle';
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002', c = '00000000-0000-4000-8000-000000000003';
const profile = 'a'.repeat(64); const item = (id: string): OwnedAgentSession => ({ id, workflow_id: 'wf', title: id, status: 'active', current_sequence: 0, state_version: 1 });
const tick = () => new Promise((r) => setImmediate(r));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let scope = profile; let focus = { active_agent_session_id: a as string | null, version: 1, event_id: a };
  const calls: Array<{ beforeId: string; authScope: string } | undefined> = []; let writes = 0;
  let emit = () => {};
  let handler = async (page?: { beforeId: string; authScope: string }) => ({ authScope: scope, focus: { ...focus },
    sessions: page ? { items: [item(c)], has_more: false, next_cursor: null as string | null }
      : { items: [item(a), item(b)], has_more: true, next_cursor: b as string | null } });
  const model = new MobileAgentConversationModel({ origin: 'https://mobile.example.test', userId: '7' }, {
    async run(update, signal, once) {
      emit = () => update({ type: 'value', source: 'snapshot', hasMore: false, value: { authScope: scope, messages: [], omittedMessages: 0,
        snapshot: focus.active_agent_session_id ? { id: focus.active_agent_session_id, workflow_id: 'wf', title: 'Shared', state_version: 1,
          current_sequence: 0, latest_turn: null, message_history_complete: true } : null } });
      emit();
      if (!once) await new Promise<void>((r) => { signal.addEventListener('abort', () => r(), { once: true }); if (signal.aborted) r(); });
    },
  }, { send: async () => { writes++; throw new AgentTurnComposeFailure('unknown'); }, dispose() {} }, () => undefined, () => 'logical', () => undefined,
  { read: async (_signal, page) => { calls.push(page); return handler(page); }, send: async () => { writes++; throw new MobileAgentLifecycleFailure('unknown'); }, dispose() {} });
  model.setVisible(true);
  return { model, calls, writes: () => writes, handle(next: typeof handler) { handler = next; },
    focus(id: string | null) { focus = { ...focus, active_agent_session_id: id, version: focus.version + 1 }; }, scope(value: string) { scope = value; }, notify() { emit(); } };
}
test('older/latest replace bounded rows without selecting focus or clearing same-focus draft; terminal page sends no extra read', async () => {
  const f = fixture(); await f.model.refreshCatalog(); await tick(); f.model.setDraft('keep');
  assert.equal(await f.model.loadOlderCatalog(), true); await tick(); assert.deepEqual(f.calls[1], { beforeId: b, authScope: profile });
  assert.deepEqual(f.model.state.catalog.items.map((v) => v.id), [c]); assert.equal(f.model.state.catalog.olderPage, true);
  assert.equal(f.model.state.catalog.focus?.active_agent_session_id, a); assert.equal(f.model.state.draft, 'keep'); assert.equal(f.writes(), 0);
  assert.equal(await f.model.loadOlderCatalog(), false); assert.equal(f.calls.length, 2);
  await f.model.refreshCatalog(); await tick(); assert.equal(f.calls[2], undefined); assert.equal(f.model.state.catalog.olderPage, false);
  assert.equal(f.model.state.draft, 'keep'); assert.deepEqual(f.model.state.catalog.items.map((v) => v.id), [a, b]); f.model.dispose();
});
test('double clicks issue one read; failure/nonadvancing page retains rows and requires recheck', async () => {
  for (const mode of ['failure', 'repeat']) {
    const f = fixture(); await f.model.refreshCatalog(); await tick(); const gate = deferred<Awaited<ReturnType<Parameters<typeof f.handle>[0]>>>();
    f.handle(async () => gate.promise); const reading = f.model.loadOlderCatalog(); await tick();
    assert.equal(await f.model.loadOlderCatalog(), false); assert.equal(f.calls.length, 2);
    gate.resolve(mode === 'repeat' ? { authScope: profile, focus: { active_agent_session_id: a, version: 1, event_id: a },
      sessions: { items: [item(b)], has_more: true, next_cursor: b } } : Promise.reject(new Error('private-server-error')) as never);
    assert.equal(await reading, false); assert.deepEqual(f.model.state.catalog.items.map((v) => v.id), [a, b]);
    assert.equal(JSON.stringify(f.model.state).includes('private-server-error'), false); assert.equal(f.model.state.catalog.canLoadOlder, false); f.model.dispose();
  }
});
test('focus/scope change discards returned older rows/cursor; explicit latest read needed and no automatic fallback', async () => {
  for (const mode of ['focus', 'scope']) {
    const f = fixture(); await f.model.refreshCatalog(); await tick(); f.model.setDraft('old');
    if (mode === 'focus') f.focus(c); else f.scope('b'.repeat(64));
    assert.equal(await f.model.loadOlderCatalog(), false); await tick(); assert.equal(f.calls.length, 2);
    assert.equal(f.model.state.catalog.items.length, 0); assert.equal(f.model.state.draft, '');
    assert.equal(f.model.state.catalog.canWrite, false); assert.equal(f.model.state.turn.canSubmit, false); f.model.dispose();
  }
});
test('older browsing preserves unknown turn intent; unknown lifecycle locks paging until latest read', async () => {
  const f = fixture(); await f.model.refreshCatalog(); await tick(); f.model.setDraft('original'); await f.model.submit(); await tick();
  const original = { ...f.model.state.turn.request }; await f.model.loadOlderCatalog(); await tick();
  assert.deepEqual(f.model.state.turn.request, original); assert.equal(f.model.state.turn.canRetry, true); assert.equal(f.model.state.draft, 'original'); f.model.dispose();
  const next = fixture(); await next.model.refreshCatalog(); await tick(); await next.model.createSession('wf');
  assert.equal(next.model.state.catalog.writeBlocked, true); const count = next.calls.length;
  assert.equal(await next.model.loadOlderCatalog(), false); assert.equal(next.calls.length, count);
  await next.model.start(true); assert.equal(next.model.state.catalog.writeBlocked, true);
  await next.model.refreshCatalog(); assert.equal(next.model.state.catalog.writeBlocked, false); next.model.dispose();
});
test('late older page after background never restores data or auto resumes', async () => {
  const f = fixture(); await f.model.refreshCatalog(); await tick(); const late = deferred<Awaited<ReturnType<Parameters<typeof f.handle>[0]>>>();
  f.handle(async () => late.promise); const reading = f.model.loadOlderCatalog(); await tick(); f.model.setVisible(false); f.model.setVisible(true);
  late.resolve({ authScope: profile, focus: { active_agent_session_id: a, version: 1, event_id: a }, sessions: { items: [item(c)], has_more: false, next_cursor: null } });
  assert.equal(await reading, false); assert.deepEqual(f.model.state.catalog.items, []); assert.equal(f.model.state.catalog.focus, null);
  assert.equal(f.model.state.catalog.pageKnown, false); assert.equal(f.model.state.catalog.canLoadOlder, false);
  assert.equal(f.model.state.conversation, null); assert.equal(f.calls.length, 2); f.model.dispose();
});
test('authoritative live selection changes clear the old catalog immediately and require latest read', async () => {
  const f = fixture(); await f.model.refreshCatalog(); await tick(); f.model.setDraft('old selection');
  f.focus(c); f.notify();
  assert.equal(f.model.state.conversation?.snapshot?.id, c); assert.equal(f.model.state.draft, '');
  assert.deepEqual(f.model.state.catalog.items, []); assert.equal(f.model.state.catalog.focus, null);
  assert.equal(f.model.state.catalog.hasMore, false); assert.equal(f.model.state.catalog.olderPage, false);
  assert.equal(f.model.state.catalog.pageKnown, false); assert.equal(f.model.state.catalog.canWrite, false);
  assert.equal(await f.model.loadOlderCatalog(), false); assert.equal(f.calls.length, 1); f.model.dispose();
});
