import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeDeviceKeyStore, NativeCliSession } from '@dex/engine';
import { nativeKeyThumbprint } from '@dex/engine/native-dpop';
import { DesktopNativeSessions, isNativeSessionSender } from '../src/main/native-session';
import type { DesktopNativeNotice, DesktopNativeReply } from '../src/native-session-types';

const origin = 'https://app.example.test'; const device = '018f1240-0000-7000-8000-000000000001'; const sid = '018f1240-0000-7000-8000-000000000002';
const challenge = Buffer.alloc(32, 5).toString('base64url');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-native-')); const values = new Map<string, string>();
  const keys = new NativeDeviceKeyStore({ env: {}, lockDirectory: dir, keychain: async () => ({
    getPassword: async (s, n) => values.get(`${s}:${n}`) ?? null, setPassword: async (s, n, v) => { values.set(`${s}:${n}`, v); }, deletePassword: async (s, n) => values.delete(`${s}:${n}`),
  }) });
  const notices: DesktopNativeNotice[] = []; const replies: DesktopNativeReply[] = []; const calls: string[] = []; const secrets = ['private-password', 'e30.e30.c2ln'];
  let current = { origin, userId: '7' as string | null }; let account = '7'; let registered = false; let trusted = false; let publicKey: any; let count = 0;
  let custom: ((path: string, init: RequestInit) => Promise<Response> | undefined) | undefined;
  const fetchImpl = (async (input, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname; calls.push(path); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    const intercepted = await custom?.(path, init); if (intercepted) return intercepted;
    const body = JSON.parse(String(init.body ?? '{}'));
    if (path === '/api/auth/login') return Response.json({ success: true, user_id: account, access_token: secrets[1] });
    if (path === '/api/auth/logout') return Response.json({ success: true });
    if (path.includes('/registration/status/')) { assert.ok(path.includes('/native/desktop/')); return Response.json(registered ? { device_id: device, state: trusted ? 'trusted' : 'pending' } : null); }
    if (path.endsWith('/registration/challenge')) { publicKey = body.public_key_jwk; return Response.json({ challenge, expires_in_seconds: 300 }); }
    if (path.endsWith('/registration/complete')) { registered = true; return Response.json({ device_id: device, state: 'pending' }); }
    if (path.endsWith('/begin')) return Response.json({ flow_id: sid, device_id: device, challenge, expires_in_seconds: 300 });
    if (path.endsWith('/complete')) {
      const exp = Math.floor(Date.now() / 1000) + 600; const refresh = Buffer.alloc(32, ++count).toString('base64url');
      const access = `e30.${Buffer.from(JSON.stringify({ sub: account, sid, device_id: device, platform_type: 'desktop', token_use: 'platform_access', exp, cnf: { jkt: nativeKeyThumbprint(publicKey) } })).toString('base64url')}.c2ln`;
      secrets.push(refresh, access);
      return Response.json({ session_id: sid, ...(path.includes('/refresh/') ? { refreshed: true, access_ready: true } : { state: 'active' }), token_type: 'DPoP', access_token: access, refresh_token: refresh, access_expires_at: new Date(exp * 1000).toISOString() });
    }
    if (path.endsWith('/agent-state')) return Response.json({ active_agent_session_id: null, version: 0, event_id: null });
    if (path.endsWith('/agent-events')) return Response.json({ events: [], next_cursor: 0, snapshot_version: 0, has_more: false });
    if (init.method === 'DELETE') { assert.ok((init.headers as any).DPoP); return new Response(null, { status: 204 }); }
    assert.fail('Unexpected native fixture request');
  }) as typeof fetch;
  const host = new DesktopNativeSessions({ current: () => current, keys, fetch: fetchImpl, notify: (n) => notices.push(n) });
  const request = async (method: string, params: Record<string, unknown> = {}) => { const r = await host.request(method, params); replies.push(r); return r; };
  const value = async (method: string, params: Record<string, unknown> = {}) => { const r = await request(method, params); assert.ok(r.ok); return r.value as any; };
  const register = () => value('device', { action: 'register', email: 'a', password: secrets[0] });
  const login = async () => { await register(); trusted = true; return value('session', { action: 'login', email: 'a', password: secrets[0] }); };
  return { host, keys, values, notices, replies, calls, secrets, request, value, register, login,
    change: (context: typeof current) => { current = context; }, account: (id: string) => { account = id; }, custom: (f: typeof custom) => { custom = f; },
    cleanup: async () => { host.reset(); await rm(dir, { recursive: true, force: true }); } };
}
test('only the designated main top frame can enter the native IPC credential boundary', () => {
  const url = 'file:///application/renderer/index.html'; const main = { mainFrame: { url } };
  assert.equal(isNativeSessionSender(main, main.mainFrame, main, url), true);
  for (const [sender, frame, owner] of [[{}, main.mainFrame, main], [main, {}, main], [main, null, main], [main, main.mainFrame, null]]) assert.equal(isNativeSessionSender(sender, frame, owner as typeof main | null, url), false);
  main.mainFrame.url = `${url}#settings`; assert.equal(isNativeSessionSender(main, main.mainFrame, main, url), true);
  for (const outside of ['https://other.test/index.html', 'about:blank', 'file:///application/renderer/overlay.html', `${url}?override=1`]) {
    main.mainFrame.url = outside; assert.equal(isNativeSessionSender(main, main.mainFrame, main, url), false);
  }
});
test('Desktop rejects renderer account/origin/platform overrides, signed-out and HTTP contexts before network/key access', async () => {
  const f = await fixture();
  try {
    for (const extra of [{ user_id: '8' }, { profile: 'cli' }, { platform: 'cli' }, { origin: 'https://other.test' }, { access_token: 'private' }]) assert.equal((await f.request('session', { action: 'status', ...extra })).ok, false);
    f.change({ origin, userId: null }); assert.equal((await f.request('session', { action: 'status' })).ok, false);
    f.change({ origin: 'http://localhost', userId: '7' }); assert.equal((await f.request('session', { action: 'status' })).ok, false);
    assert.equal(f.calls.length, 0); assert.equal(f.values.size, 0);
  } finally { await f.cleanup(); }
});
test('another valid password account is rejected before registering any key and its temporary context is revoked', async () => {
  const f = await fixture();
  try {
    f.account('8'); const r = await f.request('device', { action: 'register', email: 'other', password: f.secrets[0] });
    assert.equal(r.ok, false); assert.equal(f.values.size, 0); assert.deepEqual(f.calls, ['/api/auth/login', '/api/auth/logout']);
  } finally { await f.cleanup(); }
});
test('Desktop owns isolated OS-keychain scopes and exposes no credentials through public IPC replies', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.login()).platform_type, 'desktop');
    await assert.rejects(new NativeCliSession(origin, f.keys).status('7'));
    await f.value('session', { action: 'refresh' });
    assert.equal((await f.value('session', { action: 'logout', password: f.secrets[0] })).result.state, 'signed_out');
    assert.equal(f.values.size, 1);
    for (const secret of [...f.secrets, 'privateKeyPkcs8', 'access_token', 'refresh_token']) assert.equal(JSON.stringify([f.replies, f.notices]).includes(secret), false);
  } finally { await f.cleanup(); }
});
test('Desktop binds conversation reads and polling to the main-process account scope', async () => {
  const f = await fixture();
  try {
    await f.login();
    assert.equal((await f.request('conversation', { user_id: '8' })).ok, false);
    const read = await f.value('conversation');
    assert.equal(read.view, 'conversation'); assert.deepEqual(read.conversation, { snapshot: null, messages: [], omittedMessages: 0 });
    const watched = await f.value('watch-conversation'); assert.equal(watched.view, 'conversation');
    for (let i = 0; i < 40 && !f.notices.some((n) => n.type === 'update' && 'view' in n.value
      && n.value.watch_id === watched.watch_id && n.value.update.type === 'conversation'); i++) await new Promise((r) => setTimeout(r, 5));
    const notice = f.notices.find((n) => n.type === 'update' && 'view' in n.value
      && n.value.watch_id === watched.watch_id && n.value.update.type === 'conversation');
    assert.ok(notice && notice.type === 'update' && 'view' in notice.value); assert.equal(notice.value.view, 'conversation');
    assert.equal(JSON.stringify([read, notice]).includes('authScope'), false);
    await f.value('unwatch', { watch_id: watched.watch_id });
    const live = await f.value('watch-live'); assert.equal(live.view, 'conversation');
    for (let i = 0; i < 40 && !f.notices.some((n) => n.type === 'update' && 'view' in n.value
      && n.value.watch_id === live.watch_id && n.value.update.type === 'conversation'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(f.notices.some((n) => n.type === 'update' && 'view' in n.value
      && n.value.watch_id === live.watch_id && n.value.update.type === 'conversation'));
    await f.value('unwatch', { watch_id: live.watch_id });
  } finally { await f.cleanup(); }
});
test('account reset aborts an active read and suppresses old-scope notifications and successful replies', async () => {
  const f = await fixture(); let start!: (signal: AbortSignal) => void; const ready = new Promise<AbortSignal>((r) => { start = r; });
  try {
    await f.login(); f.custom((path, init) => path.endsWith('/agent-state') ? new Promise((_resolve, reject) => {
      start(init.signal!); init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }) : undefined);
    await f.value('watch'); const signal = await ready;
    const before = f.notices.length; f.change({ origin, userId: '8' }); f.host.reset(); assert.equal(signal.aborted, true);
    await new Promise((r) => setImmediate(r)); assert.equal(f.notices.slice(before).some((n) => n.type === 'update'), false);
    assert.equal(f.notices.at(-1)!.type, 'cleared');
  } finally { await f.cleanup(); }
});
test('cancelling rotation preserves a token-free journal and local recovery declares no server revoke', async () => {
  const f = await fixture(); let start!: (signal: AbortSignal) => void; const ready = new Promise<AbortSignal>((r) => { start = r; });
  try {
    await f.login(); f.custom((path, init) => path.endsWith('/refresh/begin') ? new Promise((_resolve, reject) => {
      start(init.signal!); init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }) : undefined);
    const rotating = f.request('session', { action: 'refresh' }); const signal = await ready;
    await f.request('cancel'); assert.equal(signal.aborted, true); assert.equal((await rotating).ok, false);
    assert.equal((await f.value('session', { action: 'status' })).result.state, 'refreshing');
    const count = f.calls.length; assert.equal((await f.request('watch')).ok, false); assert.equal(f.calls.length, count);
    assert.equal((await f.value('session', { action: 'forget-local' })).server_revoked, false); assert.equal(f.calls.length, count);
  } finally { await f.cleanup(); }
});
