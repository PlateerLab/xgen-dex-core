import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentSessionLifecycleClient,
  AgentSessionLifecycleHttpError,
  AgentSessionLifecycleOutcomeUnknown,
  parseCreatedAgentSession,
  parseSwitchedAgentFocus,
  validateCreateAgentSession,
  validateSwitchAgentFocus,
  type AgentSessionLifecycleProofSource,
  type CreateAgentSessionInput,
  type SwitchAgentFocusInput,
} from '../src/agent-session-lifecycle';

const SESSION = '018f1240-0000-7000-8000-000000000001';
const OTHER_SESSION = '018f1240-0000-7000-8000-000000000002';
const EVENT = '018f1240-0000-7000-8000-000000000003';
const OTHER_EVENT = '018f1240-0000-7000-8000-000000000004';
const CREATE: CreateAgentSessionInput = {
  workflow_id: 'workflow-한글', expected_version: 7, title: '새 대화', origin_id: 'cli-1',
};
const SWITCH: SwitchAgentFocusInput = {
  active_agent_session_id: SESSION, expected_version: 8, origin_id: 'cli-1',
};

function focus(active: string | null = SESSION, version = 8, event: string | null = EVENT) {
  return { active_agent_session_id: active, version, event_id: event };
}

function created(patch: Record<string, unknown> = {}) {
  return { id: SESSION, workflow_id: CREATE.workflow_id, focus: focus(), ...patch };
}

function proof(overrides: Partial<AgentSessionLifecycleProofSource> = {}): AgentSessionLifecycleProofSource {
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
    if (value instanceof Response) return value;
    return Response.json(value, { status: init.method === 'POST' ? 201 : 200 });
  }) as typeof fetch;
  return {
    calls, signatures,
    client: new AgentSessionLifecycleClient('https://app.example.test', source, fetchImpl),
  };
}

test('validators copy and normalize lifecycle requests using Unicode code-point bounds', () => {
  const normalizedCreate = validateCreateAgentSession({ workflow_id: '🙂'.repeat(256), expected_version: 0 });
  assert.deepEqual(normalizedCreate, {
    workflow_id: '🙂'.repeat(256), expected_version: 0, title: '',
  });
  const create = validateCreateAgentSession(CREATE);
  assert.notEqual(create, CREATE);
  assert.deepEqual(create, CREATE);
  const switched = validateSwitchAgentFocus(SWITCH);
  assert.notEqual(switched, SWITCH);
  assert.deepEqual(switched, SWITCH);

  const invalidCreates: unknown[] = [
    null, { workflow_id: '', expected_version: 0 },
    { workflow_id: '🙂'.repeat(257), expected_version: 0 },
    { workflow_id: '\ud800', expected_version: 0 },
    { workflow_id: 'flow', expected_version: -1 },
    { workflow_id: 'flow', expected_version: Number.MAX_SAFE_INTEGER },
    { workflow_id: 'flow', expected_version: 0.5 },
    { workflow_id: 'flow', expected_version: 0, title: '\udfff' },
    { workflow_id: 'flow', expected_version: 0, title: '🙂'.repeat(257) },
    { workflow_id: 'flow', expected_version: 0, origin_id: '' },
    { workflow_id: 'flow', expected_version: 0, origin_id: '🙂'.repeat(129) },
    { workflow_id: 'flow', expected_version: 0, extra: true },
  ];
  for (const input of invalidCreates) assert.throws(() => validateCreateAgentSession(input), TypeError);

  const invalidSwitches: unknown[] = [
    {}, { active_agent_session_id: SESSION.toUpperCase(), expected_version: 0 },
    { active_agent_session_id: 'not-a-uuid', expected_version: 0 },
    { active_agent_session_id: null, expected_version: Number.MAX_SAFE_INTEGER },
    { active_agent_session_id: null, expected_version: 0, origin_id: '\ud800' },
    { active_agent_session_id: null, expected_version: 0, hidden: 'secret' },
  ];
  for (const input of invalidSwitches) assert.throws(() => validateSwitchAgentFocus(input), TypeError);
});

