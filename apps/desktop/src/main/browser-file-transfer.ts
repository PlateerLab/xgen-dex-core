import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { UPLOAD_MAX_BYTES } from '@dex/protocol';
import { atomicWorkspaceWrite } from '@dex/engine/atomic-workspace-write';
import {
  RootGrant,
  nativeFsStagePath,
  openPrivateStageSource,
  resolveRootedPath,
  type RootedResolvedPath,
} from '@dex/engine/rooted-fs';

const OUTPUT_MAX_BYTES = 100 * 1024 * 1024;
const COPY_CHUNK = 8 * 1024 * 1024;

type Scope = { names: string[]; grants: RootGrant[]; abort: AbortController };

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2));
  return value;
}

/** Grants remain pinned for the conversation, including across calls. */
export class BrowserFileScopes {
  private scopes = new Map<string, Scope>();

  clear(interactionId?: string): void {
    for (const [key, scope] of this.scopes) {
      if (interactionId !== undefined && key !== interactionId) continue;
      scope.abort.abort(new Error('브라우저 파일 권한이 해제되었습니다.'));
      for (const grant of scope.grants) grant.close();
      this.scopes.delete(key);
    }
  }

  signal(interactionId: string): AbortSignal {
    return this.scopes.get(interactionId)?.abort.signal ?? AbortSignal.abort(new Error('브라우저 파일 권한이 해제되었습니다.'));
  }

  async resolve(
    raw: unknown,
    interactionId: string,
    folderNames: string[],
    allowMissing: boolean,
  ): Promise<RootedResolvedPath> {
    if (!folderNames.length) throw new Error('이 대화에 연결된 폴더가 없어 파일을 사용할 수 없습니다.');
    const requested = String(raw ?? '').trim();
    if (!requested) throw new Error('파일 경로가 필요합니다.');
    const names = folderNames.map((name) => resolve(expandHome(name)));
    let scope = this.scopes.get(interactionId);
    if (scope && (scope.names.length !== names.length || scope.names.some((name, i) => name !== names[i]))) {
      this.clear(interactionId);
      scope = undefined;
    }
    if (!scope) {
      const grants: RootGrant[] = [];
      try {
        for (const name of names) grants.push(new RootGrant(name));
      } catch (error) {
        for (const grant of grants) grant.close();
        throw error;
      }
      scope = { names, grants, abort: new AbortController() };
      this.scopes.set(interactionId, scope);
    }
    const expanded = expandHome(requested);
    const absolute = isAbsolute(expanded) ? expanded : resolve(names[0], expanded);
    return resolveRootedPath(absolute, names[0], scope.grants, { allowMissing });
  }
}

/** Only the trusted desktop host and the browser helper can name this directory. */
export class BrowserScratch {
  private constructor(readonly directory: string) {}

  static async create(): Promise<BrowserScratch> {
    const stage = nativeFsStagePath();
    if (!stage) throw new Error('브라우저 파일 작업에 필요한 비공개 파일 영역이 없습니다.');
    return new BrowserScratch(await mkdtemp(join(stage, 'browser-')));
  }

  path(name: string): string {
    if (basename(name) !== name || name === '.' || name === '..') throw new Error('invalid scratch filename');
    return join(this.directory, name);
  }

  async uploadFrom(sourcePath: RootedResolvedPath, index: number, signal?: AbortSignal): Promise<string> {
    const source = sourcePath.grant.openSource(sourcePath.relativePath);
    const name = sourcePath.relativePath.split('/').at(-1) || 'file';
    const uploadDirectory = this.path(`upload-${index}`);
    const path = join(uploadDirectory, name);
    let output;
    try {
      signal?.throwIfAborted();
      if (source.size > UPLOAD_MAX_BYTES) throw new Error('브라우저 업로드 파일은 1GiB를 넘을 수 없습니다.');
      await mkdir(uploadDirectory, { mode: 0o700 });
      output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      for (let offset = 0; offset < source.size; offset += COPY_CHUNK) {
        signal?.throwIfAborted();
        const chunk = source.read(offset, Math.min(COPY_CHUNK, source.size - offset));
        let written = 0;
        while (written < chunk.byteLength) {
          const result = await output.write(chunk, written, chunk.byteLength - written);
          if (result.bytesWritten <= 0) throw new Error('브라우저 업로드 임시 파일 쓰기에 실패했습니다.');
          written += result.bytesWritten;
        }
      }
      signal?.throwIfAborted();
      source.assertUnchanged();
      await output.sync();
      return path;
    } finally {
      source.close();
      await output?.close();
    }
  }

  async readOutput(name: string): Promise<Uint8Array> {
    const source = openPrivateStageSource(relative(nativeFsStagePath(), this.path(name)).split('\\').join('/'));
    try {
      if (source.size > OUTPUT_MAX_BYTES) {
        throw new Error('브라우저 출력은 일반 파일이어야 하며 100MiB를 넘을 수 없습니다.');
      }
      const bytes = new Uint8Array(source.size);
      for (let offset = 0; offset < bytes.byteLength; offset += COPY_CHUNK) {
        bytes.set(source.read(offset, Math.min(COPY_CHUNK, bytes.byteLength - offset)), offset);
      }
      source.assertUnchanged();
      return bytes;
    } finally {
      source.close();
    }
  }

  async commit(name: string, target: RootedResolvedPath, signal?: AbortSignal): Promise<void> {
    const bytes = await this.readOutput(name);
    const parent = target.relativePath.split('/').slice(0, -1).join('/');
    target.grant.mkdirs(parent);
    signal?.throwIfAborted();
    let source;
    try {
      source = target.grant.openSource(target.relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (source) {
      try {
        target.grant.writeExpected(target.relativePath, bytes, source.identity);
      } finally {
        source.close();
      }
    } else {
      await atomicWorkspaceWrite(target, bytes, {
        overwrite: false, creationMode: 0o666 & ~process.umask(), ...(signal ? { signal } : {}),
      });
    }
  }

  async cleanup(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}

/** Keep private staging paths out of tool responses and errors. */
export function displayBrowserFileResult(result: unknown, scratch: BrowserScratch, paths: ReadonlyMap<string, string>): unknown {
  const replace = (value: string): string => {
    let clean = value;
    for (const [privatePath, displayPath] of paths) clean = clean.split(privatePath).join(displayPath);
    return clean.split(scratch.directory).join('[private browser staging]');
  };
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return replace(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    }
    return value;
  };
  return visit(result);
}
