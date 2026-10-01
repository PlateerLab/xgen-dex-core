import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentSessionMutationClient,
  AgentSessionMutationHttpError,
  AgentSessionMutationOutcomeUnknown,
  parseStoppedAgentTurn,
  parseSubmittedAgentTurn,
  validateStopAgentTurn,
  validateSubmitAgentTurn,
  type AgentSessionMutationProofSource,
  type SubmitAgentTurnInput,
} from '../src/agent-session-mutation';

const SESSION = '018f1240-0000-7000-8000-000000000001';
const TURN = '018f1240-0000-7000-8000-000000000002';
const OTHER_TURN = '018f1240-0000-7000-8000-000000000003';
const SUBMIT: SubmitAgentTurnInput = {
  input_text: '질문', expected_state_version: 7, idempotency_key: 'request-1', origin_id: 'cli-1',
};

function submitted(patch: Record<string, unknown> = {}) {
  return {
    turn_id: TURN, status: 'accepted', accepted_sequence: 11,
    state_version: 8, replayed: false, ...patch,
  };
}

function proof(overrides: Partial<AgentSessionMutationProofSource> = {}): AgentSessionMutationProofSource {
  return {
    accessToken: async () => 'platform.access.jwt',
    signProof: async () => 'proof.jwt.value',
    ...overrides,
  };
}

function clientWith(responses: Array<Response | unknown>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const signatures: Array<{ method: string; htu: string; token: string }> = [];
  const source = proof({
    signProof: async (method, htu, token) => {
      signatures.push({ method, htu, token });
      return `proof.${signatures.length}.jwt`;
    },
  });
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const value = responses.shift();
    return value instanceof Response ? value : Response.json(value, { status: 202 });
  }) as typeof fetch;
  return { calls, signatures, client: new AgentSessionMutationClient('https://app.example.test', source, fetchImpl) };
}

test('submit and stop use the exact canonical write transport and project safe acknowledgements', async () => {
  const f = clientWith([
    submitted({ internal_debug: 'discard me' }),
    { turn_id: TURN, state_version: 8, requested: true, internal_debug: 'discard me' },
  ]);
  assert.deepEqual(await f.client.submitTurn(SESSION, SUBMIT), submitted());
  assert.deepEqual(await f.client.stopTurn(SESSION, { turn_id: TURN, expected_state_version: 8 }), {
    turn_id: TURN, state_version: 8, requested: true,
  });
  assert.deepEqual(f.calls.map((call) => new URL(call.url).pathname), [
    `/api/agentflow/agent-sessions/${SESSION}/turns`,
    `/api/agentflow/agent-sessions/${SESSION}/stop`,
  ]);
  assert.deepEqual(f.calls[0].body, SUBMIT);
  assert.deepEqual(f.calls[1].body, { turn_id: TURN, expected_state_version: 8 });
  assert.deepEqual(f.signatures.map((item) => item.htu), f.calls.map((item) => item.url));
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, {
      Authorization: 'DPoP platform.access.jwt', DPoP: `proof.${index + 1}.jwt`,
      Accept: 'application/json', 'Content-Type': 'application/json',
    });
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
  }
});

test('trusted native response adapters may provide bounded json without a readable body stream', async () => {
  let cancelled = false;
  const response = {
    status: 202, ok: true,
    body: { cancel: async () => { cancelled = true; } },
    json: async () => submitted(),
  } as unknown as Response;
  const client = new AgentSessionMutationClient('https://app.example.test', proof(),
    (async () => response) as typeof fetch);
  assert.deepEqual(await client.submitTurn(SESSION, SUBMIT), submitted());
  assert.equal(cancelled, false);

  const conflict = {
    status: 409, ok: false,
    body: { cancel: async () => { cancelled = true; } },
    json: async () => ({ detail: { code: 'STATE_VERSION_CONFLICT', current_state_version: 8 } }),
  } as unknown as Response;
  const conflictClient = new AgentSessionMutationClient('https://app.example.test', proof(),
    (async () => conflict) as typeof fetch);
  await assert.rejects(conflictClient.submitTurn(SESSION, SUBMIT), (error: unknown) =>
    error instanceof AgentSessionMutationHttpError
    && error.conflict?.code === 'STATE_VERSION_CONFLICT'
    && error.conflict.current_state_version === 8);
});

