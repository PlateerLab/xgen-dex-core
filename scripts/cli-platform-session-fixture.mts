/** Opt-in HTTPS protocol fixture, not an ACTIVE Gateway or deployment test. Uses disposable OS-keychain slots. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeDeviceKeyStore } from '../packages/engine/src/native-device-key-store';
import { nativeKeyThumbprint } from '../packages/engine/src/native-dpop';

const directory = mkdtempSync(join(tmpdir(), 'dex-cli-session-fixture-'));
const certificates = resolve('../xgen-infra/compose/full-stack/.local-certs');
const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
const password = randomBytes(32).toString('base64url');
const email = `fixture-${randomUUID()}@example.invalid`;
const userId = String(randomInt(1_000_000_000, 2_000_000_000));
const deviceId = randomUUID();
const signingSecret = randomBytes(32);
const keys = new NativeDeviceKeyStore();
const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const contexts = new Set<string>();
const secrets = new Set<string>([password]);
const flows = new Map<string, { challenge: string; purpose: string }>();
const seenProofs = new Set<string>();
let publicKey: JsonWebKey;
let origin = '';
let sid: string | null = null;
let refresh: string | null = null;
let loseCompletion = false;
let requests = 0;
let errors = 0;
let keyCreated = false;
const server = createServer({ cert: readFileSync(join(certificates, 'localhost.pem')), key: readFileSync(join(certificates, 'localhost-key.pem')) }, (req, res) => {
  void (async () => {
    requests++;
    assert.equal(req.headers.origin, undefined); assert.equal(req.headers.cookie, undefined);
    const path = req.url!; const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const reply = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (path === '/api/auth/login') {
      assert.equal(body.email, email); assert.equal(body.password, createHash('sha256').update(password).digest('hex'));
      const token = `e30.e30.${randomBytes(32).toString('base64url')}`; contexts.add(token); secrets.add(token);
      reply({ success: true, user_id: userId, access_token: token }); return;
    }
    if (path === '/api/auth/logout') { assert.equal(contexts.delete(body.token), true); reply({ success: true }); return; }
    const account = req.headers.authorization?.replace(/^Bearer /, '');
    if (path.includes('/registration/status/')) { assert.ok(account && contexts.has(account)); reply({ device_id: deviceId, state: 'trusted' }); return; }
    if (path.endsWith('/begin')) {
      const isRefresh = path.includes('/native/refresh/');
      if (isRefresh) { assert.equal(req.headers.authorization, undefined); assert.equal(body.refresh_token, refresh); }
      else assert.ok(account && contexts.has(account));
      assert.equal(body.device_id, deviceId);
      const flow = randomUUID(); const challenge = randomBytes(32).toString('base64url');
      flows.set(flow, { challenge, purpose: isRefresh ? 'native_refresh' : 'login' });
      reply({ flow_id: flow, device_id: deviceId, challenge, expires_in_seconds: 300 }); return;
    }
    if (path.endsWith('/complete')) {
      const isRefresh = path.includes('/native/refresh/');
      if (isRefresh) { assert.equal(req.headers.authorization, undefined); assert.equal(body.refresh_token, refresh); }
      else { assert.ok(account && contexts.has(account)); assert.equal(body.password, password); }
      const flow = flows.get(body.flow_id)!; assert.ok(flow); flows.delete(body.flow_id);
      assert.equal(body.device_id, deviceId); assert.equal(body.challenge, flow.challenge);
      const [h, p, s] = body.proof_jwt.split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      assert.equal(claims.purpose, flow.purpose); assert.equal(claims.challenge, flow.challenge);
      const key = await subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`)), true);
      sid ??= randomUUID(); refresh = randomBytes(32).toString('base64url');
      secrets.add(refresh);
      if (isRefresh && loseCompletion) { loseCompletion = false; req.socket.destroy(); return; }
      const exp = Math.floor(Date.now() / 1000) + 600;
      const input = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'platform-access+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify({
        sub: userId, sid, device_id: deviceId, platform_type: 'cli', token_use: 'platform_access', exp,
        cnf: { jkt: nativeKeyThumbprint(publicKey as any) } })).toString('base64url')}`;
      const access = `${input}.${createHmac('sha256', signingSecret).update(input).digest('base64url')}`;
      secrets.add(access);
      reply({ session_id: sid, ...(isRefresh ? { refreshed: true, access_ready: true } : { state: 'active' }),
        token_type: 'DPoP', access_token: access, access_expires_at: new Date(exp * 1000 + 123).toISOString(), refresh_token: refresh }); return;
    }
    assert.ok(req.headers.authorization?.startsWith('DPoP '));
    const access = req.headers.authorization!.slice(5); const [ah, ap, signature] = access.split('.');
    assert.equal(signature, createHmac('sha256', signingSecret).update(`${ah}.${ap}`).digest('base64url'));
    const accessClaims = JSON.parse(Buffer.from(ap, 'base64url').toString()); assert.equal(accessClaims.sid, sid);
    const [h, p, s] = String(req.headers.dpop).split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()); const proof = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.equal(header.typ, 'dpop+jwt'); assert.equal(header.alg, 'ES256');
    assert.equal(nativeKeyThumbprint(header.jwk), nativeKeyThumbprint(publicKey as any));
    assert.equal(proof.htm, req.method); assert.equal(proof.htu, `${origin}${path}`);
    assert.equal(proof.ath, createHash('sha256').update(access).digest('base64url')); assert.equal(seenProofs.has(proof.jti), false); seenProofs.add(proof.jti);
    const key = await subtle.importKey('jwk', header.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`)), true);
    if (path === '/api/agentflow/me/agent-state') { reply({ active_agent_session_id: null, version: 0, event_id: null }); return; }
    assert.equal(path, `/api/me/platform-sessions/${sid}`); assert.equal(req.method, 'DELETE'); assert.equal(body.password, password);
    sid = null; refresh = null; res.writeHead(204); res.end();
  })().catch(() => { errors++; res.writeHead(500); res.end(); });
});
async function cli(action: string, expectedExit = 0) {
  const secret = action === 'login' || action === 'logout';
  const args = ['apps/cli/dist/cli.js', 'session', action, '--json',
    ...(action === 'login' ? ['--email', email] : ['--user-id', userId]), ...(secret ? ['--password-stdin'] : [])];
  return new Promise<any>((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, DEX_CLI_HOME: directory, NODE_EXTRA_CA_CERTS: join(caRoot, 'rootCA.pem') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => reject(new Error('Fixture CLI failed to start')));
    child.on('close', (code) => {
      try {
        assert.equal(code, expectedExit);
        for (const forbidden of [...secrets, 'privateKeyPkcs8', 'accessToken', 'refreshToken']) {
          assert.equal(output.includes(forbidden), false); assert.equal(stderr.includes(forbidden), false);
        }
        resolveResult(expectedExit ? null : JSON.parse(output).result);
      } catch { reject(new Error(`Fixture CLI ${action} validation failed; output withheld`)); }
    });
    child.stdin.end(secret ? password : '');
  });
}
try {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `https://localhost:${address.port}`;
  const scope = { origin, platform: 'cli' as const, userId };
  keyCreated = true;
  await keys.withIdentity(scope, true, async (identity) => { publicKey = identity.publicKey; });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ version: 1, currentProfile: 'fixture', profiles: { fixture: { serverUrl: origin } } }), { mode: 0o600 });
  const loggedIn = await cli('login'); assert.equal(loggedIn.state, 'active');
  assert.deepEqual(await cli('status'), loggedIn);
  await cli('focus'); await cli('refresh'); await cli('focus');
  assert.equal((await cli('logout')).state, 'signed_out'); assert.equal((await cli('status')).state, 'signed_out');
  console.log('HTTPS fixture: separate built CLI processes / OS-keychain restore / rotation / Canonical DPoP / password logout PASS');
  await cli('login'); loseCompletion = true; await cli('refresh', 1);
  assert.equal((await cli('status')).state, 'refreshing'); const count = requests;
  await cli('refresh', 3); assert.equal(requests, count);
  assert.equal((await cli('forget-local')).state, 'signed_out'); assert.equal(requests, count);
  assert.equal(contexts.size, 0); assert.equal(errors, 0);
  console.log('Lost refresh completion: restart refuses reuse/retry; explicit local-only recovery PASS. ACTIVE Gateway remains untested.');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  try {
    if (keyCreated) {
      const scope = { origin, platform: 'cli' as const, userId };
      await keys.withSession(scope, async (_identity, _sign, vault) => { await vault.clear(); });
      await keys.remove(scope);
    }
  } finally { signingSecret.fill(0); rmSync(directory, { recursive: true, force: true }); }
  console.log('Disposable fixture keychain slots and profile folder removed.');
}
