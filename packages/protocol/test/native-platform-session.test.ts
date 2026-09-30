import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import {
  NativeAccountChanged, NativeDeviceKeyUnavailable, NativePlatformHttpError,
  NativePlatformProtocolError, NativePlatformSessionClient, NativePlatformTransportError,
  type NativeAccountCredential, type NativeDeviceProofPurpose, type NativePlatform,
  type NativePlatformSessionOptions, type NativePublicKey,
} from '../src/native-platform-session';
import { createNativeDeviceSigner } from '../src/native-device-proof';

const DEVICE = '018f1240-0000-7000-8000-000000000001';
const APPROVER = '018f1240-0000-7000-8000-000000000002';
const FLOW = '018f1240-0000-7000-8000-000000000003';
const SESSION = '018f1240-0000-7000-8000-000000000004';
const CHALLENGE = Buffer.alloc(32, 5).toString('base64url');
const REFRESH = Buffer.alloc(32, 6).toString('base64url');
const ROTATED = Buffer.alloc(32, 7).toString('base64url');
const PROOF = 'e30.e30.c2ln';
const NOW = '2026-09-30T00:00:00Z';
const LATER = '2026-09-30T00:10:00Z';
const KEY: NativePublicKey = { kty: 'EC', crv: 'P-256', x: CHALLENGE, y: CHALLENGE };
const BEGIN = { flow_id: FLOW, device_id: DEVICE, challenge: CHALLENGE, expires_in_seconds: 300 };
const ACCESS = { token_type: 'DPoP', access_token: 'e30.e30.c2ln', access_expires_at: LATER };
const EMPTY_ACCESS = { token_type: null, access_token: null, access_expires_at: null };
const ACTIVE = { session_id: SESSION, state: 'active', ...ACCESS, refresh_token: REFRESH };
const PENDING = { session_id: SESSION, state: 'pending_takeover', ...EMPTY_ACCESS, refresh_token: null };
function approval(platform: NativePlatform = 'cli') {
  return { request_id: FLOW, target_device_id: DEVICE, target_platform: platform, target_device_name: 'PC',
    approver_device_id: APPROVER, approver_platform: 'web', state: 'pending',
    requested_at: NOW, expires_at: LATER, confirmation_code: '012345' };
}
function fixture(responses: unknown[], platform: NativePlatform = 'cli') {
  let current: NativeAccountCredential | null = { authScope: 'account-A/login-1', accessToken: 'legacy.access.jwt' };
  const calls: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> | null }> = [];
  const proofs: Array<{ purpose: NativeDeviceProofPurpose; challenge: string }> = [];
  const options: NativePlatformSessionOptions = {
    origin: 'https://app.example.test', platform,
    account: { current: () => current },
    identity: { installId: 'native/install?123456', publicKey: { ...KEY }, signChallenge: async (purpose, challenge) => {
      proofs.push({ purpose, challenge }); return PROOF;
    } },
    fetch: (async (input, init = {}) => {
      calls.push({ url: new URL(String(input)), init, body: init.body ? JSON.parse(String(init.body)) : null });
      const value = responses.shift();
      return value instanceof Response ? value : Response.json(value);
    }) as typeof fetch,
  };
  return { options, calls, proofs, client: () => new NativePlatformSessionClient(options),
    change: (value: NativeAccountCredential | null) => { current = value; } };
}

