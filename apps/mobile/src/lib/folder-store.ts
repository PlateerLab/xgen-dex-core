/**
 * 대화별 폴더 연결 — 앱 전체가 함께 보는 한 곳.
 *
 * 채팅 화면(헤더의 [폴더 연결])이 더하고 빼고, 도구 브리지는 호출마다 그 대화의
 * 폴더를 여기서 찾는다. 계정마다 따로 저장한다 — 로그아웃하고 다른 계정으로
 * 들어오면 이전 계정의 폴더가 보이지 않는다.
 *
 * 연결·해제는 서버 사본에도 올린다(@dex/protocol 의 ConversationFolderSync, 데스크톱과
 * 같은 규칙) — 웹·PC 에서 이 대화를 열어도 폴더가 보이고, 그 화면에서 보낸 턴도 이
 * 휴대폰의 폴더를 쓴다. 한 대화에 여러 기기의 폴더가 함께 붙을 수 있다(대화당 기기 하나만
 * 받는 옛 서버면 예전처럼 [이 기기로 옮기기]).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import {
  ConversationFolderSync,
  folderOwnership,
  otherDeviceFolders,
  parseConversationFolders,
  type ConversationFolderDeviceFolders,
  type ConversationFoldersApi,
  type ConversationFoldersState,
  type FolderLedger,
} from '@dex/protocol';
import { cachedDeviceId, deviceName, devicePlatform } from './device';
import { diagLog } from './diag';
import {
  createFolderFs,
  folderAccessSupported,
  forgetResolved,
  pickFolders,
  releaseFolder,
} from './folder-fs';
import { MobileFolderBook, toWire, type MobileFolder } from './mobile-folders';
import { userPcFoldersChanged } from './user-pc';
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
    remoteStates.clear();
    remoteUses.clear();
    if (!next) return;
    loaded = AsyncStorage.getItem(`${STORAGE_PREFIX}${next}`)
      .then((raw) => {
        if (account !== next) return;
        book.load(raw ? JSON.parse(raw) : {});
        notifyAll();
        // 꺼져 있는 동안 다른 기기로 옮겨 간 대화는 잊고, 이 기능 이전에 붙인 폴더는 올린다.
        void sync.reconcile();
      })
      .catch((e) => diagLog(`폴더 장부를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`));
  }, [key]);
}

const watchers = new Set<() => void>();
function notifyAll(): void {
  for (const watcher of watchers) watcher();
}

let foldersApi: ConversationFoldersApi | null = null;

const ledger: FolderLedger<MobileFolder> = {
  list: (interactionId) => book.list(interactionId),
  set: (interactionId, folders) => book.set(interactionId, folders),
  forget: (interactionId) => book.forget(interactionId),
  entries: () =>
    Object.entries(book.snapshot()).map(([interactionId, entry]) => ({ interactionId, folders: entry.folders })),
  accountId: () => account || null,
};

const sync = new ConversationFolderSync<MobileFolder>({
  // 기기 id 가 아직 없으면(부팅 직후) 올리지 않는다 — 이름 없는 기기로 적히지 않게.
  api: () => (cachedDeviceId() ? foldersApi : null),
  ledger,
  device: () => ({ deviceId: cachedDeviceId(), deviceName: deviceName(), devicePlatform: devicePlatform() }),
  wire: toWire,
  log: diagLog,
});

/** 다른 화면(웹·PC)에서 온 요청으로 이 휴대폰의 폴더를 조작한 마지막 것 — 대화마다. */
export interface RemoteFolderUse {
  interactionId: string;
  toolName: string;
  originName: string;
  at: number;
}

const remoteStates = new Map<string, ConversationFoldersState | null>();
const remoteUses = new Map<string, RemoteFolderUse>();
const remoteWatchers = new Set<(interactionId: string) => void>();
function notifyRemote(interactionId: string): void {
  for (const watcher of remoteWatchers) watcher(interactionId);
}

async function refreshRemote(interactionId: string): Promise<void> {
  if (!interactionId) return;
  remoteStates.set(interactionId, await sync.state(interactionId));
  notifyRemote(interactionId);
}

book.onChange((interactionId) => {
  notifyAll();
  // 빠진 폴더에서 돌던 사용자 PC 접속 명령을 멈춘다.
  userPcFoldersChanged(interactionId, book.list(interactionId));
  // 이 휴대폰에서 바꾼 것만 서버에 올린다(서버가 시켜서 잊은 것은 메아리가 된다).
  if (sync.isQuiet(interactionId)) return;
  void sync.publish(interactionId).then((result) => {
    // 대화당 기기 하나만 받는 서버에서 그 사이 다른 기기가 이 대화를 가져갔다 — 이 휴대폰은 잊는다.
    if (result && !result.ok && result.code === 'other_device') sync.onOtherDevice(result.state);
    void refreshRemote(interactionId);
  });
});

