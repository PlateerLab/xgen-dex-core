import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentTurnComposeFailure,
  AgentTurnComposer,
  type AgentTurnComposeRequest,
  type AgentTurnComposerView,
  type AgentTurnScope,
} from '../src/agent-turn-composer';

const SESSION = '018f1240-0000-7000-8000-000000000001';
const OTHER_SESSION = '018f1240-0000-7000-8000-000000000002';
const TURN = '018f1240-0000-7000-8000-000000000003';
const OTHER_TURN = '018f1240-0000-7000-8000-000000000004';
const SCOPE: AgentTurnScope = { platform_type: 'vscode', profile: 'corp', server_url: 'https://app.example.test', user_id: '7' };

function snapshot(stateVersion = 4, status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | null = null,
  id = SESSION, turn = TURN) {
  return { id, workflow_id: 'wf', title: 'Agent', current_sequence: status ? 8 : 0, state_version: stateVersion,
    message_history_complete: false,
    latest_turn: status ? { id: turn, status, accepted_sequence: 8 } : null };
}

function envelope(request: AgentTurnComposeRequest, mutation: unknown, patch: Record<string, unknown> = {}) {
  return { ...request.scope, agent_session_id: request.agent_session_id, mutation, ...patch };
}

function fixture(handler: (request: AgentTurnComposeRequest) => Promise<unknown>, keys = ['logical-key']) {
  const views: AgentTurnComposerView[] = [];
  const composer = new AgentTurnComposer(handler, (view) => views.push(view), () => keys.shift()!);
  composer.context(SCOPE, snapshot(), true);
  return { composer, views };
}

test('submit projects a safe request and holds acceptance until an authoritative terminal snapshot', async () => {
  const requests: AgentTurnComposeRequest[] = [];
  const f = fixture(async (request) => {
    requests.push(request);
    return envelope(request, { turn_id: TURN, status: 'accepted', accepted_sequence: 8,
      state_version: 5, replayed: false, private: 'discard' });
  });
  const result = await f.composer.submit('private prompt');
  assert.equal(result?.turn_id, TURN);
  assert.equal(f.composer.view.status, 'accepted');
  assert.equal(f.composer.view.canSubmit, false);
  assert.deepEqual(f.composer.view.request, { operation: 'submit', agent_session_id: SESSION,
    expected_state_version: 4, idempotency_key: 'logical-key' });
  assert.equal(JSON.stringify(f.views).includes('private prompt'), false);
  assert.equal(JSON.stringify(f.composer.view).includes('private'), false);
  assert.deepEqual(requests[0].input, { input_text: 'private prompt', expected_state_version: 4, idempotency_key: 'logical-key' });

  f.composer.context(SCOPE, snapshot(5, 'running'), true);
  assert.equal(f.composer.view.status, 'accepted');
  assert.equal(f.composer.view.canStop, true);
  f.composer.context(SCOPE, snapshot(5, 'completed', SESSION, OTHER_TURN), true);
  assert.equal(f.composer.view.status, 'accepted');
  assert.equal(f.composer.view.canSubmit, false);
  f.composer.context(SCOPE, snapshot(6, 'completed'), true);
  assert.equal(f.composer.view.status, 'idle');
  assert.equal(f.composer.view.canSubmit, true);
  assert.equal(f.composer.view.submitted, undefined);
});

