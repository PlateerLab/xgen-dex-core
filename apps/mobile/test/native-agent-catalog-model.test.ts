import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentFocus, OwnedAgentSession } from '@dex/protocol/agent-session';
import { AgentTurnComposeFailure } from '@dex/protocol/agent-turn-composer';
import { MobileAgentConversationModel } from '../src/lib/native-agent-conversation-model';
import { MobileAgentLifecycleFailure, type MobileAgentLifecycleRequest } from '../src/lib/native-agent-lifecycle';
const a = '018f1240-0000-7000-8000-000000000001', b = '018f1240-0000-7000-8000-000000000002';
const scope = 'a'.repeat(64); const tick = () => new Promise((r) => setImmediate(r));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let authScope = scope; let focus = { active_agent_session_id: null as string | null, version: 0, event_id: null as string | null };
  let reads = 0; let watchers = 0; const requests: MobileAgentLifecycleRequest[] = []; let turnWrites = 0;
  let catalogRead: () => Promise<{ authScope: string; focus: AgentFocus; sessions: { items: OwnedAgentSession[]; has_more: boolean; next_cursor: string | null } }> = async () => ({ authScope, focus: { ...focus }, sessions: { items: [a, b].map((id) => ({ id, workflow_id: 'wf', title: id, status: 'active',
    current_sequence: 0, state_version: 1 })), has_more: true, next_cursor: b } });
  let handler = async (r: MobileAgentLifecycleRequest): Promise<unknown> => {
    focus = { active_agent_session_id: r.operation === 'create' ? a : r.input.active_agent_session_id, version: r.input.expected_version + 1, event_id: b };
    return { ...r.scope, ...(r.operation === 'create' ? { created: { id: a, workflow_id: r.input.workflow_id, focus } } : { focus }) };
  };
  const model = new MobileAgentConversationModel({ origin: 'https://mobile.example.test', userId: '7' }, {
    async run(update, signal, once) {
      watchers++; update({ type: 'value', source: 'snapshot', hasMore: false, value: { authScope, messages: [], omittedMessages: 0,
        snapshot: focus.active_agent_session_id ? { id: focus.active_agent_session_id, workflow_id: 'wf', title: 'Shared', current_sequence: 0,
          state_version: 1, latest_turn: null, message_history_complete: true } : null } });
      if (!once) await new Promise<void>((r) => { signal.addEventListener('abort', () => r(), { once: true }); if (signal.aborted) r(); });
    },
  }, { send: async () => { turnWrites++; throw new AgentTurnComposeFailure('unknown'); }, dispose() {} }, () => undefined,
  () => 'logical-key', () => undefined, { read: async () => { reads++; return catalogRead(); },
    send: async (r) => { requests.push(structuredClone(r)); return handler(r); }, dispose() {} });
  model.setVisible(true);
  return { model, requests, reads: () => reads, watchers: () => watchers, turnWrites: () => turnWrites,
    handle(next: typeof handler) { handler = next; }, read(next: typeof catalogRead) { catalogRead = next; },
    focus(id: string | null, version = focus.version + 1) { focus = { active_agent_session_id: id, version, event_id: b }; },
    scope(value: string) { authScope = value; } };
}
test('empty focus can create once; observed CAS, active owned selection, same-target draft and clear', async () => {
  const f = fixture(); assert.equal(await f.model.createSession('wf'), false); await f.model.refreshCatalog();
  assert.equal(f.model.state.catalog.canWrite, true); assert.equal(f.model.state.catalog.hasMore, true);
  const late = deferred<unknown>(); f.handle(async (r) => { f.focus(a, 1); return late.promise; });
  const creating = f.model.createSession('wf', '제목'); await tick(); assert.equal(await f.model.createSession('wf'), false);
  late.resolve({ ...f.requests[0].scope, created: { id: a, workflow_id: 'wf', focus: { active_agent_session_id: a, version: 1, event_id: b } } });
  assert.equal(await creating, true); await tick(); assert.equal(f.requests.length, 1); assert.equal(f.model.state.turn.canSubmit, true);
  assert.deepEqual(f.requests[0].input, { workflow_id: 'wf', title: '제목', expected_version: 0 });
  f.model.setDraft('keep'); f.handle(async (r) => ({ ...r.scope, focus: { active_agent_session_id: a, version: 1, event_id: b } }));
  await f.model.selectSession(a); await tick(); assert.equal(f.model.state.draft, 'keep');
  assert.equal(await f.model.selectSession('018f1240-0000-7000-8000-000000000003'), false);
  f.handle(async (r) => { f.focus(null, 2); return { ...r.scope, focus: { active_agent_session_id: null, version: 2, event_id: b } }; });
  await f.model.selectSession(null); assert.equal(f.model.state.draft, ''); assert.equal(f.model.state.conversation, null);
  assert.equal(f.model.state.turn.canSubmit, false); f.model.dispose();
});
test('lost create ACK locks all writes across hide/resume until explicit catalog recheck, never replays', async () => {
  const f = fixture(); await f.model.refreshCatalog(); f.handle(async () => { f.focus(a, 1); throw new MobileAgentLifecycleFailure('unknown'); });
  await f.model.createSession('wf'); assert.equal(f.model.state.catalog.writeBlocked, true);
  f.model.setVisible(false); assert.deepEqual(f.model.state.catalog.items, []); f.model.setVisible(true);
  await f.model.start(true); assert.equal(f.model.state.turn.canSubmit, false); assert.equal(f.model.state.catalog.canWrite, false);
  await f.model.submit(); await f.model.createSession('wf'); assert.equal(f.requests.length, 1); assert.equal(f.turnWrites(), 0);
  await f.model.refreshCatalog(); await tick(); assert.equal(f.requests.length, 1); assert.equal(f.model.state.catalog.writeBlocked, false);
  assert.equal(f.model.state.turn.canSubmit, true); f.model.dispose();
});
test('focus conflict requires recheck; invalid scope/ACK is unknown; safe prewire failure does not lock', async () => {
  for (const mode of ['conflict', 'scope', 'ack', 'unavailable']) {
    const f = fixture(); await f.model.refreshCatalog();
    f.handle(async (r) => {
      if (mode === 'conflict') throw new MobileAgentLifecycleFailure('rejected', { code: 'FOCUS_VERSION_CONFLICT', current: { active_agent_session_id: b, version: 3, event_id: b } });
      if (mode === 'unavailable') throw new MobileAgentLifecycleFailure('unavailable');
      return mode === 'scope' ? { ...r.scope, profile: 'b'.repeat(64), focus: {} } : { ...r.scope, created: {} };
    });
    await f.model.createSession('wf'); assert.equal(f.model.state.catalog.writeBlocked, mode !== 'unavailable');
    if (mode === 'conflict') assert.equal(f.model.state.catalog.focus?.version, 3);
    f.model.dispose();
  }
});
test('unknown turn prevents lifecycle writes; same-focus catalog read preserves original turn intent', async () => {
  const f = fixture(); f.focus(a, 1); await f.model.refreshCatalog(); await tick(); f.model.setDraft('original');
  await f.model.submit(); await tick(); assert.equal(f.model.state.turn.status, 'unknown');
  await f.model.refreshCatalog(); await tick(); assert.equal(f.model.state.turn.canRetry, true);
  assert.equal(await f.model.selectSession(b), false); assert.equal(await f.model.createSession('wf'), false);
  assert.equal(f.requests.length, 0); assert.equal(f.model.state.draft, 'original');
  f.scope('b'.repeat(64)); await f.model.refreshCatalog(); await tick();
  assert.equal(f.model.state.draft, ''); assert.equal(f.model.state.turn.request, undefined); f.model.dispose();
});
test('remote focus change locks stale catalog and clears draft; explicit refresh binds current snapshot', async () => {
  const f = fixture(); f.focus(a, 1); await f.model.refreshCatalog(); await tick(); f.model.setDraft('old');
  f.model.stopRead(); await tick(); f.focus(b, 2); await f.model.start(true);
  assert.equal(f.model.state.catalog.canWrite, false); assert.equal(f.model.state.turn.canSubmit, false); assert.equal(f.model.state.draft, '');
  await f.model.refreshCatalog(); await tick(); assert.equal(f.model.state.turn.canSubmit, true); f.model.dispose();
});
test('background during catalog/write discards late display, retains unknown lock, and never auto reads on rapid resume', async () => {
  const f = fixture(); await f.model.refreshCatalog(); const late = deferred<unknown>(); f.handle(async () => late.promise);
  const creating = f.model.createSession('wf'); await tick(); const before = f.watchers();
  f.model.setVisible(false); f.model.setVisible(true);
  late.resolve({ ...f.requests[0].scope, created: { id: a, workflow_id: 'wf', focus: { active_agent_session_id: a, version: 1, event_id: b } } });
  await creating; await tick(); assert.equal(f.model.state.catalog.writeBlocked, true); assert.equal(f.watchers(), before);
  f.model.dispose();
  const fresh = fixture(); const read = deferred<Awaited<ReturnType<Parameters<typeof fresh.read>[0]>>>(); fresh.read(async () => read.promise);
  const reading = fresh.model.refreshCatalog(); await tick(); fresh.model.setVisible(false); fresh.model.setVisible(true);
  read.resolve({ authScope: scope, focus: { active_agent_session_id: a, version: 1, event_id: b }, sessions: { items: [], has_more: false, next_cursor: null } });
  await reading; assert.equal(fresh.model.state.catalog.focus, null); assert.equal(fresh.model.state.catalog.canWrite, false); fresh.model.dispose();
});
