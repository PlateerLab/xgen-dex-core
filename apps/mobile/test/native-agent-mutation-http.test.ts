import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import {
  createMobileAgentMutationFetch,
  createMobileTurnKey,
  MobileAgentMutationResponseInvalid,
  MobileAgentMutationTransportBusy,
  MobileAgentMutationTransportUnavailable,
  type MobileAgentMutationHttpModule,
} from '../src/lib/native-agent-mutation-http';

const ORIGIN = 'https://mobile.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000001';
const TURN = '018f1240-0000-7000-8000-000000000002';
const SUBMIT = { input_text: 'hello\n', expected_state_version: 3, idempotency_key: 'mobile-turn-1', origin_id: 'mobile-1' };
const STOP = { turn_id: TURN, expected_state_version: 4 };

function request(path: string, body: unknown = SUBMIT, changes: RequestInit = {}): [string, RequestInit] {
  return [`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: 'DPoP access.safe.jwt',
      DPoP: 'proof.safe.jwt',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    ...changes,
  }];
}

function fixture() {
  const calls: unknown[][] = [];
  const cancelled: string[] = [];
  const module: MobileAgentMutationHttpModule = {
    newRequestId: randomUUID,
    newTurnKey: randomUUID,
    async turnRequest(...args) {
      calls.push(args);
      return { status: 202, body: JSON.stringify({ turn_id: TURN, status: 'accepted' }) };
    },
    cancelRequest(id) { cancelled.push(id); },
  };
  return { module, calls, cancelled, fetch: createMobileAgentMutationFetch(module, ORIGIN) };
}

test('turn-only adapter preserves exact validated submit/stop payloads and fixed native arguments', async () => {
  const f = fixture();
  const submit = request(`/api/agentflow/agent-sessions/${SESSION}/turns`);
  const response = await f.fetch(...submit);
  assert.equal(response.status, 202); assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { turn_id: TURN, status: 'accepted' });
  await assert.rejects(response.json(), MobileAgentMutationResponseInvalid);
  assert.deepEqual(f.calls[0]!.slice(1), [ORIGIN, `/api/agentflow/agent-sessions/${SESSION}/turns`, 'access.safe.jwt', 'proof.safe.jwt', JSON.stringify(SUBMIT)]);

  const stop = request(`/api/agentflow/agent-sessions/${SESSION}/stop`, STOP);
  await f.fetch(...stop);
  assert.deepEqual(f.calls[1]!.slice(1), [ORIGIN, `/api/agentflow/agent-sessions/${SESSION}/stop`, 'access.safe.jwt', 'proof.safe.jwt', JSON.stringify(STOP)]);
});

test('origin, route, method, fetch policy, headers and canonical mutation body are rejected before native I/O', async () => {
  const f = fixture();
  const path = `/api/agentflow/agent-sessions/${SESSION}/turns`;
  const valid = request(path);
  const attempts: Array<[unknown, RequestInit]> = [
    [`${OTHER_ORIGIN}${path}`, valid[1]],
    [`${ORIGIN}${path}?private=1`, valid[1]],
    [`${ORIGIN}${path}#private`, valid[1]],
    [`${ORIGIN}/api/agentflow/agent-sessions/${SESSION.toUpperCase()}/turns`, valid[1]],
    [`${ORIGIN}/api/agentflow/agent-sessions/${SESSION}/snapshot`, valid[1]],
    request(path, SUBMIT, { method: 'GET' }),
    request(path, SUBMIT, { credentials: 'include' }),
    request(path, SUBMIT, { redirect: 'follow' }),
    request(path, SUBMIT, { cache: 'default' }),
    request(path, SUBMIT, { headers: { ...(valid[1].headers as Record<string, string>), Cookie: 'private=1' } }),
    request(path, SUBMIT, { headers: { ...(valid[1].headers as Record<string, string>), Origin: ORIGIN } }),
    request(path, SUBMIT, { headers: { ...(valid[1].headers as Record<string, string>), Authorization: 'Bearer private' } }),
    request(path, SUBMIT, { headers: { ...(valid[1].headers as Record<string, string>), DPoP: 'bad' } }),
    request(path, { ...SUBMIT, private_field: 'private' }),
    request(path, { ...SUBMIT, expected_state_version: Number.MAX_SAFE_INTEGER }),
    request(`/api/agentflow/agent-sessions/${SESSION}/stop`, SUBMIT),
    request(path, SUBMIT, { body: `{"input_text":"first","input_text":"hello\\n","expected_state_version":3,"idempotency_key":"mobile-turn-1","origin_id":"mobile-1"}` }),
    request(path, SUBMIT, { body: `{"expected_state_version":3,"input_text":"hello\\n","idempotency_key":"mobile-turn-1","origin_id":"mobile-1"}` }),
    request(path, SUBMIT, { body: '{' }),
  ];
  for (const [input, init] of attempts) {
    await assert.rejects(f.fetch(input as string, init), NativePlatformTransportError);
  }
  assert.equal(f.calls.length, 0);
  for (const bad of ['http://mobile.example.test', `${ORIGIN}/`, `${ORIGIN}/path`, 'https://user@mobile.example.test', 'bad']) {
    assert.throws(() => createMobileAgentMutationFetch(f.module, bad), NativePlatformTransportError);
  }
});

