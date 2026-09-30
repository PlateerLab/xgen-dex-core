import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DexError, MemoryConfigStore, NativeDeviceKeyStore, defaultConfig } from '@dex/engine';
import { parseArgs } from '../src/args';
import { runSessionCommand } from '../src/session-command';

const origin = 'https://app.example.test';
const DEVICE = '018f1240-0000-7000-8000-000000000001';
const SID = '018f1240-0000-7000-8000-000000000002';
const CHALLENGE = Buffer.alloc(32, 5).toString('base64url');
const refresh = Buffer.alloc(32, 1).toString('base64url');
function configs(serverUrl = origin) { return new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl } } }); }

test('invalid actions, account IDs, HTTP origins and credential flags fail before password input', async () => {
  let read = false;
  const dependencies = { readPassword: async () => { read = true; return 'secret'; }, fetch: (async () => assert.fail()) as typeof fetch };
  for (const argv of [['session', 'retry'], ['session', 'login', '--email', 'a', '--password', 'secret'],
    ['session', 'refresh', '--user-id', '7', '--token', 'secret'], ['session', 'status', '--user-id', '01'],
    ['session', 'focus', '--user-id', '7', '--password-stdin'], ['session', 'watch-focus', '--user-id', '7', '--json'],
    ['session', 'watch-focus', '--user-id', '7', '--interval-ms', '199'], ['session', 'watch-focus', '--user-id', '7', '--interval-ms', '1e3'],
    ['session', 'watch-focus', '--user-id', '7', '--interval-ms', '60001'], ['session', 'status', '--user-id', '7', '--jsonl']]) {
    await assert.rejects(runSessionCommand(parseArgs(argv), configs(), dependencies), DexError);
  }
  await assert.rejects(runSessionCommand(parseArgs(['session', 'login', '--email', 'a']), configs('http://localhost'), dependencies), DexError);
  assert.equal(read, false);
});

test('JSON login/status/local forgetting expose no credential and do not ask for a password on local reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-session-command-'));
  try {
    const values = new Map<string, string>();
    const keychain = { getPassword: async (service: string, name: string) => values.get(`${service}:${name}`) ?? null,
      setPassword: async (service: string, name: string, raw: string) => { values.set(`${service}:${name}`, raw); },
      deletePassword: async (service: string, name: string) => values.delete(`${service}:${name}`) };
    const keys = new NativeDeviceKeyStore({ lockDirectory: directory, keychain: async () => keychain, env: {} });
    let jkt = '';
    await keys.withIdentity({ origin, platform: 'cli', userId: '7' }, true, async ({ publicKey: k }) => {
      jkt = createHash('sha256').update(JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x, y: k.y })).digest('base64url');
    });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const access = `e30.${Buffer.from(JSON.stringify({ sub: '7', sid: SID, device_id: DEVICE, platform_type: 'cli', token_use: 'platform_access', cnf: { jkt }, exp })).toString('base64url')}.c2ln`;
    const output: string[] = []; let requests = 0; let reads = 0;
    const fetchImpl = (async (input) => {
      requests++; const path = new URL(String(input)).pathname;
      if (path === '/api/auth/login') return Response.json({ success: true, user_id: '7', access_token: 'e30.e30.c2ln' });
      if (path === '/api/auth/logout') return Response.json({ success: true });
      if (path === '/api/agentflow/me/agent-state') return Response.json({ active_agent_session_id: null, version: 0, event_id: null });
      if (path.includes('/status/')) return Response.json({ device_id: DEVICE, state: 'trusted' });
      if (path.endsWith('/begin')) return Response.json({ flow_id: SID, device_id: DEVICE, challenge: CHALLENGE, expires_in_seconds: 300 });
      return Response.json({ session_id: SID, state: 'active', token_type: 'DPoP', access_token: access, access_expires_at: new Date(exp * 1000).toISOString(), refresh_token: refresh });
    }) as typeof fetch;
    const dependencies = { keys, fetch: fetchImpl, readPassword: async () => { reads++; return 'private-password'; }, write: (value: string) => { output.push(value); } };
    await runSessionCommand(parseArgs(['session', 'login', '--email', 'a', '--json']), configs(), dependencies);
    const before = requests;
    await runSessionCommand(parseArgs(['session', 'status', '--user-id', '7', '--json']), configs(), dependencies);
    const controller = new AbortController();
    await runSessionCommand(parseArgs(['session', 'watch-focus', '--user-id', '7', '--jsonl']), configs(), {
      ...dependencies, signal: controller.signal, write: (raw) => { output.push(raw); if (JSON.parse(raw).type === 'focus') controller.abort(); },
    });
    const updates = output.slice(2).map((raw) => JSON.parse(raw));
    assert.deepEqual(updates.map((e) => e.type), ['reset', 'focus', 'stopped']);
    assert.equal(updates[1].source, 'snapshot'); assert.equal(updates[2].reason, 'cancelled');
    assert.equal(updates[1].authScope, undefined);
    await runSessionCommand(parseArgs(['session', 'forget-local', '--user-id', '7', '--json']), configs(), dependencies);
    assert.equal(requests, before + 1); assert.equal(reads, 1);
    for (const raw of output) {
      for (const forbidden of ['private-password', 'privateKeyPkcs8', access, refresh, 'e30.e30.c2ln', 'accessToken', 'refreshToken']) assert.equal(raw.includes(forbidden), false);
    }
    assert.equal(JSON.parse(output[0]).result.user_id, '7');
    assert.equal(JSON.parse(output.at(-1)!).server_revoked, false); assert.equal(values.size, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