test('each explicit retry obtains fresh proof while a same-key replay preserves the original reservation', async () => {
  const f = clientWith([
    submitted(),
    submitted({ status: 'running', replayed: true }),
  ]);
  const first = await f.client.submitTurn(SESSION, SUBMIT);
  const replay = await f.client.submitTurn(SESSION, { ...SUBMIT });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.turn_id, first.turn_id);
  assert.equal(f.signatures.length, 2);
  assert.notEqual((f.calls[0].init.headers as Record<string, string>).DPoP,
    (f.calls[1].init.headers as Record<string, string>).DPoP);
  assert.deepEqual(f.calls.map((call) => call.body.idempotency_key), ['request-1', 'request-1']);
});

test('request validation and serialization finish before asynchronous credential work can mutate input', async () => {
  const input = { ...SUBMIT };
  let fetchBody: unknown;
  const source = proof({ accessToken: async () => {
    input.input_text = 'mutated prompt';
    input.idempotency_key = 'mutated-key';
    input.expected_state_version = 99;
    return 'platform.access.jwt';
  } });
  const client = new AgentSessionMutationClient('https://app.example.test', source, (async (_url, init) => {
    fetchBody = JSON.parse(String(init?.body));
    return Response.json(submitted(), { status: 202 });
  }) as typeof fetch);
  await client.submitTurn(SESSION, input);
  assert.deepEqual(fetchBody, SUBMIT);
});

test('validators return copies and reject unknown fields, unsafe primitives, malformed Unicode and noncanonical UUIDs', () => {
  const normalized = validateSubmitAgentTurn(SESSION, SUBMIT);
  assert.notEqual(normalized, SUBMIT);
  assert.deepEqual(normalized, SUBMIT);
  const stop = { turn_id: TURN, expected_state_version: 1 };
  const normalizedStop = validateStopAgentTurn(SESSION, stop);
  assert.notEqual(normalizedStop, stop);
  assert.deepEqual(normalizedStop, stop);
  const invalidSubmits: unknown[] = [
    { ...SUBMIT, extra: true }, { ...SUBMIT, input_text: '' },
    { ...SUBMIT, input_text: '\ud800' }, { ...SUBMIT, input_text: '🙂'.repeat(65_537) },
    { ...SUBMIT, expected_state_version: 0 }, { ...SUBMIT, expected_state_version: Number.MAX_SAFE_INTEGER },
    { ...SUBMIT, idempotency_key: 'has space' }, { ...SUBMIT, idempotency_key: 'é' },
    { ...SUBMIT, origin_id: '' }, { ...SUBMIT, origin_id: '\udfff' },
  ];
  for (const value of invalidSubmits) {
    assert.throws(() => validateSubmitAgentTurn(SESSION, value as SubmitAgentTurnInput), TypeError);
  }
  assert.throws(() => validateSubmitAgentTurn(SESSION.toUpperCase(), SUBMIT), TypeError);
  assert.throws(() => validateStopAgentTurn(SESSION, {
    turn_id: TURN, expected_state_version: 1, extra: true,
  } as unknown as Parameters<typeof validateStopAgentTurn>[1]), TypeError);
  assert.throws(() => validateStopAgentTurn(SESSION, { turn_id: TURN.toUpperCase(), expected_state_version: 1 }), TypeError);
});

test('invalid input fails synchronously before credentials, proof, or fetch are consulted', async () => {
  let credentials = 0; let signatures = 0; let fetches = 0;
  const client = new AgentSessionMutationClient('https://app.example.test', proof({
    accessToken: async () => { credentials++; return 'platform.access.jwt'; },
    signProof: async () => { signatures++; return 'proof.jwt.value'; },
  }), (async () => { fetches++; throw new Error('unexpected'); }) as typeof fetch);
  const request = client.submitTurn(SESSION, { ...SUBMIT, extra: 'secret' } as SubmitAgentTurnInput);
  assert.equal(credentials, 0);
  await assert.rejects(request, TypeError);
  assert.deepEqual([credentials, signatures, fetches], [0, 0, 0]);
});

test('only exact HTTPS origins are accepted', () => {
  for (const origin of [
    'http://app.example.test', 'https://app.example.test/', 'https://APP.example.test',
    'https://app.example.test:443', 'https://user:pass@app.example.test',
    'https://app.example.test/path', 'https://app.example.test?query', 'https://app.example.test#fragment',
  ]) assert.throws(() => new AgentSessionMutationClient(origin, proof()), TypeError);
});

