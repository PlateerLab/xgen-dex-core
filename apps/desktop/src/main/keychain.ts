/**
 * 토큰/자격 증명 저장 — keytar(OS 키체인) 1차 + safeStorage 파일 폴백.
 *
 * geny-connector 의 강건성 교훈 이식: keytar 는 리눅스에서 Secret Service
 * (libsecret + 실행 중인 키링)가 없으면 로드/호출이 실패한다. 이전 구현은
 * 이때 **무음으로 인메모리 Map** 에 떨어져 재시작하면 토큰이 증발했고,
 * UI 는 저장 실패를 알 길이 없었다 (자동 로그인이 조용히 풀리는 미스터리).
 *
 * 새 사다리:
 *   1. keytar (Keychain / Credential Manager / libsecret)
 *   2. Electron safeStorage 로 암호화한 userData/secure-store.json (mode 0600,
 *      값 접두사 `enc:`) — safeStorage 불가 시 `raw:`(base64) 로 저하하되
 *      영속성은 유지한다 (데스크톱 로컬 파일, 평문 config 와 동급 노출면)
 *   3. 인메모리 (최후 폴백 — 세션 한정)
 *
 * 저장 API 는 **persisted 여부를 반환**하고, storageStatus() 가 현재 백엔드를
 * 보고한다 — 렌더러가 "키체인 사용 불가(재시작 시 재로그인 필요)"를 표시할
 * 수 있게 (무음 실패 금지).
 */
import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE = 'xgen-connector';
const ACCESS = 'xgen_access_token';
const REFRESH = 'xgen_refresh_token';
const CREDS = 'xgen_login_credentials';

type Keytar = typeof import('keytar');
let keytarMod: Keytar | null | undefined;
const memory = new Map<string, string>();

export type SecureBackend = 'keychain' | 'encrypted-file' | 'plain-file' | 'memory';
let lastBackend: SecureBackend = 'memory';

async function keytar(): Promise<Keytar | null> {
  if (keytarMod !== undefined) return keytarMod;
  try {
    keytarMod = (await import('keytar')).default as unknown as Keytar;
  } catch {
    keytarMod = null; // 파일 폴백으로
  }
  return keytarMod;
}

// ── safeStorage 파일 폴백 ──────────────────────────────────────────

function storePath(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'secure-store.json');
}

