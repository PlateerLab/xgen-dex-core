import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import { createMobileDeviceKeys, MobileDeviceKeyError, type MobileNativeContext, type MobileNativeKeyModule } from '../src/lib/native-device-key';

const origin = 'https://xgen.example.test'; const challenge = Buffer.alloc(32, 5).toString('base64url');
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const exported = pair.publicKey.export({ format: 'jwk' });
const metadata = { installId: randomUUID(), storage: 'secure-enclave', publicKey: { kty: 'EC', crv: 'P-256', x: exported.x!, y: exported.y! } };
function fixture() {
  let context: MobileNativeContext | null = { origin, userId: '7', authScope: 'first-login' };
  const calls: unknown[][] = [];
  const module: MobileNativeKeyModule = {
    async prepare(...args) { calls.push(args); return metadata; },
    async signChallenge(...args) {
      calls.push(args); assert.equal(args[2], metadata.installId);
      assert.equal(args[3], createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: metadata.publicKey.x, y: metadata.publicKey.y })).digest('base64url'));
      const input = `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'platform-device-proof+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify({ challenge: args[5], purpose: args[4], iat: Math.floor(Date.now() / 1000) })).toString('base64url')}`;
      return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    },
  };
  return { module, calls, current: () => context, change: (next: MobileNativeContext | null) => { context = next; }, keys: createMobileDeviceKeys(module, () => context) };
}
const code = (expected: MobileDeviceKeyError['code']) => (e: unknown) => e instanceof MobileDeviceKeyError && e.code === expected;
test('mobile signer binds native calls to normalized HTTPS/current user/install/key and exposes only public identity', async () => {
  const f = fixture(); const identity = await f.keys.identity(true);
  assert.deepEqual(Object.keys(identity).sort(), ['installId', 'publicKey', 'signChallenge', 'signDpop', 'storage']);
  for (const purpose of ['register', 'approval_request', 'login', 'native_refresh'] as const) {
    const proof = await identity.signChallenge(purpose, challenge); const parts = proof.split('.');
    assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url')), true);
    assert.deepEqual(f.calls.at(-1)?.slice(0, 3), [origin, '7', metadata.installId]);
  }
  assert.deepEqual(f.calls[0], [origin, '7', true]); assert.equal(JSON.stringify(identity).includes('privateKey'), false);
  assert.equal(Object.isFrozen(identity.publicKey), true);
});
test('Expo Go/no module, software storage and native failures never use a software key or leak raw errors', async () => {
  const f = fixture(); await assert.rejects(createMobileDeviceKeys(null, f.current).identity(true), code('unavailable'));
  for (const raw of [{ ...metadata, storage: 'software' }, { ...metadata, privateKey: 'private-secret' }, { ...metadata, publicKey: { ...metadata.publicKey, d: 'private-secret' } }]) {
    f.module.prepare = async () => raw; await assert.rejects(f.keys.identity(true), code('invalid'));
  }
  f.module.prepare = async () => { throw Object.assign(new Error('private-secret'), { code: 'mobile_key_locked' }); };
  await assert.rejects(f.keys.identity(true), (e: unknown) => code('locked')(e) && e instanceof Error && !e.message.includes('private-secret'));
});
test('invalid/HTTP/userinfo/query/path/signed-out scope fails before native key access', async () => {
  const f = fixture();
  for (const value of ['http://localhost', `${origin}/path`, `${origin}?q=1`, 'https://user:password@xgen.example.test']) {
    f.change({ origin: value, userId: '7', authScope: 'selected' }); await assert.rejects(f.keys.identity(true));
  }
  f.change({ origin, userId: '0', authScope: 'selected' }); await assert.rejects(f.keys.identity());
  f.change(null); await assert.rejects(f.keys.identity()); assert.equal(f.calls.length, 0);
});
test('lost/orphaned native keys are not silently recreated by create=true', async () => {
  const f = fixture(); f.module.prepare = async () => { throw Object.assign(new Error('native details'), { code: 'mobile_key_invalid' }); };
  await assert.rejects(f.keys.identity(true), code('invalid')); assert.equal(f.calls.length, 0);
});
test('account/logout/same-account relogin stops old native identities before signing', async () => {
  const f = fixture(); const identity = await f.keys.identity();
  for (const context of [{ origin, userId: '8', authScope: 'first-login' }, { origin, userId: '7', authScope: 'new-login' },
    { origin: 'https://other.test', userId: '7', authScope: 'first-login' }, null]) {
    f.change(context); await assert.rejects(identity.signChallenge('register', challenge), code('account_changed'));
  }
  assert.equal(f.calls.length, 1);
});
test('late preparation and signing results are discarded after account change or cancellation', async () => {
  const f = fixture(); let done!: (v: unknown) => void;
  f.module.prepare = () => new Promise((r) => { done = r; }); const pending = f.keys.identity();
  f.change({ origin, userId: '8', authScope: 'new-login' }); done(metadata); await assert.rejects(pending, code('account_changed'));
  f.module.prepare = async () => metadata; const controller = new AbortController(); const identity = await f.keys.identity(false, controller.signal);
  const original = fixture().module.signChallenge; f.module.signChallenge = (...args) => new Promise((r) => { done = r; void original(...args).then((proof) => { controller.abort(); r(proof); }); });
  await assert.rejects(identity.signChallenge('register', challenge), (e: unknown) => e instanceof Error && e.name === 'AbortError');
  const before = f.calls.length; await assert.rejects(identity.signChallenge('register', challenge)); assert.equal(f.calls.length, before);
});
test('malformed or mismatched native proof headers/claims/signature never leave the provider', async () => {
  const f = fixture(); const identity = await f.keys.identity();
  const header = { alg: 'ES256', typ: 'platform-device-proof+jwt' }; const claims = { challenge, purpose: 'register', iat: Math.floor(Date.now() / 1000) };
  const jwt = (h: object, c: object, signature = Buffer.alloc(64, 1).toString('base64url')) => `${Buffer.from(JSON.stringify(h)).toString('base64url')}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.${signature}`;
  for (const raw of [jwt({ ...header, alg: 'none' }, claims), jwt(header, { ...claims, purpose: 'login' }), jwt(header, { ...claims, challenge: Buffer.alloc(32, 6).toString('base64url') }),
    jwt(header, { ...claims, iat: 0 }), jwt(header, { ...claims, token: 'secret' }), jwt(header, claims, 'bad'), 'not-jwt']) {
    f.module.signChallenge = async () => raw; await assert.rejects(identity.signChallenge('register', challenge), code('invalid'));
  }
});
test('invalid purpose/challenge and a pre-aborted operation fail before invoking the native signer', async () => {
  const f = fixture(); const identity = await f.keys.identity();
  await assert.rejects(identity.signChallenge('register', 'bad'), code('invalid'));
  await assert.rejects(identity.signChallenge('unknown' as 'register', challenge), code('invalid'));
  const controller = new AbortController(); controller.abort(); await assert.rejects(identity.signChallenge('register', challenge, controller.signal));
  assert.equal(f.calls.length, 1);
});
test('native DPoP binds public hardware identity, method/resource/access hash with a real P-256 signature', async () => {
  const f = fixture(); const token = 'e30.e30.aaa'; const htu = `${origin}/api/me/platform-sessions/${randomUUID()}`;
  const turnHtu = `${origin}/api/agentflow/agent-sessions/018f1240-0000-7000-8000-000000000001/turns`;
  const stopHtu = `${origin}/api/agentflow/agent-sessions/018f1240-0000-7000-8000-000000000001/stop`;
  f.module.signDpop = async (...args) => {
    f.calls.push(args); const input = `${Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: metadata.publicKey })).toString('base64url')}.${Buffer.from(JSON.stringify({ jti: randomUUID(), htm: args[4], htu: args[5],
      ath: createHash('sha256').update(args[6]).digest('base64url'), iat: Math.floor(Date.now() / 1000) })).toString('base64url')}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const identity = await f.keys.identity();
  const signed = await Promise.all([
    identity.signDpop!('DELETE', htu, token),
    identity.signDpop!('POST', turnHtu, token),
    identity.signDpop!('POST', stopHtu, token),
  ]);
  const jtis = new Set<string>();
  for (const proof of signed) {
    const parts = proof.split('.');
    assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url')), true);
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { jti: string; htm: string; htu: string };
    jtis.add(claims.jti);
  }
  assert.equal(jtis.size, 3); assert.deepEqual(f.calls.at(-1)?.slice(0, 3), [origin, '7', metadata.installId]);
  for (const [method, uri, access] of [['POST', htu, token], ['GET', turnHtu, token], ['DELETE', `${htu}?a=1`, token],
    ['POST', `${turnHtu}?a=1`, token], ['POST', turnHtu.replace('/turns', '/snapshot'), token],
    ['POST', turnHtu.toUpperCase(), token], ['DELETE', htu.replace(origin, 'https://other.test'), token],
    ['DELETE', `${origin}/api/me/devices/${randomUUID()}`, token], ['GET', `${origin}/api/auth/platform-devices/trust-overview`, token], ['DELETE', htu, 'Bearer secret']] as const) {
    await assert.rejects(identity.signDpop!(method, uri, access));
  }
  assert.equal(f.calls.length, 4); f.change({ origin, userId: '7', authScope: 'new-login' }); await assert.rejects(identity.signDpop!('DELETE', htu, token), code('account_changed'));
});
test('DPoP cannot emit mismatched hash/JWK/claims or a stale native result', async () => {
  const f = fixture(); const token = 'e30.e30.aaa'; const htu = `${origin}/api/me/platform-sessions/${randomUUID()}`;
  const claims = { jti: randomUUID(), htm: 'DELETE', htu, ath: createHash('sha256').update(token).digest('base64url'), iat: Math.floor(Date.now() / 1000) };
  const build = (header: object, c: object) => `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.${Buffer.alloc(64, 3).toString('base64url')}`;
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: metadata.publicKey }; const identity = await f.keys.identity();
  for (const proof of [build(header, { ...claims, ath: challenge }), build(header, { ...claims, htm: 'GET' }), build(header, { ...claims, jti: 'bad' }),
    build(header, { ...claims, iat: 0 }), build({ ...header, jwk: { ...metadata.publicKey, d: 'private' } }, claims), build(header, { ...claims, token: 'secret' })]) {
    f.module.signDpop = async () => proof; await assert.rejects(identity.signDpop!('DELETE', htu, token), code('invalid'));
  }
  f.module.signDpop = async () => build(header, claims);
  await identity.signDpop!('DELETE', htu, token);
  await assert.rejects(identity.signDpop!('DELETE', htu, token), code('invalid'));
  let done!: (v: unknown) => void; f.module.signDpop = () => new Promise((r) => { done = r; }); const pending = identity.signDpop!('DELETE', htu, token);
  f.change(null); done(build(header, claims)); await assert.rejects(pending, code('account_changed'));
});