for (const platform of ['desktop', 'mobile', 'cli', 'vscode'] as const) {
  test(`${platform}: pending enrollment, status, selected browser approval and native login`, async () => {
    const overview = { enrollment_state: 'existing_trust', trusted_devices: [{ device_id: APPROVER,
      platform: 'web', device_name: 'Approval PC', registered_at: NOW, last_seen_at: null, is_default_approver: true }],
    more_trusted_devices: false, admin_code_required: true };
    const f = fixture([
      null, { challenge: CHALLENGE, expires_in_seconds: 300 }, { device_id: DEVICE, state: 'pending' },
      overview, { flow_id: FLOW, device_challenge: CHALLENGE, expires_in_seconds: 300 }, approval(platform),
      { device_id: DEVICE, state: 'trusted' }, BEGIN, ACTIVE,
    ], platform);
    const client = f.client();
    assert.equal(await client.registrationStatus(), null);
    assert.deepEqual(await client.register(' PC '), { device_id: DEVICE, state: 'pending' });
    assert.deepEqual(await client.trustOverview(), overview);
    assert.deepEqual(await client.requestApproval(DEVICE, APPROVER), approval(platform));
    assert.equal((await client.registrationStatus())?.state, 'trusted');
    assert.deepEqual(await client.login(DEVICE, 'current-password'), ACTIVE);
    const base = `/api/auth/platform-devices/native/${platform}/registration`;
    assert.deepEqual(f.calls.map(({ url }) => url.pathname), [
      `${base}/status/native%2Finstall%3F123456`, `${base}/challenge`, `${base}/complete`,
      '/api/auth/platform-devices/trust-overview',
      `/api/me/devices/native/${platform}/${DEVICE}/approval-requests/begin`,
      `/api/me/devices/native/${platform}/${DEVICE}/approval-requests`,
      `${base}/status/native%2Finstall%3F123456`,
      '/api/auth/platform-sessions/native/login-key/begin', '/api/auth/platform-sessions/native/login-key/complete',
    ]);
    assert.deepEqual(f.calls[1].body, { install_id: 'native/install?123456', public_key_jwk: KEY });
    assert.deepEqual(f.calls[2].body, { challenge: CHALLENGE, proof_jwt: PROOF, device_name: 'PC' });
    assert.deepEqual(f.calls[4].body, { approver_device_id: APPROVER });
    assert.deepEqual(f.calls[5].body, { flow_id: FLOW, device_challenge: CHALLENGE, device_proof_jwt: PROOF });
    assert.deepEqual(f.proofs, ['register', 'approval_request', 'login'].map((purpose) => ({ purpose, challenge: CHALLENGE })));
    for (const { url, init, body } of f.calls) {
      assert.equal(url.origin, 'https://app.example.test');
      assert.equal(url.search, '');
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      assert.deepEqual(init.headers, { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: 'Bearer legacy.access.jwt' });
      assert.equal(url.href.includes('current-password'), false);
      assert.equal(body?.password !== undefined, url.pathname.endsWith('login-key/complete'));
    }
  });
}

test('constructor rejects HTTP, URL credentials/paths, browser platform, private JWK and invalid installs', () => {
  for (const origin of ['http://localhost:8000', 'https://host/api', 'https://host?x', 'https://host/#x', 'https://u:p@host']) {
    assert.throws(() => new NativePlatformSessionClient({ ...fixture([]).options, origin }), TypeError);
  }
  for (const patch of [{ platform: 'web' }, { identity: { ...fixture([]).options.identity, installId: 'short' } },
    { identity: { ...fixture([]).options.identity, publicKey: { ...KEY, d: REFRESH } } },
    { identity: { ...fixture([]).options.identity, publicKey: { ...KEY, x: `${CHALLENGE}=` } } }]) {
    assert.throws(() => new NativePlatformSessionClient({ ...fixture([]).options, ...patch } as NativePlatformSessionOptions), TypeError);
  }
});

test('invalid input and missing account credentials fail before network or signing', async () => {
  const f = fixture([]); const client = f.client();
  for (const run of [() => client.login('../target', 'password'), () => client.login(DEVICE, ''),
    () => client.register(''), () => client.register('line\nname'), () => client.register('\u202ehidden'),
    () => client.requestApproval(DEVICE, DEVICE), () => client.requestApproval(DEVICE, '../approver'),
    () => client.refresh(DEVICE, SESSION, `${REFRESH}=`)]) await assert.rejects(run(), TypeError);
  f.change(null); await assert.rejects(client.registrationStatus(), NativeAccountChanged);
  f.change({ authScope: 'A', accessToken: 'bad\r\nheader' }); await assert.rejects(client.register(), NativeAccountChanged);
  f.change({ authScope: 'A', accessToken: null }); await assert.rejects(client.login(DEVICE, 'p'), NativeAccountChanged);
  assert.equal(f.calls.length, 0); assert.equal(f.proofs.length, 0);
});

test('origin/platform/install/public key are captured without private data', async () => {
  const f = fixture([{ challenge: CHALLENGE, expires_in_seconds: 300 }, { device_id: DEVICE, state: 'pending' }]);
  const client = f.client();
  f.options.origin = 'https://other.test'; f.options.platform = 'desktop'; f.options.identity.installId = 'another-install-id';
  f.options.identity.publicKey.x = REFRESH;
  await client.register();
  assert.equal(f.calls[0].url.origin, 'https://app.example.test');
  assert.equal(f.calls[0].url.pathname.includes('/cli/'), true);
  assert.deepEqual(f.calls[0].body, { install_id: 'native/install?123456', public_key_jwk: KEY });
});

test('logout, same-account relogin and token rotation during signing stop completion', async () => {
  for (const next of [null, { authScope: 'account-A/login-2', accessToken: 'legacy.access.jwt' },
    { authScope: 'account-A/login-1', accessToken: 'rotated.access.jwt' }]) {
    const f = fixture([{ challenge: CHALLENGE, expires_in_seconds: 300 }]);
    f.options.identity.signChallenge = async () => { f.change(next); return PROOF; };
    await assert.rejects(f.client().register(), NativeAccountChanged);
    assert.equal(f.calls.length, 1);
  }
});

