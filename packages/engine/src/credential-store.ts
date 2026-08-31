import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoredSession } from './contract';
import { dataDirectory } from './config-store';

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

/** 어디에 저장하고 있는지. `dex status` 가 이걸 말해 준다. */
export type CredentialBackend = 'keychain' | 'file';

let activeBackend: CredentialBackend = 'file';

export function credentialBackend(): CredentialBackend {
  return activeBackend;
}

/**
 * OS 키체인을 **쓸 수 있으면** 돌려주고, 아니면 ``null``.
 *
 * 예전에는 여기서 던졌다. 그래서 keytar 가 안 붙는 환경 — 새 npm 이 설치
 * 스크립트를 막아 네이티브 바인딩이 안 깔린 경우, 키링이 없는 헤드리스 서버,
 * D-Bus 가 없는 컨테이너 — 에서는 **로그인 자체가 불가능**했다. 그 셋 다 흔하다.
 *
 * 데스크톱은 이미 키체인 → 암호화 파일 → 평문 파일 → 메모리 사다리를 갖고 있었다.
 * 터미널에는 그게 없었을 뿐이다.
 */
let keytarProbe: Promise<KeytarLike | null> | null = null;

/**
 * 키체인 호출의 상한.
 *
 * **필요한 이유**: 키링 데몬이 없는 리눅스(헤드리스 서버·컨테이너·SSH 세션)에서
 * libsecret 은 오류를 내지 않고 **그냥 응답하지 않는다.** 실측했다 — 이 머신에서
 * `getPassword` 는 28ms 만에 null 을 주는데 `setPassword` 는 영원히 돌아오지
 * 않았다. 타임아웃이 없으면 `dex login` 이 아무 메시지 없이 멈춘 것처럼 보인다.
 *
 * 응답하는 키링이라면 수십 ms 안에 끝난다 — 2초는 느린 기계를 위한 여유다.
 */
const KEYCHAIN_TIMEOUT_MS = 2_000;

/** 정해진 시간 안에 끝나지 않으면 실패로 본다. 매다는 것보다 파일에 저장하는 편이 낫다. */
async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('keychain timeout')), KEYCHAIN_TIMEOUT_MS);
        // 이 타이머가 프로세스를 붙잡으면 CLI 가 끝나도 안 죽는다.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadKeytar(): Promise<KeytarLike | null> {
  // 한 번만 시도한다 — 없는 모듈을 매 호출마다 import 하면 그만큼 느려진다.
  keytarProbe ??= (async () => {
    // 사용자가 명시적으로 끌 수 있다. 키링이 매번 암호를 묻는 환경에서 필요하다.
    if (process.env.DEX_NO_KEYCHAIN === '1') return null;
    try {
      const loaded = (await import('keytar')) as unknown as {
        default?: KeytarLike;
        getPassword?: KeytarLike['getPassword'];
        setPassword?: KeytarLike['setPassword'];
        deletePassword?: KeytarLike['deletePassword'];
      };
      const keytar = (loaded.default ?? loaded) as KeytarLike;
      if (!keytar.getPassword || !keytar.setPassword || !keytar.deletePassword) return null;
      // 실제로 한 번 읽어 본다 — 모듈이 로드돼도 키링이 없으면 여기서 걸린다.
      await withTimeout(keytar.getPassword(SERVICE, '__probe__'));
      return keytar;
    } catch {
      return null;
    }
  })();
  const keytar = await keytarProbe;
  activeBackend = keytar ? 'keychain' : 'file';
  return keytar;
}

/**
 * 키체인이 없을 때의 자리 — 사용자 데이터 폴더의 0600 파일.
 *
 * "암호화" 라고 부르지 않는다. OS 가 키를 쥐어 주지 않는 곳에서 키를 파일 옆에
 * 두고 암호화했다고 말하는 것은 거짓말이고, 그 거짓말을 믿고 이 파일을 백업에
 * 넣게 된다. 실제로 하는 일은 **소유자만 읽을 수 있게 하는 것**이고, 그건 그렇게
 * 말해야 한다.
 */
function filePath(): string {
  return join(dataDirectory(), 'credentials.json');
}

function readFileStore(): Record<string, string> {
  try {
    const raw = readFileSync(filePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeFileStore(values: Record<string, string>): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(values, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* 파일시스템이 권한을 안 받는 곳(일부 마운트) — 내용은 그대로 쓴다 */
  }
  renameSync(tmp, path);
}

async function secretGet(account: string): Promise<string | null> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      return await withTimeout(keytar.getPassword(SERVICE, account));
    } catch {
      // 저장은 키체인에 했는데 지금 읽기가 막힌 경우(키링 잠김) — 파일로 내려간다.
    }
  }
  return readFileStore()[account] ?? null;
}

async function secretSet(account: string, value: string | null): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      if (value === null) await withTimeout(keytar.deletePassword(SERVICE, account));
      else await withTimeout(keytar.setPassword(SERVICE, account, value));
      return;
    } catch {
      // 쓰기가 막히거나 응답하지 않으면 아래 파일로 내려간다. 읽기는 되는데
      // 쓰기만 매다는 키링이 실제로 있다(이 저장소를 만든 머신이 그랬다).
      activeBackend = 'file';
    }
  }
  const values = readFileStore();
  if (value === null) delete values[account];
  else values[account] = value;
  if (Object.keys(values).length === 0 && existsSync(filePath())) {
    try {
      unlinkSync(filePath());
    } catch {
      writeFileStore(values);
    }
    return;
  }
  writeFileStore(values);
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

/**
 * 기본 자격증명 저장소 — OS 키체인이 있으면 거기, 없으면 소유자 전용 파일.
 *
 * 이름에 keytar 를 넣지 않는다. 무엇으로 저장하는지는 환경이 정하고, 부르는 쪽은
 * 그걸 알 필요가 없다 — 알아야 할 때는 `credentialBackend()` 로 묻는다.
 */
export class SystemCredentialStore implements CredentialStore {
  /**
   * 엔진의 `SecretPort` 로 내보내는 두 함수 — 프로파일 세션 말고 **임의의 비밀**
   * (MCP 서버 시크릿 · OAuth 상태)을 같은 백엔드에 둔다.
   *
   * 저장소를 나누지 않는 이유: 사용자에게는 "이 앱이 내 키체인에 무엇을 넣었나"가
   * 하나의 질문이고, 두 곳에 나뉘면 로그아웃할 때 한쪽이 남는다.
   */
  async getRaw(name: string): Promise<string | null> {
    return secretGet(name);
  }

  async setRaw(name: string, value: string | null): Promise<boolean> {
    await secretSet(name, value);
    return true;
  }

  async get(profile: string): Promise<StoredSession | null> {
    return parseSession(await secretGet(ACCOUNT_PREFIX + profile));
  }

  async set(profile: string, session: StoredSession): Promise<void> {
    await secretSet(ACCOUNT_PREFIX + profile, JSON.stringify(session));
  }

  async delete(profile: string): Promise<void> {
    await secretSet(ACCOUNT_PREFIX + profile, null);
  }
}

/** 옛 이름 — 한동안 남긴다(외부에서 import 하고 있을 수 있다). */
export const KeytarCredentialStore = SystemCredentialStore;

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
