import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionHttpError } from '../src/agent-session';
import {
  reconcileAgentFocus, type AgentFocusReader, type ScopedAgentFocus,
} from '../src/agent-session-focus-recovery';

const SESSION = '018f1240-0000-7000-8000-000000000001';
const EVENT1 = '018f1240-0000-7000-8000-000000000002';
const EVENT2 = '018f1240-0000-7000-8000-000000000003';
const initial: ScopedAgentFocus = {
  authScope: 'verified-login-A',
  focus: { active_agent_session_id: null, version: 0, event_id: null },
};

function event(sequence: number, eventId: string, previous: string | null, active: string | null) {
  return {
    event_id: eventId, sequence, event_type: 'agent_session.focus_changed' as const,
    previous_agent_session_id: previous, active_agent_session_id: active,
    origin_id: 'desktop-1', created_at: '2026-09-30T00:00:00Z',
  };
}

function page(events: ReturnType<typeof event>[], cursor: number, snapshot: number, hasMore = false) {
  return { events, next_cursor: cursor, snapshot_version: snapshot, has_more: hasMore };
}

test('new or changed verified login scope loads a fresh snapshot before reading events', async () => {
  const snapshots = [
    { active_agent_session_id: SESSION, version: 1, event_id: EVENT1 },
    { active_agent_session_id: null, version: 0, event_id: null },
  ];
  const reader: AgentFocusReader = {
    focus: async () => snapshots.shift()!,
    accountEvents: async () => { throw new Error('must not replay another account'); },
  };
  const first = await reconcileAgentFocus(reader, 'verified-login-A', null);
  assert.equal(first.source, 'snapshot');
  assert.equal(first.state.focus.active_agent_session_id, SESSION);
  const switched = await reconcileAgentFocus(reader, 'verified-login-B', first.state);
  assert.equal(switched.source, 'snapshot');
  assert.equal(switched.state.authScope, 'verified-login-B');
  assert.equal(switched.state.focus.version, 0);
  await assert.rejects(reconcileAgentFocus(reader, '  ', initial), TypeError);
});

test('same login scope replays all pages in order and leaves the input state untouched', async () => {
  const cursors: number[] = [];
  const reader: AgentFocusReader = {
    focus: async () => { throw new Error('unexpected snapshot'); },
    accountEvents: async (after, limit) => {
      cursors.push(after);
      assert.equal(limit, 100);
      return after === 0
        ? page([event(1, EVENT1, null, SESSION)], 1, 2, true)
        : page([event(2, EVENT2, SESSION, null)], 2, 2);
    },
  };
  const result = await reconcileAgentFocus(reader, initial.authScope, initial);
  assert.deepEqual(cursors, [0, 1]);
  assert.equal(result.source, 'replay');
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.state.focus, {
    active_agent_session_id: null, version: 2, event_id: EVENT2,
  });
  assert.equal(initial.focus.version, 0);
});

test('409 or an invalid replay page recovers with an owner-scoped focus snapshot', async () => {
  for (const fail of [
    () => { throw new AgentSessionHttpError(409); },
    () => page([event(2, EVENT2, null, SESSION)], 2, 2),
  ]) {
    let snapshots = 0;
    const reader: AgentFocusReader = {
      focus: async () => {
        snapshots++;
        return { active_agent_session_id: SESSION, version: 2, event_id: EVENT2 };
      },
      accountEvents: async () => fail(),
    };
    const result = await reconcileAgentFocus(reader, initial.authScope, initial);
    assert.equal(result.source, 'recovered');
    assert.equal(result.state.focus.version, 2);
    assert.equal(result.hasMore, false);
    assert.equal(snapshots, 1);
  }
});

test('authentication, network, and cancellation failures never use a snapshot fallback', async () => {
  for (const error of [new AgentSessionHttpError(401), new AgentSessionHttpError(403),
    new Error('network unavailable')]) {
    const reader: AgentFocusReader = {
      focus: async () => { throw new Error('unexpected snapshot'); },
      accountEvents: async () => { throw error; },
    };
    await assert.rejects(reconcileAgentFocus(reader, initial.authScope, initial),
      (caught: unknown) => caught === error);
  }
  const controller = new AbortController();
  const reader: AgentFocusReader = {
    focus: async () => { throw new Error('unexpected snapshot'); },
    accountEvents: async () => {
      controller.abort();
      throw new AgentSessionHttpError(409);
    },
  };
  await assert.rejects(reconcileAgentFocus(reader, initial.authScope, initial, controller.signal),
    (caught: unknown) => caught instanceof AgentSessionHttpError && caught.status === 409);
});

test('a bounded step returns a resumable cursor when the backlog keeps growing', async () => {
  const cursors: number[] = [];
  const reader: AgentFocusReader = {
    focus: async () => { throw new Error('unexpected snapshot'); },
    accountEvents: async (after) => {
      cursors.push(after);
      const sequence = after + 1;
      const eventId = `018f1240-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
      return page([event(sequence, eventId, after % 2 ? SESSION : null,
        sequence % 2 ? SESSION : null)], sequence, 11, sequence < 11);
    },
  };
  const first = await reconcileAgentFocus(reader, initial.authScope, initial);
  assert.equal(first.state.focus.version, 10);
  assert.equal(first.hasMore, true);
  const resumed = await reconcileAgentFocus(reader, initial.authScope, first.state);
  assert.equal(resumed.state.focus.version, 11);
  assert.equal(resumed.hasMore, false);
  assert.deepEqual(cursors, Array.from({ length: 11 }, (_, index) => index));
});
