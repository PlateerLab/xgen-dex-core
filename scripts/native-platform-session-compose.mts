/** Opt-in test against the local Compose stack. No existing account/device is modified. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Agent, request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { NativePlatformHttpError, NativePlatformSessionClient, type NativePublicKey } from '../packages/protocol/src/native-platform-session';
import { createNativeDeviceSigner } from '../packages/protocol/src/native-device-proof';
import { NativeDeviceKeyStore } from '../packages/engine/src/native-device-key-store';
import { DexRpcClient, DexRpcError } from '../packages/rpc/src/client';
import type { NativeRpcResult } from '../packages/rpc/src/wire';
import { createMobileEnrollment } from '../apps/mobile/src/lib/native-device-enrollment';
import { createMobileEnrollmentFetch } from '../apps/mobile/src/lib/native-enrollment-http';
import { createMobilePlatformSession } from '../apps/mobile/src/lib/native-platform-session';
import { createMobileSessionFetch } from '../apps/mobile/src/lib/native-session-http';
import { createMobileSessionVault } from '../apps/mobile/src/lib/native-session-vault';
import { createMobileAgentFetch } from '../apps/mobile/src/lib/native-agent-http';
import { createMobileAgentFocusSource } from '../apps/mobile/src/lib/native-agent-focus';
import { createMobileAgentFocusWatcher } from '../apps/mobile/src/lib/native-agent-focus-watch';
import { createMobileAgentConversationWatcher } from '../apps/mobile/src/lib/native-agent-conversation-watch';
import { createMobileAgentLiveWatcher } from '../apps/mobile/src/lib/native-agent-live-watch';
import { createMobileAgentSocketTransport } from '../apps/mobile/src/lib/native-agent-socket';
import { createNativeDpopSigner } from '../packages/engine/src/native-dpop';

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
const testCli = process.argv.includes('--cli');
const testVscode = process.argv.includes('--vscode');
const testDesktop = process.argv.includes('--desktop');
const testNativeMessages = process.argv.includes('--native-messages');
const testMobileWs = process.argv.includes('--mobile-ws');
const testMobileMessages = process.argv.includes('--mobile-messages') || testMobileWs;
const testMobileFocus = process.argv.includes('--mobile-focus') || testMobileMessages;
const testMobileSession = process.argv.includes('--mobile-session') || testMobileFocus;
const testMobileController = process.argv.includes('--mobile-controller') || testMobileSession;
const platforms = testMobileController ? ['mobile'] as const : ['desktop', 'mobile', 'cli', 'vscode'] as const;
const desktopElectron: string | null = testDesktop ? createRequire(import.meta.url)('../apps/desktop/node_modules/electron') : null;
const cliDirectory = testCli || testVscode || testDesktop ? mkdtempSync(join(tmpdir(), 'dex-native-compose-')) : null;
const cliKeys = new NativeDeviceKeyStore();
const nativeKeysCreated = new Set<'cli' | 'vscode' | 'desktop'>();
let rpc: DexRpcClient | null = null;
async function stopNativeRpc() { const current = rpc; rpc = null; await current?.stop(); }
async function nativeRpc(platform: 'vscode' | 'desktop', category: 'device' | 'session' | 'watch' | 'conversation' | 'watch-conversation', action?: string, extra: object = {}) {
  assert.ok(cliDirectory);
  rpc ??= new DexRpcClient({ process: { command: platform === 'desktop' ? desktopElectron! : process.execPath, args: platform === 'desktop'
    ? ['-r', 'tsx/cjs', 'apps/desktop/verify/native-session-host.cjs', `--origin=${origin}`, `--user-id=${userId}`]
    : ['apps/cli/dist/cli.js', 'serve', '--stdio', '--native-platform', 'vscode'],
    env: { ...process.env, DEX_CLI_HOME: cliDirectory, NODE_EXTRA_CA_CERTS: join(caRoot, 'rootCA.pem') } }, clientVersion: 'compose-fixture' });
  const initialized = await rpc.start(); assert.equal(initialized.capabilities.nativePlatformSession?.platform, platform);
  if (testNativeMessages) assert.equal(initialized.capabilities.nativePlatformSession?.canonicalConversation, true);
  const result = await rpc.request<NativeRpcResult>(`native/${category}`, { profile: 'compose',
    ...(category === 'watch' || category === 'conversation' || category === 'watch-conversation' ? { user_id: String(userId) } : { action,
      ...(category === 'device' || action === 'login' ? { email: `${tag}@example.invalid`, password } : { user_id: String(userId) }) }), ...extra });
  assert.equal(result.platform_type, platform); assert.equal(result.user_id, String(userId));
  const output = JSON.stringify(result);
  for (const secret of [password, accessToken!, 'privateKeyPkcs8', 'access_token', 'refresh_token']) assert.equal(output.includes(secret), false);
  return result.result;
}
function cli(action: string, extra: string[] = [], category = 'device') {
  assert.ok(cliDirectory);
  const output = execFileSync(process.execPath, ['apps/cli/dist/cli.js', category, action,
    ...(category === 'session' && action !== 'login' ? ['--user-id', String(userId)] : ['--email', `${tag}@example.invalid`]),
    ...(category === 'device' || action === 'login' ? ['--password-stdin'] : []), action.startsWith('watch-') ? '--jsonl' : '--json', ...extra], {
    input: password, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEX_CLI_HOME: cliDirectory, NODE_EXTRA_CA_CERTS: join(caRoot, 'rootCA.pem') },
  });
  const result = JSON.parse(output);
  assert.equal(result.storage, 'os-keychain-software');
  for (const secret of [password, accessToken!, 'privateKeyPkcs8', 'access_token', 'refresh_token']) assert.equal(output.includes(secret), false);
  return result.result;
}
let created = false;
let accessToken: string | null = null;
try {
  sql(`INSERT INTO users(id,username,email,password_hash,is_active,is_superuser,status)
    VALUES (${userId},${literal(tag)},${literal(`${tag}@example.invalid`)},${literal(hash(password))},TRUE,FALSE,'1');`);
  created = true;
  if (cliDirectory) writeFileSync(join(cliDirectory, 'config.json'), JSON.stringify({ version: 1,
    currentProfile: 'compose', profiles: { compose: { serverUrl: origin } } }), { mode: 0o600 });
  const login = await json('/api/auth/login', { email: `${tag}@example.invalid`, password: hash(password) });
  assert.equal(login.success, true);
  assert.equal(login.user_id, String(userId));
  assert.equal(typeof login.access_token, 'string'); accessToken = login.access_token;
  if (cliDirectory) {
    const claims = JSON.parse(Buffer.from(accessToken!.split('.')[1], 'base64url').toString());
    assert.equal(typeof claims.jti, 'string', 'Gateway must run the legacy token uniqueness fix before temporary CLI login/logout testing');
  }
  const browser = await key();
  const thumbprint = createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: browser.publicKey.x, y: browser.publicKey.y })).digest('base64url');
  // Fixture precondition: an existing trusted browser. This does not test first-device bootstrap.
  sql(`BEGIN; INSERT INTO trusted_devices(id,user_id,install_id,public_key_jwk,key_thumbprint,platform_type,trust_state,device_name)
    VALUES (${literal(browserId)},${userId},${literal(`${tag}-browser`)},${literal(JSON.stringify(browser.publicKey))}::jsonb,
      ${literal(thumbprint)},'web','trusted','Disposable approval browser');
    INSERT INTO device_bootstrap_state(tenant_id,user_id,first_device_id,platform_type,trust_method)
    VALUES ('system',${userId},${literal(browserId)},'web','password_device_proof'); COMMIT;`);
  for (const platform of platforms) {
    if ((platform === 'cli' && testCli) || (platform === 'vscode' && testVscode) || (platform === 'desktop' && testDesktop)) {
      // Separate real CLI processes must restore the same OS-keychain key and install ID.
      nativeKeysCreated.add(platform);
      const run = async (action: string, extra: string[] = [], category = 'device'): Promise<any> => platform === 'cli' ? cli(action, extra, category)
        : nativeRpc(platform, category as 'device' | 'session', action, action === 'register' ? { device_name: `Disposable ${platform}` }
          : action === 'request-approval' ? { approver_device_id: browserId } : {});
      const pending = await run('register', ['--name', 'Disposable CLI']);
      assert.equal(pending.state, 'pending');
      await stopNativeRpc(); // Restart the native host; no key/token travels over RPC.
      assert.deepEqual(await run('register'), pending);
      assert.deepEqual(await run('status'), pending);
      const overview = await run('approvers');
      assert.ok(overview.trusted_devices.some((device: any) => device.device_id === browserId));
      const approval = await run('request-approval', ['--approver', browserId]);
      const path = `/api/me/device-approval-requests/${approval.request_id}/approve-key`;
      const begun = await json(`${path}/begin`, { approver_device_id: browserId }, accessToken!);
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'platform-device-proof+jwt' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ challenge: begun.device_challenge, purpose: 'device_approval', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
      const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, browser.pair.privateKey, new TextEncoder().encode(`${header}.${claims}`));
      const approved = await json(path, { flow_id: begun.flow_id, device_challenge: begun.device_challenge,
        device_proof_jwt: `${header}.${claims}.${Buffer.from(signature).toString('base64url')}`,
        confirmation_code: approval.confirmation_code, password }, accessToken!);
      assert.equal(approved.state, 'trusted'); assert.equal((await run('status')).state, 'trusted');
      assert.equal(sql(`SELECT COUNT(*) FROM trusted_devices WHERE user_id=${userId} AND platform_type=${literal(platform)};`), '1');
      assert.equal(sql(`SELECT COUNT(*) FROM device_approval_requests WHERE user_id=${userId} AND target_platform_type=${literal(platform)};`), '1');
      assert.equal(readFileSync(join(cliDirectory!, 'config.json'), 'utf8').includes('privateKey'), false);
      await assert.rejects(run('login', [], 'session'), (error: unknown) =>
        error instanceof Error && (error.message.includes('503') || ('stderr' in error && String(error.stderr).includes('503'))));
      assert.equal((await run('status', [], 'session')).state, 'login_pending');
      await assert.rejects(platform === 'cli' ? run('watch-focus', [], 'session') : nativeRpc(platform, 'watch'), (error: unknown) =>
        error instanceof DexRpcError ? error.engineCode === 'auth_required' : error instanceof Error && 'status' in error && error.status === 3 && 'stderr' in error && String(error.stderr).includes('auth_required'));
      if (testNativeMessages) {
        for (const action of ['conversation', 'watch-conversation'] as const) {
          await assert.rejects(platform === 'cli' ? run(action, [], 'session') : nativeRpc(platform, action), (error: unknown) =>
            error instanceof DexRpcError ? error.engineCode === 'auth_required' : error instanceof Error && 'status' in error && error.status === 3 && 'stderr' in error && String(error.stderr).includes('auth_required'));
        }
        console.log(`${platform}: conversation read/poll fail closed with login_pending; no automatic refresh or legacy fallback PASS`);
      }
      assert.equal((await run('forget-local', [], 'session')).state, 'signed_out');
      await stopNativeRpc();
      console.log(`${platform}: built engine processes / OS-keychain restore / idempotent registration / selected browser approval / trusted status PASS`);
      console.log(`${platform}: real Gateway ACTIVE login closed (503), safe local journal, blocked Canonical watcher and explicit recovery PASS`);
      continue;
    }
    const device = await key();
    const installId = testMobileController ? randomUUID() : `${tag}-${platform}`;
    const client = new NativePlatformSessionClient({ origin, platform, fetch: fetchImpl,
      account: { current: () => ({ authScope: tag, accessToken }) },
      identity: { installId, publicKey: device.publicKey,
        signChallenge: createNativeDeviceSigner(device.pair.privateKey, subtle) } });
    // This is a software test key and Node TLS bridge, not a physical Mobile hardware/OS test.
    const activeHttp = new Map<string, AbortController>();
    const mobileCurrent = () => ({ origin, userId: String(userId), authScope: tag, accessToken: accessToken! });
    const mobileKeys = { identity: async () => ({ installId, publicKey: device.publicKey, storage: 'android-tee' as const,
      signChallenge: createNativeDeviceSigner(device.pair.privateKey, subtle), signDpop: createNativeDpopSigner(device.pair.privateKey, device.publicKey, origin) }) };
    const mobileEnrollmentFetch = testMobileController ? createMobileEnrollmentFetch({ newRequestId: randomUUID,
        async request(id, requestedOrigin, path, method, token, body) {
          assert.equal(requestedOrigin, origin); const controller = new AbortController(); activeHttp.set(id, controller);
          try {
            const response = await fetchImpl(`${requestedOrigin}${path}`, { method, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`,
              ...(body === null ? {} : { 'Content-Type': 'application/json' }) }, body: body ?? undefined,
              credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
            return { status: response.status, body: await response.text() };
          } finally { activeHttp.delete(id); }
        },
        cancelRequest(id) { activeHttp.get(id)?.abort(); },
      }, origin) : null;
    const enrollment = mobileEnrollmentFetch ? createMobileEnrollment({ current: mobileCurrent, keys: mobileKeys, fetch: mobileEnrollmentFetch }) : null;
    assert.equal(await client.registrationStatus(), null);
    const pending = enrollment ? (await enrollment.register('Disposable Mobile')).registration! : await client.register(`Disposable ${platform}`);
    assert.equal(pending.state, 'pending');
    assert.deepEqual(await client.registrationStatus(), pending);
    assert.ok((await client.trustOverview()).trusted_devices.some((item) => item.device_id === browserId && item.platform === 'web'));
    if (enrollment) {
      assert.deepEqual((await enrollment.register('Disposable Mobile')).registration, pending);
      enrollment.selectApprover(browserId);
    }
    const approval = enrollment ? (await enrollment.requestApproval()).approval! : await client.requestApproval(pending.device_id, browserId);
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
    if (enrollment) {
      const state = await enrollment.inspect(); assert.equal(state.registration?.state, 'trusted'); assert.equal(state.approval, null);
      assert.equal(sql(`SELECT COUNT(*) FROM trusted_devices WHERE user_id=${userId} AND platform_type='mobile';`), '1');
      assert.equal(sql(`SELECT COUNT(*) FROM device_approval_requests WHERE user_id=${userId} AND target_platform_type='mobile';`), '1');
      assert.equal(JSON.stringify(state).includes(accessToken!), false); assert.equal(activeHttp.size, 0); enrollment.dispose();
      console.log('Mobile production controller + JS native adapter: selected browser / idempotent registration / trusted reconciliation PASS (software fixture key, Node TLS bridge)');
    }
    if (testMobileSession) {
      // Memory storage is a test seam, NOT the real Expo SecureStore or native hardware/OS transport.
      const records = new Map<string, string>(); let calls = 0;
      const vault = createMobileSessionVault({ getItemAsync: async (k) => records.get(k) ?? null,
        setItemAsync: async (k, v) => { records.set(k, v); }, deleteItemAsync: async (k) => { records.delete(k); } });
      const sessionFetch = createMobileSessionFetch({ newRequestId: randomUUID,
        async sessionRequest(id, selected, path, method, authorization, dpop, body) {
          calls++; assert.equal(selected, origin); const controller = new AbortController(); activeHttp.set(id, controller);
          try {
            const response = await fetchImpl(`${origin}${path}`, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json',
              ...(authorization === null ? {} : { Authorization: authorization }), ...(dpop === null ? {} : { DPoP: dpop }) },
              body: body ?? undefined, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
            return { status: response.status, body: await response.text() };
          } finally { activeHttp.delete(id); }
        }, cancelRequest(id) { activeHttp.get(id)?.abort(); },
      }, origin);
      const make = () => createMobilePlatformSession({ current: mobileCurrent, keys: mobileKeys, vault, generation: randomUUID,
        enrollmentFetch: mobileEnrollmentFetch!, sessionFetch });
      const session = make(); assert.equal((await session.inspect()).state, 'signed_out');
      // Mobile's CJS and this ESM harness can load distinct protocol class instances.
      await assert.rejects(session.login(password), (e: unknown) => e instanceof Error && 'status' in e && e.status === 503);
      assert.equal(calls, 1); assert.equal(session.snapshot().state, 'login_pending'); assert.equal(records.size, 1);
      const retained = JSON.parse([...records.values()][0]!); assert.equal(retained.phase, 'login_pending');
      for (const secret of [password, accessToken!]) assert.equal([...records.values()].join('').includes(secret), false);
      assert.equal(retained.refreshToken, null); assert.equal(retained.accessToken, null); session.dispose();
      const restored = make(); assert.equal((await restored.inspect()).state, 'login_pending');
      await assert.rejects(restored.refresh()); await assert.rejects(restored.login(password)); assert.equal(calls, 1);
      if (testMobileFocus) {
        let canonicalCalls = 0;
        const canonicalFetch = createMobileAgentFetch({ newRequestId: randomUUID,
          async readRequest(id, selected, path, token, dpop) {
            canonicalCalls++; assert.equal(selected, origin); const controller = new AbortController(); activeHttp.set(id, controller);
            try {
              const response = await fetchImpl(`${origin}${path}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `DPoP ${token}`, DPoP: dpop },
                credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
              return { status: response.status, body: await response.text() };
            } finally { activeHttp.delete(id); }
          }, cancelRequest(id) { activeHttp.get(id)?.abort(); },
        }, origin);
        let socketReservations = 0; let socketOpens = 0;
        const socket = testMobileWs ? createMobileAgentSocketTransport({
          newSocketId() { socketReservations++; return randomUUID(); },
          async openAgentSocket() { socketOpens++; assert.fail('Pending journal must block WebSocket before wire'); },
          async nextAgentSocket() { assert.fail('Pending journal must block WebSocket receive'); },
          async closeAgentSocket() {},
        }, origin) : undefined;
        const source = createMobileAgentFocusSource({ current: mobileCurrent, keys: mobileKeys, vault, fetch: canonicalFetch, socket });
        await assert.rejects(source.reconcileFocus(null));
        const updates: unknown[] = [];
        await assert.rejects(createMobileAgentFocusWatcher(source).run((u) => updates.push(u), new AbortController().signal));
        assert.deepEqual(updates, [{ type: 'reset' }, { type: 'stopped', reason: 'authentication' }]);
        if (testMobileMessages) {
          await assert.rejects(source.reconcileConversation(null)); const conversationUpdates: unknown[] = [];
          await assert.rejects(createMobileAgentConversationWatcher(source).run((u) => conversationUpdates.push(u), new AbortController().signal, true));
          assert.deepEqual(conversationUpdates, [{ type: 'reset' }, { type: 'stopped', reason: 'authentication' }]);
          console.log('Mobile production conversation source/watcher: pending journal blocks snapshots/events/messages before wire; safe updates PASS');
        }
        if (testMobileWs) {
          const liveUpdates: unknown[] = [];
          await assert.rejects(createMobileAgentLiveWatcher(source).run((u) => liveUpdates.push(u), new AbortController().signal));
          assert.deepEqual(liveUpdates, [{ type: 'reset' }, { type: 'stopped', reason: 'authentication' }]);
          assert.equal(socketReservations, 0); assert.equal(socketOpens, 0);
          console.log('Mobile production live watcher + JS socket adapter: pending journal stops before native socket reservation/handshake; safe authentication stop PASS (no ACTIVE WSS success claimed)');
        }
        assert.equal(canonicalCalls, 0); assert.equal(calls, 1); assert.equal(records.size, 1); source.dispose();
        console.log('Mobile production Canonical source/watcher: enrollment-mode login_pending blocks focus/read/poll before wire; no refresh/Bearer fallback PASS');
      }
      assert.equal((await restored.forgetLocal()).state, 'signed_out'); assert.equal(records.size, 0); assert.equal(calls, 1);
      assert.equal((await client.registrationStatus())?.state, 'trusted'); restored.dispose(); assert.equal(activeHttp.size, 0);
      console.log('Mobile production session controller/vault + JS session transport: ACTIVE 503, durable token-free login_pending, owner restart, reuse blocked, explicit local recovery PASS (memory vault/software key/Node TLS test seams)');
    }
    // Production parser intentionally keeps active closed. Do not change modes to make this test pass.
    await assert.rejects(client.login(pending.device_id, password), (error: unknown) => error instanceof NativePlatformHttpError && error.status === 503);
    await assert.rejects(client.refresh(pending.device_id, randomUUID(), randomBytes(32).toString('base64url')),
      (error: unknown) => error instanceof NativePlatformHttpError && error.status === 503);
    console.log(`${platform}: enrollment / selected browser approval / trusted status PASS; active login & refresh closed (503)`);
  }
  assert.equal(sql(`SELECT COUNT(*) FROM platform_sessions WHERE user_id=${userId};`), '0');
  assert.equal(sql(`SELECT COUNT(*) FROM security_events WHERE user_id=${userId} AND event_type='device_registration_requested';`), String(platforms.length));
  assert.equal(sql(`SELECT COUNT(*) FROM security_events WHERE user_id=${userId} AND event_type='device_approval_requested';`), String(platforms.length));
  console.log('No Platform Session issued by enrollment/approval. HTTPS certificate verification enabled.');
} finally {
  try {
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
  } finally {
    try {
      await stopNativeRpc();
      for (const platform of nativeKeysCreated) {
        if (platform === 'desktop') {
          const cleanup = new DexRpcClient({ process: { command: desktopElectron!,
            args: ['-r', 'tsx/cjs', 'apps/desktop/verify/native-session-host.cjs', `--origin=${origin}`, `--user-id=${userId}`] }, clientVersion: 'compose-fixture' });
          try { await cleanup.start(); await cleanup.request('verify/cleanup-key'); } finally { await cleanup.stop(); }
          continue;
        }
        const scope = { origin, platform, userId: String(userId) };
        await cliKeys.withSession(scope, async (_identity, _sign, vault) => { await vault.clear(); });
        await cliKeys.remove(scope);
      }
    } finally {
      if (cliDirectory) rmSync(cliDirectory, { recursive: true, force: true });
      agent.destroy();
    }
  }
}
