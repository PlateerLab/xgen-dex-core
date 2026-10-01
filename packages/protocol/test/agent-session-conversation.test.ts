import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentSessionHttpError, AgentSessionProtocolError, AgentSessionReadClient, parseAgentSessionMessagePage, parseAgentSessionSnapshot,
  type AgentSessionMessage, type AgentSessionSnapshot } from '../src/agent-session';
import { reconcileAgentConversation, type AgentConversationReader } from '../src/agent-session-conversation-recovery';

const sid = randomUUID(); const eventId = randomUUID(); const turnId = randomUUID();
const snapshot = (sequence = 6, version = 3): AgentSessionSnapshot => ({ id: sid, workflow_id: 'workflow', title: 'Shared', current_sequence: sequence,
  state_version: version, message_history_complete: false, latest_turn: { id: turnId, status: 'completed', accepted_sequence: 1 } });
const message = (sequence = 2): AgentSessionMessage => ({ turn_id: randomUUID(), sequence, status: 'completed', input_text: 'question',
  output_text: 'answer', source: 'user', content_complete: true });
const page = (messages: AgentSessionMessage[], cursor = messages.at(-1)?.sequence ?? 0, more = false, sequence = 6, version = 3) =>
  ({ messages, next_cursor: cursor, has_more: more, snapshot_sequence: sequence, state_version: version });

