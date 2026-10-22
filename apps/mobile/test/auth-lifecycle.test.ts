import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MobileAuthLifecycle, type MobileSession, type SavedCredentials } from '../src/lib/auth-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const session = (name: string): MobileSession => ({ serverUrl: `https://${name}.example`, accessToken: `${name}-access`, refreshToken: `${name}-refresh`, userId: name, username: name });
const credentials: SavedCredentials = { serverUrl: 'https://alice.example', email: 'alice', password: 'secret' };
interface FakeClient {
  session: MobileSession;
  failed(): void;
  rotated(access: string, refresh?: string): void;
  api: { restore(access: string, refresh?: string): Promise<boolean>; logout(): Promise<void> };
}

function harness() {
  const h = {
    saved: null as MobileSession | null,
    credentials: null as SavedCredentials | null,
    lastChat: 'old-chat' as string | null,
    active: null as FakeClient | null,
    built: [] as FakeClient[],
    revoked: [] as string[],
    writes: [] as Array<string | null>,
    credentialReads: 0,
    loginCalls: 0,
    sessionRead: async (): Promise<MobileSession | null> => h.saved,
    loginReply: async (): Promise<MobileSession> => session('alice'),
    restoreReply: async (): Promise<boolean> => true,
    writeReply: async (_s: MobileSession | null): Promise<void> => {},
    credentialWriteReply: async (_c: SavedCredentials | null): Promise<void> => {},
    revokeReply: async (): Promise<void> => {},
  };
  const auth = new MobileAuthLifecycle<FakeClient>({
    readSession: () => h.sessionRead(),
    readCredentials: async () => { h.credentialReads++; return h.credentials; },
    writeSession: async (s) => { h.writes.push(s?.accessToken ?? null); await h.writeReply(s); h.saved = s; },
    writeCredentials: async (c) => { await h.credentialWriteReply(c); h.credentials = c; },
    writeLastChat: async (v) => { h.lastChat = v; },
    login: async () => { h.loginCalls++; return h.loginReply(); },
    build: (s, failed, rotated) => {
      const client: FakeClient = { session: s, failed, rotated, api: {
        restore: () => h.restoreReply(),
        logout: async () => { h.revoked.push(s.accessToken); await h.revokeReply(); },
      } };
      h.built.push(client);
      return client;
    },
    changed: (c) => { h.active = c; },
    log: () => {},
  });
  return { h, auth };
}

test('login stores the selected remember policy; logout immediately retires the client and revokes it', async () => {
  const { h, auth } = harness();
  await auth.login(credentials.serverUrl, credentials.email, credentials.password, true);
  assert.equal(h.active?.session.userId, 'alice');
  assert.deepEqual(h.credentials, credentials);
  const old = h.active!;
  const revoke = deferred<void>();
  h.revokeReply = () => revoke.promise;
  const loggingOut = auth.logout();
  assert.equal(h.active, null);
  assert.equal(auth.owns(old), false);
  assert.deepEqual(h.revoked, ['alice-access']);
  revoke.resolve();
  await loggingOut;
  assert.equal(h.saved, null);
  assert.equal(h.credentials, null);
  assert.equal(h.lastChat, null);
  h.loginReply = async () => session('bob');
  await auth.login('https://bob.example', 'bob', 'password', false);
  assert.equal((h.active as FakeClient | null)?.session.userId, 'bob');
  assert.equal(h.credentials, null);
});

test('logout drains an already running rotation write before deletion; retired callbacks cannot persist again', async () => {
  const { h, auth } = harness();
  await auth.login(credentials.serverUrl, 'alice', 'secret', true);
  const old = h.active!;
  const pending = deferred<void>();
  const reached = deferred<void>();
  h.writeReply = async (s) => { if (s?.accessToken === 'rotated') { reached.resolve(); await pending.promise; } };
  old.rotated('rotated', 'rotated-refresh');
  await reached.promise;
  const logout = auth.logout();
  old.rotated('too-late', 'stale-refresh');
  old.failed();
  pending.resolve();
  await logout;
  assert.equal(h.saved, null);
  assert.equal(h.credentials, null);
  assert.deepEqual(h.writes, [null, 'alice-access', 'rotated', null]);
  assert.deepEqual(h.revoked, ['rotated']);
});

test('logout clears credentials and last chat even if session storage and server revocation fail', async () => {
  const { h, auth } = harness();
  await auth.login(credentials.serverUrl, 'alice', 'secret', true);
  h.writeReply = async () => { throw new Error('storage unavailable'); };
  h.revokeReply = async () => { throw new Error('offline'); };
  await auth.logout();
  assert.equal(h.active, null);
  assert.equal(h.credentials, null);
  assert.equal(h.lastChat, null);
  assert.equal(h.revoked.length, 1);
});

