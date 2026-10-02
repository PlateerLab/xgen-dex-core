/**
 * 연결한 휴대폰 폴더의 파일 작업 — 플랫폼별 구현.
 *
 * - Android: 네이티브 모듈(XgenFolderAccess)이 문서 제공자 트리 안에서 한다.
 *   트리 밖으로는 닿을 수 없다.
 * - iOS: 네이티브 모듈이 북마크를 풀어 이 프로세스에 그 폴더의 접근을 열어 두고,
 *   파일 작업은 expo-file-system 이 file:// 로 한다.
 *
 * 경로 검증(`..` 거부·가상 경로 해석)은 mobile-folders 가 이미 했다. 여기서는
 * 폴더 기준 상대 경로만 받는다.
 */
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { FolderAccess, type PickedFolder } from '../../modules/xgen-folder-access';
import type { MobileFolder } from './mobile-folders';
import { pathSegments } from './mobile-folders';
import type { FolderEntry, FolderFs } from './mobile-tools';

const UNSUPPORTED = '이 기기에서는 폴더 연결을 지원하지 않습니다.';

function native() {
  if (!FolderAccess) throw new Error(UNSUPPORTED);
  return FolderAccess;
}

export function folderAccessSupported(): boolean {
  return !!FolderAccess && (Platform.OS === 'android' || Platform.OS === 'ios');
}

/** 시스템 폴더 선택기. 취소하면 빈 목록. */
export async function pickFolders(): Promise<PickedFolder[]> {
  const picked = await native().pickFolders();
  return Array.isArray(picked) ? picked.filter((folder) => !!folder?.uri) : [];
}

/** 폴더 연결을 끊을 때 — Android 는 영구 권한을 돌려주고, iOS 는 접근을 닫는다. */
export async function releaseFolder(folder: MobileFolder, resolvedUri?: string): Promise<void> {
  if (!FolderAccess) return;
  try {
    await FolderAccess.release(Platform.OS === 'ios' ? resolvedUri ?? folder.uri : folder.uri);
  } catch {
    /* 이미 없어진 권한 — 조용히 넘어간다 */
  }
}

// ── iOS: 북마크 → file:// ─────────────────────────────────────────

const resolved = new Map<string, string>();

/** iOS 북마크를 풀어 접근을 연다(실행마다 한 번). 새 북마크가 나오면 알린다. */
export async function iosFolderUri(
  folder: MobileFolder,
  onBookmarkRenewed?: (uri: string, bookmark: string) => void,
): Promise<string> {
  const cached = resolved.get(folder.id);
  if (cached) return cached;
  const mod = native();
  if (!mod.resolveBookmark || !folder.bookmark) {
    throw new Error('폴더 정보를 찾지 못했습니다. 폴더를 다시 연결하세요.');
  }
  const r = await mod.resolveBookmark(folder.bookmark);
  if (r.stale && r.bookmark && r.bookmark !== folder.bookmark) onBookmarkRenewed?.(folder.uri, r.bookmark);
  const uri = r.uri.endsWith('/') ? r.uri : `${r.uri}/`;
  resolved.set(folder.id, uri);
  return uri;
}

export function forgetResolved(folder: MobileFolder): string | undefined {
  const uri = resolved.get(folder.id);
  resolved.delete(folder.id);
  return uri;
}

function encodeRel(rel: string): string {
  return pathSegments(rel).map(encodeURIComponent).join('/');
}