test('account switch during response body read discards old credentials', async () => {
  const f = fixture([BEGIN]);
  const original = f.options.fetch!;
  f.options.fetch = (async (...args) => {
    if (f.calls.length === 0) return original(...args);
    const response = Response.json(ACTIVE);
    response.json = async () => { f.change({ authScope: 'B', accessToken: 'other.account.jwt' }); return ACTIVE; };
    return response;
  }) as typeof fetch;
  await assert.rejects(f.client().login(DEVICE, 'password'), NativeAccountChanged);
});

test('bad challenges, flow IDs and changed device responses stop before signing', async () => {
  for (const broken of [{ ...BEGIN, challenge: 'not-a-challenge' }, { ...BEGIN, expires_in_seconds: 301 },
    { ...BEGIN, flow_id: 'not-uuid' }, { ...BEGIN, device_id: APPROVER }]) {
    const f = fixture([broken]);
    await assert.rejects(f.client().login(DEVICE, 'password'), NativePlatformProtocolError);
    assert.equal(f.calls.length, 1); assert.equal(f.proofs.length, 0);
  }
});

test('server cannot turn pending enrollment or a selected approval into trust/another device', async () => {
  const registered = fixture([{ challenge: CHALLENGE, expires_in_seconds: 300 }, { device_id: DEVICE, state: 'trusted' }]);
  await assert.rejects(registered.client().register(), NativePlatformProtocolError);
  for (const patch of [{ target_device_id: APPROVER }, { target_platform: 'web' }, { approver_device_id: DEVICE },
    { approver_platform: 'cli' }, { state: 'trusted' }, { confirmation_code: '12345' }, { expires_at: NOW }]) {
    const f = fixture([{ flow_id: FLOW, device_challenge: CHALLENGE, expires_in_seconds: 300 }, { ...approval(), ...patch }]);
    await assert.rejects(f.client().requestApproval(DEVICE, APPROVER), NativePlatformProtocolError);
  }
});

test('trust overview validates devices and preserves server-selected defaults without auto approving', async () => {
  const device = { device_id: APPROVER, platform: 'web', device_name: null, registered_at: NOW,
    last_seen_at: null, is_default_approver: false };
  for (const devices of [[device, device], [{ ...device, platform: 'unknown' }], [{ ...device, last_seen_at: 'bad' }]]) {
    const f = fixture([{ enrollment_state: 'existing_trust', trusted_devices: devices,
      more_trusted_devices: false, admin_code_required: true }]);
    await assert.rejects(f.client().trustOverview(), NativePlatformProtocolError);
  }
});

test('pending takeover has no credentials, active access signing failure retains only refresh', async () => {
  for (const result of [PENDING, { ...ACTIVE, ...EMPTY_ACCESS }]) {
    const f = fixture([BEGIN, result]);
    assert.deepEqual(await f.client().login(DEVICE, 'password'), result);
  }
  for (const result of [{ ...PENDING, ...ACCESS }, { ...PENDING, refresh_token: REFRESH },
    { ...ACTIVE, token_type: 'Bearer' }, { ...ACTIVE, access_expires_at: null }, { ...ACTIVE, refresh_token: null },
    { ...ACTIVE, state: 'pending_trust' }, { ...ACTIVE, refresh_token: `${REFRESH}=` }]) {
    const f = fixture([BEGIN, result]); await assert.rejects(f.client().login(DEVICE, 'password'), NativePlatformProtocolError);
  }
});

test('native refresh works without account Bearer and returns exactly one rotated credential', async () => {
  for (const ready of [true, false]) {
    const result = { session_id: SESSION, refreshed: true, access_ready: ready,
      ...(ready ? ACCESS : EMPTY_ACCESS), refresh_token: ROTATED };
    const f = fixture([BEGIN, result]); f.change({ authScope: 'native-session-A', accessToken: null });
    assert.deepEqual(await f.client().refresh(DEVICE, SESSION, REFRESH), result);
    assert.deepEqual(f.proofs, [{ purpose: 'native_refresh', challenge: CHALLENGE }]);
    assert.equal(f.calls.length, 2);
    for (const { init, url, body } of f.calls) {
      assert.equal((init.headers as Record<string, string>).Authorization, undefined);
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      assert.equal(url.search, ''); assert.equal(body?.refresh_token, REFRESH);
    }
  }
});