test('authoritative HTTP rejection exposes only the status and allowlisted 409 conflict metadata', async () => {
  for (const status of [400, 401, 403, 422, 429]) {
    const f = clientWith([new Response(`private-${status}`, { status })]);
    await assert.rejects(f.client.submitTurn(SESSION, SUBMIT), (error: unknown) =>
      error instanceof AgentSessionMutationHttpError
      && error.status === status && error.conflict === undefined
      && !error.message.includes('private'));
  }
  const conflict = clientWith([Response.json({ detail: {
    code: 'TURN_IN_PROGRESS', current_state_version: 9, current_turn_id: OTHER_TURN,
    prompt: 'must not escape', token: 'must not escape',
  } }, { status: 409 })]);
  await assert.rejects(conflict.client.submitTurn(SESSION, SUBMIT), (error: unknown) => {
    assert(error instanceof AgentSessionMutationHttpError);
    assert.deepEqual(error.conflict, {
      code: 'TURN_IN_PROGRESS', current_state_version: 9, current_turn_id: OTHER_TURN,
    });
    assert.equal(JSON.stringify(error).includes('must not escape'), false);
    return true;
  });
  const unknownCode = clientWith([Response.json({ detail: {
    code: 'SECRET_CONFLICT', current_state_version: 9, current_turn_id: OTHER_TURN,
  } }, { status: 409 })]);
  await assert.rejects(unknownCode.client.submitTurn(SESSION, SUBMIT), (error: unknown) =>
    error instanceof AgentSessionMutationHttpError && error.status === 409 && error.conflict === undefined);
});

test('transport loss, timeout statuses, redirects and server failures have an unknown write outcome', async () => {
  for (const response of [new Response('', { status: 408 }), new Response('', { status: 500 }), new Response('', { status: 302 })]) {
    const f = clientWith([response]);
    await assert.rejects(f.client.submitTurn(SESSION, SUBMIT), AgentSessionMutationOutcomeUnknown);
    assert.equal(f.calls.length, 1);
  }
  let attempts = 0;
  const client = new AgentSessionMutationClient('https://app.example.test', proof(), (async () => {
    attempts++; throw new TypeError('network details');
  }) as typeof fetch);
  await assert.rejects(client.submitTurn(SESSION, SUBMIT), (error: unknown) =>
    error instanceof AgentSessionMutationOutcomeUnknown && !error.message.includes('network details'));
  assert.equal(attempts, 1);
});