test('parsers bind projected acknowledgements to the requested CAS operation', () => {
  assert.deepEqual(parseCreatedAgentSession(created({ internal: 'discard' }), CREATE), created());
  assert.deepEqual(parseSwitchedAgentFocus({ ...focus(), internal: 'discard' }, SWITCH), focus());
  assert.deepEqual(parseSwitchedAgentFocus(focus(SESSION, 9, OTHER_EVENT), SWITCH),
    focus(SESSION, 9, OTHER_EVENT));
  assert.deepEqual(parseSwitchedAgentFocus(focus(null, 0, null), {
    active_agent_session_id: null, expected_version: 0,
  }), focus(null, 0, null));

  const badCreates: unknown[] = [
    created({ id: SESSION.toUpperCase() }), created({ workflow_id: 'other' }),
    created({ focus: focus(OTHER_SESSION) }), created({ focus: focus(SESSION, 7) }),
    created({ focus: focus(SESSION, 8, null) }),
  ];
  for (const value of badCreates) {
    assert.throws(() => parseCreatedAgentSession(value, CREATE), AgentSessionLifecycleOutcomeUnknown);
  }
  for (const value of [
    focus(OTHER_SESSION, 8), focus(SESSION, 10), focus(SESSION, 8, null),
    focus(null, 0, EVENT), focus(SESSION, 0, null),
  ]) assert.throws(() => parseSwitchedAgentFocus(value, SWITCH), AgentSessionLifecycleOutcomeUnknown);
});

test('create and switch use exact DPoP transports and serialize a copy before credential work', async () => {
  const createInput = { ...CREATE };
  const switchInput = { ...SWITCH };
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const signatures: Array<{ method: string; htu: string; token: string }> = [];
  let credentialCalls = 0;
  const source = proof({
    accessToken: async () => {
      credentialCalls++;
      if (credentialCalls === 1) {
        createInput.workflow_id = 'mutated'; createInput.title = 'mutated';
      } else {
        switchInput.active_agent_session_id = OTHER_SESSION; switchInput.expected_version = 99;
      }
      return 'platform.access.jwt';
    },
    signProof: async (method, htu, token) => {
      signatures.push({ method, htu, token });
      return `proof.${signatures.length}.jwt`;
    },
  });
  const client = new AgentSessionLifecycleClient('https://app.example.test', source,
    (async (url, init = {}) => {
      calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
      return init.method === 'POST'
        ? Response.json(created(), { status: 201 })
        : Response.json(focus(), { status: 200 });
    }) as typeof fetch);
  assert.deepEqual(await client.createSession(createInput), created());
  assert.deepEqual(await client.switchFocus(switchInput), focus());
  assert.equal(credentialCalls, 2);
  assert.deepEqual(calls.map((call) => call.body), [CREATE, SWITCH]);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://app.example.test/api/agentflow/agent-sessions',
    'https://app.example.test/api/agentflow/me/agent-state',
  ]);
  assert.deepEqual(signatures.map(({ method, htu }) => ({ method, htu })), [
    { method: 'POST', htu: calls[0].url }, { method: 'PUT', htu: calls[1].url },
  ]);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual(call.init.headers, {
      Authorization: 'DPoP platform.access.jwt', DPoP: `proof.${index + 1}.jwt`,
      Accept: 'application/json', 'Content-Type': 'application/json',
    });
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
  }
});

test('invalid requests and origins fail before credentials or network dispatch', async () => {
  for (const origin of [
    'http://app.example.test', 'https://app.example.test/', 'https://APP.example.test',
    'https://app.example.test:443', 'https://user:pass@app.example.test',
    'https://app.example.test/path', 'https://app.example.test?x=1',
  ]) assert.throws(() => new AgentSessionLifecycleClient(origin, proof()), TypeError);

  let credentials = 0; let proofs = 0; let fetches = 0;
  const client = new AgentSessionLifecycleClient('https://app.example.test', proof({
    accessToken: async () => { credentials++; return 'platform.access.jwt'; },
    signProof: async () => { proofs++; return 'proof.jwt.value'; },
  }), (async () => { fetches++; throw new Error('unexpected'); }) as typeof fetch);
  const pending = client.createSession({ ...CREATE, extra: 'secret' } as CreateAgentSessionInput);
  assert.equal(credentials, 0);
  await assert.rejects(pending, TypeError);
  assert.deepEqual([credentials, proofs, fetches], [0, 0, 0]);
});