function readStore(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(data: Record<string, string>): boolean {
  try {
    writeFileSync(storePath(), JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function fileSet(account: string, value: string | null): boolean {
  const store = readStore();
  if (value === null) {
    delete store[account];
    return writeStore(store);
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      store[account] = 'enc:' + safeStorage.encryptString(value).toString('base64');
      lastBackend = 'encrypted-file';
    } else {
      store[account] = 'raw:' + Buffer.from(value, 'utf-8').toString('base64');
      lastBackend = 'plain-file';
    }
  } catch {
    store[account] = 'raw:' + Buffer.from(value, 'utf-8').toString('base64');
    lastBackend = 'plain-file';
  }
  return writeStore(store);
}

function fileGet(account: string): string | null {
  const raw = readStore()[account];
  if (!raw) return null;
  try {
    if (raw.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'));
    }
    if (raw.startsWith('raw:')) {
      return Buffer.from(raw.slice(4), 'base64').toString('utf-8');
    }
  } catch {
    return null; // OS 키 변경 등으로 복호 불가 — 재로그인 유도
  }
  return null;
}

// ── 공통 set/get (사다리) ─────────────────────────────────────────

/** 저장 시도 — 영속 저장에 성공했으면 true (인메모리 폴백이면 false).
 *
 *  삭제(value=null)는 **모든 계층**에서 지운다: 과거 keytar 런타임 실패로
 *  파일 폴백에 남은 사본이, keytar 가 복구된 뒤의 로그아웃에서 살아남아
 *  get() 이 낡은 토큰을 부활시키는 구멍을 막는다 (mac 은 ad-hoc 재서명
 *  업데이트마다 키체인 프롬프트가 재출현해 이 경로가 실제로 밟힌다). */
/**
 * 엔진의 `SecretPort` 로 내보내는 두 함수.
 *
 * 엔진(MCP 시크릿·OAuth 상태)은 이 두 개만 알면 되고, 키체인 → 암호화 파일 →
 * 메모리로 내려가는 사다리는 여기 안에 남는다. 그 사다리는 데스크톱의 사정이다.
 */
export const secretGet = (account: string): Promise<string | null> => get(account);
export const secretSet = (account: string, value: string | null): Promise<boolean> =>
  set(account, value);

async function set(account: string, value: string | null): Promise<boolean> {
  const k = await keytar();
  if (value === null) {
    if (k) await k.deletePassword(SERVICE, account).catch(() => {});
    fileSet(account, null);
    memory.delete(account);
    return true;
  }
  if (k) {
    try {
      await k.setPassword(SERVICE, account, value);
      lastBackend = 'keychain';
      // 키체인 저장 성공 → 파일 폴백의 낡은 사본을 정리해 단일 진실 유지.
      fileSet(account, null);
      lastBackend = 'keychain';
      return true;
    } catch {
      // keytar 로드는 됐지만 런타임 실패(키링 미가동/프롬프트 거부) — 파일 폴백
    }
  }
  if (fileSet(account, value)) return true;
  memory.set(account, value);
  lastBackend = 'memory';
  return false;
}

/** get() 에서 키체인 **읽기**가 거부된 적 있는지 — 쓰기 프로브만 보는
 *  storageStatus 가 "정상"이라 보고하는 동안 읽기만 조용히 실패하는 상태
 *  (mac 프롬프트 '거부')를 표면화한다. */
let lastGetDenied = false;

async function get(account: string): Promise<string | null> {
  const k = await keytar();
  if (k) {
    try {
      const v = await k.getPassword(SERVICE, account);
      if (v !== null) return v;
    } catch {
      lastGetDenied = true; // 프롬프트 거부/키링 잠김 — 파일 폴백으로
    }
  }
  const fromFile = fileGet(account);
  if (fromFile !== null) return fromFile;
  return memory.get(account) ?? null;
}

/** 현재 저장 백엔드 상태 — UI 가 "재시작 시 재로그인 필요"를 표시할 근거. */
export async function storageStatus(): Promise<{
  backend: SecureBackend;
  persistent: boolean;
  readDenied: boolean;
}> {
  // 실측: 마커 라운드트립으로 실제 영속 여부를 판정한다.
  const probeKey = '__storage_probe__';
  const persisted = await set(probeKey, 'ok');
  await set(probeKey, null);
  return { backend: lastBackend, persistent: persisted, readDenied: lastGetDenied };
}

export const tokenStore = {
  /** @returns 영속 저장 성공 여부 — false 면 재시작 시 토큰이 사라진다. */
  async setAccess(token: string | null): Promise<boolean> {
    return set(ACCESS, token);
  },
  async getAccess() {
    return get(ACCESS);
  },
  async setRefresh(token: string | null): Promise<boolean> {
    return set(REFRESH, token);
  },
  async getRefresh() {
    return get(REFRESH);
  },
  async clear() {
    await set(ACCESS, null);
    await set(REFRESH, null);
  },
};

/** Auto-login credentials (email + password) — 사용자가 "자동 로그인"을 켤
 *  때만 저장. 평문 config 파일에는 절대 쓰지 않는다. */
export interface SavedCredentials {
  email: string;
  password: string;
}
export const credentialStore = {
  /** @returns 영속 저장 성공 여부. */
  async save(creds: SavedCredentials): Promise<boolean> {
    return set(CREDS, JSON.stringify(creds));
  },
  async get(): Promise<SavedCredentials | null> {
    const raw = await get(CREDS);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as SavedCredentials;
      return c && typeof c.email === 'string' && typeof c.password === 'string' ? c : null;
    } catch {
      return null;
    }
  },
  async clear(): Promise<void> {
    await set(CREDS, null);
  },
};

// ── MCP server secrets (env/headers) — never written to plaintext config.json ──
// The connector.json config keeps the KEY names (for the UI) but redacts the
// VALUES; the real values live here, encrypted by the same safeStorage ladder.
const MCP_SECRET_PREFIX = 'xgen_mcp_secret_';

export interface McpServerSecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

function nonEmpty(o?: Record<string, string>): boolean {
  return !!o && Object.values(o).some((v) => typeof v === 'string' && v.length > 0);
}

export const mcpSecretStore = {
  /** Store a server's secret env/headers. Empty → cleared. */
  async save(server: string, secrets: McpServerSecrets): Promise<boolean> {
    if (!nonEmpty(secrets.env) && !nonEmpty(secrets.headers)) {
      await set(MCP_SECRET_PREFIX + server, null);
      return true;
    }
    return set(MCP_SECRET_PREFIX + server, JSON.stringify(secrets));
  },
  async get(server: string): Promise<McpServerSecrets | null> {
    const raw = await get(MCP_SECRET_PREFIX + server);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? (p as McpServerSecrets) : null;
    } catch {
      return null;
    }
  },
  async clear(server: string): Promise<void> {
    await set(MCP_SECRET_PREFIX + server, null);
  },
};

// ── MCP OAuth state (tokens + client info + PKCE verifier) per server ──
const MCP_OAUTH_PREFIX = 'xgen_mcp_oauth_';

export interface McpOAuthState {
  tokens?: unknown; // OAuthTokens
  clientInformation?: unknown; // OAuthClientInformationFull
  codeVerifier?: string;
}

// Per-server write serialization — patch() is load-modify-save on one shared
// keychain entry, so a concurrent silent refresh + interactive authorize could
// clobber each other's fields. Chain writes per server to keep them atomic.
const oauthWriteChain = new Map<string, Promise<unknown>>();

export const mcpOAuthStore = {
  async load(server: string): Promise<McpOAuthState> {
    const raw = await get(MCP_OAUTH_PREFIX + server);
    if (!raw) return {};
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? (p as McpOAuthState) : {};
    } catch {
      return {};
    }
  },
  async save(server: string, state: McpOAuthState): Promise<boolean> {
    return set(MCP_OAUTH_PREFIX + server, JSON.stringify(state));
  },
  async patch(server: string, patch: Partial<McpOAuthState>): Promise<boolean> {
    const prev = oauthWriteChain.get(server) ?? Promise.resolve();
    const next = prev.then(async () => {
      const cur = await mcpOAuthStore.load(server);
      return mcpOAuthStore.save(server, { ...cur, ...patch });
    });
    oauthWriteChain.set(
      server,
      next.catch(() => undefined),
    );
    return next;
  },
  async clear(server: string): Promise<void> {
    await set(MCP_OAUTH_PREFIX + server, null);
  },
};
