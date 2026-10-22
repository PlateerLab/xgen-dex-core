import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XgenClient, type LoginResult } from '@dex/protocol';
import type { FetchLike } from '../src/client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const identity = { valid: true, user_id: 'alice', username: 'Alice' };
const loginResult: LoginResult = { accessToken: 'new-access', refreshToken: 'new-refresh', userId: 'alice', username: 'Alice', tokenType: 'bearer' };

test('logout retires memory before the request finishes, and a 401 never calls auth failure', async () => {
  const response = deferred<Response>();
  const requests: unknown[] = [];
  let failures = 0;
  const client = new XgenClient({
    baseUrl: 'https://old.example', accessToken: 'access', refreshToken: 'refresh',
    onAuthFailure: () => failures++,
    fetch: async (url, init) => {
      requests.push([new URL(url).pathname, JSON.parse(String(init?.body))]);
      if (url.endsWith('/logout')) return response.promise;
      return reply({ success: false }, 401);
    },
  });
  const logout = client.logout();
  assert.equal(client.getAccessTokenAfterRotation(), '');
  assert.equal(client.getRefreshToken(), undefined);
  assert.equal(client.user, null);
  assert.equal(await client.ensureFreshAuth('stale-persisted-refresh'), null);
  response.resolve(reply({ success: false }, 401));
  await logout;
  assert.equal(failures, 0);
  assert.deepEqual(requests, [
    ['/api/auth/logout', { token: 'access' }],
    ['/api/auth/refresh', { refresh_token: 'refresh' }],
  ]);
});

for (const accessToken of ['valid', 'expired', '']) {
  test(`gateway-compatible family revocation (${accessToken || 'refresh-only'}) never adopts its temporary token`, async () => {
    const requests: Array<[string, unknown]> = [];
    let revoked = false;
    let rotations = 0;
    const client = new XgenClient({
      baseUrl: 'https://example.test', accessToken, refreshToken: 'family-refresh',
      onTokensRotated: () => rotations++,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init?.body));
        requests.push([path, body]);
        if (path.endsWith('/refresh')) {
          assert.equal(body.refresh_token, 'family-refresh');
          return reply({ success: !revoked, access_token: revoked ? null : 'temporary-access' });
        }
        if (body.token === 'expired') return reply({ success: false }, 401);
        assert.ok(['valid', 'temporary-access'].includes(body.token));
        revoked = true;
        return reply({ success: true });
      },
    });
    await client.logout();
    assert.equal(revoked, true);
    assert.equal(rotations, 0);
    assert.equal(client.getAccessTokenAfterRotation(), '');
    assert.equal(client.getRefreshToken(), undefined);
    assert.deepEqual(requests.map(([path]) => path), accessToken === 'valid'
      ? ['/api/auth/logout']
      : [...(accessToken ? ['/api/auth/logout'] : []), '/api/auth/refresh', '/api/auth/logout']);
  });
}

for (const failure of ['offline', 'server-error'] as const) {
  test(`logout is best effort on ${failure} without minting another token`, async () => {
    let calls = 0;
    const client = new XgenClient({ baseUrl: 'https://example.test', accessToken: 'access', refreshToken: 'refresh', fetch: async () => {
      calls++;
      if (failure === 'offline') throw new TypeError('offline');
      return reply({}, 503);
    } });
    await client.logout();
    assert.equal(calls, 1);
    assert.equal(client.getAccessTokenAfterRotation(), '');
    assert.equal(client.getRefreshToken(), undefined);
  });
}

test('a refresh that finishes after logout cannot rotate, persist, or restore tokens', async () => {
  const refresh = deferred<Response>();
  let rotations = 0;
  const client = new XgenClient({ baseUrl: 'https://example.test', accessToken: 'old', refreshToken: 'refresh', onTokensRotated: () => rotations++,
    fetch: async (url) => url.endsWith('/refresh') ? refresh.promise : reply({ success: true }),
  });
  const pending = client.ensureFreshAuth();
  await client.logout();
  refresh.resolve(reply({ success: true, access_token: 'late' }));
  assert.equal(await pending, null);
  assert.equal(client.getAccessTokenAfterRotation(), '');
  assert.equal(client.getRefreshToken(), undefined);
  assert.equal(rotations, 0);
});

for (const stage of ['validate', 'refresh', 'refreshed-identity'] as const) {
  test(`restore finishing ${stage} after logout cannot install identity or continue fallback`, async () => {
    const late = deferred<Response>();
    const reached = deferred<void>();
    let validates = 0;
    let refreshes = 0;
    let rotations = 0;
    const client = new XgenClient({ baseUrl: 'https://example.test', onTokensRotated: () => rotations++, fetch: async (url) => {
      if (url.endsWith('/logout')) return reply({ success: true });
      if (url.endsWith('/refresh')) {
        refreshes++;
        if (stage === 'refresh') { reached.resolve(); return late.promise; }
        return reply({ success: true, access_token: 'fresh' });
      }
      validates++;
      if (stage === 'validate' || validates === 2) { reached.resolve(); return late.promise; }
      return reply({ valid: false }, 401);
    } });
    const restoring = client.restoreDetailed('old', 'refresh');
    await reached.promise;
    await client.logout();
    const rotationsAtLogout = rotations;
    late.resolve(stage === 'refresh' ? reply({ success: true, access_token: 'late' }) : reply({ ...identity, new_access_token: 'late' }));
    // Cancellation is not server rejection: hosts must preserve a newer session.
    assert.equal(await restoring, 'network');
    assert.equal(client.user, null);
    assert.equal(client.getAccessTokenAfterRotation(), '');
    assert.equal(rotations, rotationsAtLogout);
    assert.equal(refreshes, stage === 'validate' ? 0 : 1);
  });
}

