/**
 * [폴더 연결] — 이 대화에서 에이전트가 이 PC 의 파일과 터미널을 쓸 수 있는 폴더.
 *
 * 폴더는 대화에 붙는다. 연결한 폴더 안에서만 파일 도구와 터미널이 돌고, 연결을
 * 해제하면 다음 요청부터 그 폴더를 쓰지 않는다(그 폴더에서 돌던 작업도 멈춘다).
 * 폴더는 네이티브 선택 창으로만 더해진다 — 이 화면은 경로를 입력받지 않는다.
 *
 * 한 대화에 여러 기기(다른 PC·휴대폰·웹 브라우저)의 폴더가 함께 붙을 수 있다 — 이 PC 의 폴더 아래에
 * 다른 기기의 폴더 이름과 그 기기가 켜져 있는지를 보여 준다. 대화당 기기 하나만 받는 서버(옛 서버,
 * 표를 아직 바꾸지 않은 서버)면 예전처럼 그 기기를 보여 주고 [이 기기로 옮기기] 를 묻는다.
 * 이 PC 의 폴더는 웹·휴대폰에서 보낸 요청으로도 쓰인다 — 그때 여기에 알린다.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { ChatFolderRemote, ChatFolderView } from '../../../main/chat-folders';
import type { RemoteFolderUse } from '@dex/engine/local-tools';
import {
  folderOwnership,
  otherDeviceFolders,
  type ConversationFolderDeviceFolders,
} from '@dex/protocol/conversation-folders';
import { xgen } from '../bridge';
import { CloseIcon, FolderIcon, FolderOpenIcon, PlusIcon } from '../brand/icons';
import { useModalDismiss } from './use-modal-dismiss';

export interface ChatFoldersState {
  folders: ChatFolderView[];
  busy: boolean;
  error: string;
  /** 서버 사본(다른 기기의 폴더·켜짐 여부). 옛 서버면 state 가 null. */
  remote: ChatFolderRemote | null;
  /** 이 대화의 폴더가 다른 기기에만 있고, 서버가 대화당 기기 하나만 받는다 — [이 기기로 옮기기]. */
  elsewhere: boolean;
  /** 다른 기기들에 있는 이 대화의 폴더(이름만). */
  others: ConversationFolderDeviceFolders[];
  /** 마지막으로 다른 화면에서 온 요청으로 조작한 것. */
  remoteUse: RemoteFolderUse | null;
  /** 방금(2분 안) 다른 화면에서 온 요청으로 조작했다 — 헤더 단추에 표시한다. */
  remoteNow: boolean;
  add: () => Promise<void>;
  remove: (folderId: string) => Promise<void>;
  reveal: (folderId: string) => Promise<void>;
  moveHere: () => Promise<void>;
}

/** 헤더 단추의 "다른 화면에서 사용 중" 표시가 남는 시간. */
const REMOTE_NOW_MS = 2 * 60_000;

