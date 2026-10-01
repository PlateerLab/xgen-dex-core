import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import test from 'node:test';
import { createMobileDeviceKeys, mobileKeyThumbprint } from '../src/lib/native-device-key';
import { createMobileEnrollmentFetch } from '../src/lib/native-enrollment-http';
import { createMobileSessionFetch } from '../src/lib/native-session-http';
import { createMobileSessionVault, mobileVaultScope, MobileVaultError, validateMobileRecord, type MobilePlatformRecord } from '../src/lib/native-session-vault';
import { createMobilePlatformSession, mobilePlatformMessage, MobilePlatformError } from '../src/lib/native-platform-session';
import type { MobileEnrollmentAccount } from '../src/lib/native-device-enrollment';

const origin = 'https://mobile.example.test'; const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = pair.publicKey.export({ format: 'jwk' }); const publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as const;
const metadata = { installId: randomUUID(), storage: 'android-tee', publicKey };
const challenge = Buffer.alloc(32, 3).toString('base64url');
const jwt = (header: object, claims: object) => { const input = [header, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; };
function fixture() {
  const userId = `${Math.floor(Math.random() * 1e12) + 1}`;
  let account: MobileEnrollmentAccount | null = { origin, userId, authScope: randomUUID(), accessToken: 'account-bearer' };
  const authority = { ...account }; const sid = randomUUID(); const deviceId = randomUUID(); let trust = 'trusted'; let refreshVersion = 1;
  const values = new Map<string, string>(); const calls: { path: string; auth: string | null; dpop: string | null; body: Record<string, unknown> }[] = [];
  const key = mobileVaultScope(authority); const cancellations: string[] = [];
  const access = () => { const exp = Math.floor(Date.now() / 1000) + 300;
    return { token_type: 'DPoP', access_token: jwt({ alg: 'ES256' }, { sub: userId, sid, device_id: deviceId, platform_type: 'mobile',
      token_use: 'platform_access', cnf: { jkt: mobileKeyThumbprint(publicKey) }, exp }), access_expires_at: new Date(exp * 1000).toISOString() }; };
  const refresh = () => Buffer.alloc(32, refreshVersion).toString('base64url');
  let handle = async (path: string): Promise<{ status: number; body: string }> => {
    if (path.endsWith('/begin')) return { status: 200, body: JSON.stringify({ flow_id: randomUUID(), device_id: deviceId, challenge, expires_in_seconds: 60 }) };
    if (path.endsWith('/login-key/complete')) return { status: 200, body: JSON.stringify({ session_id: sid, state: 'active', refresh_token: refresh(), ...access() }) };
    if (path.endsWith('/refresh/complete')) { refreshVersion++; return { status: 200, body: JSON.stringify({ session_id: sid, refreshed: true, access_ready: true, refresh_token: refresh(), ...access() }) }; }
    if (path === `/api/me/platform-sessions/${sid}`) return { status: 204, body: '' };
    throw new Error('unexpected fixture path');
  };
  const storage = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
    deleteItemAsync: async (key: string) => { values.delete(key); },
  };
  const native = {
    newRequestId: randomUUID,
    async prepare() { return metadata; },
    async signChallenge(_o: string, _u: string, _i: string, _t: string, purpose: string, challenge: string) {
      return jwt({ alg: 'ES256', typ: 'platform-device-proof+jwt' }, { purpose, challenge, iat: Math.floor(Date.now() / 1000) });
    },
    async signDpop(_o: string, _u: string, _i: string, _t: string, method: string, htu: string, token: string) {
      const { createHash } = await import('node:crypto');
      return jwt({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicKey }, { jti: randomUUID(), htm: method, htu,
        iat: Math.floor(Date.now() / 1000), ath: createHash('sha256').update(token).digest('base64url') });
    },
    async request(_id: string, _origin: string, _path: string) { return { status: 200, body: JSON.stringify({ device_id: deviceId, state: trust }) }; },
    async sessionRequest(_id: string, _origin: string, path: string, _method: string, auth: string | null, dpop: string | null, body: string | null) {
      assert.equal(_origin, origin); calls.push({ path, auth, dpop, body: JSON.parse(body!) });
      return handle(path);
    },
    cancelRequest(id: string) { cancellations.push(id); },
  };
  const current = () => account ? { ...account } : null;
  const keys = createMobileDeviceKeys(native, current);
  const make = () => createMobilePlatformSession({ current, keys, vault: createMobileSessionVault(storage), generation: randomUUID,
    enrollmentFetch: createMobileEnrollmentFetch(native, origin), sessionFetch: createMobileSessionFetch(native, origin) });
  return { controller: make(), make, key, authority, sid, deviceId, values, calls, storage, native, keys, access, cancellations,
    change(value: typeof account) { account = value; }, current, trust(value: string) { trust = value; }, handle(value: typeof handle) { handle = value; },
    record: () => JSON.parse(values.get(key)!) as MobilePlatformRecord, rawHandle: () => handle };
}

