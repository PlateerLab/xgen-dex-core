import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentSessionProtocolError } from '@dex/protocol/agent-session';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { createMobileAgentFetch, MobileAgentTransportBusy, MobileAgentTransportUnavailable, mobileAgentReadPath, type MobileAgentHttpModule } from '../src/lib/native-agent-http';

const origin = 'https://mobile.example.test'; const sid = '11111111-1111-4111-8111-111111111111';
const init: RequestInit = { method: 'GET', headers: { Accept: 'application/json', Authorization: 'DPoP access.jwt.signature', DPoP: 'proof.jwt.signature' },
  credentials: 'omit', redirect: 'error', cache: 'no-store' };
function fixture() {
  const calls: unknown[][] = []; const cancelled: string[] = [];
  const native: MobileAgentHttpModule = { newRequestId: randomUUID,
    readRequest: async (...args) => { calls.push(args); return { status: 200, body: '{"ok":true}' }; }, cancelRequest: (id) => { cancelled.push(id); } };
  return { native, calls, cancelled, fetch: createMobileAgentFetch(native, origin) };
}
test('only exact Canonical GET routes/ordered canonical query bounds enter the native bridge', async () => {
  const f = fixture();
  for (const path of ['/api/agentflow/me/agent-state', '/api/agentflow/me/agent-events?after_sequence=0&limit=200',
    '/api/agentflow/me/agent-events?after_sequence=9007199254740991&limit=1', `/api/agentflow/agent-sessions/${sid}/snapshot`,
    `/api/agentflow/agent-sessions/${sid}/events?after_sequence=42&limit=100`, '/api/agentflow/me/agent-sessions?limit=100',
    `/api/agentflow/me/agent-sessions?limit=1&before_id=${sid}`]) {
    assert.equal(mobileAgentReadPath(path), true); const response = await f.fetch(`${origin}${path}`, init); assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(f.calls.at(-1)!.slice(1), [origin, path, 'access.jwt.signature', 'proof.jwt.signature']);
  }
});
test('unknown/duplicate/encoded parameters, query reorder, fractions, overflows and noncanonical UUIDs fail before wire', async () => {
  const f = fixture();
  for (const path of ['/api/agentflow/me/agent-state?', '/api/agentflow/me/agent-state?limit=1', '/api/agentflow/me/agent-state\n',
    '/api/agentflow/me/agent-events?limit=1&after_sequence=0', '/api/agentflow/me/agent-events?after_sequence=00&limit=1',
    '/api/agentflow/me/agent-events?after_sequence=1.0&limit=1', '/api/agentflow/me/agent-events?after_sequence=-1&limit=1',
    '/api/agentflow/me/agent-events?after_sequence=9007199254740992&limit=1', '/api/agentflow/me/agent-events?after_sequence=0&limit=201',
    '/api/agentflow/me/agent-events?after_sequence=0&limit=01', '/api/agentflow/me/agent-events?after_sequence=0&limit=0',
    '/api/agentflow/me/agent-events?after_sequence=%30&limit=1', '/api/agentflow/me/agent-events?after_sequence=0&limit=1&limit=1',
    '/api/agentflow/me/agent-sessions?limit=101', '/api/agentflow/me/agent-sessions?limit=1&extra=1',
    `/api/agentflow/agent-sessions/${sid.replace('4111', '0111')}/snapshot`, `/api/agentflow/agent-sessions/${sid}/snapshot#fragment`,
    '/api/agentflow/agent-sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/snapshot'.toUpperCase(),
    '/api/agentflow/me/../me/agent-state', '/api/agentflow/me%2fagent-state', '/api/agentflow/me\\agent-state']) {
    await assert.rejects(f.fetch(`${origin}${path}`, init), NativePlatformTransportError);
  }
  assert.equal(f.calls.length, 0);
});
test('GET never accepts Bearer, blank/newline tokens, arbitrary headers/body, insecure/foreign origin or RN fallback', async () => {
  const f = fixture(); const url = `${origin}/api/agentflow/me/agent-state`;
  for (const patch of [{ method: 'POST' }, { body: '{}' }, { credentials: 'include' }, { redirect: 'follow' }, { cache: 'default' },
    { headers: { ...init.headers, Cookie: 'private' } }, { headers: { ...init.headers, Authorization: 'Bearer account-token' } },
    { headers: { ...init.headers, Authorization: 'DPoP access.jwt.signature\n' } }, { headers: { ...init.headers, DPoP: 'proof.jwt.signature\n' } },
    { headers: { ...init.headers, DPoP: 'invalid' } }]) await assert.rejects(f.fetch(url, { ...init, ...patch } as RequestInit), NativePlatformTransportError);
  await assert.rejects(f.fetch(url.replace(origin, 'https://other.test'), init), NativePlatformTransportError);
  assert.throws(() => createMobileAgentFetch(null, origin), MobileAgentTransportUnavailable);
  for (const bad of ['http://mobile.example.test', `${origin}/`, `${origin}?q=1`, 'bad']) assert.throws(() => createMobileAgentFetch(f.native, bad), NativePlatformTransportError);
  assert.equal(f.calls.length, 0);
});
test('native cancel settles promptly and late results are discarded; concurrent reused IDs are refused', async () => {
  const f = fixture(); const control = new AbortController(); const id = randomUUID(); f.native.newRequestId = () => id;
  let resolve!: (value: unknown) => void; f.native.readRequest = () => new Promise((r) => { resolve = r; });
  const pending = f.fetch(`${origin}/api/agentflow/me/agent-state`, { ...init, signal: control.signal });
  await assert.rejects(f.fetch(`${origin}/api/agentflow/me/agent-state`, init), MobileAgentTransportBusy);
  control.abort(); await assert.rejects(pending); assert.deepEqual(f.cancelled, [id]); resolve({ status: 200, body: '{}' });
});
test('cancelled native read remains busy across adapter owners until actual OS completion, without blocking local recovery', async () => {
  const f = fixture(); const control = new AbortController(); let resolve!: (value: unknown) => void; let calls = 0;
  f.native.readRequest = async () => { calls++; return new Promise((r) => { resolve = r; }); };
  const url = `${origin}/api/agentflow/me/agent-state`; const read = f.fetch(url, { ...init, signal: control.signal }); control.abort(); await assert.rejects(read);
  const second = createMobileAgentFetch(f.native, origin);
  assert.throws(() => second.assertAvailable(), MobileAgentTransportBusy); await assert.rejects(second(url, init), MobileAgentTransportBusy); assert.equal(calls, 1);
  resolve({ status: 200, body: '{}' }); await new Promise((r) => setImmediate(r)); second.assertAvailable();
  f.native.readRequest = async () => ({ status: 200, body: '{}' }); await second(url, init);
});
test('partial native modules and permanent native contract errors never become retryable transport failures', async () => {
  for (const missing of ['newRequestId', 'readRequest', 'cancelRequest']) {
    const f = fixture(); const partial = { ...f.native, [missing]: undefined } as unknown as MobileAgentHttpModule;
    assert.throws(() => createMobileAgentFetch(partial, origin), MobileAgentTransportUnavailable);
  }
  const f = fixture(); f.native.readRequest = async () => { throw { code: 'mobile_transport_invalid', message: 'private-native' }; };
  await assert.rejects(f.fetch(`${origin}/api/agentflow/me/agent-state`, init), MobileAgentTransportUnavailable); f.fetch.assertAvailable();
});
test('native request reservation busy/invalid errors retain their bounded or permanent classification before wire', async () => {
  const f = fixture();
  for (const [code, expected] of [['mobile_transport_busy', MobileAgentTransportBusy], ['mobile_transport_invalid', MobileAgentTransportUnavailable]] as const) {
    f.native.newRequestId = () => { throw { code, message: 'private-native' }; };
    await assert.rejects(f.fetch(`${origin}/api/agentflow/me/agent-state`, init), expected);
  }
  assert.equal(f.calls.length, 0);
});
test('redirect/oversize/invalid native responses and exception details are contained; invalid JSON is a protocol error', async () => {
  const f = fixture(); const url = `${origin}/api/agentflow/me/agent-state`;
  for (const raw of [{ status: 302, body: '' }, { status: 200.5, body: '{}' }, { status: 200, body: '가'.repeat(22000) },
    { status: 200, body: '{}', cookie: 'secret' }, { status: 200, body: null }, null]) {
    f.native.readRequest = async () => raw; await assert.rejects(f.fetch(url, init), NativePlatformTransportError);
  }
  f.native.readRequest = async () => { throw new Error('private-native-error'); };
  await assert.rejects(f.fetch(url, init), (e: Error) => e instanceof NativePlatformTransportError && !e.message.includes('private'));
  f.native.readRequest = async () => ({ status: 200, body: 'private-not-json' });
  await assert.rejects((await f.fetch(url, init)).json(), AgentSessionProtocolError);
});
