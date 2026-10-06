import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { createNativeDpopSigner, nativeKeyThumbprint } from '../src/native-dpop';
import type { NativePublicKey } from '@dex/protocol/native-platform-session';

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const origin = 'https://app.example.test';
const token = 'e30.e30.c2ln';
async function fixture() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await subtle.exportKey('jwk', pair.publicKey) as NativePublicKey;
  return { pair, publicKey, sign: createNativeDpopSigner(pair.privateKey, publicKey, origin) };
}
test('DPoP signature binds method, URI, token hash and public key, with a fresh jti each time', async () => {
  const f = await fixture();
  const uri = `${origin}/api/agentflow/me/agent-state`;
  const first = await f.sign('GET', uri, token);
  const second = await f.sign('GET', uri, token);
  const [header, payload, signature] = first.split('.');
  const h = JSON.parse(Buffer.from(header, 'base64url').toString());
  const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(h.typ, 'dpop+jwt'); assert.equal(h.alg, 'ES256');
  assert.deepEqual(Object.keys(h.jwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(p.htm, 'GET'); assert.equal(p.htu, uri);
  assert.equal(p.ath, createHash('sha256').update(token).digest('base64url'));
  assert.notEqual(p.jti, JSON.parse(Buffer.from(second.split('.')[1], 'base64url').toString()).jti);
  assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.pair.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`)), true);
  assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.pair.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}x`)), false);
  assert.equal(first.includes(token), false);
  assert.equal(nativeKeyThumbprint(f.publicKey), createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: h.jwk.x, y: h.jwk.y })).digest('base64url'));
});
test('foreign origins, query, fragment, userinfo, invalid credentials and cancellation are rejected', async () => {
  const f = await fixture();
  for (const uri of ['http://app.example.test/api', 'https://other.test/api', `${origin}/api?cursor=1`, `${origin}/api#x`, 'https://user@app.example.test/api']) {
    await assert.rejects(f.sign('GET', uri, token), TypeError);
  }
  await assert.rejects(f.sign('GET', `${origin}/api`, 'private-secret'), TypeError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.sign('GET', `${origin}/api`, token, controller.signal), (e: unknown) => e instanceof Error && e.name === 'AbortError');
});
test('DPoP signer allows only exact canonical lifecycle write routes and methods', async () => {
  const f = await fixture();
  const created = await f.sign('POST', `${origin}/api/agentflow/agent-sessions`, token);
  const switched = await f.sign('PUT', `${origin}/api/agentflow/me/agent-state`, token);
  assert.equal(JSON.parse(Buffer.from(created.split('.')[1]!, 'base64url').toString()).htm, 'POST');
  assert.equal(JSON.parse(Buffer.from(switched.split('.')[1]!, 'base64url').toString()).htm, 'PUT');
  for (const [method, path] of [
    ['PUT', '/api/agentflow/agent-sessions'],
    ['POST', '/api/agentflow/me/agent-state'],
    ['PUT', '/api/agentflow/me/agent-state/'],
    ['POST', '/api/agentflow/agent-sessions/'],
    ['PUT', '/api/agentflow/me/agent-events'],
  ] as const) {
    await assert.rejects(f.sign(method, `${origin}${path}`, token), TypeError);
  }
});
test('extractable private keys are rejected by the DPoP supplier', async () => {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await subtle.exportKey('jwk', pair.publicKey) as NativePublicKey;
  assert.throws(() => createNativeDpopSigner(pair.privateKey, publicKey, origin), TypeError);
});

test('attachment signing admits only exact reservation, content and cancellation methods', async () => {
  const f = await fixture();
  const base = '/api/agentflow/agent-sessions/018f1240-0000-7000-8000-000000000001/attachments';
  const attachment = base + '/018f1240-0000-7000-8000-000000000002';
  for (const [method, path] of [['POST', base], ['PUT', attachment + '/content'], ['POST', attachment + '/cancel']] as const) {
    const jwt = await f.sign(method, origin + path, token);
    const [header, payload, signature] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    assert.equal(claims.htm, method); assert.equal(claims.htu, origin + path);
    assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.pair.publicKey,
      Buffer.from(signature!, 'base64url'), new TextEncoder().encode(`${header}.${payload}`)), true);
  }
  for (const [method, path] of [['PUT', base], ['POST', attachment + '/content'], ['PUT', attachment + '/cancel'],
    ['POST', base + '/'], ['PUT', attachment + '/content?x=1'], ['POST', attachment + '/cancel/extra'],
    ['PUT', attachment.toUpperCase() + '/content'], ['POST', base.replace('018f1240', 'not-a-uuid')]] as const) {
    await assert.rejects(f.sign(method, origin + path, token), TypeError);
  }
});
