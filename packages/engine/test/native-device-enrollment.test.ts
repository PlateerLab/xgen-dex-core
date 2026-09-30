import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { nativeDeviceEnrollment, type NativeEnrollmentAction } from '../src/native-device-enrollment';
import { NativePlatformHttpError } from '@dex/protocol/native-platform-session';
import { DexError } from '../src/errors';

const DEVICE = '018f1240-0000-7000-8000-000000000001';
const APPROVER = '018f1240-0000-7000-8000-000000000002';
const FLOW = '018f1240-0000-7000-8000-000000000003';
const CHALLENGE = Buffer.alloc(32, 5).toString('base64url');
const TOKEN = 'e30.e30.c2ln';
function fixture(responses: unknown[]) {
  const calls: Array<{ path: string; init: RequestInit; body: Record<string, unknown> }> = [];
  let scope: unknown; let create: boolean | undefined;
  const keys = { withIdentity: async <T>(input: unknown, shouldCreate: boolean, work: (identity: any) => Promise<T>) => {
    scope = input; create = shouldCreate;
    return work({ installId: 'cli-install-123456', publicKey: { kty: 'EC', crv: 'P-256', x: CHALLENGE, y: CHALLENGE }, signChallenge: async () => TOKEN });
  } };
  const fetchImpl = (async (input, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, init, body: JSON.parse(String(init.body ?? '{}')) });
    if (path === '/api/auth/logout') return Response.json({ success: true });
    if (path === '/api/auth/login') return Response.json({ success: true, user_id: '7', access_token: TOKEN, refresh_token: 'legacy-refresh-never-stored' });
    const value = responses.shift(); return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  const run = (operation: NativeEnrollmentAction) => nativeDeviceEnrollment({ origin: 'https://app.example.test', email: 'account@example.test',
    password: 'private-password', operation, keys, fetch: fetchImpl });
  return { calls, keys, fetchImpl, run, scope: () => scope, create: () => create };
}

test('fresh account login is isolated, uses the returned account ID, and revokes its temporary context', async () => {
  const f = fixture([null, { challenge: CHALLENGE, expires_in_seconds: 300 }, { device_id: DEVICE, state: 'pending' }]);
  assert.deepEqual(await f.run({ action: 'register' }), { device_id: DEVICE, state: 'pending' });
  assert.deepEqual(f.scope(), { origin: 'https://app.example.test', userId: '7', platform: 'cli' });
  assert.equal(f.create(), true);
  assert.deepEqual(f.calls[0].body, { email: 'account@example.test', password: createHash('sha256').update('private-password').digest('hex'), token: null });
  assert.equal(f.calls.at(-1)?.path, '/api/auth/logout'); assert.deepEqual(f.calls.at(-1)?.body, { token: TOKEN });
  for (const { init, body } of f.calls) {
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(JSON.stringify(body).includes('private-password'), false);
    assert.equal(JSON.stringify(body).includes('legacy-refresh-never-stored'), false);
    assert.equal('privateKeyPkcs8' in body, false);
  }
});

test('register after a previous completion returns the same device without a new key challenge', async () => {
  const f = fixture([{ device_id: DEVICE, state: 'trusted' }]);
  assert.equal((await f.run({ action: 'register' }) as any).state, 'trusted');
  assert.equal(f.calls.length, 3);
});

test('a pending device selects the requested browser and returns the comparison code only', async () => {
  const result = { request_id: FLOW, target_device_id: DEVICE, target_platform: 'cli', target_device_name: 'CLI',
    approver_device_id: APPROVER, approver_platform: 'web', state: 'pending', requested_at: '2026-09-30T00:00:00Z',
    expires_at: '2026-09-30T00:10:00Z', confirmation_code: '012345' };
  const f = fixture([{ device_id: DEVICE, state: 'pending' }, { flow_id: FLOW, device_challenge: CHALLENGE, expires_in_seconds: 300 }, result]);
  assert.deepEqual(await f.run({ action: 'request-approval', approverDeviceId: APPROVER }), result);
  assert.equal(f.create(), false); assert.deepEqual(f.calls[2].body, { approver_device_id: APPROVER });
});

