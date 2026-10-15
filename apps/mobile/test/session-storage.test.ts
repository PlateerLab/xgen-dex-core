import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionStorage } from '../src/lib/session-storage';

const session = {
  serverUrl: 'https://example.test',
  accessToken: 'access',
  refreshToken: 'refresh',
  userId: '42',
  username: 'user',
};

function memoryStorage() {
  const secureValues = new Map<string, string>();
  const legacyValues = new Map<string, string>();
  const storage = createSessionStorage({
    getItemAsync: async (key) => secureValues.get(key) ?? null,
    setItemAsync: async (key, value) => { secureValues.set(key, value); },
    deleteItemAsync: async (key) => { secureValues.delete(key); },
  }, {
    getItem: async (key) => legacyValues.get(key) ?? null,
    removeItem: async (key) => { legacyValues.delete(key); },
  });
  return { storage, secureValues, legacyValues };
}

test('login and rotation write tokens only to secure storage; logout removes both copies', async () => {
  const { storage, secureValues, legacyValues } = memoryStorage();
  legacyValues.set('xgen-session', JSON.stringify(session));
  await storage.save(session);
  assert.equal(legacyValues.has('xgen-session'), false);
  assert.deepEqual(await storage.restore(), session);

  const rotated = { ...session, accessToken: 'new-access', refreshToken: 'new-refresh' };
  await storage.save(rotated);
  assert.deepEqual(await storage.restore(), rotated);
  await storage.clear();
  assert.equal(secureValues.has('xgen-session'), false);
  assert.equal(legacyValues.has('xgen-session'), false);
});

test('legacy plaintext is migrated once, including removal on invalid or failed migration', async () => {
  const { storage, secureValues, legacyValues } = memoryStorage();
  legacyValues.set('xgen-session', JSON.stringify(session));
  assert.deepEqual(await storage.restore(), session);
  assert.equal(legacyValues.has('xgen-session'), false);
  assert.deepEqual(JSON.parse(secureValues.get('xgen-session')!), session);

  secureValues.clear();
  legacyValues.set('xgen-session', '{invalid');
  assert.equal(await storage.restore(), null);
  assert.equal(legacyValues.has('xgen-session'), false);

  legacyValues.set('xgen-session', JSON.stringify(session));
  const failing = createSessionStorage({
    getItemAsync: async () => null,
    setItemAsync: async () => { throw new Error('keychain unavailable'); },
    deleteItemAsync: async () => {},
  }, {
    getItem: async (key) => legacyValues.get(key) ?? null,
    removeItem: async (key) => { legacyValues.delete(key); },
  });
  await assert.rejects(failing.restore(), /keychain unavailable/);
  assert.equal(legacyValues.has('xgen-session'), false);
});

test('logout waits for an in-flight token rotation before removing the token', async () => {
  let releaseWrite!: () => void;
  const holdWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const secureValues = new Map<string, string>();
  const storage = createSessionStorage({
    getItemAsync: async (key) => secureValues.get(key) ?? null,
    setItemAsync: async (key, value) => {
      await holdWrite;
      secureValues.set(key, value);
    },
    deleteItemAsync: async (key) => { secureValues.delete(key); },
  }, {
    getItem: async () => null,
    removeItem: async () => {},
  });

  const rotation = storage.save(session);
  const logout = storage.clear();
  releaseWrite();
  await Promise.all([rotation, logout]);
  assert.equal(secureValues.has('xgen-session'), false);
});
