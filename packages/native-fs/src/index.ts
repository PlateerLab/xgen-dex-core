import { createRequire } from 'node:module';
import { arch, platform } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface NativeEntryStat {
  type: NativeEntryType;
  size: number;
  mtimeMs: number;
  mtimeNs: string;
  ctimeNs: string;
  dev: string;
  ino: string;
  mode: number;
}

export interface NativeDirectoryEntry extends NativeEntryStat {
  name: string;
}

export interface NativeRootInfo {
  id: bigint;
  canonicalPath: string;
  dev: string;
  ino: string;
}

export interface NativeFileIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  /** Windows only: content snapshot required for conditional writes. */
  contentSha256?: string;
}

export interface NativeSourceInfo extends NativeEntryStat {
  id: bigint;
}

export interface NativeQuarantineInfo {
  path: string;
  token: bigint;
}

interface NativeBinding {
  openRoot(path: string): NativeRootInfo;
  closeRoot(id: bigint): void;
  stat(root: bigint, relativePath: string): NativeEntryStat;
  list(root: bigint, relativePath: string): NativeDirectoryEntry[];
  mkdirs(root: bigint, relativePath: string): void;
  write(root: bigint, relativePath: string, bytes: Uint8Array, append: boolean): void;
  writeExpected(root: bigint, relativePath: string, bytes: Uint8Array, expected: NativeFileIdentity): void;
  setMode(root: bigint, relativePath: string, mode: number): void;
  openSource(root: bigint, relativePath: string): NativeSourceInfo;
  openStageSource(relativePath: string): NativeSourceInfo;
  readSource(source: bigint, offset: number, length: number): Uint8Array;
  statSource(source: bigint): NativeEntryStat;
  sourceIdentity?(source: bigint): NativeFileIdentity;
  closeSource(source: bigint): void;
  configureStage(path: string): string;
  atomicWrite(
    root: bigint,
    relativePath: string,
    bytes: Uint8Array,
    overwrite: boolean,
    expected?: NativeFileIdentity | null,
    creationMode?: number,
  ): void;
  renameNoReplace(root: bigint, sourcePath: string, targetPath: string): void;
  moveToStage(root: bigint, relativePath: string): string;
  beginQuarantine(root: bigint, relativePath: string): NativeQuarantineInfo;
  rollbackQuarantine(token: bigint): void;
  finishQuarantine(token: bigint): void;
  copyFileNoReplace(root: bigint, sourcePath: string, targetPath: string): void;
}

let explicitBindingPath = '';
let loaded: NativeBinding | null = null;
let configuredStagePath = '';

/** Bundled hosts pass their packaged prebuild explicitly before opening grants. */
export function configureNativeFsBinding(path: string): void {
  if (loaded) throw new Error('NATIVE_FS_ALREADY_LOADED');
  explicitBindingPath = resolve(path);
}

function binding(): NativeBinding {
  if (loaded) return loaded;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`[NATIVE_ROOTED_FS_UNSUPPORTED] no rooted backend for ${platform}`);
  }
  const own = dirname(fileURLToPath(import.meta.url));
  const path = explicitBindingPath || join(own, '..', 'prebuilds', `${platform}-${arch}`, 'native-fs.node');
  try {
    loaded = createRequire(import.meta.url)(path) as NativeBinding;
    return loaded;
  } catch (cause) {
    throw new Error(`[NATIVE_ROOTED_FS_UNAVAILABLE] native prebuild could not be loaded: ${path}`, { cause });
  }
}

export function configureNativeFsStage(path: string): string {
  const canonical = binding().configureStage(resolve(path));
  configuredStagePath = canonical;
  return canonical;
}

export function nativeFsStagePath(): string {
  return configuredStagePath;
}

export class NativeRoot {
  readonly canonicalPath: string;
  readonly dev: string;
  readonly ino: string;
  #id: bigint | null;

  constructor(path: string) {
    const info = binding().openRoot(path);
    this.#id = info.id;
    this.canonicalPath = info.canonicalPath;
    this.dev = info.dev;
    this.ino = info.ino;
  }