test('HTTP rejections expose only status and an allowlisted validated focus conflict', async () => {
  for (const status of [400, 401, 403, 422, 429]) {
    const f = clientWith([new Response(`private-${status}`, { status })]);
    await assert.rejects(f.client.createSession(CREATE), (error: unknown) =>
      error instanceof AgentSessionLifecycleHttpError && error.status === status
      && error.conflict === undefined && !error.message.includes('private'));
  }
  const f = clientWith([Response.json({ detail: {
    code: 'FOCUS_VERSION_CONFLICT',
    current: { ...focus(OTHER_SESSION, 9, OTHER_EVENT), private_token: 'do-not-leak' },
    request_body: { password: 'do-not-leak' },
  } }, { status: 409 })]);
  await assert.rejects(f.client.createSession(CREATE), (error: unknown) => {
    assert(error instanceof AgentSessionLifecycleHttpError);
    assert.deepEqual(error.conflict, {
      code: 'FOCUS_VERSION_CONFLICT', current: focus(OTHER_SESSION, 9, OTHER_EVENT),
    });
    assert.equal(JSON.stringify(error).includes('do-not-leak'), false);
    return true;
  });
  const malformed = clientWith([Response.json({ detail: {
    code: 'FOCUS_VERSION_CONFLICT', current: focus(OTHER_SESSION, 0, OTHER_EVENT),
  } }, { status: 409 })]);
  await assert.rejects(malformed.client.createSession(CREATE), (error: unknown) =>
    error instanceof AgentSessionLifecycleHttpError && error.status === 409
    && error.conflict === undefined);
});

test('lost acknowledgements, timeout, server failure and malformed success are unknown without retry', async () => {
  for (const response of [
    new Response('', { status: 408 }), new Response('', { status: 500 }),
    new Response('', { status: 302 }), Response.json(created(), { status: 200 }),
    Response.json(created({ workflow_id: 'wrong' }), { status: 201 }),
    new Response(Uint8Array.from([0xc3, 0x28]), { status: 201 }),
    new Response('x'.repeat(65_537), { status: 201 }),
  ]) {
    const f = clientWith([response]);
    await assert.rejects(f.client.createSession(CREATE), AgentSessionLifecycleOutcomeUnknown);
    assert.equal(f.calls.length, 1);
  }
  let attempts = 0;
  const client = new AgentSessionLifecycleClient('https://app.example.test', proof(), (async () => {
    attempts++; throw new TypeError('network details and secret');
  }) as typeof fetch);
  await assert.rejects(client.createSession(CREATE), (error: unknown) =>
    error instanceof AgentSessionLifecycleOutcomeUnknown
    && !error.message.includes('network details'));
  assert.equal(attempts, 1);
});

test('abort before dispatch remains AbortError and abort after dispatch is unknown', async () => {
  const before = new AbortController(); before.abort();
  let fetches = 0;
  const beforeClient = new AgentSessionLifecycleClient('https://app.example.test', proof(),
    (async () => { fetches++; throw new Error('unexpected'); }) as typeof fetch);
  await assert.rejects(beforeClient.createSession(CREATE, before.signal), (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
  assert.equal(fetches, 0);

  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  const after = new AbortController();
  const afterClient = new AgentSessionLifecycleClient('https://app.example.test', proof(),
    (async () => { entered(); return new Promise<Response>(() => {}); }) as typeof fetch);
  const pending = afterClient.switchFocus(SWITCH, after.signal);
  await dispatched; after.abort();
  await assert.rejects(pending, AgentSessionLifecycleOutcomeUnknown);
});

test('aborting a stalled acknowledgement cancels and releases its reader', { timeout: 1000 }, async () => {
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled = false; let released = false;
  const reader = {
    read: () => { entered(); return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}); },
    cancel: async () => { cancelled = true; },
    releaseLock: () => { released = true; },
  };
  const response = {
    status: 201, redirected: false, url: '', headers: { get: () => null },
    body: { getReader: () => reader, cancel: async () => { cancelled = true; } },
  } as unknown as Response;
  const client = new AgentSessionLifecycleClient('https://app.example.test', proof(),
    (async () => response) as typeof fetch);
  const controller = new AbortController();
  const pending = client.createSession(CREATE, controller.signal);
  await reading; controller.abort();
  await assert.rejects(pending, AgentSessionLifecycleOutcomeUnknown);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});
