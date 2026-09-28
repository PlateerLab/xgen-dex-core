/**
 * 대화에 연결된 이 기기의 폴더 — 로컬 도구가 닿을 수 있는 범위의 유일한 출처.
 *
 * 예전에는 설정의 [로컬 컨트롤] 스위치 하나가 모든 대화에 같은 범위를 열었다.
 * 그러면 어느 대화에서 무엇을 만져도 되는지를 사용자가 대화마다 정할 수 없고,
 * 스위치를 켜 둔 동안에는 상관없는 대화도 같은 폴더를 본다. 이제 범위는 **대화에
 * 붙는다**: 사용자가 그 대화에 연결한 폴더 안에서만 파일 도구와 터미널이 돈다.
 *
 * 이 기기가 권한의 주인이다. 서버도 요청의 `local_folders` 로 같은 목록을 알지만,
 * 도구 호출을 허락할지는 여기서 대화 id(`interaction_id`)로 다시 찾은 목록이
 * 정한다 — 서버가 범위를 넓혀 부를 수 없게.
 */
import { createHash } from 'node:crypto';
import { platform } from 'node:os';
import { basename, isAbsolute, resolve as pathResolve } from 'node:path';

/** 한 대화에 연결된 폴더 하나. `path` 는 이 기기의 절대 경로다. */
export interface LocalFolder {
  id: string;
  name: string;
  path: string;
}

/** 한 대화에 연결할 수 있는 폴더 수 — 서버 요청 모델(max 32)과 같다. */
export const MAX_FOLDERS_PER_CONVERSATION = 32;
/** 기억해 두는 대화 수 — 넘치면 가장 오래 손대지 않은 대화부터 잊는다. */
export const MAX_REMEMBERED_CONVERSATIONS = 500;

const IS_WIN = platform() === 'win32';

/** 같은 폴더인지 비교할 열쇠. Windows 경로는 대소문자를 구분하지 않는다. */
function pathKey(path: string): string {
  return IS_WIN ? path.toLowerCase() : path;
}

/** 끝의 구분자를 떼되 루트(`/`, `C:\`)는 그대로 둔다. */
function trimTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path.slice(0, 1) || path;
  if (/^[a-zA-Z]:$/.test(trimmed)) return `${trimmed}\\`;
  return trimmed;
}

/** 절대 경로로 정규화한다. 상대 경로는 받지 않는다 — 기준이 모호하다. */
export function normalizeFolderPath(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (!text || text.includes('\0')) return null;
  if (!isAbsolute(text)) return null;
  return trimTrailingSeparator(pathResolve(text));
}

/** 목록에 보일 이름 — 폴더 이름, 루트면 경로 자체. */
export function folderDisplayName(path: string): string {
  return basename(path) || path;
}

/** 경로에서 나온 안정적인 id — 같은 폴더를 다시 연결해도 id 가 같다. */
export function folderIdOf(path: string): string {
  return createHash('sha256').update(pathKey(path)).digest('hex').slice(0, 16);
}

export function makeLocalFolder(path: string): LocalFolder | null {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return null;
  return { id: folderIdOf(normalized), name: folderDisplayName(normalized), path: normalized };
}

/** 느슨한 입력(저장 파일·IPC)을 폴더 목록으로 — 경로 없는 항목과 중복은 버린다. */
export function normalizeLocalFolders(raw: unknown): LocalFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalFolder[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const path =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? (item as Record<string, unknown>).path
          : undefined;
    const folder = makeLocalFolder(String(path ?? ''));
    if (!folder || seen.has(pathKey(folder.path))) continue;
    const name = item && typeof item === 'object' ? String((item as Record<string, unknown>).name ?? '').trim() : '';
    seen.add(pathKey(folder.path));
    out.push(name ? { ...folder, name } : folder);
    if (out.length >= MAX_FOLDERS_PER_CONVERSATION) break;
  }
  return out;
}

/** 서버 요청(`local_folders`)에 싣는 모양. */
export function localFoldersForRequest(folders: LocalFolder[]): LocalFolder[] {
  return folders.map((folder) => ({ id: folder.id, name: folder.name, path: folder.path }));
}

interface BookEntry {
  folders: LocalFolder[];
  updatedAt: number;
}