test('Mobile login persists scoped credentials, restarts locally and rotates without account Bearer or retries', async () => {
  const f = fixture(); assert.equal((await f.controller.inspect()).state, 'signed_out'); assert.equal(f.calls.length, 0);
  const result = await f.controller.login('user-password'); assert.equal(result.state, 'active'); assert.equal(result.sessionId, f.sid);
  assert.ok(!JSON.stringify(result).includes('token')); assert.equal(f.values.get(`${f.key}-journal`), undefined);
  assert.equal(f.calls[0]!.auth, 'Bearer account-bearer'); assert.equal(f.calls[0]!.body.password, undefined); assert.equal(f.calls[1]!.body.password, 'user-password');
  assert.ok(![...f.values.values()].join('').includes('user-password')); assert.ok(![...f.values.values()].join('').includes('account-bearer'));
  const restored = f.make(); const count = f.calls.length; assert.equal((await restored.inspect()).state, 'active'); assert.equal(f.calls.length, count);
  const old = f.record().refreshToken; await restored.refresh(); assert.notEqual(f.record().refreshToken, old);
  assert.ok(f.calls.slice(-2).every((c) => c.auth === null && c.dpop === null)); assert.equal(f.calls.length, 4);
});
test('pending takeover contains no credentials and cannot refresh or logout', async () => {
  const f = fixture(); const previous = f.rawHandle(); f.handle(async (path) => path.endsWith('/complete')
    ? { status: 200, body: JSON.stringify({ session_id: f.sid, state: 'pending_takeover', token_type: null, access_token: null, access_expires_at: null, refresh_token: null }) } : previous(path));
  assert.equal((await f.controller.login('password')).state, 'pending_takeover'); assert.equal(f.record().refreshToken, null);
  await assert.rejects(f.controller.refresh(), MobilePlatformError); await assert.rejects(f.controller.logout('password'), MobilePlatformError);
  assert.equal(f.calls.length, 2);
});
test('lost refresh completion erases old tokens and leaves a durable journal across new controller instances', async () => {
  const f = fixture(); await f.controller.login('password'); const old = f.record(); const previous = f.rawHandle();
  f.handle(async (path) => { assert.equal(f.values.has(f.key), false); assert.equal(JSON.parse(f.values.get(`${f.key}-journal`)!).phase, 'refreshing');
    if (path.endsWith('/complete')) throw new Error('lost-response-secret'); return previous(path); });
  await assert.rejects(f.controller.refresh()); assert.equal(f.controller.snapshot().state, 'refreshing');
  assert.ok(![...f.values.values()].join('').includes(old.refreshToken!));
  const restarted = f.make(); assert.equal((await restarted.inspect()).state, 'refreshing'); const count = f.calls.length;
  await assert.rejects(restarted.refresh(), MobilePlatformError); assert.equal(f.calls.length, count);
  assert.ok(!mobilePlatformMessage(new Error('lost-response-secret')).includes('secret'));
});
test('marker write/read-back failure stops the wire and never restores or retries a credential', async () => {
  for (const failed of ['write', 'readback']) {
    const f = fixture(); await f.controller.login('password'); const count = f.calls.length;
    if (failed === 'write') f.storage.setItemAsync = async () => { throw new Error('secret-keystore'); };
    else { const get = f.storage.getItemAsync; f.storage.getItemAsync = async (key) => key.endsWith('-journal') && f.values.has(key) ? '{wrong' : get(key); }
    await assert.rejects(f.controller.refresh(), MobileVaultError); assert.equal(f.calls.length, count);
  }
});
test('new credential write/readback failures keep the verified blocker; retained old bytes cannot bypass it', async () => {
  for (const failed of ['write', 'readback']) {
    const f = fixture(); await f.controller.login('password'); const old = f.record(); const put = f.storage.setItemAsync; const get = f.storage.getItemAsync;
    let wrote = false;
    f.storage.setItemAsync = async (key, value) => { if (key === f.key && failed === 'write') throw new Error('secret'); await put(key, value); if (key === f.key) wrote = true; };
    f.storage.getItemAsync = async (key) => key === f.key && failed === 'readback' && wrote ? '{wrong' : get(key);
    await assert.rejects(f.controller.refresh(), MobileVaultError); assert.equal(f.controller.snapshot().state, 'refreshing');
    f.storage.getItemAsync = get; f.values.set(f.key, JSON.stringify(old));
    assert.equal((await f.make().inspect()).state, 'refreshing');
  }
});
test('account switch and cancellation discard late completion and leave no usable credentials', async () => {
  for (const mode of ['dispose', 'account']) {
    const f = fixture(); await f.controller.login('password'); const previous = f.rawHandle();
    let done!: (v: { status: number; body: string }) => void; let begun!: () => void; const entered = new Promise<void>((r) => { begun = r; });
    f.handle(async (path) => { if (!path.endsWith('/complete')) return previous(path); begun(); return new Promise((r) => { done = r; }); });
    const refresh = f.controller.refresh(); await entered;
    if (mode === 'dispose') f.controller.dispose(); else f.change({ ...f.authority, authScope: randomUUID() });
    done(await previous('/api/auth/platform-sessions/native/refresh/complete')); await assert.rejects(refresh);
    assert.equal(f.values.has(f.key), false); assert.equal((await f.make().inspect()).state, 'refreshing');
  }
});
test('same account lock serializes distinct controllers so login/refresh cannot overlap or reuse a token', async () => {
  const f = fixture(); const other = f.make(); const results = await Promise.allSettled([f.controller.login('password'), other.login('password')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(f.calls.length, 2);
  const previous = f.rawHandle(); let done!: (v: { status: number; body: string }) => void; let begun!: () => void;
  const entered = new Promise<void>((r) => { begun = r; });
  f.handle(async (path) => { if (!path.endsWith('/complete')) return previous(path); begun(); return new Promise((r) => { done = r; }); });
  const first = f.make().refresh(); await entered; const second = f.make().refresh();
  done({ status: 503, body: '' }); const rotated = await Promise.allSettled([first, second]);
  assert.equal(rotated.every((r) => r.status === 'rejected'), true); assert.equal(f.calls.length, 4);
});
test('logout binds a real ES256 DPoP to this access token/sid and clears only after server 204', async () => {
  const f = fixture(); await f.controller.login('password'); const token = f.record().accessToken;
  assert.equal((await f.controller.logout('user-password')).state, 'signed_out'); assert.equal(f.values.size, 0);
  const call = f.calls.at(-1)!; assert.equal(call.auth, `DPoP ${token}`); assert.equal(call.body.password, 'user-password');
  const parts = call.dpop!.split('.'); const c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  assert.equal(c.htm, 'DELETE'); assert.equal(c.htu, `${origin}/api/me/platform-sessions/${f.sid}`);
  assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url')), true);
});
test('failed logout is token-free and local forget neither calls server nor recreates/removes the device key', async () => {
  const f = fixture(); await f.controller.login('password'); f.handle(async () => ({ status: 401, body: 'private-server-message' }));
  await assert.rejects(f.controller.logout('password')); assert.equal((await f.make().inspect()).state, 'logout_pending');
  f.native.prepare = async () => { throw new Error('key-missing'); }; const count = f.calls.length;
  assert.equal((await f.make().forgetLocal()).state, 'signed_out'); assert.equal(f.calls.length, count); assert.equal(f.values.size, 0);
});
test('trust and password prerequisites fail before journal/network; existing records cannot login again', async () => {
  for (const trust of ['pending', 'suspended', 'revoked']) { const f = fixture(); f.trust(trust); await assert.rejects(f.controller.login('password'), MobilePlatformError); assert.equal(f.calls.length, 0); assert.equal(f.values.size, 0); }
  const f = fixture(); await assert.rejects(f.controller.login(''), MobilePlatformError); await f.controller.login('password');
  await assert.rejects(f.controller.login('password'), MobilePlatformError); assert.equal(f.calls.length, 2);
});
test('persisted record and JWT must match account, origin, install/key, mobile slot, sid/device and expiry', async () => {
  const f = fixture(); await f.controller.login('password'); const valid = f.record(); const identity = await f.keys.identity();
  for (const patch of [{ origin: 'https://other.test' }, { userId: '999' }, { installId: randomUUID() }, { keyThumbprint: challenge }, { platform: 'cli' },
    { deviceId: randomUUID() }, { sessionId: randomUUID() }, { generation: 'bad' }, { privateKey: 'secret' }, { accessExpiresAt: '2025-99-99T' }, { refreshToken: 'bad' }]) {
    assert.throws(() => validateMobileRecord({ ...valid, ...patch }, f.authority, identity), MobileVaultError);
  }
  const claims = JSON.parse(Buffer.from(valid.accessToken!.split('.')[1]!, 'base64url').toString());
  for (const patch of [{ sub: '999' }, { token_use: 'legacy' }, { platform_type: 'desktop' }, { cnf: { jkt: challenge } }, { exp: claims.exp + 1 }]) {
    assert.throws(() => validateMobileRecord({ ...valid, accessToken: jwt({ alg: 'ES256' }, { ...claims, ...patch }) }, f.authority, identity), MobileVaultError);
  }
  for (const phase of ['refreshing', 'login_pending', 'pending_takeover']) assert.throws(() => validateMobileRecord({ ...valid, phase }, f.authority, identity), MobileVaultError);
  assert.notEqual(mobileVaultScope({ ...f.authority, userId: '999' }), f.key); assert.notEqual(mobileVaultScope({ ...f.authority, origin: 'https://other.test' }), f.key);
});
test('corrupt/mismatched credentials fail closed without erasure and old account cannot inspect or clear them', async () => {
  const f = fixture(); f.values.set(f.key, '{private-corrupt-record'); await assert.rejects(f.controller.inspect(), MobileVaultError); assert.equal(f.values.size, 1);
  f.change({ ...f.authority, authScope: 'new-login' }); await assert.rejects(f.controller.forgetLocal()); assert.equal(f.values.size, 1);
  await f.make().forgetLocal(); assert.equal(f.values.size, 0);
});
test('access-unavailable refresh persists new refresh only, and cannot sign logout using a legacy token', async () => {
  const f = fixture(); await f.controller.login('password'); const previous = f.rawHandle();
  f.handle(async (path) => { if (!path.endsWith('/complete')) return previous(path); return { status: 200, body: JSON.stringify({ session_id: f.sid, refreshed: true,
    access_ready: false, token_type: null, access_token: null, access_expires_at: null, refresh_token: Buffer.alloc(32, 8).toString('base64url') }) }; });
  assert.equal((await f.controller.refresh()).state, 'access_unavailable'); await assert.rejects(f.controller.logout('password'), MobilePlatformError); assert.equal(f.calls.length, 4);
});
test('normal account Bearer rotation is independent of native refresh, but login rejects a changed Bearer', async () => {
  const f = fixture(); await f.controller.login('password'); f.change({ ...f.authority, accessToken: 'rotated-account-bearer' }); await f.controller.refresh();
  assert.equal(f.calls.slice(-2).every((c) => c.auth === null), true);
  const g = fixture(); const previous = g.rawHandle(); g.handle(async (path) => { const response = await previous(path); g.change({ ...g.authority, accessToken: 'rotated-account-bearer' }); return response; });
  await assert.rejects(g.controller.login('password')); assert.equal(g.calls.length, 1); assert.equal(g.values.has(g.key), false);
});