test('refresh rejects session mixup, unrotated credentials and inconsistent access state', async () => {
  const result = { session_id: SESSION, refreshed: true, access_ready: true, ...ACCESS, refresh_token: ROTATED };
  for (const patch of [{ session_id: DEVICE }, { refresh_token: REFRESH }, { refreshed: false }, { access_ready: false }]) {
    const f = fixture([BEGIN, { ...result, ...patch }]);
    await assert.rejects(f.client().refresh(DEVICE, SESSION, REFRESH), NativePlatformProtocolError);
    assert.equal(f.calls.length, 2);
  }
  const f = fixture([BEGIN]);
  f.options.identity.signChallenge = async () => { f.change(null); return PROOF; };
  await assert.rejects(f.client().refresh(DEVICE, SESSION, REFRESH), NativeAccountChanged);
  assert.equal(f.calls.length, 1);
});

test('HTTP failure and transport rejection never echo bodies or retry/fallback', async () => {
  for (const status of [401, 409, 429, 503]) {
    const f = fixture([BEGIN, new Response('password secret refresh-token', { status })]);
    await assert.rejects(f.client().login(DEVICE, 'secret'), (e: unknown) => {
      assert.ok(e instanceof NativePlatformHttpError); assert.equal(e.status, status);
      assert.equal(e.message.includes('secret'), false); assert.equal('body' in e, false); return true;
    });
    assert.equal(f.calls.length, 2);
  }
  const f = fixture([]); f.options.fetch = async () => { throw new Error('password secret'); };
  await assert.rejects(f.client().register(), (e: unknown) => e instanceof NativePlatformTransportError && !e.message.includes('secret'));
});

test('abort before start or while signing prevents completion; malformed signer output is scrubbed', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture([]); await assert.rejects(f.client().register(undefined, controller.signal), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  for (const mode of ['abort', 'malformed', 'failure']) {
    const f = fixture([{ challenge: CHALLENGE, expires_in_seconds: 300 }]);
    const controller = new AbortController();
    f.options.identity.signChallenge = async () => {
      if (mode === 'abort') controller.abort();
      if (mode === 'failure') throw new Error('private-key secret');
      return mode === 'malformed' ? 'private-key secret' : PROOF;
    };
    await assert.rejects(f.client().register(undefined, controller.signal), mode === 'abort' ? { name: 'AbortError' } : NativeDeviceKeyUnavailable);
    assert.equal(f.calls.length, 1);
  }
});

test('parallel mutations are rejected, then the ceremony guard is released after a failure', async () => {
  const f = fixture([]);
  let release!: (response: Response) => void;
  f.options.fetch = () => new Promise<Response>((resolve) => { release = resolve; });
  const client = f.client();
  const first = client.refresh(DEVICE, SESSION, REFRESH);
  await assert.rejects(client.refresh(DEVICE, SESSION, REFRESH), NativePlatformProtocolError);
  await assert.rejects(client.login(DEVICE, 'p'), NativePlatformProtocolError);
  release(new Response('', { status: 503 }));
  await assert.rejects(first, NativePlatformHttpError);
  const next = client.register(); release(new Response('', { status: 503 }));
  await assert.rejects(next, NativePlatformHttpError);
});

test('nonextractable WebCrypto key signs exact gateway ES256 proofs for every purpose', async () => {
  const subtle = webcrypto.subtle as unknown as SubtleCrypto;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  assert.equal(pair.privateKey.extractable, false);
  const signer = createNativeDeviceSigner(pair.privateKey, subtle);
  for (const purpose of ['register', 'approval_request', 'login', 'native_refresh'] as const) {
    const proof = await signer(purpose, CHALLENGE);
    const [header, payload, signature] = proof.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', typ: 'platform-device-proof+jwt' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.deepEqual(Object.keys(claims).sort(), ['challenge', 'iat', 'purpose']);
    assert.equal(claims.challenge, CHALLENGE); assert.equal(claims.purpose, purpose);
    assert.ok(Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 5);
    const bytes = Uint8Array.from(Buffer.from(signature, 'base64url'));
    assert.equal(bytes.length, 64);
    assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, bytes, new TextEncoder().encode(`${header}.${payload}`)), true);
  }
  await assert.rejects(subtle.exportKey('jwk', pair.privateKey));
  const extractable = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  assert.throws(() => createNativeDeviceSigner(extractable.privateKey, subtle), TypeError);
  assert.throws(() => createNativeDeviceSigner(pair.publicKey, subtle), TypeError);
  await assert.rejects(signer('device_approval' as NativeDeviceProofPurpose, CHALLENGE), TypeError);
  await assert.rejects(signer('register', `${CHALLENGE}=`), TypeError);
});
