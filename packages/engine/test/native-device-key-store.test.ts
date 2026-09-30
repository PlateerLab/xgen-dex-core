import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { NativeDeviceKeyStore, nativeKeyScope, type NativeKeychain, type NativeKeyScope } from '../src/native-device-key-store';
import { DexError } from '../src/errors';

const scope: NativeKeyScope = { origin: 'https://app.example.test', userId: '7', platform: 'cli' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dex-native-key-test-'));
  const records = new Map<string, string>();
  const writes: string[] = [];
  const keychain: NativeKeychain = {
    getPassword: async (service, name) => records.get(`${service}:${name}`) ?? null,
    setPassword: async (service, name, value) => { records.set(`${service}:${name}`, value); writes.push(value); },
    deletePassword: async (service, name) => records.delete(`${service}:${name}`),
  };
  const options = { lockDirectory: directory, keychain: async () => keychain, env: {} };
  return { directory, records, writes, keychain, options, store: () => new NativeDeviceKeyStore(options),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function failed(error: unknown): boolean {
  assert.ok(error instanceof DexError); assert.equal(error.code, 'credential_store_unavailable');
  assert.equal(JSON.stringify(error).includes('private-key-secret'), false); return true;
}

test('persist before use, restore the same install/key in a new store, and return no private bytes', async () => {
  const f = await fixture();
  try {
    const first = await f.store().withIdentity(scope, true, async (identity) => {
      assert.equal(f.records.size, 1); assert.equal(f.writes.length, 1);
      assert.deepEqual(Object.keys(identity).sort(), ['installId', 'publicKey', 'signChallenge']);
      const files = await readdir(f.directory); assert.equal(files.length, 1);
      const lock = await readFile(join(f.directory, files[0]), 'utf8');
      assert.deepEqual(Object.keys(JSON.parse(lock)).sort(), ['pid', 'startedAt']);
      assert.equal(lock.includes(identity.publicKey.x), false);
      return { installId: identity.installId, key: identity.publicKey };
    });
    await f.store().withIdentity(scope, false, async (identity) => {
      assert.equal(identity.installId, first.installId); assert.deepEqual(identity.publicKey, first.key);
      const challenge = randomBytes(32).toString('base64url');
      const [header, payload, signature] = (await identity.signChallenge('register', challenge)).split('.');
      const subtle = webcrypto.subtle as unknown as SubtleCrypto;
      const publicKey = await subtle.importKey('jwk', identity.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
        Uint8Array.from(Buffer.from(signature, 'base64url')), new TextEncoder().encode(`${header}.${payload}`)), true);
    });
    assert.equal(f.writes.length, 1); assert.deepEqual(await readdir(f.directory), []);
    await f.store().remove(scope); assert.equal(f.records.size, 0);
  } finally { await f.cleanup(); }
});

test('origin, actual account ID and platform isolate keychain slots; URL normalization is stable', async () => {
  const f = await fixture();
  try {
    const keys = new Set<string>();
    for (const input of [scope, { ...scope, userId: '8' }, { ...scope, origin: 'https://other.test' }, { ...scope, platform: 'vscode' as const }]) {
      keys.add(await f.store().withIdentity(input, true, async (identity) => identity.publicKey.x));
    }
    assert.equal(keys.size, 4); assert.equal(f.records.size, 4);
    await f.store().withIdentity({ ...scope, origin: 'https://APP.example.test:443/' }, false, async () => {});
    assert.equal(f.writes.length, 4);
    for (const slot of f.records.keys()) assert.match(slot, /^xgen-dex-native-device:[a-f0-9]{64}$/);
    for (const userId of ['0', '7x', '01', '2147483648']) assert.throws(() => nativeKeyScope({ ...scope, userId }));
    assert.throws(() => nativeKeyScope({ ...scope, origin: 'http://localhost' }));
  } finally { await f.cleanup(); }
});

test('missing/disabled/locked keychain never writes a fallback file or reaches the identity callback', async () => {
  const f = await fixture();
  try {
    let used = false;
    const callback = async () => { used = true; };
    await assert.rejects(new NativeDeviceKeyStore({ ...f.options, env: { DEX_NO_KEYCHAIN: '1' } }).withIdentity(scope, true, callback), failed);
    await assert.rejects(new NativeDeviceKeyStore({ ...f.options, keychain: async () => { throw new Error('private-key-secret'); } }).withIdentity(scope, true, callback), failed);
    f.keychain.getPassword = async () => { throw new Error('private-key-secret'); };
    await assert.rejects(f.store().withIdentity(scope, true, callback), failed);
    assert.equal(used, false); assert.equal(f.records.size, 0); assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.cleanup(); }
});

test('corrupt records, scope mismatch and unrelated private/public keys are never silently regenerated', async () => {
  const f = await fixture();
  try {
    await f.store().withIdentity(scope, true, async () => {});
    const [slot, raw] = [...f.records][0];
    const second = { ...scope, userId: '8' };
    await f.store().withIdentity(second, true, async () => {});
    const other = JSON.parse([...f.records.values()][1]);
    for (const broken of ['private-key-secret', JSON.stringify({ ...JSON.parse(raw), userId: '8' }),
      JSON.stringify({ ...JSON.parse(raw), publicKey: other.publicKey }), JSON.stringify({ ...JSON.parse(raw), refreshToken: 'private-key-secret' })]) {
      f.records.set(slot, broken);
      await assert.rejects(f.store().withIdentity(scope, true, async () => assert.fail('must not use corrupt key')), failed);
      assert.equal(f.records.get(slot), broken);
    }
    assert.equal(f.writes.length, 2);
  } finally { await f.cleanup(); }
});

test('write failure/readback mismatch prevent registration; status does not create a missing key', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store().withIdentity(scope, false, async () => assert.fail()), (e: unknown) => e instanceof DexError && e.code === 'not_found');
    f.keychain.setPassword = async () => { throw new Error('private-key-secret'); };
    await assert.rejects(f.store().withIdentity(scope, true, async () => assert.fail()), failed);
    f.keychain.setPassword = async () => {};
    await assert.rejects(f.store().withIdentity(scope, true, async () => assert.fail()), failed);
    assert.equal(f.records.size, 0); assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.cleanup(); }
});

