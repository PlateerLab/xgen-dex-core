import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTurnComposeFailure, type AgentTurnComposeRequest } from '@dex/protocol/agent-turn-composer';
import type { MobileCanonicalUpdate } from '../src/lib/native-agent-focus-watch';
import type { MobileConversationView } from '../src/lib/native-agent-conversation-watch';
import { MobileAgentConversationModel } from '../src/lib/native-agent-conversation-model';
const sid = '018f1240-0000-7000-8000-000000000001'; const turnId = '018f1240-0000-7000-8000-000000000002';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function value(version = 4, status: 'running' | 'completed' | null = null, id = sid, authScope = 'verified-scope'): MobileConversationView {
  return { authScope, messages: [], omittedMessages: 0,
    snapshot: { id, workflow_id: 'wf', title: 'Shared', state_version: version, current_sequence: 1, message_history_complete: true,
      latest_turn: status ? { id: turnId, status, accepted_sequence: 1 } : null } };
}
function fixture() {
  let current: MobileConversationView = value(); let hasMore = false; let emit!: (u: MobileCanonicalUpdate<MobileConversationView>) => void;
  let readCount = 0; let disposed = false;
  let handler = async (r: AgentTurnComposeRequest): Promise<unknown> => ({ ...r.scope, agent_session_id: r.agent_session_id,
    mutation: r.operation === 'submit' ? { turn_id: turnId, status: 'accepted', accepted_sequence: 1, state_version: r.input.expected_state_version + 1, replayed: false }
      : { turn_id: r.input.turn_id, state_version: r.input.expected_state_version, requested: true } });
  const requests: AgentTurnComposeRequest[] = [];
  const model = new MobileAgentConversationModel({ origin: 'https://mobile.example.test', userId: '7' }, {
    async run(update, signal, once) {
      readCount++; emit = update; update({ type: 'reset' }); update({ type: 'value', value: structuredClone(current), hasMore, source: 'snapshot' });
      if (!once) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); });
    },
  }, { send: async (r, _signal) => { requests.push(structuredClone(r)); return handler(r); }, dispose: () => { disposed = true; } },
  () => undefined, () => 'logical-one'); model.setVisible(true);
  return { model, requests, reads: () => readCount, disposed: () => disposed,
    next(v: MobileConversationView, more = false) { current = v; hasMore = more; },
    update(v: MobileConversationView, more = false) { current = v; emit({ type: 'value', value: v, source: 'snapshot', hasMore: more }); },
    emit(u: MobileCanonicalUpdate<MobileConversationView>) { emit(u); }, handle(v: typeof handler) { handler = v; } };
}
const tick = () => new Promise((r) => setImmediate(r));
test('same login unknown survives screen/background hide; explicit retry keeps original body/key/version and clears accepted draft', async () => {
  const f = fixture(); await f.model.start(true); f.model.setDraft('  exact\n끝\n'); let count = 0;
  f.handle(async (r) => { if (++count === 1) throw new AgentTurnComposeFailure('unknown'); return { ...r.scope, agent_session_id: sid,
    mutation: { turn_id: turnId, status: 'running', accepted_sequence: 1, state_version: 5, replayed: true } }; });
  await f.model.submit(); await tick(); assert.equal(f.model.state.turn.status, 'unknown'); assert.equal(f.requests.length, 1);
  f.model.setVisible(false); assert.equal(f.model.state.conversation, null); assert.equal(f.model.state.draft, ''); assert.equal(f.model.state.turn.canRetry, false);
  await tick(); const reads = f.reads(); f.model.setVisible(true); assert.equal(f.reads(), reads); assert.equal(f.model.state.draft, '  exact\n끝\n');
  f.next(value(5, 'running')); await f.model.start(true); await f.model.retry(); await tick();
  assert.deepEqual(f.requests[1], f.requests[0]); assert.equal(f.model.state.draft, ''); assert.equal(f.model.state.turn.canSubmit, false); f.model.dispose();
});
test('double clicks send once, then exact verified stop ACK remains distinct from terminal cancellation', async () => {
  const f = fixture(); await f.model.start(true); f.model.setDraft('once'); const gate = deferred<unknown>(); let request!: AgentTurnComposeRequest;
  f.handle(async (r) => { request = r; return gate.promise; }); const send = f.model.submit(); await tick(); await f.model.submit(); assert.equal(f.requests.length, 1);
  f.next(value(5, 'running')); gate.resolve({ ...request.scope, agent_session_id: sid,
    mutation: { turn_id: turnId, status: 'accepted', accepted_sequence: 1, state_version: 5, replayed: false } }); await send; await tick();
  assert.equal(f.model.state.turn.canStop, true);
  f.handle(async (r) => ({ ...r.scope, agent_session_id: sid, mutation: { turn_id: turnId, state_version: 5, requested: true } }));
  await f.model.stopTurn(); await tick(); assert.deepEqual(f.requests[1].input, { turn_id: turnId, expected_state_version: 5 });
  assert.equal(f.model.state.turn.status, 'stop-requested'); assert.equal(f.model.state.turn.canSubmit, false);
  f.update(value(6, 'completed')); assert.equal(f.model.state.turn.canSubmit, true); f.model.dispose();
});
test('transient read failure keeps uncertain intent; changed focus, platform session or empty focus erases draft and intent', async () => {
  for (const next of [value(4, null, '018f1240-0000-7000-8000-000000000003'), value(4, null, sid, 'new-platform-sid'), { ...value(), snapshot: null }]) {
    const f = fixture(); await f.model.start(true); f.model.setDraft('old account draft'); f.handle(async () => { throw new AgentTurnComposeFailure('unknown'); });
    await f.model.submit(); await tick(); f.emit({ type: 'reconnecting', retryInMs: 1000 }); assert.equal(f.model.state.turn.status, 'unknown');
    assert.equal(f.model.state.turn.canRetry, false); f.update(next); assert.equal(f.model.state.turn.request, undefined); assert.equal(f.model.state.draft, ''); f.model.dispose();
  }
});
test('hiding during dispatch cancels wait, retains unknown, discards late old-owner callbacks and never auto writes on resume', async () => {
  const f = fixture(); await f.model.start(true); f.model.setDraft('one'); const gate = deferred<unknown>();
  f.handle(async () => gate.promise); const send = f.model.submit(); await tick(); f.model.setVisible(false);
  gate.resolve(Promise.reject(new AgentTurnComposeFailure('unknown'))); await send; assert.equal(f.model.state.turn.status, 'unknown');
  assert.equal(f.model.state.conversation, null); f.model.setVisible(true); assert.equal(f.requests.length, 1); assert.equal(f.model.state.turn.canRetry, false); f.model.dispose();
});
test('partial no-snapshot replay blocks writes without falsely clearing draft; full empty focus clears it', async () => {
  const f = fixture(); await f.model.start(true); f.model.setDraft('draft'); void f.model.start(false); await tick();
  f.update({ ...value(), snapshot: null }, true); assert.equal(f.model.state.draft, 'draft'); assert.equal(f.model.state.turn.canSubmit, false);
  f.update({ ...value(), snapshot: null }, false); assert.equal(f.model.state.draft, ''); assert.equal(f.model.state.turn.request, undefined); f.model.dispose();
});
test('unknown retry stays blocked without verified snapshot; new login owner never inherits intent', async () => {
  const f = fixture(); await f.model.start(true); f.model.setDraft('old'); f.handle(async () => { throw new AgentTurnComposeFailure('unknown'); }); await f.model.submit(); await tick();
  f.model.dispose(); assert(f.disposed()); assert.equal(f.model.state.turn.request, undefined);
  const fresh = fixture(); assert.equal(fresh.model.state.draft, ''); assert.equal(fresh.model.state.turn.canRetry, false); fresh.model.dispose();
});
test('rapid background/foreground during a write still requires explicit read after the cancelled write settles', async () => {
  const f = fixture(); await f.model.start(true); f.model.setDraft('one'); const gate = deferred<unknown>();
  f.handle(async () => gate.promise); const sending = f.model.submit(); await tick(); const before = f.reads();
  f.model.setVisible(false); f.model.setVisible(true); gate.resolve(Promise.reject(new AgentTurnComposeFailure('unknown')));
  await sending; await tick(); assert.equal(f.reads(), before); assert.equal(f.model.state.turn.canRetry, false);
  await f.model.start(true); assert.equal(f.model.state.turn.canRetry, true); f.model.dispose();
});