test('abort before dispatch stays an abort, while abort after dispatch has an unknown outcome', async () => {
  const before = new AbortController(); before.abort();
  let beforeFetches = 0;
  const beforeClient = new AgentSessionMutationClient('https://app.example.test', proof(), (async () => {
    beforeFetches++; throw new Error('unexpected');
  }) as typeof fetch);
  await assert.rejects(beforeClient.submitTurn(SESSION, SUBMIT, before.signal), (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
  assert.equal(beforeFetches, 0);

  const after = new AbortController(); let afterFetches = 0;
  const afterClient = new AgentSessionMutationClient('https://app.example.test', proof(), (async (_url, init) => {
    afterFetches++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch);
  const pending = afterClient.submitTurn(SESSION, SUBMIT, after.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  after.abort();
  await assert.rejects(pending, AgentSessionMutationOutcomeUnknown);
  assert.equal(afterFetches, 1);
});

test('abort after dispatch does not wait for a fetch implementation that ignores its signal', { timeout: 1000 }, async () => {
  let entered!: () => void;
  let finish!: (response: Response) => void;
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  const ignored = new Promise<Response>((resolve) => { finish = resolve; });
  let lateBodyCancelled = false;
  const client = new AgentSessionMutationClient('https://app.example.test', proof(), (async () => {
    entered();
    return ignored;
  }) as typeof fetch);
  const controller = new AbortController();
  const pending = client.submitTurn(SESSION, SUBMIT, controller.signal);
  await dispatched;
  controller.abort();
  await assert.rejects(pending, AgentSessionMutationOutcomeUnknown);
  finish(new Response(new ReadableStream<Uint8Array>({
    cancel() { lateBodyCancelled = true; },
  }), { status: 202 }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(lateBodyCancelled, true);
});

test('abort cancels a stalled acknowledgement reader and returns unknown', { timeout: 1000 }, async () => {
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled = false; let released = false;
  const reader = {
    read: () => { entered(); return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}); },
    cancel: async () => { cancelled = true; },
    releaseLock: () => { released = true; },
  };
  const response = {
    status: 202, redirected: false, url: '', headers: { get: () => null },
    body: { getReader: () => reader, cancel: async () => { cancelled = true; } },
  } as unknown as Response;
  const client = new AgentSessionMutationClient('https://app.example.test', proof(),
    (async () => response) as typeof fetch);
  const controller = new AbortController();
  const pending = client.submitTurn(SESSION, SUBMIT, controller.signal);
  await reading;
  controller.abort();
  await assert.rejects(pending, AgentSessionMutationOutcomeUnknown);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('redirect evidence is checked before a forged authoritative rejection status', async () => {
  for (const response of [
    { status: 401, redirected: true, url: '', body: { cancel: async () => {} } },
    { status: 409, redirected: false, url: 'https://attacker.example/redirect', body: { cancel: async () => {} } },
  ]) {
    const client = new AgentSessionMutationClient('https://app.example.test', proof(),
      (async () => response as unknown as Response) as typeof fetch);
    await assert.rejects(client.submitTurn(SESSION, SUBMIT), AgentSessionMutationOutcomeUnknown);
  }
});

test('malformed stream acknowledgements cancel and release their reader', async () => {
  let reads = 0; let cancellations = 0; let releases = 0;
  const reader = {
    read: async () => reads++ === 0
      ? { done: false as const, value: Uint8Array.from([0xc3, 0x28]) }
      : { done: true as const, value: undefined },
    cancel: async () => { cancellations++; },
    releaseLock: () => { releases++; },
  };
  const response = {
    status: 202, redirected: false, url: '', headers: { get: () => null },
    body: { getReader: () => reader, cancel: async () => {} },
  } as unknown as Response;
  const client = new AgentSessionMutationClient('https://app.example.test', proof(),
    (async () => response) as typeof fetch);
  await assert.rejects(client.submitTurn(SESSION, SUBMIT), AgentSessionMutationOutcomeUnknown);
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
});

test('mixed, malformed, mismatched and oversized acknowledgements have an unknown outcome', async () => {
  const malformed: unknown[] = [
    null, submitted({ turn_id: TURN.toUpperCase() }), submitted({ status: 'unknown' }),
    submitted({ accepted_sequence: 0 }), submitted({ state_version: 9 }),
    submitted({ replayed: 'false' }), submitted({ status: 'running', replayed: false }),
  ];
  for (const acknowledgement of malformed) {
    assert.throws(() => parseSubmittedAgentTurn(acknowledgement, 7), AgentSessionMutationOutcomeUnknown);
  }
  assert.throws(() => parseStoppedAgentTurn({ turn_id: OTHER_TURN, state_version: 8, requested: true }, TURN, 8),
    AgentSessionMutationOutcomeUnknown);
  assert.throws(() => parseStoppedAgentTurn({ turn_id: TURN, state_version: 9, requested: true }, TURN, 8),
    AgentSessionMutationOutcomeUnknown);
  assert.throws(() => parseStoppedAgentTurn({ turn_id: TURN, state_version: 8, requested: false }, TURN, 8),
    AgentSessionMutationOutcomeUnknown);

  const invalidJson = clientWith([new Response('{', { status: 202 })]);
  await assert.rejects(invalidJson.client.submitTurn(SESSION, SUBMIT), AgentSessionMutationOutcomeUnknown);
  const oversized = clientWith([new Response('x'.repeat(65_537), { status: 202 })]);
  await assert.rejects(oversized.client.submitTurn(SESSION, SUBMIT), AgentSessionMutationOutcomeUnknown);
});

test('unexpected statuses cancel unread bodies before returning outcome unknown', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() { /* keep the response unread */ },
    cancel() { cancelled = true; },
  });
  const f = clientWith([new Response(stream, { status: 503 })]);
  await assert.rejects(f.client.submitTurn(SESSION, SUBMIT), AgentSessionMutationOutcomeUnknown);
  assert.equal(cancelled, true);
});