/** 저장 파일에 쓰는 모양 — 대화 id → 폴더 목록. */
export type ConversationFolderSnapshot = Record<string, { folders: LocalFolder[]; updatedAt: number }>;

export type ConversationFolderListener = (interactionId: string, folders: LocalFolder[]) => void;

/**
 * 대화별 폴더 장부.
 *
 * 데스크톱은 계정별로 파일에 저장하고, CLI 와 VSCode 는 실행 동안만 들고 있는다
 * (그 둘은 대화를 시작할 때마다 지금 폴더를 다시 붙인다). 장부는 저장 방법을
 * 모른다 — 바뀔 때마다 `persist` 를 부를 뿐이다.
 */
export class ConversationFolderBook {
  private entries = new Map<string, BookEntry>();
  private listeners = new Set<ConversationFolderListener>();

  constructor(
    private readonly options: {
      persist?: (snapshot: ConversationFolderSnapshot) => void;
      maxConversations?: number;
      now?: () => number;
    } = {},
  ) {}

  /** 저장된 장부를 읽는다. 알림은 보내지 않는다(시작 시 한 번). */
  load(snapshot: unknown): void {
    this.entries.clear();
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [id, value] of Object.entries(snapshot as Record<string, unknown>)) {
      const key = id.trim();
      if (!key || !value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const folders = normalizeLocalFolders(record.folders);
      if (!folders.length) continue;
      const updatedAt = Number(record.updatedAt);
      this.entries.set(key, { folders, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 });
    }
    this.evict();
  }

  list(interactionId: string | undefined | null): LocalFolder[] {
    const key = String(interactionId ?? '').trim();
    if (!key) return [];
    return [...(this.entries.get(key)?.folders ?? [])];
  }

  /** 폴더를 더한다. 이미 있는 폴더는 그대로 두고, 상한을 넘는 것은 버린다. */
  add(interactionId: string, paths: string[]): LocalFolder[] {
    const current = this.list(interactionId);
    return this.set(interactionId, [...current, ...paths.map((path) => ({ path }))]);
  }

  remove(interactionId: string, folderId: string): LocalFolder[] {
    const current = this.list(interactionId);
    return this.set(
      interactionId,
      current.filter((folder) => folder.id !== folderId),
    );
  }

  /** 목록을 통째로 바꾼다. 빈 목록이면 그 대화를 잊는다. */
  set(interactionId: string, folders: unknown): LocalFolder[] {
    const key = String(interactionId ?? '').trim();
    if (!key) return [];
    const next = normalizeLocalFolders(folders);
    const before = this.entries.get(key)?.folders ?? [];
    if (sameFolders(before, next)) return [...before];
    if (next.length) this.entries.set(key, { folders: next, updatedAt: this.now() });
    else this.entries.delete(key);
    this.evict();
    this.changed(key, next);
    return [...next];
  }

  /** 대화가 지워졌을 때 — 그 대화의 폴더 연결도 없앤다. */
  forget(interactionId: string): void {
    this.set(interactionId, []);
  }

  snapshot(): ConversationFolderSnapshot {
    const out: ConversationFolderSnapshot = {};
    for (const [id, entry] of this.entries) {
      out[id] = { folders: entry.folders.map((folder) => ({ ...folder })), updatedAt: entry.updatedAt };
    }
    return out;
  }

  onChange(listener: ConversationFolderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private evict(): void {
    const limit = this.options.maxConversations ?? MAX_REMEMBERED_CONVERSATIONS;
    if (this.entries.size <= limit) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of oldest.slice(0, this.entries.size - limit)) this.entries.delete(id);
  }

  private changed(interactionId: string, folders: LocalFolder[]): void {
    this.options.persist?.(this.snapshot());
    for (const listener of this.listeners) {
      try {
        listener(interactionId, [...folders]);
      } catch {
        /* 한 구독자의 실패가 다른 구독자를 막지 않는다 */
      }
    }
  }
}

export function sameFolders(a: LocalFolder[], b: LocalFolder[]): boolean {
  return (
    a.length === b.length &&
    a.every((folder, index) => folder.path === b[index].path && folder.name === b[index].name)
  );
}