test('separate stores serialize an installation across the whole registration operation', async () => {
  const f = await fixture();
  try {
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const done = new Promise<void>((resolve) => { release = resolve; });
    const active = f.store().withIdentity(scope, true, async () => { entered(); await done; });
    await started;
    await assert.rejects(f.store().withIdentity(scope, true, async () => assert.fail()), failed);
    release(); await active;
    await f.store().withIdentity(scope, false, async () => {});
    assert.equal(f.writes.length, 1);
  } finally { await f.cleanup(); }
});

test('keychain timeout retains the process lock until the late operation settles and quarantines the store', async () => {
  const f = await fixture();
  try {
    let settle!: (value: string | null) => void;
    f.keychain.getPassword = () => new Promise((resolve) => { settle = resolve; });
    const timed = new NativeDeviceKeyStore({ ...f.options, timeoutMs: 20 });
    await assert.rejects(timed.withIdentity(scope, true, async () => assert.fail()), failed);
    assert.equal((await readdir(f.directory)).length, 1);
    await assert.rejects(f.store().withIdentity(scope, true, async () => assert.fail()), failed);
    settle(null);
    for (let i = 0; i < 10 && (await readdir(f.directory)).length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await readdir(f.directory), []);
    await assert.rejects(timed.withIdentity(scope, true, async () => assert.fail()), failed);
    f.keychain.getPassword = async () => null;
    await assert.rejects(f.store().withIdentity(scope, false, async () => assert.fail()), (e: unknown) => e instanceof DexError && e.code === 'not_found');
  } finally { await f.cleanup(); }
});

test('a late keychain write keeps its installation and cannot race with a replacement key', async () => {
  const f = await fixture();
  try {
    let settle!: () => void;
    const save = f.keychain.setPassword;
    f.keychain.setPassword = (service, name, value) => new Promise<void>((resolve) => {
      settle = () => { void save(service, name, value).then(resolve); };
    });
    const timed = new NativeDeviceKeyStore({ ...f.options, timeoutMs: 20 });
    await assert.rejects(timed.withIdentity(scope, true, async () => assert.fail()), failed);
    assert.equal((await readdir(f.directory)).length, 1);
    await assert.rejects(f.store().withIdentity(scope, true, async () => assert.fail()), failed);
    settle();
    for (let i = 0; i < 20 && (await readdir(f.directory)).length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await readdir(f.directory), []);
    const persisted = JSON.parse([...f.records.values()][0]);
    await f.store().withIdentity(scope, true, async (identity) => assert.equal(identity.installId, persisted.installId));
    assert.equal(f.writes.length, 1);
  } finally { await f.cleanup(); }
});
