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

export function validateServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new DexError('config_invalid', '서버 URL은 http:// 또는 https://로 시작해야 합니다.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DexError('config_invalid', '서버 URL은 http:// 또는 https://만 사용할 수 있습니다.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DexError('config_invalid', '서버 URL에는 자격 증명, query, fragment를 넣을 수 없습니다.');
  }
  return url.toString().replace(/\/$/, '');
}