test('unknown submit explicitly retries the exact original body, key, version and scope', async () => {
  const requests: AgentTurnComposeRequest[] = [];
  let attempt = 0;
  const f = fixture(async (request) => {
    requests.push(structuredClone(request));
    if (++attempt === 1) throw new Error('native transport details');
    return envelope(request, { turn_id: TURN, status: 'running', accepted_sequence: 8,
      state_version: 5, replayed: true });
  });
  await assert.rejects(f.composer.submit('same body'), (error: unknown) =>
    error instanceof AgentTurnComposeFailure && error.outcome === 'unknown'
      && !error.message.includes('transport'));
  assert.equal(f.composer.view.canRetry, true);
  assert.equal(f.composer.view.canSubmit, false);

  // A current snapshot must not silently rewrite the retry CAS reservation.
  f.composer.context(SCOPE, snapshot(5, 'running'), true);
  const replay = await f.composer.retry();
  assert.equal(replay && 'replayed' in replay && replay.replayed, true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal((requests[1].input as { expected_state_version: number }).expected_state_version, 4);
});

test('unknown attachment submit retries the exact ordered references after adapter mutation', async () => {
  const first = '018f1240-0000-7000-8000-000000000005';
  const second = '018f1240-0000-7000-8000-000000000006';
  const original = [
    { attachment_id: first, sha256: 'a'.repeat(64) },
    { attachment_id: second, sha256: 'b'.repeat(64) },
  ];
  const requests: AgentTurnComposeRequest[] = [];
  let attempt = 0;
  const f = fixture(async (request) => {
    requests.push(structuredClone(request));
    if (request.operation !== 'submit') throw new Error('unexpected operation');
    const sent = request.input.attachments as { attachment_id: string; sha256: string }[];
    sent.reverse();
    sent[0]!.attachment_id = TURN;
    if (++attempt === 1) throw new Error('lost acknowledgement');
    return envelope(requests.at(-1)!, { turn_id: TURN, status: 'running', accepted_sequence: 8,
      state_version: 5, replayed: true });
  });

  await assert.rejects(f.composer.submit('same body', original), AgentTurnComposeFailure);
  original.reverse();
  original[0]!.attachment_id = OTHER_TURN;
  await f.composer.retry();

  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual((requests[1] as Extract<AgentTurnComposeRequest, { operation: 'submit' }>).input.attachments, [
    { attachment_id: first, sha256: 'a'.repeat(64) },
    { attachment_id: second, sha256: 'b'.repeat(64) },
  ]);
  assert.equal((requests[1].input as { expected_state_version: number }).expected_state_version, 4);
  assert.equal((requests[1].input as { idempotency_key: string }).idempotency_key, 'logical-key');
});

test('temporary read unavailability preserves uncertain intent and disables every action', async () => {
  const f = fixture(async () => { throw new AgentTurnComposeFailure('unknown'); });
  await assert.rejects(f.composer.submit('question'), AgentTurnComposeFailure);
  f.composer.context({ ...SCOPE }, null, false);
  assert.deepEqual({ status: f.composer.view.status, submit: f.composer.view.canSubmit,
    retry: f.composer.view.canRetry, stop: f.composer.view.canStop },
  { status: 'unknown', submit: false, retry: false, stop: false });
  assert.equal(f.composer.view.request?.idempotency_key, 'logical-key');
  f.composer.context({ ...SCOPE }, snapshot(4), true);
  assert.equal(f.composer.view.status, 'unknown');
  assert.equal(f.composer.view.canRetry, true);
});

test('sending remains visible while the same context has a transient snapshot gap', async () => {
  let resolve!: (value: unknown) => void;
  let request!: AgentTurnComposeRequest;
  const f = fixture((value) => {
    request = value;
    return new Promise((done) => { resolve = done; });
  });
  const pending = f.composer.submit('question');
  f.composer.context({ ...SCOPE }, null, false);
  assert.deepEqual({ status: f.composer.view.status, submit: f.composer.view.canSubmit,
    retry: f.composer.view.canRetry, stop: f.composer.view.canStop },
  { status: 'sending', submit: false, retry: false, stop: false });
  assert.equal(f.composer.view.request?.operation, 'submit');
  resolve(envelope(request, { turn_id: TURN, status: 'accepted', accepted_sequence: 8,
    state_version: 5, replayed: false }));
  await pending;
  assert.equal(f.composer.view.status, 'accepted');
  assert.equal(f.composer.view.canSubmit, false);
});

test('a strictly newer different peer turn releases an obsolete accepted receipt', async () => {
  for (const peerStatus of ['running', 'completed'] as const) {
    const f = fixture(async (request) => envelope(request, {
      turn_id: TURN, status: 'accepted', accepted_sequence: 8, state_version: 5, replayed: false,
    }));
    await f.composer.submit('question');
    f.composer.context(SCOPE, snapshot(5, peerStatus, SESSION, OTHER_TURN), true);
    assert.equal(f.composer.view.status, 'accepted');
    assert.equal(f.composer.view.canSubmit, false);
    f.composer.context(SCOPE, snapshot(6, peerStatus, SESSION, OTHER_TURN), true);
    assert.equal(f.composer.view.status, 'idle');
    assert.equal(f.composer.view.canSubmit, peerStatus === 'completed');
    assert.equal(f.composer.view.canStop, peerStatus === 'running');
  }
});

test('scope and session changes suppress late acknowledgements and clear private intent', async () => {
  let resolve!: (value: unknown) => void;
  let enter!: () => void;
  const entered = new Promise<void>((done) => { enter = done; });
  const f = fixture((request) => { enter(); return new Promise((r) => { resolve = r; }); });
  const pending = f.composer.submit('old account secret');
  await entered;
  f.composer.context({ ...SCOPE, user_id: '8' }, snapshot(4), true);
  resolve(envelope({ operation: 'submit', scope: SCOPE, agent_session_id: SESSION,
    input: { input_text: 'old account secret', expected_state_version: 4, idempotency_key: 'logical-key' } },
  { turn_id: TURN, status: 'accepted', accepted_sequence: 8, state_version: 5, replayed: false }));
  assert.equal(await pending, null);
  assert.equal(f.composer.view.status, 'idle');
  assert.equal(f.composer.view.request, undefined);

  const session = fixture(async () => { throw new Error('not used'); });
  session.composer.context(SCOPE, snapshot(4, null, OTHER_SESSION), true);
  assert.equal(session.composer.view.canSubmit, true);
  assert.equal(session.composer.view.request, undefined);
});

test('forged native envelopes and malformed acknowledgements have an unknown outcome', async () => {
  for (const reply of [
    (request: AgentTurnComposeRequest) => envelope(request, { turn_id: TURN, status: 'accepted', accepted_sequence: 8,
      state_version: 5, replayed: false }, { user_id: '8' }),
    (request: AgentTurnComposeRequest) => envelope(request, { turn_id: TURN, status: 'accepted', accepted_sequence: 8,
      state_version: 99, replayed: false }),
  ]) {
    const f = fixture(async (request) => reply(request));
    await assert.rejects(f.composer.submit('question'), (error: unknown) =>
      error instanceof AgentTurnComposeFailure && error.outcome === 'unknown');
    assert.equal(f.composer.view.status, 'unknown');
    assert.equal(f.composer.view.canRetry, true);
  }
});

test('authoritative rejection releases intent and retains only allowlisted conflict metadata', async () => {
  const f = fixture(async () => { throw new AgentTurnComposeFailure('rejected', {
    code: 'TURN_IN_PROGRESS', current_state_version: 5, current_turn_id: TURN,
  }); });
  await assert.rejects(f.composer.submit('question'), (error: unknown) => {
    assert(error instanceof AgentTurnComposeFailure);
    assert.equal(error.outcome, 'rejected');
    assert.deepEqual(error.conflict, { code: 'TURN_IN_PROGRESS', current_state_version: 5, current_turn_id: TURN });
    return true;
  });
  assert.equal(f.composer.view.status, 'rejected');
  assert.equal(f.composer.view.canRetry, false);
  assert.equal(f.composer.view.canSubmit, true);
});

test('repeated submit and stop clicks are rejected before a second send', async () => {
  let release!: (value: unknown) => void;
  let calls = 0;
  const f = fixture((request) => {
    calls++;
    return new Promise((resolve) => { release = (mutation) => resolve(envelope(request, mutation)); });
  });
  const pending = f.composer.submit('once');
  await assert.rejects(f.composer.submit('twice'), (error: unknown) =>
    error instanceof AgentTurnComposeFailure && error.outcome === 'unavailable');
  await assert.rejects(f.composer.stop(), AgentTurnComposeFailure);
  assert.equal(calls, 1);
  release({ turn_id: TURN, status: 'accepted', accepted_sequence: 8, state_version: 5, replayed: false });
  await pending;
});

test('stop uses only a verified active latest turn and the current version, then waits for terminal state', async () => {
  const requests: AgentTurnComposeRequest[] = [];
  const f = fixture(async (request) => {
    requests.push(request);
    return envelope(request, { turn_id: TURN, state_version: 5, requested: true, completed: true });
  });
  f.composer.context(SCOPE, snapshot(5, 'running'), true);
  const result = await f.composer.stop();
  assert.deepEqual(result, { turn_id: TURN, state_version: 5, requested: true });
  assert.deepEqual(requests[0].input, { turn_id: TURN, expected_state_version: 5 });
  assert.equal(f.composer.view.status, 'stop-requested');
  assert.equal(f.composer.view.canSubmit, false);
  assert.equal(f.composer.view.canStop, false);
  f.composer.context(SCOPE, snapshot(5, 'running'), true);
  assert.equal(f.composer.view.status, 'stop-requested');
  f.composer.context(SCOPE, snapshot(5, 'running', SESSION, OTHER_TURN), true);
  assert.equal(f.composer.view.status, 'stop-requested');
  assert.equal(f.composer.view.canSubmit, false);
  f.composer.context(SCOPE, snapshot(6, 'cancelled'), true);
  assert.equal(f.composer.view.status, 'idle');
  assert.equal(f.composer.view.canSubmit, true);

  f.composer.context(SCOPE, snapshot(7, 'completed', SESSION, OTHER_TURN), true);
  await assert.rejects(f.composer.stop(), AgentTurnComposeFailure);
  assert.equal(requests.length, 1);
});

test('backlogged snapshots still expose actions from verified latest turn state', () => {
  const f = fixture(async () => ({}));
  assert.equal(f.composer.view.canSubmit, true);
  f.composer.context(SCOPE, snapshot(4, 'accepted'), true);
  assert.equal(f.composer.view.canSubmit, false);
  assert.equal(f.composer.view.canStop, true);
});

test('context copies primitives, rejects rollback, and an authoritative missing session clears state', async () => {
  const mutable = snapshot(4);
  const f = fixture(async () => { throw new AgentTurnComposeFailure('unknown'); });
  f.composer.context(SCOPE, mutable, true);
  mutable.state_version = 99;
  await assert.rejects(f.composer.submit('stable'), AgentTurnComposeFailure);
  assert.equal(f.composer.view.request?.expected_state_version, 4);
  f.composer.context(SCOPE, snapshot(3), true);
  assert.equal(f.composer.view.status, 'unknown');
  assert.equal(f.composer.view.canRetry, false);
  f.composer.context(SCOPE, null, true);
  assert.equal(f.composer.view.status, 'unavailable');
  assert.equal(f.composer.view.request, undefined);
});

test('invalid scope, input Unicode and generated keys fail before dispatch', async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; return {}; }, ['bad key']);
  await assert.rejects(f.composer.submit('\ud800'), TypeError);
  await assert.rejects(f.composer.submit('valid'), TypeError);
  assert.equal(sends, 0);
  assert.throws(() => f.composer.context({ ...SCOPE, server_url: 'http://app.example.test' }, snapshot(), true), TypeError);
  assert.equal(f.composer.view.status, 'unavailable');
  assert.equal(f.composer.view.canSubmit, false);
  assert.throws(() => f.composer.context({ ...SCOPE, user_id: '07' }, snapshot(), true), TypeError);
  assert.throws(() => f.composer.context({ ...SCOPE, user_id: 7 as unknown as string }, snapshot(), true), TypeError);
});

test('reset invalidates late results and immutable public views never expose input text', async () => {
  let resolve!: (value: unknown) => void;
  let request!: AgentTurnComposeRequest;
  const f = fixture((value) => { request = value; return new Promise((done) => { resolve = done; }); });
  const pending = f.composer.submit('never render this');
  assert.throws(() => { (f.composer.view as { notice: string }).notice = 'mutated'; }, TypeError);
  f.composer.reset();
  resolve(envelope(request, { turn_id: TURN, status: 'accepted', accepted_sequence: 8, state_version: 5, replayed: false }));
  assert.equal(await pending, null);
  assert.equal(f.composer.view.status, 'unavailable');
  assert.equal(JSON.stringify(f.views).includes('never render this'), false);
});
