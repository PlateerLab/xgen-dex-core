/**
 * 대화별 폴더 연결 — 데스크톱의 장부 저장소.
 *
 * 사용자가 채팅 헤더의 [폴더 연결]로 고른 폴더가 그 대화의 작업 공간이다. 이
 * 파일은 그 목록을 **계정마다** 따로 저장한다(같은 PC 에 다른 계정으로 로그인하면
 * 그 계정의 대화에는 이 계정의 폴더가 보이지 않아야 한다). 계정이 바뀌면 다음
 * 조회 때 그 계정의 장부로 바뀐다.
 *
 * 경로는 사용자가 네이티브 선택 창에서 고른 것만 들어온다 — 렌더러가 경로
 * 문자열을 보내 스스로 범위를 넓힐 수 없다.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConversationFolderBook,
  type ConversationFolderSnapshot,
  type LocalFolder,
} from '@dex/engine/local-folders';

/** 화면에 보이는 폴더 — 지금 이 PC 에 있는지를 함께 알린다. */
export interface ChatFolderView extends LocalFolder {
  missing: boolean;
}

/** 이 대화의 서버 사본을 이 PC 에서 본 것 — [폴더] 창과 헤더가 쓴다. */
export interface ChatFolderRemote {
  /** 서버 사본. 옛 서버·오프라인이면 null(이 PC 장부만 보인다). */
  state: import('@dex/protocol/conversation-folders').ConversationFoldersState | null;
  /** 이 PC 의 기기 id — 사본의 기기와 비교해 "다른 기기" 를 가른다. */
  deviceId: string;
  /** 서버가 이 대화에 기기 하나만 받는다(옛 서버, 표를 아직 바꾸지 않은 서버) — [이 기기로 옮기기]. */
  exclusive: boolean;
  /** 이 대화에서 마지막으로 다른 화면에서 온 요청으로 조작한 것. */
  lastRemoteUse: import('@dex/engine/local-tools').RemoteFolderUse | null;
}

export type ChatFolderListener = (interactionId: string, folders: LocalFolder[]) => void;

function writeAtomic(file: string, snapshot: ConversationFolderSnapshot): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    renameSync(tmp, file);
  } catch (error) {
    console.error('[chat-folders] 저장 실패:', error);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class ChatFolderStore {
  private account: string | null = null;
  private book: ConversationFolderBook | null = null;
  private listeners = new Set<ChatFolderListener>();

  constructor(
    private readonly dir: string,
    private readonly accountKey: () => string | null,
  ) {}

  /** 이 대화에 연결된 폴더. 로그인 전이면 빈 목록. */
  list(interactionId: string | undefined | null): LocalFolder[] {
    return this.current()?.list(interactionId) ?? [];
  }

  view(interactionId: string): ChatFolderView[] {
    return this.list(interactionId).map((folder) => ({
      ...folder,
      missing: !existsSync(folder.path),
    }));
  }

  /** 선택 창에서 고른 폴더를 더한다. 폴더가 아닌 경로는 버린다. */
  add(interactionId: string, paths: string[]): LocalFolder[] {
    const book = this.requireBook();
    return book.add(interactionId, paths.filter(isDirectory));
  }

  remove(interactionId: string, folderId: string): LocalFolder[] {
    return this.requireBook().remove(interactionId, folderId);
  }

  /** 대화가 지워졌을 때 그 대화의 폴더 연결도 없앤다. */
  forget(interactionId: string): void {
    this.current()?.forget(interactionId);
  }

  /** 목록을 통째로 바꾼다(되돌리기·옮기기). 폴더가 아닌 경로는 버린다. */
  set(interactionId: string, folders: LocalFolder[]): LocalFolder[] {
    return this.requireBook().set(
      interactionId,
      folders.filter((folder) => isDirectory(folder.path)),
    );
  }

  /** 지금 계정의 장부 전체 — 서버 사본과 맞출 때. 로그인 전이면 빈 목록. */
  entries(): { interactionId: string; folders: LocalFolder[] }[] {
    const snapshot = this.current()?.snapshot() ?? {};
    return Object.entries(snapshot).map(([interactionId, entry]) => ({
      interactionId,
      folders: entry.folders,
    }));
  }

  /** 지금 계정 — 맞추기를 계정마다 한 번씩 하려고. */
  accountId(): string | null {
    return this.accountKey();
  }

  onChange(listener: ChatFolderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireBook(): ConversationFolderBook {
    const book = this.current();
    if (!book) throw new Error('로그인한 뒤에 폴더를 연결할 수 있습니다.');
    return book;
  }

  private current(): ConversationFolderBook | null {
    const key = this.accountKey();
    if (!key) return null;
    if (this.book && this.account === key) return this.book;
    const name = createHash('sha256').update(key).digest('hex').slice(0, 24);
    const file = join(this.dir, `${name}.json`);
    const book = new ConversationFolderBook({ persist: (snapshot) => writeAtomic(file, snapshot) });
    try {
      book.load(JSON.parse(readFileSync(file, 'utf-8')));
    } catch {
      /* 처음이거나 깨진 파일 — 빈 장부로 시작한다 */
    }
    book.onChange((interactionId, folders) => {
      for (const listener of this.listeners) listener(interactionId, folders);
    });
    this.account = key;
    this.book = book;
    return book;
  }
}