test('late login is discarded and revoked on its original server after logout/rebind', async () => {
  const late = deferred<Response>();
  const reached = deferred<void>();
  const revocations: Array<[string, unknown]> = [];
  const client = new XgenClient({ baseUrl: 'https://old.example', fetch: async (url, init) => {
    if (url.endsWith('/login')) { reached.resolve(); return late.promise; }
    revocations.push([new URL(url).host, JSON.parse(String(init?.body))]);
    return reply({ success: true });
  } });
  const login = client.login('alice@example.com', 'password');
  const rejected = assert.rejects(login, { name: 'AbortError', message: 'Authentication superseded' });
  await reached.promise;
  await client.logout();
  client.setBaseUrl('https://new.example');
  late.resolve(reply({ success: true, access_token: 'late-issued', refresh_token: 'late-refresh' }));
  await rejected;
  assert.deepEqual(revocations, [['old.example', { token: 'late-issued' }]]);
  assert.equal(client.getAccessTokenAfterRotation(), '');
  assert.equal(client.user, null);
});

test('pending identity cannot overwrite a deliberate new login on the reused client', async () => {
  const oldIdentity = deferred<Response>();
  const revoking = deferred<Response>();
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/logout')) return revoking.promise;
    if (url.endsWith('/validate-token') && body.token === 'new-access') return oldIdentity.promise;
    return reply({ valid: true, user_id: 'bob', username: 'Bob' });
  };
  const client = new XgenClient({ baseUrl: 'https://example.test', fetch });
  const old = client.adoptLogin(loginResult);
  const rejected = assert.rejects(old, { name: 'AbortError', message: 'Authentication superseded' });
  const logout = client.logout();
  await client.adoptLogin({ ...loginResult, accessToken: 'bob-access', refreshToken: 'bob-refresh', userId: 'bob', username: 'Bob' });
  oldIdentity.resolve(reply(identity));
  revoking.resolve(reply({ success: true }));
  await Promise.all([logout, rejected]);
  assert.equal(client.getAccessTokenAfterRotation(), 'bob-access');
  assert.equal(client.getRefreshToken(), 'bob-refresh');
  assert.equal(client.user?.userId, 'bob');
});

test('normal refresh remains single-flight and repeated same-server binding does not cancel it', async () => {
  const response = deferred<Response>();
  let calls = 0;
  let rotations = 0;
  const client = new XgenClient({ baseUrl: 'https://example.test', refreshToken: 'refresh', onTokensRotated: () => rotations++, fetch: async () => { calls++; return response.promise; } });
  const first = client.ensureFreshAuth();
  client.setBaseUrl('https://example.test/');
  const second = client.ensureFreshAuth();
  response.resolve(reply({ success: true, access_token: 'fresh' }));
  assert.deepEqual(await Promise.all([first, second]), ['fresh', 'fresh']);
  assert.equal(calls, 1);
  assert.equal(rotations, 1);
});

test('a stalled logout response body cannot exceed the best-effort deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = deferred<void>();
  const client = new XgenClient({ baseUrl: 'https://example.test', accessToken: 'access', fetch: async () => new Response(new ReadableStream({
    pull() { reading.resolve(); return new Promise(() => {}); },
  })) });
  const logout = client.logout();
  await reading.promise;
  context.mock.timers.tick(8001);
  await logout;
  assert.equal(client.getAccessTokenAfterRotation(), '');
  assert.equal(client.user, null);
});

test('concurrent restore of the same pair shares validation and rotation instead of invalidating a valid session', async () => {
  const response = deferred<Response>();
  let validations = 0;
  let rotations = 0;
  const client = new XgenClient({ baseUrl: 'https://example.test', onTokensRotated: () => rotations++, fetch: async () => {
    validations++;
    return response.promise;
  } });
  const first = client.restoreDetailed('access', 'refresh');
  const second = client.restoreDetailed('access', 'refresh');
  response.resolve(reply({ ...identity, new_access_token: 'rotated' }));
  assert.deepEqual(await Promise.all([first, second]), ['valid', 'valid']);
  assert.equal(validations, 1);
  assert.equal(rotations, 1);
  assert.equal(client.getAccessTokenAfterRotation(), 'rotated');
});

test('a superseded restore preserves the new login and returns no server-rejection verdict', async () => {
  const oldIdentity = deferred<Response>();
  const client = new XgenClient({ baseUrl: 'https://example.test', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return body.token === 'old-access' ? oldIdentity.promise : reply(identity);
  } });
  const oldRestore = client.restoreDetailed('old-access', 'old-refresh');
  await client.adoptLogin(loginResult);
  oldIdentity.resolve(reply({ valid: false }, 401));
  assert.equal(await oldRestore, 'network');
  assert.equal(client.getAccessTokenAfterRotation(), loginResult.accessToken);
  assert.equal(client.getRefreshToken(), loginResult.refreshToken);
  assert.equal(client.user?.userId, 'alice');
});