/** "방금" · "3분 전" · "2시간 전". */
export function sinceLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 이 대화의 폴더 목록. 다른 창에서 바꿔도 따라온다. */
export function useChatFolders(interactionId: string): ChatFoldersState {
  const [folders, setFolders] = useState<ChatFolderView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remote, setRemote] = useState<ChatFolderRemote | null>(null);
  const [remoteUse, setRemoteUse] = useState<RemoteFolderUse | null>(null);
  const [remoteNow, setRemoteNow] = useState(false);
  useEffect(() => {
    if (!remoteUse) return setRemoteNow(false);
    const left = REMOTE_NOW_MS - (Date.now() - remoteUse.at);
    setRemoteNow(left > 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setRemoteNow(false), left);
    return () => clearTimeout(timer);
  }, [remoteUse]);

  useEffect(() => {
    let alive = true;
    setFolders([]);
    setError('');
    setRemote(null);
    setRemoteUse(null);
    void xgen.chatFolders
      .list(interactionId)
      .then((next) => alive && setFolders(next))
      .catch(() => undefined);
    const readRemote = () =>
      void xgen.chatFolders
        .remote(interactionId)
        .then((next) => {
          if (!alive) return;
          setRemote(next);
          if (next.lastRemoteUse) setRemoteUse(next.lastRemoteUse);
        })
        .catch(() => undefined);
    readRemote();
    const off = xgen.chatFolders.onChanged((id, next) => {
      if (id === interactionId) setFolders(next);
    });
    // 다른 기기가 연결·해제·옮기거나 기기가 켜지고 꺼지면(빈 id) 사본을 다시 읽는다.
    const offRemote = xgen.chatFolders.onRemoteChanged((id) => {
      if (!id || id === interactionId) readRemote();
    });
    const offUse = xgen.chatFolders.onRemoteUse((use) => {
      if (use.interactionId === interactionId) setRemoteUse(use);
    });
    return () => {
      alive = false;
      off();
      offRemote();
      offUse();
    };
  }, [interactionId]);

  const run = useCallback(async (task: () => Promise<ChatFolderView[] | void>) => {
    setBusy(true);
    setError('');
    try {
      const next = await task();
      if (next) setFolders(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const elsewhere =
    !folders.length &&
    !!remote?.exclusive &&
    folderOwnership(remote.state, remote.deviceId) === 'other';
  const others = elsewhere ? [] : otherDeviceFolders(remote?.state, remote?.deviceId ?? '');
  return {
    folders,
    busy,
    error,
    remote,
    elsewhere,
    others,
    remoteUse,
    remoteNow,
    add: () => run(() => xgen.chatFolders.add(interactionId)),
    moveHere: () => run(() => xgen.chatFolders.moveHere(interactionId)),
    remove: (folderId) => run(() => xgen.chatFolders.remove(interactionId, folderId)),
    reveal: (folderId) =>
      run(async () => {
        const r = await xgen.chatFolders.reveal(interactionId, folderId);
        if (!r.ok) throw new Error(r.error || '폴더를 열지 못했습니다.');
      }),
  };
}

/** 채팅 헤더의 [폴더] 버튼 — 이 대화에 연결된 폴더 수를 함께 보인다(다른 기기의 폴더 포함). */
export const FolderConnectButton: React.FC<{
  count: number;
  onClick: () => void;
  /** 폴더가 다른 기기에만 있고 서버가 기기 하나만 받으면 그 기기 이름. */
  elsewhereName?: string;
  /** count 중 다른 기기에 있는 폴더 수. */
  otherCount?: number;
  /** 방금 다른 화면에서 온 요청으로 이 PC 폴더를 조작했다. */
  remoteNow?: boolean;
}> = ({ count, onClick, elsewhereName, otherCount = 0, remoteNow }) => (
  <button
    type="button"
    className={`chat-hbtn folder-connect${count ? ' on' : ''}${elsewhereName ? ' elsewhere' : ''}`}
    onClick={onClick}
    title={
      elsewhereName
        ? `이 대화의 폴더 ${count}개는 ${elsewhereName}에 있습니다`
        : remoteNow
          ? '다른 화면에서 온 요청으로 방금 이 PC의 폴더를 사용했습니다'
          : count
            ? otherCount
              ? `이 대화에 연결된 폴더 ${count}개(다른 기기 ${otherCount}개 포함)를 관리합니다`
              : `이 대화에 연결된 폴더 ${count}개를 관리합니다`
            : '이 대화에서 작업할 이 PC의 폴더를 연결합니다'
    }
    aria-haspopup="dialog"
  >
    <FolderIcon size={14} /> 폴더
    {count > 0 && <span className="folder-connect-count">{count}</span>}
    {remoteNow && <span className="folder-connect-remote" aria-label="다른 화면에서 사용 중" />}
  </button>
);

export const FolderConnectModal: React.FC<{
  state: ChatFoldersState;
  onClose: () => void;
}> = ({ state, onClose }) => {
  useModalDismiss(onClose);
  const { folders, busy, error } = state;
  const device = state.remote?.state?.device ?? null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal chat-folders-modal"
        role="dialog"
        aria-label="폴더 연결"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>폴더 연결</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="chat-folders-desc">
          연결한 폴더 안에서만 에이전트가 이 PC의 파일과 터미널을 사용합니다.
        </p>
        {state.elsewhere && device ? (
          <div className="chat-folders-elsewhere">
            <p className="chat-folders-elsewhere-head">
              <span>
                이 대화의 폴더는 <strong>{device.name}</strong>에 있습니다
              </span>
              <span className={`chat-folders-device-state${device.online ? ' on' : ''}`}>
                {device.online ? '켜짐' : '꺼짐'}
              </span>
            </p>
            <div className="roots-list">
              {(state.remote?.state?.folders ?? []).map((folder) => (
                <div className="root-item chat-folder" key={folder.id}>
                  <span className="root-icon">
                    <FolderIcon size={15} />
                  </span>
                  <span className="chat-folder-text">
                    <span className="chat-folder-name">{folder.name}</span>
                  </span>
                </div>
              ))}
            </div>
            <p className="small muted chat-folders-hint">
              {device.online
                ? '다른 화면에서 보낸 요청도 그 기기의 폴더를 사용합니다.'
                : '그 기기가 켜지면 다시 사용할 수 있습니다.'}
            </p>
            <button className="root-add" disabled={busy} onClick={() => void state.moveHere()}>
              <PlusIcon size={14} /> 이 기기로 옮기기
            </button>
            <p className="small muted chat-folders-hint">
              옮기면 {device.name}의 연결은 해제되고 이 PC에서 고른 폴더를 사용합니다.
            </p>
          </div>
        ) : (
        <div className="roots-list">
          {folders.length === 0 && (
            <div className="roots-empty small muted">
              {state.others.length ? '이 PC에 연결된 폴더가 없습니다.' : '연결된 폴더가 없습니다.'}
            </div>
          )}
          {folders.map((folder) => (
            <div className={`root-item chat-folder${folder.missing ? ' missing' : ''}`} key={folder.id}>
              <span className="root-icon">
                <FolderIcon size={15} />
              </span>
              <span className="chat-folder-text">
                <span className="chat-folder-name">
                  {folder.name}
                  {folder.missing && <em className="chat-folder-missing">찾을 수 없음</em>}
                </span>
                <span className="root-path" title={folder.path}>
                  {folder.path}
                </span>
              </span>
              <button
                className="root-remove chat-folder-open"
                title="파일 관리자에서 열기"
                aria-label={`${folder.name} 폴더 열기`}
                disabled={busy || folder.missing}
                onClick={() => void state.reveal(folder.id)}
              >
                <FolderOpenIcon size={14} />
              </button>
              <button
                className="root-remove"
                title="연결 해제"
                aria-label={`${folder.name} 연결 해제`}
                disabled={busy}
                onClick={() => void state.remove(folder.id)}
              >
                <CloseIcon size={13} />
              </button>
            </div>
          ))}
          <button className="root-add" disabled={busy} onClick={() => void state.add()}>
            <PlusIcon size={14} /> 폴더 추가
          </button>
        </div>
        )}
        {state.others.length > 0 && (
          <div className="chat-folders-others">
            <p className="chat-folders-others-title">다른 기기의 폴더</p>
            {state.others.map((other) => (
              <div className="chat-folders-other" key={other.deviceId}>
                <p className="chat-folders-elsewhere-head">
                  <span>
                    <strong>{other.name}</strong>
                  </span>
                  <span className={`chat-folders-device-state${other.online ? ' on' : ''}`}>
                    {other.online ? '켜짐' : '꺼짐'}
                  </span>
                </p>
                <div className="roots-list">
                  {other.folders.map((folder) => (
                    <div className="root-item chat-folder" key={folder.id || folder.name}>
                      <span className="root-icon">
                        <FolderIcon size={15} />
                      </span>
                      <span className="chat-folder-text">
                        <span className="chat-folder-name">{folder.name}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="small muted chat-folders-hint">
              다른 기기의 폴더도 이 대화에서 함께 쓰입니다. 그 기기가 켜져 있을 때만 사용할 수 있고,
              연결과 해제는 그 기기에서 합니다.
            </p>
          </div>
        )}
        {error && <p className="settings-hint warn">{error}</p>}
        {state.remoteUse && folders.length > 0 && (
          <p className="chat-folders-remote-use">
            {state.remoteUse.originName}에서 온 요청으로 이 PC의 폴더를 사용했습니다 ·{' '}
            {sinceLabel(state.remoteUse.at)}
          </p>
        )}
        {!state.elsewhere && folders.length > 0 && (
          <p className="small muted chat-folders-hint">
            웹이나 휴대폰에서 보낸 요청도 이 PC가 켜져 있는 동안 이 폴더를 사용합니다.
          </p>
        )}
        {!state.elsewhere && (
          <p className="small muted chat-folders-hint">
            연결을 해제하면 다음 요청부터 그 폴더를 쓰지 않고, 그 폴더에서 실행 중이던 작업도 멈춥니다.
          </p>
        )}
      </div>
    </div>
  );
};
