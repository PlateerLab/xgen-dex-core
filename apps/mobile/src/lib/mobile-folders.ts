/**
 * 대화에 연결된 휴대폰 폴더 — 모바일 도구가 닿는 범위의 유일한 출처.
 *
 * 휴대폰에는 사용자가 알아볼 절대 경로가 없다(안드로이드는 content:// URI, iOS 는
 * 앱마다 다른 컨테이너 경로). 그래서 에이전트에게는 **가상 경로**를 준다: 연결한
 * 폴더마다 `/<이름>` 이 뿌리이고, 도구의 경로는 그 아래 상대 경로다. 같은 이름의
 * 폴더가 둘이면 "(2)" 를 붙여 가른다.
 *
 * 이 파일은 순수하다(네이티브·저장소 없음) — 장부, 경로 해석, 요청 모양만 다룬다.
 */
import { sha256 } from 'js-sha256';

/** 한 대화에 연결된 폴더 하나. */
export interface MobileFolder {
  id: string;
  /** 대화 안에서 겹치지 않는 이름 — 가상 경로 `/<name>` 의 뿌리. */
  name: string;
  /** Android: 트리 URI(content://…), iOS: 고를 때의 file:// URL(표시·식별용). */
  uri: string;
  /** iOS 만 — 다음 실행에서 접근을 되살리는 북마크(base64). */
  bookmark?: string;
}

/** 서버 요청(`local_folders`)의 항목 — path 는 가상 경로다. */
export interface LocalFolderWire {
  id: string;
  name: string;
  path: string;
}

export const MAX_FOLDERS_PER_CONVERSATION = 32;
export const MAX_REMEMBERED_CONVERSATIONS = 300;

/** 폴더가 없는 대화에서 폴더 도구를 불렀을 때 에이전트가 받는 문장. */
export const NO_FOLDER_MESSAGE =
  '[NO_FOLDER] 이 대화에는 연결된 휴대폰 폴더가 없어 파일을 다룰 수 없습니다. ' +
  '사용자에게 채팅 위 [폴더 연결]로 작업할 폴더를 연결해 달라고 요청하세요.';

export function folderIdOf(uri: string): string {
  return sha256(uri).slice(0, 16);
}

export function virtualRoot(folder: Pick<MobileFolder, 'name'>): string {
  return `/${folder.name}`;
}

export function toWire(folders: MobileFolder[]): LocalFolderWire[] {
  return folders.map((folder) => ({ id: folder.id, name: folder.name, path: virtualRoot(folder) }));
}

/** 가상 경로의 이름으로 쓸 수 있게 다듬는다 — 구분자와 빈 이름을 없앤다. */
function cleanName(raw: string): string {
  const name = String(raw ?? '')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name && name !== '.' && name !== '..' ? name : '폴더';
}

/** 대화 안에서 겹치지 않는 이름. 대소문자만 다른 이름도 겹친 것으로 본다. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const name = cleanName(base);
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** 경로 조각 — `.`·`..` 는 거부한다(폴더 밖으로 나갈 수 없다). */
export function pathSegments(raw: string): string[] {
  const parts = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`[PATH_DOMAIN_MISMATCH] 허용되지 않는 경로입니다: ${raw}`);
  }
  return parts;
}

export interface ResolvedPath {
  folder: MobileFolder;
  /** 폴더 안의 상대 경로('' = 폴더 자체). */
  rel: string;
  /** 에이전트에게 돌려줄 가상 경로. */
  display: string;
}

/**
 * 에이전트가 준 경로 → (폴더, 상대 경로).
 *
 * `/<폴더 이름>/…` 은 그 폴더, 그 밖의 경로(상대 경로·빈 경로)는 첫 번째 폴더
 * 기준이다. 절대 경로인데 첫 조각이 연결된 폴더 이름이 아니면 거부한다 — 휴대폰의
 * 다른 곳을 가리키는 경로를 첫 폴더 아래로 조용히 옮기지 않는다.
 */
export function resolveFolderPath(folders: MobileFolder[], raw: unknown): ResolvedPath {
  if (!folders.length) throw new Error(NO_FOLDER_MESSAGE);
  const text = String(raw ?? '').trim();
  const parts = pathSegments(text);
  const absolute = text.startsWith('/') || text.startsWith('\\');
  let folder = folders[0];
  let rest = parts;
  if (absolute && parts.length) {
    const head = parts[0];
    const match =
      folders.find((candidate) => candidate.name === head) ??
      folders.find((candidate) => candidate.name.toLowerCase() === head.toLowerCase());
    if (!match) {
      throw new Error(
        `[PATH_DOMAIN_MISMATCH] 연결된 폴더 밖의 경로입니다: ${text} ` +
          `(연결된 폴더: ${folders.map(virtualRoot).join(', ')})`,
      );
    }
    folder = match;
    rest = parts.slice(1);
  }
  const rel = rest.join('/');
  return { folder, rel, display: rel ? `${virtualRoot(folder)}/${rel}` : virtualRoot(folder) };
}

