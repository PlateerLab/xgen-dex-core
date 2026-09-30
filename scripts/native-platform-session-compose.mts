/** Opt-in test against the local Compose stack. No existing account/device is modified. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { NativePlatformHttpError, NativePlatformSessionClient, type NativePublicKey } from '../packages/protocol/src/native-platform-session';
import { createNativeDeviceSigner } from '../packages/protocol/src/native-device-proof';

const origin = 'https://localhost:3443';
const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
const agent = new Agent({ ca: readFileSync(join(caRoot, 'rootCA.pem')) });
const fetchImpl: typeof fetch = async (input, init: RequestInit = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, origin);
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, { agent, method: init.method, headers: init.headers as Record<string, string>,
      signal: init.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks).toString(), { status: res.statusCode ?? 500 })));
    });
    req.on('error', reject);
    req.end(init.body);
  });
};
function sql(statement: string): string {
  return execFileSync('docker', ['exec', '-i', 'full-stack-postgresql-1', 'sh', '-c',
    'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], {
    input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function json(path: string, body: object, token?: string) {
  const response = await fetchImpl(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store',
  });
  assert.equal(response.status, 200, `Unexpected status for ${path}: ${response.status}`);
  return response.json();
}
const subtle = webcrypto.subtle as unknown as SubtleCrypto;
async function key() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicKey: { kty: 'EC', crv: 'P-256', x: publicKey.x!, y: publicKey.y! } as NativePublicKey };
}
const userId = randomInt(1_000_000_000, 2_000_000_000);
const tag = `dex-native-${randomUUID()}`;
const password = randomBytes(32).toString('base64url');
const browserId = randomUUID();
let created = false;
let accessToken: string | null = null;
try {
  sql(`INSERT INTO users(id,username,email,password_hash,is_active,is_superuser,status)
    VALUES (${userId},${literal(tag)},${literal(`${tag}@example.invalid`)},${literal(hash(password))},TRUE,FALSE,'1');`);
  created = true;
  const login = await json('/api/auth/login', { email: `${tag}@example.invalid`, password: hash(password) });
  assert.equal(login.success, true);
  assert.equal(login.user_id, String(userId));
  assert.equal(typeof login.access_token, 'string'); accessToken = login.access_token;
  const browser = await key();
  const thumbprint = createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: browser.publicKey.x, y: browser.publicKey.y })).digest('base64url');
  // Fixture precondition: an existing trusted browser. This does not test first-device bootstrap.
  sql(`BEGIN; INSERT INTO trusted_devices(id,user_id,install_id,public_key_jwk,key_thumbprint,platform_type,trust_state,device_name)
    VALUES (${literal(browserId)},${userId},${literal(`${tag}-browser`)},${literal(JSON.stringify(browser.publicKey))}::jsonb,
      ${literal(thumbprint)},'web','trusted','Disposable approval browser');
    INSERT INTO device_bootstrap_state(tenant_id,user_id,first_device_id,platform_type,trust_method)
    VALUES ('system',${userId},${literal(browserId)},'web','password_device_proof'); COMMIT;`);
  for (const platform of ['desktop', 'mobile', 'cli', 'vscode'] as const) {
    const device = await key();
    const client = new NativePlatformSessionClient({ origin, platform, fetch: fetchImpl,
      account: { current: () => ({ authScope: tag, accessToken }) },
      identity: { installId: `${tag}-${platform}`, publicKey: device.publicKey,
        signChallenge: createNativeDeviceSigner(device.pair.privateKey, subtle) } });
    assert.equal(await client.registrationStatus(), null);
    const pending = await client.register(`Disposable ${platform}`);
    assert.equal(pending.state, 'pending');
    assert.deepEqual(await client.registrationStatus(), pending);
    assert.ok((await client.trustOverview()).trusted_devices.some((item) => item.device_id === browserId && item.platform === 'web'));
    const approval = await client.requestApproval(pending.device_id, browserId);
    const path = `/api/me/device-approval-requests/${approval.request_id}/approve-key`;
    const begun = await json(`${path}/begin`, { approver_device_id: browserId }, accessToken!);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'platform-device-proof+jwt' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ challenge: begun.device_challenge, purpose: 'device_approval',
      iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, browser.pair.privateKey, new TextEncoder().encode(`${header}.${claims}`));
    const approved = await json(path, { flow_id: begun.flow_id, device_challenge: begun.device_challenge,
      device_proof_jwt: `${header}.${claims}.${Buffer.from(signature).toString('base64url')}`,
      confirmation_code: approval.confirmation_code, password }, accessToken!);
    assert.equal(approved.state, 'trusted');
    assert.equal((await client.registrationStatus())?.state, 'trusted');
    // Production parser intentionally keeps active closed. Do not change modes to make this test pass.
    await assert.rejects(client.login(pending.device_id, password), (error: unknown) => error instanceof NativePlatformHttpError && error.status === 503);
    await assert.rejects(client.refresh(pending.device_id, randomUUID(), randomBytes(32).toString('base64url')),
      (error: unknown) => error instanceof NativePlatformHttpError && error.status === 503);
    console.log(`${platform}: enrollment / selected browser approval / trusted status PASS; active login & refresh closed (503)`);
  }
  assert.equal(sql(`SELECT COUNT(*) FROM platform_sessions WHERE user_id=${userId};`), '0');
  assert.equal(sql(`SELECT COUNT(*) FROM security_events WHERE user_id=${userId} AND event_type='device_registration_requested';`), '4');
  assert.equal(sql(`SELECT COUNT(*) FROM security_events WHERE user_id=${userId} AND event_type='device_approval_requested';`), '4');
  console.log('No Platform Session issued by enrollment/approval. HTTPS certificate verification enabled.');
} finally {
  if (created) {
    try {
      if (accessToken) {
        const result = await json('/api/auth/logout', { token: accessToken });
        assert.equal(result.success, true);
      }
    } finally {
      sql(`BEGIN;
        DELETE FROM security_outbox WHERE payload->>'user_id'=${literal(String(userId))};
        DELETE FROM security_events WHERE user_id=${userId};
        DELETE FROM user_login_logs WHERE user_id=${userId};
        DELETE FROM users WHERE id=${userId}; COMMIT;`);
      assert.equal(sql(`SELECT COUNT(*) FROM users WHERE id=${userId};`), '0');
      console.log('Disposable account, devices, approval requests and database events removed.');
    }
  }
  agent.destroy();
}
