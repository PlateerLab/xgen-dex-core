import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMobileEnrollmentFetch, type MobileEnrollmentHttpModule } from '../src/lib/native-enrollment-http';
const origin = 'https://xgen.example.test'; const path = '/api/auth/platform-devices/native/mobile/registration/challenge';
const init = (): RequestInit => ({ method: 'POST', body: '{}', headers: { Accept: 'application/json', Authorization: 'Bearer account-token', 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
function fixture() {
  const calls: unknown[][] = []; const cancelled: string[] = [];
  const module: MobileEnrollmentHttpModule = { newRequestId: randomUUID, async request(...args) { calls.push(args); return { status: 200, body: '{"ok":true}' }; }, cancelRequest(id) { cancelled.push(id); } };
  return { module, calls, cancelled, fetch: createMobileEnrollmentFetch(module, origin) };
}
test('only enrollment routes with explicit omit/error/no-store reach native TLS module; response exposes no raw headers', async () => {
  const f = fixture(); const r = await f.fetch(`${origin}${path}`, init()); assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(f.calls[0]?.slice(1), [origin, path, 'POST', 'account-token', '{}']); assert.equal(r.status, 200); assert.equal('headers' in r, false);
  const read = init(); read.method = 'GET'; delete read.body; delete (read.headers as Record<string, string>)['Content-Type'];
  await f.fetch(`${origin}/api/auth/platform-devices/trust-overview`, read);
  assert.equal(f.calls[1]?.at(-1), null);
});
test('HTTP, foreign origin, query, URL rewrites, Cookie/Origin/custom headers, method/body changes and no module fail before network', async () => {
  const f = fixture();
  for (const url of [`http://xgen.example.test${path}`, `https://other.test${path}`, `${origin}${path}?q=1`, `${origin}/api/auth/platform-sessions/native/login-key/begin`,
    `${origin}/api/../api/auth/platform-devices/native/mobile/registration/challenge`, `${origin}${path}#fragment`, `${origin}/api/auth/platform-devices/native/mobile/registration/%63hallenge`]) await assert.rejects(f.fetch(url, init()));
  for (const variant of [{ credentials: 'include' }, { redirect: 'follow' }, { cache: 'default' }, { method: 'DELETE' }, { body: '[]' }, { body: '{}'.repeat(20000) }] as RequestInit[]) await assert.rejects(f.fetch(`${origin}${path}`, { ...init(), ...variant }));
  for (const header of ['Cookie', 'Origin', 'X-User-Id']) { const request = init(); (request.headers as Record<string, string>)[header] = 'secret'; await assert.rejects(f.fetch(`${origin}${path}`, request)); }
  await assert.rejects(createMobileEnrollmentFetch(null, origin)(`${origin}${path}`, init())); assert.equal(f.calls.length, 0);
});
test('redirect, invalid native metadata and oversized UTF8 response are rejected; status failures do not retry or leak bodies', async () => {
  const f = fixture();
  for (const response of [{ status: 302, body: '{}' }, { status: 200, body: '{}', headers: { secret: 'token' } }, { status: 200, body: '가'.repeat(22000) }, { status: 200.5, body: '{}' }, { status: 0, body: '' }]) {
    f.module.request = async () => response; await assert.rejects(f.fetch(`${origin}${path}`, init()));
  }
  f.module.request = async () => ({ status: 401, body: '{"secret":"server-body"}' }); const r = await f.fetch(`${origin}${path}`, init()); assert.equal(r.ok, false);
  let calls = 0; f.module.request = async () => { calls++; throw new Error('private-native-error'); };
  await assert.rejects(f.fetch(`${origin}${path}`, init()), (e: unknown) => e instanceof Error && !e.message.includes('private')); assert.equal(calls, 1);
});
test('cancellation rejects promptly, cancels OS handle and discards a late native completion', async () => {
  const f = fixture(); let done!: (v: unknown) => void;
  f.module.request = () => new Promise((r) => { done = r; }); const controller = new AbortController(); const pending = f.fetch(`${origin}${path}`, { ...init(), signal: controller.signal });
  controller.abort(); await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === 'AbortError'); assert.equal(f.cancelled.length, 1);
  done({ status: 200, body: '{"late":true}' }); await new Promise((r) => setImmediate(r));
  const before = f.cancelled.length; await assert.rejects(f.fetch(`${origin}${path}`, { ...init(), signal: controller.signal })); assert.equal(f.cancelled.length, before);
});
test('duplicate active request IDs and malformed native IDs cannot start another call', async () => {
  const f = fixture(); f.module.newRequestId = () => 'not-an-id'; await assert.rejects(f.fetch(`${origin}${path}`, init())); assert.equal(f.calls.length, 0);
  const id = randomUUID(); f.module.newRequestId = () => id; let done!: (v: unknown) => void; f.module.request = () => new Promise((r) => { done = r; });
  const pending = f.fetch(`${origin}${path}`, init()); await assert.rejects(f.fetch(`${origin}${path}`, init())); done({ status: 200, body: '{}' }); await pending;
});
