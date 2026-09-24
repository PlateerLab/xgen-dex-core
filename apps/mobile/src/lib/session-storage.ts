import type { MobileSession } from './xgen';

const SESSION_KEY = 'xgen-session';

interface SecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

interface LegacyStorage {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

function parseSession(raw: string): MobileSession | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const session = value as Partial<MobileSession>;
    if (typeof session.serverUrl !== 'string' || !session.serverUrl
      || typeof session.accessToken !== 'string' || !session.accessToken
      || typeof session.userId !== 'string' || !session.userId
      || typeof session.username !== 'string') return null;
    if (session.refreshToken !== undefined && typeof session.refreshToken !== 'string') return null;
    return session as MobileSession;
  } catch {
    return null;
  }
}

export function createSessionStorage(secure: SecureStorage, legacy: LegacyStorage) {
  let pending: Promise<void> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    save(session: MobileSession): Promise<void> {
      return serial(async () => {
        try {
          await secure.setItemAsync(SESSION_KEY, JSON.stringify(session));
        } finally {
          await legacy.removeItem(SESSION_KEY);
        }
      });
    },

    restore(): Promise<MobileSession | null> {
      return serial(async () => {
        let saved: string | null;
        try {
          saved = await secure.getItemAsync(SESSION_KEY);
        } catch {
          await legacy.removeItem(SESSION_KEY);
          return null;
        }
        if (saved) {
          const session = parseSession(saved);
          if (session) {
            await legacy.removeItem(SESSION_KEY);
            return session;
          }
          await secure.deleteItemAsync(SESSION_KEY);
        }

        const old = await legacy.getItem(SESSION_KEY);
        if (!old) return null;
        const session = parseSession(old);
        try {
          if (session) await secure.setItemAsync(SESSION_KEY, JSON.stringify(session));
        } finally {
          // A failed migration logs the user in again; plaintext is never kept.
          await legacy.removeItem(SESSION_KEY);
        }
        return session;
      });
    },

    clear(): Promise<void> {
      return serial(async () => {
        await Promise.all([
          secure.deleteItemAsync(SESSION_KEY),
          legacy.removeItem(SESSION_KEY),
        ]);
      });
    },
  };
}