test('late storage bootstrap cannot construct a client or start credential fallback after logout', async () => {
  const { h, auth } = harness();
  const read = deferred<MobileSession | null>();
  const reached = deferred<void>();
  h.sessionRead = () => { reached.resolve(); return read.promise; };
  const boot = auth.bootstrap();
  await reached.promise;
  await auth.logout();
  read.resolve(session('alice'));
  await boot;
  assert.equal(h.built.length, 0);
  assert.equal(h.credentialReads, 0);
  assert.equal(h.active, null);
});

for (const valid of [true, false]) {
  test(`late restore (${valid}) cannot reinstall a client or start fallback after logout`, async () => {
    const { h, auth } = harness();
    h.saved = session('alice');
    h.credentials = credentials;
    const restore = deferred<boolean>();
    const reached = deferred<void>();
    h.restoreReply = () => { reached.resolve(); return restore.promise; };
    const boot = auth.bootstrap();
    await reached.promise;
    const candidate = h.built[0];
    await auth.logout();
    candidate.rotated('late-restore');
    restore.resolve(valid);
    await boot;
    assert.equal(h.active, null);
    assert.equal(h.saved, null);
    assert.equal(h.credentialReads, 0);
    assert.equal(h.loginCalls, 0);
    assert.deepEqual(h.revoked, ['alice-access']);
  });
}

test('successful restore keeps rotation persistence and does not retry credentials', async () => {
  const { h, auth } = harness();
  h.saved = session('alice');
  h.restoreReply = async () => { h.built[0].rotated('restored'); return true; };
  await auth.bootstrap();
  await auth.saveLastChat('chat');
  assert.equal(h.active?.session.accessToken, 'restored');
  assert.equal(h.saved?.accessToken, 'restored');
  assert.equal(h.lastChat, 'chat');
  assert.equal(h.credentialReads, 0);
});

test('invalid restore follows saved-credential login and preserves automatic login', async () => {
  const { h, auth } = harness();
  h.saved = session('expired');
  h.credentials = credentials;
  h.restoreReply = async () => false;
  await auth.bootstrap();
  assert.equal(h.active?.session.userId, 'alice');
  assert.equal(h.saved?.accessToken, 'alice-access');
  assert.deepEqual(h.credentials, credentials);
  assert.deepEqual(h.revoked, ['expired-access']);
});

for (const automatic of [true, false]) {
  test(`${automatic ? 'automatic' : 'manual'} login succeeding after logout revokes its newly issued pair without storing it`, async () => {
    const { h, auth } = harness();
    const issued = deferred<MobileSession>();
    const reached = deferred<void>();
    h.credentials = credentials;
    h.loginReply = () => { reached.resolve(); return issued.promise; };
    const login = automatic ? auth.bootstrap() : auth.login(credentials.serverUrl, 'alice', 'secret', true);
    await reached.promise;
    await auth.logout();
    issued.resolve(session('late'));
    await login;
    assert.deepEqual(h.revoked, ['late-access']);
    assert.equal(h.active, null);
    assert.equal(h.saved, null);
    assert.equal(h.credentials, null);
    assert.ok(!h.writes.includes('late-access'));
  });
}

test('old login completion and old-account callbacks cannot overwrite a newer account', async () => {
  const { h, auth } = harness();
  await auth.login(credentials.serverUrl, 'alice', 'secret', true);
  const alice = h.active!;
  const issued = deferred<MobileSession>();
  const reached = deferred<void>();
  h.loginReply = () => { reached.resolve(); return issued.promise; };
  const obsolete = auth.login('https://obsolete.example', 'obsolete', 'secret', true);
  await reached.promise;
  h.loginReply = async () => session('bob');
  await auth.login('https://bob.example', 'bob', 'secret', true);
  alice.rotated('alice-late', 'alice-refresh');
  alice.failed();
  issued.resolve(session('obsolete'));
  await obsolete;
  assert.equal(h.active?.session.userId, 'bob');
  assert.equal(h.saved?.accessToken, 'bob-access');
  assert.equal(h.credentials?.email, 'bob');
  assert.deepEqual(h.revoked, ['alice-access', 'obsolete-access']);
});

test('an in-flight old credential write is cleared before a new login persists its own policy', async () => {
  const { h, auth } = harness();
  const pending = deferred<void>();
  const reached = deferred<void>();
  h.credentialWriteReply = async (c) => { if (c?.email === 'alice') { reached.resolve(); await pending.promise; } };
  const oldLogin = auth.login(credentials.serverUrl, 'alice', 'secret', true);
  await reached.promise;
  const logout = auth.logout();
  h.loginReply = async () => session('bob');
  const newLogin = auth.login('https://bob.example', 'bob', 'secret', false);
  pending.resolve();
  await Promise.all([oldLogin, logout, newLogin]);
  assert.equal(h.active?.session.userId, 'bob');
  assert.equal(h.saved?.accessToken, 'bob-access');
  assert.equal(h.credentials, null);
});
