import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { DexError } from '../src/errors';
import { nativeAgentMutationFetch } from '../src/native-agent-mutation-http';

const ORIGIN = 'https://app.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000001';
const TURN = '018f1240-0000-7000-8000-000000000002';
const TOKEN = 'access.safe.jwt';
const PROOF = 'proof.safe.jwt';

function request(path: string, body: unknown, changes: RequestInit = {}): [string, RequestInit] {
  return [`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `DPoP ${TOKEN}`, 'Content-Type': 'application/json', DPoP: PROOF },
    body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', ...changes,
  }];
}

const submitBody = { input_text: 'hello', expected_state_version: 3, idempotency_key: 'request-1', origin_id: 'vscode-1' };
const stopBody = { turn_id: TURN, expected_state_version: 4 };
const createBody = { workflow_id: 'workflow-1', title: 'New session', expected_version: 3, origin_id: 'desktop-1' };
const switchBody = { active_agent_session_id: SESSION, expected_version: 4, origin_id: 'desktop-1' };

test('mutation adapter requires an exact HTTPS origin and copies request fields before an async check', async () => {
  for (const origin of ['http://app.example.test', `${ORIGIN}/`, `${ORIGIN}/path`, 'https://user@app.example.test']) {
    assert.throws(() => nativeAgentMutationFetch(origin, globalThis.fetch, async () => {}),
      (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch');
  }
  let release!: () => void; let enter!: () => void; let checks = 0;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const original = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody);
  const transport = nativeAgentMutationFetch(ORIGIN, (async (_input, init) => {
    assert.equal(init!.method, 'POST'); assert.deepEqual(JSON.parse(String(init!.body)), submitBody);
    assert.equal(new Headers(init!.headers).has('cookie'), false); assert.equal(init!.credentials, 'omit');
    return Response.json({});
  }) as typeof fetch, async () => { if (++checks === 1) { enter(); await waiting; } });
  const pending = transport(...original); await entered;
  original[1].method = 'DELETE'; original[1].body = '{}'; original[1].credentials = 'include';
  (original[1].headers as Record<string, string>).Cookie = 'private=1'; release();
  await (await pending).json();
});

test('mutation adapter forwards only exact Canonical POST routes, JSON and DPoP credentials', async () => {
  const calls: Array<{ input: string; init: RequestInit }> = []; let checks = 0;
  const fetchImpl = (async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return Response.json({ turn_id: TURN, status: 'accepted', accepted_sequence: 4, state_version: 4, replayed: false }, { status: 202 });
  }) as typeof fetch;
  const transport = nativeAgentMutationFetch(ORIGIN, fetchImpl, async () => { checks++; });
  const [url, init] = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody);
  const response = await transport(url, init);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { turn_id: TURN, status: 'accepted', accepted_sequence: 4, state_version: 4, replayed: false });
  assert.equal(calls.length, 1); assert.equal(calls[0]!.input, url); assert.ok(checks >= 3);
  assert.equal(calls[0]!.init.method, 'POST'); assert.equal(calls[0]!.init.credentials, 'omit');
  assert.equal(calls[0]!.init.redirect, 'error'); assert.equal(calls[0]!.init.cache, 'no-store');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), submitBody);
  const headers = new Headers(calls[0]!.init.headers);
  const names: string[] = []; headers.forEach((_value, name) => names.push(name));
  assert.deepEqual(names.sort(), ['accept', 'authorization', 'content-type', 'dpop']);
  assert.equal(headers.get('authorization'), `DPoP ${TOKEN}`); assert.equal(headers.get('dpop'), PROOF);
  assert.equal(headers.has('cookie'), false); assert.equal(headers.has('origin'), false);

  const stop = request(`/api/agentflow/agent-sessions/${SESSION}/stop`, stopBody);
  await (await transport(stop[0], stop[1])).json();
  assert.equal(calls.length, 2); assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), stopBody);
});

test('mutation adapter copies and forwards exact lifecycle POST and PUT requests', async () => {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let checks = 0;
  const transport = nativeAgentMutationFetch(ORIGIN, (async (input, init = {}) => {
    calls.push({ input: String(input), init }); return Response.json({});
  }) as typeof fetch, async () => { if (++checks === 1) { entered(); await gate; } });
  const create = request('/api/agentflow/agent-sessions', createBody);
  const pending = transport(...create); await waiting;
  create[1].method = 'PUT'; create[1].body = JSON.stringify({ private: 'mutated' });
  (create[1].headers as Record<string, string>).Cookie = 'private=1'; release();
  await (await pending).json();
  const switched = request('/api/agentflow/me/agent-state', switchBody, { method: 'PUT' });
  await (await transport(...switched)).json();
  assert.deepEqual(calls.map(({ input, init }) => [input, init.method, JSON.parse(String(init.body))]), [
    [`${ORIGIN}/api/agentflow/agent-sessions`, 'POST', createBody],
    [`${ORIGIN}/api/agentflow/me/agent-state`, 'PUT', switchBody],
  ]);
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.has('cookie'), false); assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  }
});

test('mutation adapter rejects route, URL, method, header and body expansion before wire I/O', async () => {
  let calls = 0;
  const transport = nativeAgentMutationFetch(ORIGIN, (async () => { calls++; return Response.json({}); }) as typeof fetch, async () => {});
  const valid = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody);
  const attempts: Array<[unknown, RequestInit]> = [
    request(`/api/agentflow/agent-sessions/${SESSION}/snapshot`, submitBody),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns?private=1`, submitBody),
    request(`/api/agentflow/agent-sessions/${SESSION.toUpperCase()}/turns`, submitBody),
    request(`/api/agentflow/agent-sessions/not-a-uuid/turns`, submitBody),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { method: 'GET' }),
    request('/api/agentflow/agent-sessions', createBody, { method: 'PUT' }),
    request('/api/agentflow/me/agent-state', switchBody),
    request('/api/agentflow/me/agent-state?private=1', switchBody, { method: 'PUT' }),
    request('/api/agentflow/agent-sessions/', createBody),
    request('/api/agentflow/agent-sessions', { ...createBody, private_field: 'private' }),
    request('/api/agentflow/me/agent-state', { ...switchBody, active_agent_session_id: 'not-a-uuid' }, { method: 'PUT' }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { credentials: 'include' }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { redirect: 'follow' }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { cache: 'default' }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { headers: { ...valid[1].headers as Record<string, string>, Cookie: 'private=1' } }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { headers: { ...valid[1].headers as Record<string, string>, Origin: ORIGIN } }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { headers: { ...valid[1].headers as Record<string, string>, Authorization: 'Bearer private' } }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { body: JSON.stringify({ ...submitBody, private_field: 'private' }) }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { body: '{' }),
    request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { body: JSON.stringify({ ...submitBody, input_text: 'x'.repeat(1024 * 1024) }) }),
    [`https://attacker.example/api/agentflow/agent-sessions/${SESSION}/turns`, valid[1]],
    [`https://user@app.example.test/api/agentflow/agent-sessions/${SESSION}/turns`, valid[1]],
  ];
  for (const [input, init] of attempts) {
    await assert.rejects(transport(input as string, init), (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch');
  }
  assert.equal(calls, 0);
});

