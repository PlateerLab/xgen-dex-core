import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DexError, MemoryConfigStore, NativeDeviceKeyStore, defaultConfig } from '@dex/engine';
import { parseArgs } from '../src/args';
import { runDeviceCommand } from '../src/device-command';

const DEVICE = '018f1240-0000-7000-8000-000000000001';
const CHALLENGE = Buffer.alloc(32, 5).toString('base64url');
function configs(origin = 'https://app.example.test') {
  return new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } } });
}

test('invalid actions, secret command-line flags and HTTP profiles fail before password input/network', async () => {
  let read = false;
  const dependencies = { readPassword: async () => { read = true; return 'secret'; }, fetch: (async () => assert.fail()) as typeof fetch };
  for (const argv of [['device', 'login'], ['device', 'register', '--email', 'a', '--password', 'secret'],
    ['device', 'request-approval', '--email', 'a', '--approver', 'invalid'], ['device', 'register', '--email', 'a', '--name', '\u202ehidden']]) {
    await assert.rejects(runDeviceCommand(parseArgs(argv), configs(), dependencies), DexError);
  }
  await assert.rejects(runDeviceCommand(parseArgs(['device', 'register', '--email', 'a']), configs('http://localhost'), dependencies), DexError);
  assert.equal(read, false);
});

test('CLI JSON exposes safe device fields and storage assurance, never password/tokens/private keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-device-command-'));
  try {
    const values = new Map<string, string>();
    const keychain = { getPassword: async (_service: string, account: string) => values.get(account) ?? null,
      setPassword: async (_service: string, account: string, raw: string) => { values.set(account, raw); }, deletePassword: async () => true };
    const keys = new NativeDeviceKeyStore({ lockDirectory: directory, keychain: async () => keychain, env: {} });
    const output: string[] = []; const bodies: unknown[] = [];
    const fetchImpl = (async (input, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname; bodies.push(JSON.parse(String(init.body ?? '{}')));
      if (path === '/api/auth/login') return Response.json({ success: true, user_id: '7', access_token: 'e30.e30.c2ln', refresh_token: 'legacy-secret' });
      if (path === '/api/auth/logout') return Response.json({ success: true });
      if (path.includes('/status/')) return Response.json(null);
      if (path.endsWith('/challenge')) return Response.json({ challenge: CHALLENGE, expires_in_seconds: 300 });
      return Response.json({ device_id: DEVICE, state: 'pending' });
    }) as typeof fetch;
    await runDeviceCommand(parseArgs(['device', 'register', '--email', 'a', '--name', 'My CLI', '--json']), configs(),
      { keys, fetch: fetchImpl, readPassword: async () => 'private-password', write: (value) => { output.push(value); } });
    const result = JSON.parse(output.join(''));
    assert.deepEqual(result, { action: 'register', profile: 'corp', serverUrl: 'https://app.example.test', storage: 'os-keychain-software', result: { device_id: DEVICE, state: 'pending' } });
    for (const forbidden of ['private-password', 'legacy-secret', 'privateKeyPkcs8', 'e30.e30.c2ln']) assert.equal(output.join('').includes(forbidden), false);
    assert.equal(JSON.stringify(bodies).includes('privateKeyPkcs8'), false);
    assert.equal(values.size, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
