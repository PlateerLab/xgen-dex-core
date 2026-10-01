import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createMobileDeviceKeys } from '../src/lib/native-device-key';
import { createMobileEnrollmentFetch } from '../src/lib/native-enrollment-http';
import { createMobileEnrollment, browserApprovers, mobileEnrollmentMessage, MobileEnrollmentError } from '../src/lib/native-device-enrollment';

const origin = 'https://xgen.example.test'; const target = randomUUID(); const first = randomUUID(); const second = randomUUID();
const challenge = Buffer.alloc(32, 5).toString('base64url'); const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = pair.publicKey.export({ format: 'jwk' });
function fixture() {
  let account: { origin: string; userId: string; authScope: string; accessToken: string } | null = { origin, userId: '7', authScope: 'login-1', accessToken: 'current-account-token' };
  let registration: null | { device_id: string; state: 'pending' | 'trusted' | 'suspended' | 'revoked' } = null;
  let browsers = [first, second].map((id, i) => ({ device_id: id, platform: 'web', device_name: `Browser ${i}`, registered_at: new Date().toISOString(), last_seen_at: null, is_default_approver: i === 0 }));
  const calls: { path: string; method: string; token: string; body: string | null }[] = [];
  const cancellations: string[] = [];
  let runRequest = async (path: string, body: string | null): Promise<unknown> => {
    if (path.includes('/registration/status/')) return registration;
    if (path.endsWith('/trust-overview')) return { enrollment_state: 'existing_trust', trusted_devices: browsers, more_trusted_devices: false, admin_code_required: false };
    if (path.endsWith('/registration/challenge')) return { challenge, expires_in_seconds: 60 };
    if (path.endsWith('/registration/complete')) { registration = { device_id: target, state: 'pending' }; return registration; }
    if (path.endsWith('/approval-requests/begin')) return { flow_id: randomUUID(), device_challenge: challenge, expires_in_seconds: 60 };
    if (path.endsWith('/approval-requests')) {
      const selected = JSON.parse(calls.at(-2)!.body!).approver_device_id;
      assert.ok(JSON.parse(body!).device_proof_jwt);
      return { request_id: randomUUID(), target_device_id: target, target_platform: 'mobile', target_device_name: 'Mobile', approver_device_id: selected,
        approver_platform: 'web', state: 'pending', requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(), confirmation_code: '123456' };
    }
    throw new Error('unexpected route');
  };
  const native = {
    newRequestId: randomUUID,
    async request(_id: string, requestedOrigin: string, path: string, method: string, token: string, body: string | null) {
      assert.equal(requestedOrigin, origin); calls.push({ path, method, token, body });
      return { status: 200, body: JSON.stringify(await runRequest(path, body)) };
    },
    cancelRequest(id: string) { cancellations.push(id); },
    async prepare(_origin: string, userId: string, create: boolean) {
      assert.equal(userId, '7'); assert.equal(create, false);
      return { installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', storage: 'android-tee', publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
    },
    async signChallenge(_origin: string, _user: string, _install: string, _thumb: string, purpose: string, value: string) {
      const input = `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'platform-device-proof+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify({ purpose, challenge: value, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}`;
      return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    },
  };
  const current = () => account ? { ...account } : null;
  const enrollment = createMobileEnrollment({ current, keys: createMobileDeviceKeys(native, current), fetch: createMobileEnrollmentFetch(native, origin) });
  return { enrollment, calls, cancellations, change(next: typeof account) { account = next; }, request(next: typeof runRequest) { runRequest = next; },
    browsers: () => browsers, setBrowsers(next: typeof browsers) { browsers = next; },
    status(next: typeof registration) { registration = next; } };
}
test('Mobile enrolls with its hardware-provider boundary, restores registration and requests only the selected browser', async () => {
  const f = fixture(); const registered = await f.enrollment.register('My phone'); assert.equal(registered.registration?.state, 'pending');
  assert.equal(registered.selectedApproverId, first); f.enrollment.selectApprover(second);
  const pending = await f.enrollment.requestApproval(); assert.equal(pending.approval?.approver_device_id, second); assert.equal(pending.approval?.confirmation_code, '123456');
  const mutations = f.calls.filter((c) => c.method === 'POST').length;
  assert.equal((await f.enrollment.register()).registration?.device_id, target); assert.equal(f.calls.filter((c) => c.method === 'POST').length, mutations);
  f.status({ device_id: target, state: 'trusted' }); const trusted = await f.enrollment.inspect(); assert.equal(trusted.registration?.state, 'trusted'); assert.equal(trusted.approval, null);
  assert.ok(f.calls.every((c) => c.token === 'current-account-token'));
  assert.ok(f.calls.every((c) => !c.path.includes('platform-sessions'))); assert.equal(JSON.stringify(trusted).includes('current-account-token'), false);
});
test('no default requires a deliberate browser choice and native/non-browser approvers cannot be selected', async () => {
  const f = fixture(); f.setBrowsers(f.browsers().map((d) => ({ ...d, is_default_approver: false })));
  const state = await f.enrollment.register(); assert.equal(state.selectedApproverId, null); assert.equal(browserApprovers(state).length, 2);
  await assert.rejects(f.enrollment.requestApproval(), (e: unknown) => e instanceof MobileEnrollmentError && e.code === 'select_approver');
  assert.throws(() => f.enrollment.selectApprover(randomUUID()), MobileEnrollmentError);
  assert.equal(f.calls.filter((c) => c.path.includes('approval-requests')).length, 0);
});
test('removing the selected browser does not silently choose the other default or start approval', async () => {
  const f = fixture(); await f.enrollment.register(); f.enrollment.selectApprover(first);
  f.setBrowsers([{ ...f.browsers()[1]!, is_default_approver: true }]);
  await assert.rejects(f.enrollment.requestApproval(), (e: unknown) => e instanceof MobileEnrollmentError && e.code === 'approver_changed');
  assert.equal(f.enrollment.snapshot().selectedApproverId, null); assert.equal(f.calls.filter((c) => c.path.includes('approval-requests')).length, 0);
});
test('trusted/suspended/revoked/unregistered devices cannot ask for approval and do not re-register', async () => {
  for (const state of ['trusted', 'suspended', 'revoked'] as const) {
    const f = fixture(); f.status({ device_id: target, state }); assert.equal((await f.enrollment.register()).registration?.state, state);
    await assert.rejects(f.enrollment.requestApproval(), (e: unknown) => e instanceof MobileEnrollmentError && e.code === 'pending_required');
    assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
  }
  await assert.rejects(fixture().enrollment.requestApproval(), MobileEnrollmentError);
});
test('snapshots are public independent copies; failures never expose body or token and mutation outcomes are uncertain', async () => {
  const f = fixture(); const state = await f.enrollment.register(); state.overview!.trusted_devices.length = 0; assert.equal(browserApprovers(f.enrollment.snapshot()).length, 2);
  f.request(async () => { throw new Error('secret-native-response-body'); });
  await assert.rejects(f.enrollment.requestApproval()); // status read failed, no mutation began.
  assert.equal(f.enrollment.snapshot().outcomeUncertain, false);
  const g = fixture(); await g.enrollment.register();
  g.request(async (path) => {
    if (path.includes('/registration/status/')) return { device_id: target, state: 'pending' };
    if (path.endsWith('/trust-overview')) return { enrollment_state: 'existing_trust', trusted_devices: g.browsers(), more_trusted_devices: false, admin_code_required: false };
    throw new Error('secret-native-response-body');
  });
  await assert.rejects(g.enrollment.requestApproval()); assert.equal(g.enrollment.snapshot().outcomeUncertain, true);
  assert.equal(g.calls.filter((c) => c.path.endsWith('approval-requests/begin')).length, 1); assert.equal(g.calls.some((c) => c.path.endsWith('/approval-requests')), false);
  assert.equal(mobileEnrollmentMessage(new Error('secret-native-response-body')).includes('secret'), false);
});
test('account/server/logout/relogin/token changes discard late results and never complete a ceremony', async () => {
  for (const changed of [null, { origin, userId: '8', authScope: 'login-1', accessToken: 'current-account-token' },
    { origin: 'https://other.test', userId: '7', authScope: 'login-1', accessToken: 'current-account-token' },
    { origin, userId: '7', authScope: 'login-2', accessToken: 'current-account-token' },
    { origin, userId: '7', authScope: 'login-1', accessToken: 'rotated-token' }]) {
    const f = fixture(); let done!: (v: unknown) => void;
    f.request(() => new Promise((r) => { done = r; })); const pending = f.enrollment.register();
    while (!done) await new Promise((r) => setImmediate(r));
    f.change(changed); done(null); await assert.rejects(pending);
    assert.equal(f.calls.length, 1); assert.equal(f.enrollment.snapshot().registration, null);
    if (changed?.accessToken !== 'rotated-token') await assert.rejects(f.enrollment.inspect());
  }
});
test('account changes between operations clear old state before HTTP; same-login token rotation allows a fresh explicit read', async () => {
  const f = fixture(); await f.enrollment.register(); const before = f.calls.length;
  f.change({ origin, userId: '8', authScope: 'login-2', accessToken: 'other-account' });
  await assert.rejects(f.enrollment.inspect()); assert.equal(f.calls.length, before); assert.equal(f.enrollment.snapshot().overview, null);
  const g = fixture(); await g.enrollment.register();
  g.change({ origin, userId: '7', authScope: 'login-1', accessToken: 'rotated-token' });
  await g.enrollment.inspect(); assert.equal(g.calls.at(-1)!.token, 'rotated-token');
});
test('one operation at a time; disposing stops native HTTP and late results cannot restore a screen', async () => {
  const f = fixture(); let done!: (v: unknown) => void; f.request(() => new Promise((r) => { done = r; }));
  const pending = f.enrollment.register(); await assert.rejects(f.enrollment.inspect(), (e: unknown) => e instanceof MobileEnrollmentError && e.code === 'busy');
  while (!done) await new Promise((r) => setImmediate(r));
  f.enrollment.dispose(); await assert.rejects(pending); assert.equal(f.cancellations.length, 1);
  done(null); await new Promise((r) => setImmediate(r)); assert.equal(f.enrollment.snapshot().registration, null); assert.equal(f.calls.length, 1);
});