test('mutation adapter bounds and fatally decodes successful JSON responses', async () => {
  const exact = JSON.stringify({ value: 'x'.repeat(65524) });
  assert.equal(Buffer.byteLength(exact), 64 * 1024);
  for (const [name, response, accepted] of [
    ['exact bound', () => new Response(exact, { status: 202 }), true],
    ['declared oversize', () => new Response('{}', { status: 202, headers: { 'Content-Length': String(64 * 1024 + 1) } }), false],
    ['streamed oversize', () => new Response(`"${'x'.repeat(64 * 1024)}"`, { status: 202 }), false],
    ['invalid UTF-8', () => new Response(Uint8Array.from([0xc3, 0x28]), { status: 202 }), false],
    ['malformed JSON', () => new Response('{', { status: 202 }), false],
  ] as const) {
    const transport = nativeAgentMutationFetch(ORIGIN, (async () => response()) as typeof fetch, async () => {});
    const args = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody);
    const result = await transport(args[0], args[1]);
    if (accepted) assert.deepEqual(await result.json(), JSON.parse(exact));
    else await assert.rejects(result.json(), (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch', name);
  }
});

test('mutation adapter rejects redirects and response URL changes, sanitizes HTTP bodies and classifies fetch loss', async () => {
  const args = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody);
  const redirected = new Response('{}', { status: 202 }); Object.defineProperty(redirected, 'redirected', { value: true });
  const mismatched = new Response('{}', { status: 202 });
  Object.defineProperty(mismatched, 'url', { value: `${ORIGIN}/api/agentflow/agent-sessions/${SESSION}/stop` });
  for (const response of [new Response('private', { status: 302, headers: { Location: 'https://attacker.example/collect' } }), redirected, mismatched]) {
    const transport = nativeAgentMutationFetch(ORIGIN, (async () => response) as typeof fetch, async () => {});
    await assert.rejects(transport(args[0], args[1]), (error: unknown) => error instanceof DexError && error.code === 'protocol_mismatch');
  }
  for (const status of [400, 401, 403, 409, 422, 500]) {
    const response = new Response('private-server-body', { status });
    const transport = nativeAgentMutationFetch(ORIGIN, (async () => response) as typeof fetch, async () => {});
    const sanitized = await transport(args[0], args[1]);
    assert.equal(sanitized.status, status); assert.equal(sanitized.ok, false);
    assert.equal(JSON.stringify(sanitized).includes('private-server-body'), false);
  }
  const transport = nativeAgentMutationFetch(ORIGIN, (async () => { throw new Error('private-transport'); }) as typeof fetch, async () => {});
  await assert.rejects(transport(args[0], args[1]), (error: unknown) => error instanceof NativePlatformTransportError
    && !error.message.includes('private-transport'));
});

test('mutation adapter cancels unread bodies when the scope changes and preserves abort identity', async () => {
  for (const failAt of [2, 3]) {
    let checks = 0; let cancellations = 0;
    const failure = new DexError('auth_required', `scope-ended-${failAt}`);
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancellations++; } }), { status: 202 });
    const transport = nativeAgentMutationFetch(ORIGIN, (async () => response) as typeof fetch, async () => {
      if (++checks === failAt) throw failure;
    });
    const args = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody);
    if (failAt === 2) await assert.rejects(transport(args[0], args[1]), (error: unknown) => error === failure);
    else await assert.rejects((await transport(args[0], args[1])).json(), (error: unknown) => error === failure);
    await Promise.resolve(); assert.equal(cancellations, 1);
  }

  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const response = new Response(new ReadableStream<Uint8Array>({ pull: async (stream) => {
    entered(); await gate; stream.enqueue(new TextEncoder().encode('{}')); stream.close();
  } }), { status: 202 });
  const transport = nativeAgentMutationFetch(ORIGIN, (async () => response) as typeof fetch, async () => {});
  const args = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, submitBody, { signal: controller.signal });
  const reading = (await transport(args[0], args[1])).json(); await started; controller.abort(); release();
  await assert.rejects(reading, (error: unknown) => error instanceof Error && error.name === 'AbortError');
});
