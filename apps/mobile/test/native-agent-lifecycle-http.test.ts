import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import {
  createMobileAgentLifecycleFetch,
  MobileAgentLifecycleResponseInvalid,
  MobileAgentLifecycleTransportBusy,
  MobileAgentLifecycleTransportUnavailable,
  type MobileAgentLifecycleHttpModule,
} from '../src/lib/native-agent-lifecycle-http';
import { createMobileAgentFetch, type MobileAgentHttpModule } from '../src/lib/native-agent-http';

const ORIGIN = 'https://mobile.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const SESSION = '018f1240-0000-7000-8000-000000000001';
const EVENT = '018f1240-0000-7000-8000-000000000002';
const CREATE = { workflow_id: 'workflow-1', expected_version: 3, title: 'New session', origin_id: 'mobile-1' };
const SWITCH = { active_agent_session_id: SESSION, expected_version: 4, origin_id: 'mobile-1' };

function request(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown = method === 'POST' ? CREATE : SWITCH,
  changes: RequestInit = {},
): [string, RequestInit] {
  return [`${ORIGIN}${path}`, {
    method,
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
  const module: MobileAgentLifecycleHttpModule & MobileAgentHttpModule = {
    newRequestId: randomUUID,
    async lifecycleRequest(...args) {
      calls.push(args);
      return args[3] === 'POST'
        ? { status: 201, body: JSON.stringify({ id: SESSION, workflow_id: CREATE.workflow_id,
          focus: { active_agent_session_id: SESSION, version: 4, event_id: EVENT } }) }
        : { status: 200, body: JSON.stringify({ active_agent_session_id: SESSION, version: 5, event_id: EVENT }) };
    },
    async readRequest() { throw new Error('unexpected read'); },
    cancelRequest(id) { cancelled.push(id); },
  };
  return { module, calls, cancelled, fetch: createMobileAgentLifecycleFetch(module, ORIGIN) };
}

test('lifecycle-only adapter preserves exact validated create/focus payloads and fixed native arguments', async () => {
  const f = fixture();
  const created = await f.fetch(...request('POST', '/api/agentflow/agent-sessions'));
  assert.equal(created.status, 201); assert.equal(created.ok, true);
  assert.deepEqual(await created.json(), { id: SESSION, workflow_id: CREATE.workflow_id,
    focus: { active_agent_session_id: SESSION, version: 4, event_id: EVENT } });
  await assert.rejects(created.json(), MobileAgentLifecycleResponseInvalid);
  assert.deepEqual(f.calls[0]!.slice(1), [ORIGIN, '/api/agentflow/agent-sessions', 'POST',
    'access.safe.jwt', 'proof.safe.jwt', JSON.stringify(CREATE)]);

  await f.fetch(...request('PUT', '/api/agentflow/me/agent-state'));
  assert.deepEqual(f.calls[1]!.slice(1), [ORIGIN, '/api/agentflow/me/agent-state', 'PUT',
    'access.safe.jwt', 'proof.safe.jwt', JSON.stringify(SWITCH)]);
});

test('origin, route, method, fetch policy, headers and canonical lifecycle body fail before native I/O', async () => {
  const f = fixture();
  const valid = request('POST', '/api/agentflow/agent-sessions');
  const attempts: Array<[unknown, RequestInit]> = [
    [`${OTHER_ORIGIN}/api/agentflow/agent-sessions`, valid[1]],
    [`${ORIGIN}/api/agentflow/agent-sessions?private=1`, valid[1]],
    [`${ORIGIN}/api/agentflow/agent-sessions#private`, valid[1]],
    request('PUT', '/api/agentflow/agent-sessions', SWITCH),
    request('POST', '/api/agentflow/me/agent-state', CREATE),
    request('POST', '/api/agentflow/agent-sessions/', CREATE),
    request('PUT', '/api/agentflow/me/agent-state/', SWITCH),
    request('POST', '/api/agentflow/agent-sessions', CREATE, { credentials: 'include' }),
    request('POST', '/api/agentflow/agent-sessions', CREATE, { redirect: 'follow' }),
    request('POST', '/api/agentflow/agent-sessions', CREATE, { cache: 'default' }),
    request('POST', '/api/agentflow/agent-sessions', { ...CREATE, extra: 'private' }),
    request('POST', '/api/agentflow/agent-sessions', { workflow_id: CREATE.workflow_id, expected_version: 3 }),
    request('PUT', '/api/agentflow/me/agent-state', { ...SWITCH, active_agent_session_id: SESSION.toUpperCase() }),
    request('POST', '/api/agentflow/agent-sessions', CREATE, { headers: { Accept: 'application/json',
      Authorization: 'Bearer private', DPoP: 'proof.safe.jwt', 'Content-Type': 'application/json' } }),
  ];
  attempts.push([valid[0], { ...valid[1], body: '{"workflow_id":"workflow-1","expected_version":3,"title":"New session","origin_id":"mobile-1","title":"New session"}' }]);
  for (const attempt of attempts) await assert.rejects(f.fetch(...attempt as [string, RequestInit]), NativePlatformTransportError);
  assert.equal(f.calls.length, 0);
  for (const bad of [`${ORIGIN}/`, `${ORIGIN}/path`, 'https://user@mobile.example.test', 'bad']) {
    assert.throws(() => createMobileAgentLifecycleFetch(f.module, bad), NativePlatformTransportError);
  }
});

test('mutable request containers cannot change a lifecycle dispatch after invocation', async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  f.module.lifecycleRequest = (...args) => { f.calls.push(args); return new Promise((resolve) => { release = resolve; }); };
  const original = request('POST', '/api/agentflow/agent-sessions');
  const pending = f.fetch(...original);
  original[1].method = 'DELETE'; original[1].body = '{}'; original[1].credentials = 'include';
  (original[1].headers as Record<string, string>).Cookie = 'private=1';
  release({ status: 201, body: '{}' }); await pending;
  assert.deepEqual(f.calls[0]!.slice(1), [ORIGIN, '/api/agentflow/agent-sessions', 'POST',
    'access.safe.jwt', 'proof.safe.jwt', JSON.stringify(CREATE)]);
});

test('abort rejects promptly but shares the origin latch with GET until actual native settlement', async () => {
  const f = fixture(); let settle!: (value: unknown) => void;
  f.module.lifecycleRequest = (...args) => { f.calls.push(args); return new Promise((resolve) => { settle = resolve; }); };
  const controller = new AbortController();
  const pending = f.fetch(...request('POST', '/api/agentflow/agent-sessions', CREATE, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(f.cancelled.length, 1);
  const otherLifecycleOwner = createMobileAgentLifecycleFetch(f.module, ORIGIN);
  const readOwner = createMobileAgentFetch(f.module, ORIGIN);
  assert.throws(() => otherLifecycleOwner.assertAvailable(), MobileAgentLifecycleTransportBusy);
  assert.throws(() => readOwner.assertAvailable());
  await assert.rejects(otherLifecycleOwner(...request('PUT', '/api/agentflow/me/agent-state')), MobileAgentLifecycleTransportBusy);
  assert.equal(f.calls.length, 1);
  settle({ status: 201, body: '{}' }); await new Promise((resolve) => setImmediate(resolve));
  otherLifecycleOwner.assertAvailable(); readOwner.assertAvailable();
});

test('request IDs are exact lowercase UUIDs and cannot be reused while active in another origin', async () => {
  const f = fixture();
  f.module.newRequestId = () => randomUUID().toUpperCase();
  await assert.rejects(f.fetch(...request('POST', '/api/agentflow/agent-sessions')), NativePlatformTransportError);
  assert.equal(f.calls.length, 0);

  const id = randomUUID(); let settle!: (value: unknown) => void;
  f.module.newRequestId = () => id;
  f.module.lifecycleRequest = (...args) => { f.calls.push(args); return new Promise((resolve) => { settle = resolve; }); };
  const first = f.fetch(...request('POST', '/api/agentflow/agent-sessions'));
  const other = createMobileAgentLifecycleFetch(f.module, OTHER_ORIGIN);
  const otherRequest = request('POST', '/api/agentflow/agent-sessions');
  otherRequest[0] = otherRequest[0].replace(ORIGIN, OTHER_ORIGIN);
  await assert.rejects(other(...otherRequest), NativePlatformTransportError);
  assert.equal(f.calls.length, 1);
  settle({ status: 201, body: '{}' }); await first;
});

test('native response shape, status, fatal UTF-8 bytes and JSON consumption are bounded', async () => {
  const f = fixture(); const args = request('POST', '/api/agentflow/agent-sessions');
  for (const raw of [null, { status: 302, body: '{}' }, { status: 200.5, body: '{}' },
    { status: 201, body: '{}', token: 'private' }, { status: 201, body: null },
    { status: 201, body: '가'.repeat(22000) }, { status: 201, body: '"\ud800"' }]) {
    f.module.lifecycleRequest = async () => raw;
    await assert.rejects(f.fetch(...args), MobileAgentLifecycleResponseInvalid);
  }
  const exact = JSON.stringify({ value: 'x'.repeat(65524) }); assert.equal(Buffer.byteLength(exact), 65536);
  f.module.lifecycleRequest = async () => ({ status: 201, body: exact });
  assert.deepEqual(await (await f.fetch(...args)).json(), JSON.parse(exact));
  f.module.lifecycleRequest = async () => ({ status: 201, body: `${exact} ` });
  await assert.rejects(f.fetch(...args), MobileAgentLifecycleResponseInvalid);
  f.module.lifecycleRequest = async () => ({ status: 201, body: '{' });
  await assert.rejects((await f.fetch(...args)).json(), MobileAgentLifecycleResponseInvalid);
  f.module.lifecycleRequest = async () => { throw new Error('private-native-error'); };
  await assert.rejects(f.fetch(...args), (error: unknown) => error instanceof NativePlatformTransportError
    && !error.message.includes('private'));
});

test('partial modules and native pre-dispatch failures expose only safe lifecycle transport errors', async () => {
  const f = fixture();
  for (const missing of ['newRequestId', 'lifecycleRequest', 'cancelRequest'] as const) {
    const partial = { ...f.module, [missing]: undefined } as unknown as MobileAgentLifecycleHttpModule;
    assert.throws(() => createMobileAgentLifecycleFetch(partial, ORIGIN), MobileAgentLifecycleTransportUnavailable);
  }
  assert.throws(() => createMobileAgentLifecycleFetch(null, ORIGIN), MobileAgentLifecycleTransportUnavailable);
  for (const [nativeCode, expected] of [['mobile_transport_invalid', MobileAgentLifecycleTransportUnavailable],
    ['mobile_transport_busy', MobileAgentLifecycleTransportBusy],
    ['mobile_transport_response_invalid', MobileAgentLifecycleResponseInvalid]] as const) {
    f.module.newRequestId = () => { throw Object.assign(new Error('private'), { code: nativeCode }); };
    await assert.rejects(f.fetch(...request('POST', '/api/agentflow/agent-sessions')), expected);
  }
});