function createIosFs(onBookmarkRenewed?: (uri: string, bookmark: string) => void): FolderFs {
  const at = async (folder: MobileFolder, rel: string): Promise<string> =>
    `${await iosFolderUri(folder, onBookmarkRenewed)}${encodeRel(rel)}`;
  const parentOf = (rel: string): string => pathSegments(rel).slice(0, -1).join('/');
  return {
    async list(folder, rel) {
      const dir = await at(folder, rel);
      const names = await FileSystem.readDirectoryAsync(dir);
      const out: FolderEntry[] = [];
      for (const name of names) {
        const info = await FileSystem.getInfoAsync(`${dir.replace(/\/$/, '')}/${encodeURIComponent(name)}`);
        out.push({
          name,
          isDir: info.exists && info.isDirectory === true,
          size: info.exists && 'size' in info ? Number(info.size ?? 0) : 0,
          // expo-file-system 은 초 단위다.
          ...(info.exists && info.modificationTime ? { modified: Math.round(info.modificationTime * 1000) } : {}),
        });
      }
      return out;
    },
    async stat(folder, rel) {
      const info = await FileSystem.getInfoAsync(await at(folder, rel));
      return {
        exists: info.exists,
        isDir: info.exists && info.isDirectory === true,
        size: info.exists && 'size' in info ? Number(info.size ?? 0) : 0,
      };
    },
    async readText(folder, rel, maxBytes) {
      const uri = await at(folder, rel);
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) throw new Error(`파일이 없습니다: ${rel}`);
      if (info.isDirectory) throw new Error(`폴더는 읽을 수 없습니다: ${rel}`);
      const size = 'size' in info ? Number(info.size ?? 0) : 0;
      const text =
        size > maxBytes
          ? await FileSystem.readAsStringAsync(uri, { position: 0, length: maxBytes, encoding: 'base64' }).then(
              decodeBase64Utf8,
            )
          : await FileSystem.readAsStringAsync(uri);
      return { text, size, truncated: size > maxBytes };
    },
    async writeText(folder, rel, content, append) {
      const uri = await at(folder, rel);
      const parent = parentOf(rel);
      if (parent) {
        await FileSystem.makeDirectoryAsync(await at(folder, parent), { intermediates: true }).catch(() => undefined);
      }
      if (append) {
        const info = await FileSystem.getInfoAsync(uri);
        const previous = info.exists ? await FileSystem.readAsStringAsync(uri) : '';
        await FileSystem.writeAsStringAsync(uri, previous + content);
      } else {
        await FileSystem.writeAsStringAsync(uri, content);
      }
    },
    async importFile(folder, rel, sourceUri) {
      const parent = parentOf(rel);
      if (parent) {
        await FileSystem.makeDirectoryAsync(await at(folder, parent), { intermediates: true }).catch(() => undefined);
      }
      await FileSystem.copyAsync({ from: sourceUri, to: await at(folder, rel) });
    },
    async remove(folder, rel) {
      if (!pathSegments(rel).length) throw new Error('연결한 폴더 자체는 지울 수 없습니다.');
      const uri = await at(folder, rel);
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) throw new Error(`파일이 없습니다: ${rel}`);
      await FileSystem.deleteAsync(uri);
    },
    async exportFile(folder, rel) {
      // 다른 앱은 이 앱이 연 보안 범위를 모른다 — 캐시에 사본을 두고 넘긴다.
      const name = pathSegments(rel).at(-1) ?? 'file';
      const dir = `${FileSystem.cacheDirectory ?? ''}xgen-open/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      const target = `${dir}${encodeURIComponent(name)}`;
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      await FileSystem.copyAsync({ from: await at(folder, rel), to: target });
      return target;
    },
  };
}

function createAndroidFs(): FolderFs {
  // 모듈 메서드는 모듈 객체에서 부른다(떼어 내 부르지 않는다).
  const android = () => {
    const mod = native();
    if (!mod.list || !mod.stat || !mod.readText || !mod.writeText || !mod.importFile || !mod.remove || !mod.exportFile) {
      throw new Error(UNSUPPORTED);
    }
    return mod as Required<typeof mod>;
  };
  return {
    list: (folder, rel) => android().list(folder.uri, rel),
    stat: (folder, rel) => android().stat(folder.uri, rel),
    readText: (folder, rel, maxBytes) => android().readText(folder.uri, rel, maxBytes),
    writeText: (folder, rel, content, append) => android().writeText(folder.uri, rel, content, append),
    importFile: (folder, rel, sourceUri) => android().importFile(folder.uri, rel, sourceUri),
    remove: (folder, rel) => android().remove(folder.uri, rel),
    exportFile: (folder, rel) => android().exportFile(folder.uri, rel),
  };
}

/** 이 플랫폼의 폴더 파일 작업. */
export function createFolderFs(onBookmarkRenewed?: (uri: string, bookmark: string) => void): FolderFs {
  return Platform.OS === 'ios' ? createIosFs(onBookmarkRenewed) : createAndroidFs();
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 → UTF-8 문자열. 잘린 끝의 반쪽 글자는 버린다(엔진에 TextDecoder 가 없어도 돈다). */
export function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    bytes.push((n >> 16) & 0xff);
    if (i + 2 < clean.length) bytes.push((n >> 8) & 0xff);
    if (i + 3 < clean.length) bytes.push(n & 0xff);
  }
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    const len = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (i + len > bytes.length) break; // 잘린 마지막 글자
    let cp = len === 1 ? b : b & (0xff >> (len + 1));
    for (let k = 1; k < len; k += 1) cp = (cp << 6) | (bytes[i + k] & 0x3f);
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}