/** 로그인한 클라이언트의 서버 사본 API — 바뀌면 장부 전체를 서버와 맞춘다(계정마다 한 번). */
export function setFolderServer(api: ConversationFoldersApi | null): void {
  foldersApi = api;
  if (api) void loaded.then(() => sync.reconcile());
}

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

  /**
   * 시스템 폴더 선택기로 골라 이 대화에 연결한다. 취소하면 그대로.
   * 대화당 기기 하나만 받는 서버가 거절하면(다른 기기에 폴더가 있다) 더하지 않는다 — 시트가
   * [이 기기로 옮기기] 를 보여 준다.
   * `takeOver` 면 고른 폴더가 이 대화의 폴더가 되고 다른 기기의 연결은 해제된다.
   */
  async add(interactionId: string, opts: { takeOver?: boolean } = {}): Promise<MobileFolder[]> {
    if (!account) throw new Error('로그인한 뒤에 폴더를 연결할 수 있습니다.');
    const picked = await pickFolders();
    if (!picked.length) return book.list(interactionId);
    const chosen = picked.map((folder) => ({ uri: folder.uri, name: folder.name, bookmark: folder.bookmark }));
    // 장부와 같은 규칙(중복·이름 가르기·상한)으로 다듬은 결과를 먼저 서버에 묻는다.
    const next = new MobileFolderBook().set(
      interactionId,
      opts.takeOver ? chosen : [...book.list(interactionId), ...chosen],
    );
    const out = await sync.add(interactionId, next, { takeOver: opts.takeOver });
    if (!out.ok) remoteStates.set(interactionId, out.state);
    void refreshRemote(interactionId);
    return book.list(interactionId);
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

  /** 대화 채널의 `folders` 소식 — 규칙은 ConversationFolderSync.onServerFolders. */
  serverFolders(interactionId: string, data: Record<string, unknown>): void {
    const state = parseConversationFolders(data, interactionId);
    sync.onServerFolders(state);
    remoteStates.set(state.interactionId || interactionId, state);
    notifyRemote(state.interactionId || interactionId);
  },

  /** 다른 화면에서 온 요청으로 이 휴대폰의 폴더 도구가 불렸다. */
  remoteUsed(use: RemoteFolderUse): void {
    remoteUses.set(use.interactionId, use);
    notifyRemote(use.interactionId);
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

export interface ChatFolderRemote {
  /** 서버 사본 — 폴더가 있는 기기와 켜짐 여부. 옛 서버·아직 모름이면 null. */
  state: ConversationFoldersState | null;
  /** 폴더가 다른 기기에만 있고 서버가 대화당 기기 하나만 받는다 — [이 기기로 옮기기]. */
  elsewhere: boolean;
  /** 다른 기기들에 있는 이 대화의 폴더(이름만). */
  others: ConversationFolderDeviceFolders[];
  /** 다른 화면에서 온 요청으로 조작한 마지막 것. */
  lastRemoteUse: RemoteFolderUse | null;
}

function remoteView(interactionId: string): ChatFolderRemote {
  const state = remoteStates.get(interactionId) ?? null;
  const mine = cachedDeviceId();
  const elsewhere =
    !book.list(interactionId).length &&
    sync.isExclusive(interactionId, state) &&
    folderOwnership(state, mine) === 'other';
  const others = elsewhere ? [] : otherDeviceFolders(state, mine);
  return { state, elsewhere, others, lastRemoteUse: remoteUses.get(interactionId) ?? null };
}

/** 이 대화 폴더의 서버 사본을 구독한다 — 열 때 한 번 읽고, 소식이 오면 다시 그린다. */
export function useChatFolderRemote(interactionId: string, active = true): ChatFolderRemote {
  const [view, setView] = useState<ChatFolderRemote>(() => remoteView(interactionId));
  useEffect(() => {
    const update = (changed: string) => {
      if (!changed || changed === interactionId) setView(remoteView(interactionId));
    };
    setView(remoteView(interactionId));
    remoteWatchers.add(update);
    if (active) void refreshRemote(interactionId);
    return () => {
      remoteWatchers.delete(update);
    };
  }, [interactionId, active]);
  return view;
}
