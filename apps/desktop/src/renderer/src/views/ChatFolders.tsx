/**
 * [폴더 연결] — 이 대화에서 에이전트가 이 PC 의 파일과 터미널을 쓸 수 있는 폴더.
 *
 * 폴더는 대화에 붙는다. 연결한 폴더 안에서만 파일 도구와 터미널이 돌고, 연결을
 * 해제하면 다음 요청부터 그 폴더를 쓰지 않는다(그 폴더에서 돌던 작업도 멈춘다).
 * 폴더는 네이티브 선택 창으로만 더해진다 — 이 화면은 경로를 입력받지 않는다.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { ChatFolderView } from '../../../main/chat-folders';
import { xgen } from '../bridge';
import { CloseIcon, FolderIcon, FolderOpenIcon, PlusIcon } from '../brand/icons';
import { useModalDismiss } from './use-modal-dismiss';

export interface ChatFoldersState {
  folders: ChatFolderView[];
  busy: boolean;
  error: string;
  add: () => Promise<void>;
  remove: (folderId: string) => Promise<void>;
  reveal: (folderId: string) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 이 대화의 폴더 목록. 다른 창에서 바꿔도 따라온다. */
export function useChatFolders(interactionId: string): ChatFoldersState {
  const [folders, setFolders] = useState<ChatFolderView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setFolders([]);
    setError('');
    void xgen.chatFolders
      .list(interactionId)
      .then((next) => alive && setFolders(next))
      .catch(() => undefined);
    const off = xgen.chatFolders.onChanged((id, next) => {
      if (id === interactionId) setFolders(next);
    });
    return () => {
      alive = false;
      off();
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

  return {
    folders,
    busy,
    error,
    add: () => run(() => xgen.chatFolders.add(interactionId)),
    remove: (folderId) => run(() => xgen.chatFolders.remove(interactionId, folderId)),
    reveal: (folderId) =>
      run(async () => {
        const r = await xgen.chatFolders.reveal(interactionId, folderId);
        if (!r.ok) throw new Error(r.error || '폴더를 열지 못했습니다.');
      }),
  };
}

/** 채팅 헤더의 [폴더 연결] 버튼 — 연결된 폴더 수를 함께 보인다. */
export const FolderConnectButton: React.FC<{ count: number; onClick: () => void }> = ({
  count,
  onClick,
}) => (
  <button
    type="button"
    className={`chat-hbtn folder-connect${count ? ' on' : ''}`}
    onClick={onClick}
    title={
      count
        ? `이 대화에 연결된 폴더 ${count}개를 관리합니다`
        : '이 대화에서 작업할 이 PC의 폴더를 연결합니다'
    }
    aria-haspopup="dialog"
  >
    <FolderIcon size={14} /> 폴더 연결
    {count > 0 && <span className="folder-connect-count">{count}</span>}
  </button>
);

export const FolderConnectModal: React.FC<{
  state: ChatFoldersState;
  onClose: () => void;
}> = ({ state, onClose }) => {
  useModalDismiss(onClose);
  const { folders, busy, error } = state;
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
        <div className="roots-list">
          {folders.length === 0 && (
            <div className="roots-empty small muted">연결된 폴더가 없습니다.</div>
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
        {error && <p className="settings-hint warn">{error}</p>}
        <p className="small muted chat-folders-hint">
          연결을 해제하면 다음 요청부터 그 폴더를 쓰지 않고, 그 폴더에서 실행 중이던 작업도 멈춥니다.
        </p>
      </div>
    </div>
  );
};
