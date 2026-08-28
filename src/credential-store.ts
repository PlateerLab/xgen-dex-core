import { DexError } from './errors';
import type { StoredSession } from './types';

const SERVICE = 'xgen-dex-cli';
const ACCOUNT_PREFIX = 'profile:';

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface CredentialStore {
  get(profile: string): Promise<StoredSession | null>;
  set(profile: string, session: StoredSession): Promise<void>;
  delete(profile: string): Promise<void>;
}

async function loadKeytar(): Promise<KeytarLike> {
  try {
    const loaded = (await import('keytar')) as unknown as {
      default?: KeytarLike;
      getPassword?: KeytarLike['getPassword'];
      setPassword?: KeytarLike['setPassword'];
      deletePassword?: KeytarLike['deletePassword'];
    };
    const keytar = (loaded.default ?? loaded) as KeytarLike;
    if (!keytar.getPassword || !keytar.setPassword || !keytar.deletePassword) throw new Error('invalid keytar module');
    return keytar;
  } catch (error) {
    throw new DexError(
      'credential_store_unavailable',
      'OS 키체인을 사용할 수 없습니다. keytar 설치와 OS 키링 상태를 확인하세요.',
      error,
    );
  }
}

function parseSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredSession;
    if (!value.serverUrl || !value.accessToken) return null;
    return value;
  } catch {
    return null;
  }
}

export class KeytarCredentialStore implements CredentialStore {
  async get(profile: string): Promise<StoredSession | null> {
    const keytar = await loadKeytar();
    return parseSession(await keytar.getPassword(SERVICE, ACCOUNT_PREFIX + profile));
  }

  async set(profile: string, session: StoredSession): Promise<void> {
    const keytar = await loadKeytar();
    await keytar.setPassword(SERVICE, ACCOUNT_PREFIX + profile, JSON.stringify(session));
  }

  async delete(profile: string): Promise<void> {
    const keytar = await loadKeytar();
    await keytar.deletePassword(SERVICE, ACCOUNT_PREFIX + profile);
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private values = new Map<string, StoredSession>();

  async get(profile: string): Promise<StoredSession | null> {
    const value = this.values.get(profile);
    return value ? structuredClone(value) : null;
  }

  async set(profile: string, session: StoredSession): Promise<void> {
    this.values.set(profile, structuredClone(session));
  }

  async delete(profile: string): Promise<void> {
    this.values.delete(profile);
  }
}