test('sparse linked messages project display fields and sign a query-free DPoP URL', async () => {
  const body = page([{ ...message(2), execution_io: 'private', tools: 'private' } as AgentSessionMessage, message(5)]);
  const parsed = parseAgentSessionMessagePage(body, 0, 2);
  assert.deepEqual(parsed.messages.map((m) => m.sequence), [2, 5]); assert.equal(JSON.stringify(parsed).includes('private'), false);
  assert.equal(parseAgentSessionMessagePage(page([], 5), 5).next_cursor, 5);
  let signed = ''; let requested = '';
  const client = new AgentSessionReadClient('https://app.example.test', { accessToken: async () => 'platform.access.jwt',
    signProof: async (method, url) => { assert.equal(method, 'GET'); signed = url; return 'proof.jwt.value'; } },
  (async (url, init) => { requested = String(url); assert.equal(init?.credentials, 'omit'); return new Response(JSON.stringify(body)); }) as typeof fetch);
  await client.messages(sid, 0, 2);
  assert.equal(signed, `https://app.example.test/api/agentflow/agent-sessions/${sid}/messages`);
  assert.equal(requested, `${signed}?after_sequence=0&limit=2`);
  for (const [after, limit] of [[-1, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [0, 21], [0, 0]]) await assert.rejects(client.messages(sid, after, limit), TypeError);
  await assert.rejects(client.messages(`${sid}\n`, 0), TypeError);
});
test('message cursor, IDs, terminal status, UTF8 size and completeness reject inconsistent responses', () => {
  const m = message();
  for (const broken of [page([m], 3), page([], 0, true), page([m], 2, false, 1), page([m, m], 2),
    page([{ ...m, status: 'running' } as unknown as AgentSessionMessage]), page([{ ...m, turn_id: `${sid}\n` }]),
    page([{ ...m, input_text: null }]), page([{ ...m, input_text: null, content_complete: false, source: 'user' }]),
    page([{ ...m, output_text: '가'.repeat(87382) }]), page([{ ...m, source: null } as unknown as AgentSessionMessage])]) {
    assert.throws(() => parseAgentSessionMessagePage(broken, 0), AgentSessionProtocolError);
  }
  assert.throws(() => parseAgentSessionMessagePage(page([m]), 2), AgentSessionProtocolError);
  assert.throws(() => parseAgentSessionMessagePage(page([m, message(5)]), 0, 1), AgentSessionProtocolError);
  const partial = { ...m, input_text: null, output_text: null, content_complete: false, source: 'unknown' as const };
  assert.deepEqual(parseAgentSessionMessagePage(page([partial]), 0).messages, [partial]);
  for (const latest of [{ id: sid, status: 'completed', accepted_sequence: 7 }, { id: `${sid}\n`, status: 'running', accepted_sequence: 1 },
    { id: sid, status: {}, accepted_sequence: 1 }]) assert.throws(() => parseAgentSessionSnapshot({ ...snapshot(), latest_turn: latest }), AgentSessionProtocolError);
  assert.deepEqual(parseAgentSessionSnapshot(snapshot()).latest_turn, snapshot().latest_turn);
});
function fixture(total = 2, text = 'answer') {
  let currentSid: string = sid; let sequence = total * 3; let version = 3;
  const messages = Array.from({ length: total }, (_, i) => ({ ...message(i * 3 + 2), output_text: text }));
  const calls: string[] = [];
  const reader: AgentConversationReader = {
    focus: async () => { calls.push('focus'); return { active_agent_session_id: currentSid, version: 1, event_id: eventId }; },
    accountEvents: async (after) => { calls.push('account'); return { events: [], next_cursor: after, snapshot_version: after, has_more: false }; },
    snapshot: async () => { calls.push('snapshot'); return { ...snapshot(sequence, version), id: currentSid }; },
    events: async (_sid, after) => { calls.push(`events:${after}`); return { events: [], next_cursor: after, snapshot_sequence: after, state_version: version, has_more: false }; },
    messages: async (_sid, after, limit) => { assert.equal(limit, 1); calls.push(`messages:${after}`); const remaining = messages.filter((m) => m.sequence > after);
      return parseAgentSessionMessagePage(page(remaining.slice(0, 1), remaining[0]?.sequence ?? after, remaining.length > 1, sequence, version), after, 1); },
  };
  return { reader, calls, messages, change: (id: string) => { currentSid = id; }, state: (seq: number, v: number) => { sequence = seq; version = v; } };
}
test('snapshot hydrates sparse messages without conflating event and message cursors; replay does not duplicate', async () => {
  const f = fixture(); const first = await reconcileAgentConversation(f.reader, 'account', null);
  assert.equal(first.state.eventCursor?.sequence, 6); assert.equal(first.state.messageCursor, 5); assert.equal(first.hasMore, false);
  assert.deepEqual(first.state.messages, f.messages); assert.equal(first.state.snapshot?.message_history_complete, false);
  const again = await reconcileAgentConversation(f.reader, 'account', first.state);
  assert.equal(again.source, 'replay'); assert.deepEqual(again.state.messages, first.state.messages);
  assert.ok(f.calls.includes('events:6')); assert.ok(f.calls.includes('messages:5'));
  assert.equal(first.state.messageCursor, 5);
});
test('changed login scope or focus discards prior transcript and incomplete account backlog never hydrates an intermediate pointer', async () => {
  const f = fixture(); const first = await reconcileAgentConversation(f.reader, 'A', null); f.change(randomUUID());
  const next = await reconcileAgentConversation(f.reader, 'B', first.state); assert.equal(next.source, 'snapshot'); assert.notEqual(next.state.snapshot?.id, sid);
  f.reader.accountEvents = async (after) => ({ events: [{ event_id: randomUUID(), sequence: after + 1, event_type: 'agent_session.focus_changed',
    previous_agent_session_id: after === 1 ? next.state.focus.active_agent_session_id : sid, active_agent_session_id: sid, origin_id: null, created_at: new Date().toISOString() }],
    next_cursor: after + 1, snapshot_version: 100, has_more: true });
  const before = f.calls.length; const backlog = await reconcileAgentConversation(f.reader, 'B', next.state);
  assert.equal(backlog.hasMore, true); assert.equal(backlog.state.snapshot, null); assert.deepEqual(backlog.state.messages, []);
  assert.equal(f.calls.slice(before).some((c) => c === 'snapshot'), false);
});
test('event gap/409 resumes with one rehydration; persistent corruption fails closed and auth/network never recover', async () => {
  for (const failure of ['gap', '409', '401', 'network']) {
    const f = fixture(); const first = await reconcileAgentConversation(f.reader, 'A', null); f.calls.length = 0;
    f.reader.events = async () => { if (failure === '409' || failure === '401') throw new AgentSessionHttpError(Number(failure));
      if (failure === 'network') throw new Error('network'); return { events: [{ event_id: randomUUID(), sequence: 8, event_type: 'turn.completed', created_at: new Date().toISOString() }],
        next_cursor: 8, snapshot_sequence: 8, state_version: 3, has_more: false }; };
    if (failure === 'gap' || failure === '409') {
      const recovered = await reconcileAgentConversation(f.reader, 'A', first.state); assert.equal(recovered.source, 'recovered'); assert.equal(recovered.state.messages.length, 2);
      assert.equal(f.calls.filter((c) => c === 'messages:0').length, 1);
    } else { await assert.rejects(reconcileAgentConversation(f.reader, 'A', first.state)); assert.equal(f.calls.some((c) => c.startsWith('messages:')), false); }
  }
  const f = fixture(); const first = await reconcileAgentConversation(f.reader, 'A', null); let attempts = 0;
  f.reader.messages = async () => { attempts++; throw new AgentSessionProtocolError('corruption'); };
  await assert.rejects(reconcileAgentConversation(f.reader, 'A', first.state), AgentSessionProtocolError); assert.equal(attempts, 2);
});
test('bounded message pages retain at most 100 turns and 4MiB without mutating the prior state', async () => {
  for (const [count, text, expected] of [[104, 'answer', 100], [20, 'x'.repeat(262144), 15]] as const) {
    const f = fixture(count, text); let result = await reconcileAgentConversation(f.reader, 'A', null);
    assert.equal(result.state.messages.length, 2); assert.equal(result.hasMore, true);
    const first = result.state;
    while (result.hasMore) result = await reconcileAgentConversation(f.reader, 'A', result.state);
    assert.equal(result.state.messages.length, expected); assert.equal(result.state.omittedMessages, count - expected);
    assert.equal(result.state.messageCursor, count * 3 - 1); assert.equal(first.messages.length, 2);
  }
});
test('final snapshot regression and cancellation never apply partial messages', async () => {
  const f = fixture(); let reads = 0; f.reader.snapshot = async () => snapshot(++reads === 1 ? 6 : 4);
  await assert.rejects(reconcileAgentConversation(f.reader, 'A', null), AgentSessionProtocolError);
  const control = new AbortController(); const c = fixture(); c.reader.messages = async () => { control.abort(); return page([message()]); };
  await assert.rejects(reconcileAgentConversation(c.reader, 'A', null, control.signal));
});
test('a focus switch during hydration clears the old transcript and resumes at the new owner pointer', async () => {
  const f = fixture(); const other = randomUUID(); let reads = 0; const newEvent = randomUUID();
  f.reader.focus = async () => ++reads === 1 ? { active_agent_session_id: sid, version: 1, event_id: eventId }
    : { active_agent_session_id: other, version: 2, event_id: newEvent };
  const moved = await reconcileAgentConversation(f.reader, 'A', null);
  assert.equal(moved.state.focus.active_agent_session_id, other); assert.equal(moved.state.snapshot, null); assert.equal(moved.hasMore, true);
  assert.deepEqual(moved.state.messages, []); f.change(other);
  const resumed = await reconcileAgentConversation(f.reader, 'A', moved.state); assert.equal(resumed.state.snapshot?.id, other); assert.equal(resumed.hasMore, false);
});
