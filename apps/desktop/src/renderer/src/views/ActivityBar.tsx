/**
 * ActivityBar — VS Code 식 왼쪽 아이콘 스트립.
 *
 * 위쪽: 사이드바 **뷰**를 고르는 탭들 (Agent / 탐색기). 활성 뷰의 아이콘을
 * 다시 누르면 사이드바가 접힌다 — VS Code 와 같은 규칙이고, 접힌 상태에서는
 * 어떤 아이콘을 눌러도 그 뷰로 펼쳐진다. 이 토글 판정은 Workspace 가 한다
 * (여기는 "눌렸다"만 알린다).
 *
 * 아래쪽: 사이드바와 무관한 전역 동작들 — 아바타 오버레이 토글, 아바타 설정
 * 탭 열기, 설정 모달, 계정(로그아웃). 예전 사이드바 헤더의 아이콘 줄과
 * 푸터가 여기로 옮겨 왔다.
 */
import React, { useState } from 'react';
import { XgenMark } from '../brand/Logo';
import {
  BotIcon,
  ChatIcon,
  FilesIcon,
  LogoutIcon,
  SettingsIcon,
  AvatarIcon,
  TeamsIcon,
} from '../brand/icons';

export type SideView = 'agent' | 'explorer' | 'teams';

const VIEWS: Array<{ id: SideView; title: string; icon: React.FC<{ size?: number }> }> = [
  { id: 'agent', title: 'Agent', icon: ChatIcon },
  { id: 'explorer', title: '탐색기', icon: FilesIcon },
  { id: 'teams', title: 'Teams', icon: TeamsIcon },
];

export const ActivityBar: React.FC<{
  view: SideView;
  collapsed: boolean;
  onPressView: (v: SideView) => void;
  /** Teams 안 읽음 총합 — 0 이면 배지를 그리지 않는다. */
  teamsUnread: number;
  overlayOn: boolean;
  onToggleOverlay: () => void;
  avatarActive: boolean;
  onOpenAvatar: () => void;
  /** 설정 탭이 지금 보이는가 — 아이콘에 활성 표시. */
  settingsActive: boolean;
  onOpenSettings: () => void;
  userName: string;
  onLogout: () => void;
}> = ({
  view,
  collapsed,
  onPressView,
  teamsUnread,
  overlayOn,
  onToggleOverlay,
  avatarActive,
  onOpenAvatar,
  settingsActive,
  onOpenSettings,
  userName,
  onLogout,
}) => {
  const [accountOpen, setAccountOpen] = useState(false);
  const initial = userName.trim().charAt(0) || 'U';

  return (
    <nav className="activity-bar">
      <div className="ab-logo" title="XGen Dex">
        <XgenMark height={24} variant="color" />
      </div>

      <div className="ab-top">
        {VIEWS.map((v) => {
          const active = view === v.id && !collapsed;
          const Icon = v.icon;
          return (
            <button
              key={v.id}
              className={`ab-btn ${active ? 'active' : ''}`}
              title={v.title}
              onClick={() => onPressView(v.id)}
            >
              {active && <span className="ab-ind" />}
              <Icon size={22} />
              {v.id === 'teams' && teamsUnread > 0 && (
                <span className="ab-badge-dot" aria-label={`안 읽은 메시지 ${teamsUnread}개`}>
                  {teamsUnread > 99 ? '99+' : teamsUnread}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="ab-bottom">
        <button
          className={`ab-btn ${overlayOn ? 'on' : ''}`}
          title={overlayOn ? '아바타 오버레이 끄기' : '아바타 오버레이 켜기'}
          onClick={onToggleOverlay}
        >
          <BotIcon size={21} />
        </button>
        <button
          className={`ab-btn ${avatarActive ? 'active' : ''}`}
          title="아바타 설정"
          onClick={onOpenAvatar}
        >
          {avatarActive && <span className="ab-ind" />}
          <AvatarIcon size={21} />
        </button>
        <button
          className={`ab-btn ${settingsActive ? 'active' : ''}`}
          title="설정"
          onClick={onOpenSettings}
        >
          {settingsActive && <span className="ab-ind" />}
          <SettingsIcon size={21} />
        </button>
        <div className="ab-account">
          <button
            className="avatar-badge ab-badge"
            title={userName}
            onClick={() => setAccountOpen((v) => !v)}
          >
            {initial}
          </button>
          {accountOpen && (
            <>
              <div className="ab-menu-backdrop" onClick={() => setAccountOpen(false)} />
              <div className="ab-menu">
                <div className="ab-menu-name">{userName}</div>
                <button
                  className="ab-menu-item"
                  onClick={() => {
                    setAccountOpen(false);
                    onLogout();
                  }}
                >
                  <LogoutIcon size={15} /> 로그아웃
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
};
