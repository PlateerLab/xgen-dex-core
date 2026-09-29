import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentSessionHttpError, AgentSessionProtocolError, AgentSessionReadClient,
  PlatformCredentialUnavailable, applyAgentSessionEventPage,
  parseAgentSessionEventPage,
} from '../src/agent-session';

const SESSION = '018f1240-0000-7000-8000-000000000001';
const EVENT1 = '018f1240-0000-7000-8000-000000000002';
const EVENT2 = '018f1240-0000-7000-8000-000000000003';
const EVENT3 = '018f1240-0000-7000-8000-000000000004';

function event(sequence: number, eventId: string) {
  return {
    event_id: eventId, sequence, event_type: 'turn.accepted',
    created_at: '2026-09-29T04:00:00Z', turn_id: SESSION,
    platform_session_id: SESSION, device_id: SESSION, origin_id: 'cli-1',
    idempotency_key: 'request-1', payload_ref: null,
  };
}

function page(events: ReturnType<typeof event>[], cursor: number, snapshot: number, more = false, version = 3) {
  return {
    events, next_cursor: cursor, snapshot_sequence: snapshot,
    state_version: version, has_more: more,
  };
}

test('canonical reads use fresh DPoP and never inherit the legacy Bearer token', async () => {
  const signed: Array<[string, string, string]> = [];
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const proof = {
    accessToken: async () => 'platform.access.jwt',
    signProof: async (_method: 'GET', htu: string, token: string) => {
      signed.push(['GET', htu, token]);
      return `proof.${signed.length}.jwt`;
    },
  };
  const responses = [
    { active_agent_session_id: SESSION, version: 1, event_id: EVENT1 },
    { items: [{ id: SESSION, workflow_id: 'wf', title: 'Shared', status: 'active',
      current_sequence: 1, state_version: 2 }], next_cursor: null, has_more: false },
    { id: SESSION, workflow_id: 'wf', title: 'Shared', current_sequence: 1,
      state_version: 2, latest_turn: null, message_history_complete: true },
    page([event(1, EVENT1)], 1, 1, false, 2),
  ];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;
  const client = new AgentSessionReadClient('https://app.example.test', proof, fetchImpl);
  assert.equal((await client.focus()).active_agent_session_id, SESSION);
  assert.equal((await client.sessions()).items[0].id, SESSION);
  assert.equal((await client.snapshot(SESSION)).current_sequence, 1);
  assert.equal((await client.events(SESSION, 0)).events[0].sequence, 1);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/api/agentflow/me/agent-state', '/api/agentflow/me/agent-sessions',
    `/api/agentflow/agent-sessions/${SESSION}/snapshot`,
    `/api/agentflow/agent-sessions/${SESSION}/events`,
  ]);
  assert.equal(calls[3].url.search, '?after_sequence=0&limit=100');
  assert.equal(signed[3][1], `https://app.example.test/api/agentflow/agent-sessions/${SESSION}/events`);
  for (const [index, { init }] of calls.entries()) {
    assert.equal((init.headers as Record<string, string>).Authorization, 'DPoP platform.access.jwt');
    assert.equal((init.headers as Record<string, string>).DPoP, `proof.${index + 1}.jwt`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
  }
});

test('missing platform credentials and malformed identifiers fail before a request', async () => {
  let fetches = 0;
  const fetchImpl = (async () => { fetches++; throw new Error('unexpected fetch'); }) as typeof fetch;
  const client = new AgentSessionReadClient('https://app.example.test', {
    accessToken: async () => null,
    signProof: async () => { throw new Error('unexpected proof'); },
  }, fetchImpl);
  await assert.rejects(client.focus(), PlatformCredentialUnavailable);
  await assert.rejects(client.events('../other', 0), TypeError);
  assert.equal(fetches, 0);
  assert.throws(() => new AgentSessionReadClient('http://app.example.test', {
    accessToken: async () => null, signProof: async () => '',
  }, fetchImpl), TypeError);
});

test('HTTP rejection remains a failure without trying legacy authentication', async () => {
  for (const status of [401, 409, 503]) {
    let attempts = 0;
    const client = new AgentSessionReadClient('https://app.example.test', {
      accessToken: async () => 'platform.access.jwt',
      signProof: async () => 'proof.jwt.value',
    }, (async () => { attempts++; return new Response('', { status }); }) as typeof fetch);
    await assert.rejects(client.events(SESSION, 3), (error: unknown) =>
      error instanceof AgentSessionHttpError && error.status === status);
    assert.equal(attempts, 1);
  }
});

test('replay advances only after a continuous page and removes overlapping events', () => {
  const initial = { sequence: 0, eventId: null, stateVersion: 1 };
  const first = applyAgentSessionEventPage(initial, page([event(1, EVENT1)], 1, 2, true), 0);
  assert.deepEqual(first.events.map((item) => item.sequence), [1]);
  assert.equal(first.cursor.sequence, 1);
  const overlap = applyAgentSessionEventPage(first.cursor, page([
    event(1, EVENT1), event(2, EVENT2),
  ], 2, 2), 0);
  assert.deepEqual(overlap.events.map((item) => item.sequence), [2]);
  assert.equal(overlap.cursor.eventId, EVENT2);
  const retry = applyAgentSessionEventPage(overlap.cursor, page([
    event(1, EVENT1), event(2, EVENT2),
  ], 2, 2), 0);
  assert.deepEqual(retry.events, []);
  const later = applyAgentSessionEventPage(retry.cursor, {
    type: 'agent_session.events', ...page([event(3, EVENT3)], 3, 3, false, 4),
  }, 2);
  assert.deepEqual(later.events.map((item) => item.sequence), [3]);
  assert.equal(later.cursor.stateVersion, 4);
});

test('gap, future cursor, conflicting duplicate, and wrong frame type stop replay', () => {
  const initial = { sequence: 0, eventId: null, stateVersion: 1 };
  for (const broken of [
    page([event(2, EVENT1)], 2, 2),
    page([event(1, EVENT1)], 0, 1),
    page([event(1, EVENT1)], 1, 2),
    page([event(1, EVENT1)], 1, 1, true),
  ]) assert.throws(() => applyAgentSessionEventPage(initial, broken, 0), AgentSessionProtocolError);
  assert.throws(() => applyAgentSessionEventPage(initial, page([], 0, 0), 1), AgentSessionProtocolError);
  assert.throws(() => applyAgentSessionEventPage(
    { sequence: 1, eventId: EVENT1, stateVersion: 3 }, page([event(1, EVENT2)], 1, 1), 0,
  ), AgentSessionProtocolError);
  assert.throws(() => parseAgentSessionEventPage({
    type: 'agent_session.focus_changed', ...page([], 0, 0),
  }), AgentSessionProtocolError);
});

test('list pagination and event payloads reject inconsistent server responses', async () => {
  const client = new AgentSessionReadClient('https://app.example.test', {
    accessToken: async () => 'platform.access.jwt', signProof: async () => 'proof.jwt.value',
  }, (async () => new Response(JSON.stringify({
    items: [], next_cursor: null, has_more: true,
  }))) as typeof fetch);
  await assert.rejects(client.sessions(), AgentSessionProtocolError);
  assert.throws(() => parseAgentSessionEventPage({
    ...page([event(1, EVENT1)], 1, 1),
    events: [{ ...event(1, EVENT1), sequence: true }],
  }), AgentSessionProtocolError);
});