test('API/keychain failures still clean up account context, and a missing/past device cannot request approval', async () => {
  for (const response of [null, { device_id: DEVICE, state: 'trusted' }, new Response('private-password', { status: 503 })]) {
    const f = fixture([response]);
    await assert.rejects(f.run({ action: 'request-approval', approverDeviceId: APPROVER }), (e: unknown) => e instanceof DexError || e instanceof NativePlatformHttpError);
    assert.equal(f.calls.at(-1)?.path, '/api/auth/logout');
  }
  const f = fixture([]); f.keys.withIdentity = async () => { throw new DexError('credential_store_unavailable', 'OS keychain unavailable'); };
  await assert.rejects(f.run({ action: 'status' }), DexError);
  assert.deepEqual(f.calls.map((call) => call.path), ['/api/auth/login', '/api/auth/logout']);
});

test('HTTP profiles are rejected before authentication; account mismatch never reaches key storage', async () => {
  const f = fixture([]);
  await assert.rejects(nativeDeviceEnrollment({ origin: 'http://localhost', email: 'a', password: 'p', operation: { action: 'status' }, keys: f.keys, fetch: f.fetchImpl }), DexError);
  assert.equal(f.calls.length, 0);
  const invalid = (async (input, init) => new URL(String(input)).pathname === '/api/auth/login'
    ? Response.json({ success: true, access_token: TOKEN, user_id: 'invalid-account' }) : f.fetchImpl(input, init)) as typeof fetch;
  await assert.rejects(nativeDeviceEnrollment({ origin: 'https://app.example.test', email: 'a', password: 'p', operation: { action: 'status' }, keys: f.keys, fetch: invalid }), DexError);
  assert.equal(f.scope(), undefined); assert.equal(f.calls.at(-1)?.path, '/api/auth/logout');
});

test('host account binding rejects another valid account before key/device access and revokes the temporary login', async () => {
  const f = fixture([]);
  await assert.rejects(nativeDeviceEnrollment({ origin: 'https://app.example.test', platform: 'desktop', expectedUserId: '8',
    email: 'a', password: 'p', operation: { action: 'register' }, keys: f.keys, fetch: f.fetchImpl }),
    (error: unknown) => error instanceof DexError && error.code === 'auth_required');
  assert.equal(f.scope(), undefined);
  assert.deepEqual(f.calls.map((call) => call.path), ['/api/auth/login', '/api/auth/logout']);
});

test('successful device work reports failed logout without exposing its token or server body', async () => {
  const f = fixture([{ device_id: DEVICE, state: 'trusted' }]);
  const fetchImpl = (async (input, init) => new URL(String(input)).pathname === '/api/auth/logout'
    ? new Response(`private-password ${TOKEN}`, { status: 503 }) : f.fetchImpl(input, init)) as typeof fetch;
  await assert.rejects(nativeDeviceEnrollment({ origin: 'https://app.example.test', email: 'a', password: 'p',
    operation: { action: 'status' }, keys: f.keys, fetch: fetchImpl }), (error: unknown) => {
    assert.ok(error instanceof DexError); assert.equal(error.code, 'network_error');
    assert.equal(error.message.includes(TOKEN), false); assert.equal(error.message.includes('private-password'), false);
    return true;
  });
});

test('abort preserves the original failure while logout uses a separate live signal', async () => {
  const f = fixture([]); const controller = new AbortController();
  const original = new Error('operation aborted');
  f.keys.withIdentity = async () => { controller.abort(original); throw original; };
  await assert.rejects(nativeDeviceEnrollment({ origin: 'https://app.example.test', email: 'a', password: 'p',
    operation: { action: 'status' }, keys: f.keys, fetch: f.fetchImpl, signal: controller.signal }), (error: unknown) => error === original);
  const cleanup = f.calls.at(-1)!;
  assert.equal(cleanup.path, '/api/auth/logout'); assert.notEqual(cleanup.init.signal, controller.signal);
  assert.equal(cleanup.init.signal?.aborted, false);
});
