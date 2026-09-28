/**
 * 대화별 폴더 연결 — 앱 전체가 함께 보는 한 곳.
 *
 * 채팅 화면(헤더의 [폴더 연결])이 더하고 빼고, 도구 브리지는 호출마다 그 대화의
 * 폴더를 여기서 찾는다. 계정마다 따로 저장한다 — 로그아웃하고 다른 계정으로
 * 들어오면 이전 계정의 폴더가 보이지 않는다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { diagLog } from './diag';
import {
  createFolderFs,
  folderAccessSupported,
  forgetResolved,
  pickFolders,
  releaseFolder,
} from './folder-fs';
import { MobileFolderBook, type MobileFolder } from './mobile-folders';
import type { FolderFs } from './mobile-tools';

const STORAGE_PREFIX = 'chat-folders:';

let account = '';
let loaded: Promise<void> = Promise.resolve();

const book = new MobileFolderBook({
  persist: (snapshot) => {
    if (!account) return;
    void AsyncStorage.setItem(`${STORAGE_PREFIX}${account}`, JSON.stringify(snapshot)).catch(() => undefined);
  },
});

/** 폴더 파일 작업 — iOS 북마크가 새로 발급되면 장부에 저장한다. */
export const folderFs: FolderFs = createFolderFs((uri, bookmark) => book.updateBookmark(uri, bookmark));

/** 로그인한 계정의 장부를 연다. 계정이 없으면 비운다. */
export function useFolderAccount(key: string | null): void {
  useEffect(() => {
    const next = key ?? '';
    if (next === account) return;
    account = next;
    book.load({});
    if (!next) return;
    loaded = AsyncStorage.getItem(`${STORAGE_PREFIX}${next}`)
      .then((raw) => {
        if (account !== next) return;
        book.load(raw ? JSON.parse(raw) : {});
        notifyAll();
      })
      .catch((e) => diagLog(`폴더 장부를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`));
  }, [key]);
}

const watchers = new Set<() => void>();
function notifyAll(): void {
  for (const watcher of watchers) watcher();
}
book.onChange(() => notifyAll());

export const folderStore = {
  supported: folderAccessSupported,

  /** 이 대화에 연결된 폴더. */
  list(interactionId: string | undefined | null): MobileFolder[] {
    return book.list(interactionId);
  },

  /** 장부를 다 읽은 뒤의 목록 — 앱을 켜자마자 오는 도구 호출이 빈 목록을 보지 않게. */
  async listReady(interactionId: string | undefined | null): Promise<MobileFolder[]> {
    await loaded;
    return book.list(interactionId);
  },

  /** 시스템 폴더 선택기로 골라 이 대화에 연결한다. 취소하면 그대로. */
  async add(interactionId: string): Promise<MobileFolder[]> {
    if (!account) throw new Error('로그인한 뒤에 폴더를 연결할 수 있습니다.');
    const picked = await pickFolders();
    if (!picked.length) return book.list(interactionId);
    return book.add(
      interactionId,
      picked.map((folder) => ({ uri: folder.uri, name: folder.name, bookmark: folder.bookmark })),
    );
  },

  /** 연결을 끊는다. 다른 대화가 같은 폴더를 쓰지 않으면 OS 권한·접근도 돌려준다. */
  async remove(interactionId: string, folderId: string): Promise<MobileFolder[]> {
    const target = book.list(interactionId).find((folder) => folder.id === folderId);
    const next = book.remove(interactionId, folderId);
    if (target && !book.inUse(target.uri)) {
      await releaseFolder(target, forgetResolved(target));
    }
    return next;
  },

  /** 대화를 지우거나 계정을 나갈 때. */
  forget(interactionId: string): void {
    book.forget(interactionId);
  },
};

/** 이 대화의 폴더 목록을 구독한다. */
export function useChatFolders(interactionId: string): MobileFolder[] {
  const [folders, setFolders] = useState<MobileFolder[]>(() => book.list(interactionId));
  useEffect(() => {
    const update = () => setFolders(book.list(interactionId));
    update();
    watchers.add(update);
    return () => {
      watchers.delete(update);
    };
  }, [interactionId]);
  return folders;
}
