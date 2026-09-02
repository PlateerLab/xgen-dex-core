import React from 'react';
import type { SessionState } from '../session-store';
import {
  AvatarIcon,
  BotIcon,
  BrowserIcon,
  ChatIcon,
  CloseIcon,
  DocIcon,
  PlusIcon,
  SettingsIcon,
  TeamsIcon,
} from '../brand/icons';
import type { WorkspaceGroup, WorkspaceTab } from './workspace-layout';

function label(tab: WorkspaceTab, sessions: Map<string, SessionState>): string {
  if (tab.kind === 'avatar') return '아바타 설정';
  if (tab.kind === 'teams') return tab.roomName || '대화';
  if (tab.kind === 'settings') return '설정';
  if (tab.kind === 'agent-create') return '새 에이전트';
  if (tab.kind === 'file-viewer') return tab.fileName || '파일';
  if (tab.kind === 'agent-viewer') return `${tab.workflowName || '에이전트'} 뷰어`;
  if (tab.kind === 'browser') return `${tab.workflowName || 'Agent'} 브라우저`;
  return sessions.get(tab.sessionKey ?? '')?.agent.workflowName || tab.workflowName || '대화';
}

export const TabBar: React.FC<{
  group: WorkspaceGroup;
  sessions: Map<string, SessionState>;
  onSelect: (tabId: string) => void;
  onClose: (tab: WorkspaceTab) => void;
  onOpenBrowser: () => void;
  onTabPointerDown: (event: React.PointerEvent, tab: WorkspaceTab) => void;
}> = ({ group, sessions, onSelect, onClose, onOpenBrowser, onTabPointerDown }) => (
  <div className="tab-strip" role="tablist" aria-label="열린 탭">
    <div className="tab-strip-scroll">
      {group.tabs.map((tab) => {
        const session = tab.kind === 'chat' ? sessions.get(tab.sessionKey ?? '') : undefined;
        const active = group.activeTabId === tab.id;
        return (
          <div
            key={tab.id}
            className={`tab-item ${active ? 'active' : ''}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-tab-id={tab.id}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => event.key === 'Enter' && onSelect(tab.id)}
            onPointerDown={(event) => onTabPointerDown(event, tab)}
            onAuxClick={(event) => event.button === 1 && onClose(tab)}
            title={label(tab, sessions)}
          >
            <span className="tab-icon">
              {tab.kind === 'chat' ? (
                <ChatIcon size={13} />
              ) : tab.kind === 'teams' ? (
                <TeamsIcon size={13} />
              ) : tab.kind === 'browser' ? (
                <BrowserIcon size={13} />
              ) : tab.kind === 'settings' ? (
                <SettingsIcon size={13} />
              ) : tab.kind === 'agent-viewer' ? (
                <BotIcon size={13} />
              ) : tab.kind === 'file-viewer' ? (
                <DocIcon size={13} />
              ) : (
                <AvatarIcon size={13} />
              )}
            </span>
            <span className="tab-label">{label(tab, sessions)}</span>
            <button
              className={`tab-close ${session?.streaming ? 'live' : ''} ${session?.unseen ? 'unseen' : ''}`}
              title={tab.kind === 'chat' ? '채팅 종료' : '닫기'}
              aria-label={tab.kind === 'chat' ? '채팅 종료' : '탭 닫기'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab);
              }}
            >
              <span className="tab-close-x">
                <CloseIcon size={12} />
              </span>
              {session?.streaming ? (
                <span className="tab-live-dot" title="진행 중" />
              ) : session?.unseen ? (
                <span
                  className={`tab-live-dot done ${session.error ? 'error' : 'success'}`}
                  title={session.error ? '오류로 종료됨' : '완료됨'}
                />
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
    <button
      className="tab-new"
      title="브라우저 열기"
      aria-label="브라우저 열기"
      onClick={onOpenBrowser}
    >
      <PlusIcon size={15} />
    </button>
  </div>
);
