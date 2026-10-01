import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMobileSessionFetch, type MobileSessionHttpModule } from '../src/lib/native-session-http';
const origin = 'https://mobile.example.test'; const login = `${origin}/api/auth/platform-sessions/native/login-key/begin`;
const refresh = `${origin}/api/auth/platform-sessions/native/refresh/complete`; const logout = `${origin}/api/me/platform-sessions/${randomUUID()}`;
const init = (auth?: string, dpop?: string): RequestInit => ({ method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
  ...(auth ? { Authorization: auth } : {}), ...(dpop ? { DPoP: dpop } : {}) }, body: '{}', credentials: 'omit', redirect: 'error', cache: 'no-store' });
function fixture() { const calls: unknown[][] = []; const cancellations: string[] = []; const module: MobileSessionHttpModule = { newRequestId: randomUUID,
  async sessionRequest(...args) { calls.push(args); return { status: 204, body: '' }; }, cancelRequest(id) { cancellations.push(id); } };
  return { module, fetch: createMobileSessionFetch(module, origin), calls, cancellations }; }
test('session-only adapter sends Bearer login, no refresh auth and DPoP logout with fixed native arguments', async () => {
  const f = fixture(); await f.fetch(login, init('Bearer account')); await f.fetch(refresh, init()); await f.fetch(logout, { ...init('DPoP e30.e30.aaa', 'e30.e30.bbb'), method: 'DELETE' });
  assert.equal(f.calls[0]![4], 'Bearer account'); assert.equal(f.calls[1]![4], null); assert.equal(f.calls[1]![5], null); assert.equal(f.calls[2]![4], 'DPoP e30.e30.aaa');
});
test('foreign/enrollment/Canonical/queries/rewritten paths and wrong auth policies stop before the native call', async () => {
  const f = fixture(); for (const url of [login.replace(origin, 'https://other.test'), `${login}?x=1`, `${login}#hash`, `${origin}/api/auth/platform-devices/trust-overview`,
    `${origin}/api/agentflow/me/agent-state`, login.replace('/api/', '/x/../api/'), `${origin}/api/me/platform-sessions/not-uuid`]) await assert.rejects(f.fetch(url, init('Bearer account')));
  for (const [url, input] of [[login, init()], [login, init('Bearer account\n')], [login, init('DPoP e30.e30.aaa')], [refresh, init('Bearer account')], [refresh, init(undefined, 'e30.e30.aaa')],
    [logout, { ...init('Bearer account'), method: 'DELETE' }], [logout, { ...init('DPoP e30.e30.aaa'), method: 'DELETE' }],
    [logout, { ...init('DPoP e30.e30.aaa\n', 'e30.e30.aaa'), method: 'DELETE' }], [logout, { ...init('DPoP e30.e30.aaa', 'e30.e30.aaa\n'), method: 'DELETE' }]] as const) await assert.rejects(f.fetch(url, input));
  assert.equal(f.calls.length, 0);
});
test('arbitrary headers/body/fetch defaults and missing native module have no RN fetch fallback', async () => {
  const f = fixture(); const valid = init('Bearer account');
  for (const input of [{ ...valid, headers: { ...(valid.headers as object), Cookie: 'secret' } }, { ...valid, redirect: 'follow' }, { ...valid, credentials: 'include' },
    { ...valid, body: '[]' }, { ...valid, body: JSON.stringify({ text: 'a'.repeat(32768) }) }, { ...valid, method: 'GET' }]) await assert.rejects(f.fetch(login, input as RequestInit));
  await assert.rejects(createMobileSessionFetch(null, origin)(login, valid)); assert.equal(f.calls.length, 0);
});
test('abort cancels once and rejects promptly while late native completion is discarded', async () => {
  const f = fixture(); let done!: (v: unknown) => void; f.module.sessionRequest = () => new Promise((r) => { done = r; });
  const controller = new AbortController(); const pending = f.fetch(login, { ...init('Bearer account'), signal: controller.signal }); controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === 'AbortError'); assert.equal(f.cancellations.length, 1); done({ status: 200, body: '{}' });
});
test('native reservation reuse, redirects, malformed/oversized results and raw errors fail safely', async () => {
  const f = fixture(); for (const raw of [{ status: 302, body: '{}' }, { status: 200.5, body: '{}' }, { status: 200, body: 'a'.repeat(65537) },
    { status: 200, body: '{}', token: 'private' }]) { f.module.sessionRequest = async () => raw; await assert.rejects(f.fetch(login, init('Bearer account'))); }
  f.module.sessionRequest = async () => { throw new Error('secret-native-error'); }; await assert.rejects(f.fetch(login, init('Bearer account')), (e: unknown) => e instanceof Error && !e.message.includes('secret'));
  let done!: (v: unknown) => void; f.module.newRequestId = () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; f.module.sessionRequest = () => new Promise((r) => { done = r; });
  const pending = f.fetch(login, init('Bearer account')); await assert.rejects(f.fetch(login, init('Bearer account'))); done({ status: 204, body: '' }); await pending;
});