interface BookEntry {
  folders: MobileFolder[];
  updatedAt: number;
}

export type MobileFolderSnapshot = Record<string, BookEntry>;

function normalizeFolders(raw: unknown): MobileFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: MobileFolder[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const uri = String(record.uri ?? '').trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const bookmark = typeof record.bookmark === 'string' && record.bookmark ? record.bookmark : undefined;
    out.push({
      id: String(record.id ?? '') || folderIdOf(uri),
      name: uniqueName(String(record.name ?? ''), out.map((folder) => folder.name)),
      uri,
      ...(bookmark ? { bookmark } : {}),
    });
    if (out.length >= MAX_FOLDERS_PER_CONVERSATION) break;
  }
  return out;
}

export type MobileFolderListener = (interactionId: string, folders: MobileFolder[]) => void;

/** 대화별 폴더 장부 — 저장 방법은 모른다(바뀔 때 persist 를 부른다). */
export class MobileFolderBook {
  private entries = new Map<string, BookEntry>();
  private listeners = new Set<MobileFolderListener>();

  constructor(
    private readonly options: {
      persist?: (snapshot: MobileFolderSnapshot) => void;
      now?: () => number;
      maxConversations?: number;
    } = {},
  ) {}

  load(snapshot: unknown): void {
    this.entries.clear();
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [id, value] of Object.entries(snapshot as Record<string, unknown>)) {
      if (!id.trim() || !value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const folders = normalizeFolders(record.folders);
      if (!folders.length) continue;
      const updatedAt = Number(record.updatedAt);
      this.entries.set(id, { folders, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 });
    }
    this.evict();
  }

  list(interactionId: string | undefined | null): MobileFolder[] {
    const key = String(interactionId ?? '').trim();
    return key ? [...(this.entries.get(key)?.folders ?? [])] : [];
  }

  /** 고른 폴더를 더한다. 같은 폴더(같은 URI)는 다시 더하지 않는다. */
  add(interactionId: string, picked: Array<Pick<MobileFolder, 'uri' | 'name' | 'bookmark'>>): MobileFolder[] {
    const current = this.list(interactionId);
    return this.set(interactionId, [...current, ...picked]);
  }

  remove(interactionId: string, folderId: string): MobileFolder[] {
    return this.set(
      interactionId,
      this.list(interactionId).filter((folder) => folder.id !== folderId),
    );
  }

  /** iOS 북마크가 새로 발급됐을 때(폴더가 옮겨졌을 때) 저장본을 바꾼다. 알림은 없다. */
  updateBookmark(uri: string, bookmark: string): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      for (const folder of entry.folders) {
        if (folder.uri === uri && folder.bookmark !== bookmark) {
          folder.bookmark = bookmark;
          changed = true;
        }
      }
    }
    if (changed) this.options.persist?.(this.snapshot());
  }

  forget(interactionId: string): void {
    this.set(interactionId, []);
  }

  /** 모든 대화에서 쓰이는 폴더 URI — 해제한 폴더가 다른 대화에 남았는지 볼 때 쓴다. */
  inUse(uri: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.folders.some((folder) => folder.uri === uri)) return true;
    }
    return false;
  }

  set(interactionId: string, folders: unknown): MobileFolder[] {
    const key = String(interactionId ?? '').trim();
    if (!key) return [];
    const next = normalizeFolders(folders);
    const before = this.entries.get(key)?.folders ?? [];
    const same =
      before.length === next.length &&
      before.every((folder, index) => folder.uri === next[index].uri && folder.name === next[index].name);
    if (same) return [...before];
    if (next.length) this.entries.set(key, { folders: next, updatedAt: this.now() });
    else this.entries.delete(key);
    this.evict();
    this.options.persist?.(this.snapshot());
    for (const listener of this.listeners) {
      try {
        listener(key, [...next]);
      } catch {
        /* 한 구독자의 실패가 다른 구독자를 막지 않는다 */
      }
    }
    return [...next];
  }

  snapshot(): MobileFolderSnapshot {
    const out: MobileFolderSnapshot = {};
    for (const [id, entry] of this.entries) {
      out[id] = { folders: entry.folders.map((folder) => ({ ...folder })), updatedAt: entry.updatedAt };
    }
    return out;
  }

  onChange(listener: MobileFolderListener): () => void {
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
}