test('mutable request containers cannot change the payload or add headers after dispatch', async () => {
  const f = fixture();
  let release!: (value: unknown) => void;
  f.module.turnRequest = (...args) => { f.calls.push(args); return new Promise((resolve) => { release = resolve; }); };
  const original = request(`/api/agentflow/agent-sessions/${SESSION}/turns`);
  const pending = f.fetch(...original);
  original[1].method = 'DELETE'; original[1].body = '{}'; original[1].credentials = 'include';
  (original[1].headers as Record<string, string>).Cookie = 'private=1';
  release({ status: 202, body: '{}' }); await pending;
  assert.deepEqual(f.calls[0]!.slice(1), [ORIGIN, `/api/agentflow/agent-sessions/${SESSION}/turns`, 'access.safe.jwt', 'proof.safe.jwt', JSON.stringify(SUBMIT)]);
});

test('abort rejects promptly but keeps every owner busy until actual native settlement', async () => {
  const f = fixture();
  let settle!: (value: unknown) => void;
  f.module.turnRequest = (...args) => { f.calls.push(args); return new Promise((resolve) => { settle = resolve; }); };
  const controller = new AbortController();
  const args = request(`/api/agentflow/agent-sessions/${SESSION}/turns`, SUBMIT, { signal: controller.signal });
  const pending = f.fetch(...args); controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(f.cancelled.length, 1);
  const otherOwner = createMobileAgentMutationFetch(f.module, ORIGIN);
  assert.throws(() => otherOwner.assertAvailable(), MobileAgentMutationTransportBusy);
  await assert.rejects(otherOwner(...request(`/api/agentflow/agent-sessions/${SESSION}/turns`)), MobileAgentMutationTransportBusy);
  assert.equal(f.calls.length, 1);
  settle({ status: 202, body: '{}' }); await new Promise((resolve) => setImmediate(resolve));
  otherOwner.assertAvailable();
  f.module.turnRequest = async (...wire) => { f.calls.push(wire); return { status: 202, body: '{}' }; };
  await otherOwner(...request(`/api/agentflow/agent-sessions/${SESSION}/turns`));
});

test('request IDs are exact lowercase UUIDs and cannot be active in another origin', async () => {
  const f = fixture();
  f.module.newRequestId = () => randomUUID().toUpperCase();
  await assert.rejects(f.fetch(...request(`/api/agentflow/agent-sessions/${SESSION}/turns`)), NativePlatformTransportError);
  assert.equal(f.calls.length, 0);

  const id = randomUUID(); let settle!: (value: unknown) => void;
  f.module.newRequestId = () => id;
  f.module.turnRequest = (...args) => { f.calls.push(args); return new Promise((resolve) => { settle = resolve; }); };
  const first = f.fetch(...request(`/api/agentflow/agent-sessions/${SESSION}/turns`));
  const other = createMobileAgentMutationFetch(f.module, OTHER_ORIGIN);
  const otherRequest = request(`/api/agentflow/agent-sessions/${SESSION}/turns`);
  otherRequest[0] = otherRequest[0].replace(ORIGIN, OTHER_ORIGIN);
  await assert.rejects(other(...otherRequest), NativePlatformTransportError);
  assert.equal(f.calls.length, 1);
  settle({ status: 202, body: '{}' }); await first;
});

test('native response status, shape, UTF-8 bytes and JSON consumption are bounded without leaking details', async () => {
  const f = fixture(); const args = request(`/api/agentflow/agent-sessions/${SESSION}/turns`);
  for (const raw of [null, { status: 302, body: '{}' }, { status: 200.5, body: '{}' }, { status: 202, body: '{}', token: 'private' },
    { status: 202, body: null }, { status: 202, body: '가'.repeat(22000) }]) {
    f.module.turnRequest = async () => raw;
    await assert.rejects(f.fetch(...args), MobileAgentMutationResponseInvalid);
  }
  const exact = JSON.stringify({ value: 'x'.repeat(65524) }); assert.equal(Buffer.byteLength(exact), 65536);
  f.module.turnRequest = async () => ({ status: 202, body: exact });
  assert.deepEqual(await (await f.fetch(...args)).json(), JSON.parse(exact));
  f.module.turnRequest = async () => ({ status: 202, body: `${exact} ` });
  await assert.rejects(f.fetch(...args), MobileAgentMutationResponseInvalid);
  f.module.turnRequest = async () => ({ status: 202, body: '{' });
  await assert.rejects((await f.fetch(...args)).json(), MobileAgentMutationResponseInvalid);
  f.module.turnRequest = async () => { throw new Error('private-native-error'); };
  await assert.rejects(f.fetch(...args), (error: unknown) => error instanceof NativePlatformTransportError && !error.message.includes('private'));
});

test('partial modules fail closed and native turn keys are exact OS UUIDs', () => {
  const f = fixture();
  for (const missing of ['newRequestId', 'newTurnKey', 'turnRequest', 'cancelRequest'] as const) {
    const partial = { ...f.module, [missing]: undefined } as unknown as MobileAgentMutationHttpModule;
    assert.throws(() => createMobileAgentMutationFetch(partial, ORIGIN), MobileAgentMutationTransportUnavailable);
  }
  assert.throws(() => createMobileAgentMutationFetch(null, ORIGIN), MobileAgentMutationTransportUnavailable);
  assert.match(createMobileTurnKey(f.module), /^[0-9a-f-]{36}$/);
  f.module.newTurnKey = () => randomUUID() + '\n';
  assert.throws(() => createMobileTurnKey(f.module), NativePlatformTransportError);
  f.module.newTurnKey = () => randomUUID().toUpperCase();
  assert.throws(() => createMobileTurnKey(f.module), NativePlatformTransportError);
  f.module.newTurnKey = () => { throw new Error('private-key-error'); };
  assert.throws(() => createMobileTurnKey(f.module), (error: unknown) => error instanceof NativePlatformTransportError && !error.message.includes('private'));
});
