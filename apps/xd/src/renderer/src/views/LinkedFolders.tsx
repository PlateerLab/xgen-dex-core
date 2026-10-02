/**
 * 채팅 머리의 연결 폴더 — 몇 개가 연결됐는지, 없어진 것은 없는지, 그리고 파일 관리자로 열기.
 *
 * 화면은 경로를 열지 않는다 — main 에 "이 에이전트의 몇 번째 연결 폴더" 만 준다(아무 경로나 열게 하지 않는다).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { XdAgent } from '../../../main/store';
import { xd } from '../bridge';
import { FOLDER_BADGE } from '../data';
import { FolderIcon, FolderOpenIcon, Tooltip } from '../dex';

export const LinkedFolders: React.FC<{ agent: XdAgent; status: Record<string, string> }> = ({ agent, status }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // 폴더를 모두 빼면 닫는다 — 다시 생겼을 때 열린 채로 나타나지 않게.
  useEffect(() => {
    if (!agent.folders.length) setOpen(false);
  }, [agent.folders.length]);

  if (!agent.folders.length) return null;
  const missing = agent.folders.filter((f) => FOLDER_BADGE[status[f]]).length;
  return (
    <div className="xd-linked" ref={ref}>
      <Tooltip label="연결 폴더">
        <button
          type="button"
          className={`chat-hbtn xd-linked-btn${missing ? ' warn' : ''}`}
          aria-label={`연결 폴더 ${agent.folders.length}개`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <FolderIcon size={15} />
          <span>{agent.folders.length}</span>
        </button>
      </Tooltip>
      {open && (
        <div className="xd-linked-pop" role="dialog" aria-label="연결 폴더">
          <p className="muted small">이 에이전트가 작업 공간 밖에서 읽고 쓸 수 있는 폴더입니다.</p>
          {agent.folders.map((f, i) => (
            <div key={f} className="xd-folder-row">
              <FolderIcon size={14} />
              <span className="xd-folder-path" title={f}>
                {f}
              </span>
              {FOLDER_BADGE[status[f]] ? (
                <span className="xd-folder-missing">{FOLDER_BADGE[status[f]]}</span>
              ) : (
                <button type="button" className="icon-btn sm" aria-label="폴더 열기" onClick={() => void xd.openFolder('linked', agent.id, i)}>
                  <FolderOpenIcon size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
