import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { DexError } from './errors';
import type { DexConfig, DexProfile } from './contract';
import { defaultLocalToolsConfig, normalizeLocalToolsConfig } from './local-tools-config';

const DEFAULT_PROFILE = 'default';

export interface ConfigStore {
  read(): Promise<DexConfig>;
  write(config: DexConfig): Promise<void>;
}

export function defaultConfig(): DexConfig {
  return {
    version: 1,
    currentProfile: DEFAULT_PROFILE,
    profiles: {},
    localTools: defaultLocalToolsConfig(),
  };
}

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEX_CLI_HOME?.trim()) return env.DEX_CLI_HOME.trim();
  if (platform() === 'win32') return join(env.APPDATA || homedir(), 'xgen-dex-cli');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'xgen-dex-cli');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'xgen-dex-cli');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), 'config.json');
}

function parseConfig(raw: unknown): DexConfig {
  if (!raw || typeof raw !== 'object') throw new DexError('config_invalid', '설정 파일이 객체가 아닙니다.');
  const value = raw as Record<string, unknown>;
  const profiles: Record<string, DexProfile> = {};
  if (value.profiles && typeof value.profiles === 'object') {
    for (const [name, profile] of Object.entries(value.profiles as Record<string, unknown>)) {
      if (!profile || typeof profile !== 'object') continue;
      const serverUrl = String((profile as Record<string, unknown>).serverUrl ?? '').trim();
      if (serverUrl) profiles[name] = { serverUrl };
    }
  }
  // 정규화는 한 곳(local-tools-config)에만 있다 — 예전엔 여기와 도구 쪽에 각각
  // 있었고, 상한값이 서로 달랐다.
  const localTools = normalizeLocalToolsConfig(value.localTools);
  return {
    version: 1,
    currentProfile: String(value.currentProfile || DEFAULT_PROFILE),
    profiles,
    localTools,
  };
}

export class FileConfigStore implements ConfigStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path = configPath()) {}

  async read(): Promise<DexConfig> {
    try {
      return parseConfig(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
      if (error instanceof DexError) throw error;
      throw new DexError('config_invalid', `설정 파일을 읽을 수 없습니다: ${this.path}`, error);
    }
  }

  async write(config: DexConfig): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    };
    this.queue = this.queue.then(operation, operation);
    await this.queue;
  }
}

export class MemoryConfigStore implements ConfigStore {
  constructor(private value: DexConfig = defaultConfig()) {}

  async read(): Promise<DexConfig> {
    return structuredClone(this.value);
  }

  async write(config: DexConfig): Promise<void> {
    this.value = structuredClone(config);
  }
}

export function validateProfileName(input: string): string {
  const name = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new DexError(
      'config_invalid',
      '프로필 이름은 영문자/숫자로 시작하고 영문자, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.',
    );
  }
  return name;
}

/**
 * 사람이 친 것을 서버 주소로 만든다.
 *
 * **스킴을 생략해도 된다.** `xgen.example.com` 이라고 치면 `https://` 를 붙인다 —
 * 브라우저 주소창이 하는 일과 같다. 예전에는 여기서 거절하고 "http:// 또는
 * https://로 시작해야 합니다" 라고 했는데, 그 말은 맞지만 사용자가 할 일은
 * 여덟 글자를 앞에 더 치는 것뿐이었다. 기계가 할 수 있는 일이다.
 *
 * `http://` 를 붙이지 않고 `https://` 를 붙이는 이유: 평문으로 떨어뜨리는 쪽이
 * 조용한 사고이기 때문이다. 정말로 http 가 필요한 사내 서버라면 그렇게 적으면 된다.
 *
 * 붙여 주지 않는 경우도 있다 — `ftp://` 처럼 **다른 스킴을 명시**했을 때다.
 * 그건 오타가 아니라 의도이고, 그 의도가 틀렸다는 것을 말해 줘야 한다.
 */
export function validateServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new DexError('config_invalid', '서버 주소를 입력하세요.');
  }
  // 스킴이 아예 없을 때만 붙인다. `//host` 도 스킴 없는 것으로 본다.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const bare = raw.replace(/^\/+/, '');
  // 로컬 주소만 http 로 붙인다. https 를 붙이면 TLS 로 반드시 실패하고, 사용자는
  // 서버가 죽은 줄 안다 — 로컬 개발 서버는 거의 언제나 평문이다. 정말로 로컬에
  // https 를 쓴다면 그렇게 적으면 된다.
  const local = /^(localhost|127\.0\.0\.1|\[?::1\]?)(:|$|\/)/i.test(bare);
  const candidate = hasScheme ? raw : `${local ? 'http' : 'https'}://${bare}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new DexError('config_invalid', '서버 주소를 알아볼 수 없습니다. 예: xgen.example.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DexError('config_invalid', '서버 URL은 http:// 또는 https://만 사용할 수 있습니다.');
  }
  if (!url.hostname) {
    throw new DexError('config_invalid', '서버 주소에 호스트가 없습니다. 예: xgen.example.com');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DexError('config_invalid', '서버 URL에는 자격 증명, query, fragment를 넣을 수 없습니다.');
  }
  return url.toString().replace(/\/$/, '');
}
