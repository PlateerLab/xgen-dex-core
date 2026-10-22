import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  NativeRoot,
  NativeQuarantine,
  NativeSource,
  configureNativeFsBinding,
  configureNativeFsStage,
  nativeFsStagePath,
  openNativeRoot,
  openPrivateStageSource as openNativePrivateStageSource,
  type NativeDirectoryEntry,
  type NativeEntryStat,
  type NativeFileIdentity,
} from '@dex/native-fs';

export {
  configureNativeFsBinding,
  configureNativeFsStage,
  nativeFsStagePath,
};

export interface RootedResolvedPath {
  grant: RootGrant;
  relativePath: string;
  displayPath: string;
}

function portableRelative(root: string, target: string): string | null {
  const value = relative(root, target);
  if (value === '') return '';
  if (isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) return null;
  return value.split(sep).join('/');
}

function pathDomainError(requested: string): Error {
  return Object.assign(
    new Error(`[PATH_DOMAIN_MISMATCH] 연결된 폴더 밖의 경로입니다: ${requested}`),
    { code: 'PATH_DOMAIN_MISMATCH' },
  );
}

async function canonicalForCreation(path: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      const base = await realpath(cursor);
      return suffix.reduceRight((current, name) => join(current, name), base);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

/** One user-approved folder, pinned to its native directory object. */
export class RootGrant {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly identity: string;
  private readonly native: NativeRoot;

  constructor(path: string) {
    this.requestedPath = resolve(path);
    this.native = openNativeRoot(path);
    this.canonicalPath = this.native.canonicalPath;
    this.identity = `${this.native.dev}:${this.native.ino}`;
  }

  close(): void {
    this.native.close();
  }

  async requestedPathStillNamesGrant(): Promise<boolean> {
    try {
      const info = await stat(this.requestedPath, { bigint: true });
      return info.dev.toString() === this.native.dev && info.ino.toString() === this.native.ino;
    } catch {
      return false;
    }
  }

  stat(relativePath: string): NativeEntryStat {
    return this.native.stat(relativePath);
  }

  list(relativePath: string): NativeDirectoryEntry[] {
    return this.native.list(relativePath);
  }

  mkdirs(relativePath: string): void {
    this.native.mkdirs(relativePath);
  }

  write(relativePath: string, bytes: Uint8Array, append = false): void {
    this.native.write(relativePath, bytes, append);
  }

  writeExpected(relativePath: string, bytes: Uint8Array, expected: NativeFileIdentity): void {
    this.native.writeExpected(relativePath, bytes, expected);
  }

  setMode(relativePath: string, mode: number): void {
    this.native.setMode(relativePath, mode);
  }

  openSource(relativePath: string): RootedSource {
    return new RootedSource(this.native.openSource(relativePath));
  }

  atomicWrite(
    relativePath: string,
    bytes: Uint8Array,
    overwrite: boolean,
    expected?: NativeFileIdentity,
    creationMode?: number,
  ): void {
    this.native.atomicWrite(relativePath, bytes, overwrite, expected, creationMode);
  }

  renameNoReplace(sourcePath: string, targetPath: string): void {
    this.native.renameNoReplace(sourcePath, targetPath);
  }

  moveToStage(relativePath: string): string {
    return this.native.moveToStage(relativePath);
  }

  beginQuarantine(relativePath: string): NativeQuarantine {
    return this.native.beginQuarantine(relativePath);
  }

  copyFileNoReplace(sourcePath: string, targetPath: string): void {
    this.native.copyFileNoReplace(sourcePath, targetPath);
  }
}

export class RootedSource {
  readonly size: number;
  readonly mtimeMs: number;
  readonly resumeIdentity: string;
  readonly identity: NativeFileIdentity;
  private readonly native: NativeSource;

  constructor(native: NativeSource) {
    if (native.type !== 'file') {
      native.close();
      throw new Error('FILE_SOURCE_NOT_REGULAR');
    }
    this.native = native;
    this.size = native.size;
    this.mtimeMs = native.mtimeMs;
    try {
      this.identity = native.identity();
    } catch (error) {
      native.close();
      throw error;
    }
    this.resumeIdentity = createHash('sha256')
      .update(JSON.stringify([
        'native-file-v3', native.dev, native.ino, native.size, native.mtimeNs, native.ctimeNs,
        this.identity.contentSha256 ?? null,
      ]))
      .digest('hex');
  }

  read(offset: number, length: number): Uint8Array {
    return this.native.read(offset, length);
  }

  assertUnchanged(): void {
    this.native.stat();
  }

  close(): void {
    this.native.close();
  }
}

/** Read a host-owned browser output from the configured private stage. */
export function openPrivateStageSource(relativePath: string): RootedSource {
  return new RootedSource(openNativePrivateStageSource(relativePath));
}

export async function openRootGrants(paths: readonly string[]): Promise<RootGrant[]> {
  const grants: RootGrant[] = [];
  try {
    for (const path of paths) grants.push(new RootGrant(path));
    return grants;
  } catch (error) {
    for (const grant of grants) grant.close();
    throw error;
  }
}

export function closeRootGrants(grants: readonly RootGrant[]): void {
  for (const grant of grants) grant.close();
}

/**
 * Canonicalize an explicitly selected in-root symlink, then convert it to a
 * relative name under a pinned grant. Native traversal never follows another
 * symlink after this point.
 */
export async function resolveRootedPath(
  requested: string,
  cwd: string,
  grants: readonly RootGrant[],
  options: { allowMissing?: boolean } = {},
): Promise<RootedResolvedPath> {
  const absolute = resolve(cwd, requested);
  const lexical = grants
    .map((grant) => ({ grant, relativePath: portableRelative(grant.requestedPath, absolute) }))
    .find((candidate) => candidate.relativePath !== null);
  try {
    const canonical = options.allowMissing
      ? await canonicalForCreation(absolute)
      : await realpath(absolute);
    for (const grant of grants) {
      const relativePath = portableRelative(grant.canonicalPath, canonical);
      if (relativePath !== null) {
        return { grant, relativePath, displayPath: canonical };
      }
    }
    // A live approved root must not use lexical fallback to turn an explicit
    // in-root symlink to an outside object into an allowed relative path.
    if (lexical && await lexical.grant.requestedPathStillNamesGrant()) {
      throw pathDomainError(requested);
    }
  } catch (error) {
    if (!lexical) throw pathDomainError(requested);
    if (!options.allowMissing && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // A pinned root may have been renamed or its old pathname may have been
  // replaced. Continue under the granted object; native nofollow traversal
  // rejects any symlink component in the lexical suffix.
  if (lexical?.relativePath !== null && lexical?.relativePath !== undefined) {
    return {
      grant: lexical.grant,
      relativePath: lexical.relativePath,
      displayPath: join(lexical.grant.canonicalPath, ...lexical.relativePath.split('/')),
    };
  }
  throw pathDomainError(requested);
}

/** Open a user-selected standalone file under a pinned parent directory. */
export async function openStandaloneSource(path: string): Promise<{
  grant: RootGrant;
  source: RootedSource;
  canonicalPath: string;
}> {
  const canonicalPath = await realpath(path);
  const grant = new RootGrant(dirname(canonicalPath));
  try {
    const source = grant.openSource(basename(canonicalPath));
    return { grant, source, canonicalPath };
  } catch (error) {
    grant.close();
    throw error;
  }
}

export interface RootedWalkEntry extends NativeDirectoryEntry {
  relativePath: string;
  displayPath: string;
}

/** Recursive handle-relative walk. Symlinks are visible to callers but never followed. */
export function walkRooted(
  resolved: RootedResolvedPath,
  options: { maxDepth: number; skipDirectories?: ReadonlySet<string>; skipHidden?: boolean },
): RootedWalkEntry[] {
  const output: RootedWalkEntry[] = [];
  const visit = (relativeDirectory: string, depth: number): void => {
    for (const entry of resolved.grant.list(relativeDirectory).sort((a, b) => a.name.localeCompare(b.name))) {
      if (options.skipHidden && entry.name.startsWith('.')) continue;
      const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const displayPath = join(resolved.grant.canonicalPath, ...child.split('/'));
      output.push({ ...entry, relativePath: child, displayPath });
      if (
        entry.type === 'directory' && depth < options.maxDepth &&
        !options.skipDirectories?.has(entry.name)
      ) {
        visit(child, depth + 1);
      }
    }
  };
  const rootStat = resolved.grant.stat(resolved.relativePath);
  if (rootStat.type === 'directory') visit(resolved.relativePath, 0);
  return output;
}