  private id(): bigint {
    if (this.#id === null) throw new Error('NATIVE_ROOT_CLOSED');
    return this.#id;
  }

  stat(relativePath: string): NativeEntryStat {
    return binding().stat(this.id(), relativePath);
  }

  list(relativePath: string): NativeDirectoryEntry[] {
    return binding().list(this.id(), relativePath);
  }

  mkdirs(relativePath: string): void {
    binding().mkdirs(this.id(), relativePath);
  }

  write(relativePath: string, bytes: Uint8Array, append = false): void {
    binding().write(this.id(), relativePath, bytes, append);
  }

  writeExpected(relativePath: string, bytes: Uint8Array, expected: NativeFileIdentity): void {
    binding().writeExpected(this.id(), relativePath, bytes, expected);
  }

  setMode(relativePath: string, mode: number): void {
    binding().setMode(this.id(), relativePath, mode);
  }

  openSource(relativePath: string): NativeSource {
    return new NativeSource(binding().openSource(this.id(), relativePath));
  }

  atomicWrite(
    relativePath: string,
    bytes: Uint8Array,
    overwrite: boolean,
    expected?: NativeFileIdentity,
    creationMode?: number,
  ): void {
    if (creationMode !== undefined) binding().atomicWrite(this.id(), relativePath, bytes, overwrite, expected ?? null, creationMode);
    else if (expected) binding().atomicWrite(this.id(), relativePath, bytes, overwrite, expected);
    else binding().atomicWrite(this.id(), relativePath, bytes, overwrite);
  }

  renameNoReplace(sourcePath: string, targetPath: string): void {
    binding().renameNoReplace(this.id(), sourcePath, targetPath);
  }

  moveToStage(relativePath: string): string {
    return binding().moveToStage(this.id(), relativePath);
  }

  beginQuarantine(relativePath: string): NativeQuarantine {
    return new NativeQuarantine(binding().beginQuarantine(this.id(), relativePath));
  }

  copyFileNoReplace(sourcePath: string, targetPath: string): void {
    binding().copyFileNoReplace(this.id(), sourcePath, targetPath);
  }

  close(): void {
    if (this.#id === null) return;
    binding().closeRoot(this.#id);
    this.#id = null;
  }
}

export class NativeQuarantine {
  readonly path: string;
  #token: bigint | null;

  constructor(info: NativeQuarantineInfo) {
    this.path = info.path;
    this.#token = info.token;
  }

  rollback(): void {
    if (this.#token === null) throw new Error('NATIVE_QUARANTINE_CLOSED');
    binding().rollbackQuarantine(this.#token);
  }

  close(): void {
    if (this.#token === null) return;
    binding().finishQuarantine(this.#token);
    this.#token = null;
  }
}

export class NativeSource {
  readonly type: NativeEntryType;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly dev: string;
  readonly ino: string;
  #id: bigint | null;

  constructor(info: NativeSourceInfo) {
    this.#id = info.id;
    this.type = info.type;
    this.size = info.size;
    this.mtimeMs = info.mtimeMs;
    this.mtimeNs = info.mtimeNs;
    this.ctimeNs = info.ctimeNs;
    this.dev = info.dev;
    this.ino = info.ino;
  }

  private id(): bigint {
    if (this.#id === null) throw new Error('NATIVE_SOURCE_CLOSED');
    return this.#id;
  }

  read(offset: number, length: number): Uint8Array {
    return Uint8Array.from(binding().readSource(this.id(), offset, length));
  }

  stat(): NativeEntryStat {
    return binding().statSource(this.id());
  }

  identity(): NativeFileIdentity {
    if (platform === 'win32') {
      const nativeIdentity = binding().sourceIdentity;
      if (!nativeIdentity) throw Object.assign(new Error('Windows source digest is unavailable'), { code: 'ENOTSUP' });
      return nativeIdentity(this.id());
    }
    return {
      dev: this.dev,
      ino: this.ino,
      size: String(this.size),
      mtimeNs: this.mtimeNs,
      ctimeNs: this.ctimeNs,
    };
  }

  close(): void {
    if (this.#id === null) return;
    binding().closeSource(this.#id);
    this.#id = null;
  }
}

export function openNativeRoot(path: string): NativeRoot {
  return new NativeRoot(path);
}

/** Trusted host read of a file below the configured private stage. */
export function openPrivateStageSource(relativePath: string): NativeSource {
  return new NativeSource(binding().openStageSource(relativePath));
}
