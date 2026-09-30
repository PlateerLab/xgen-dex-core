/**
 * ActivityBar — VS Code 식 왼쪽 아이콘 스트립.
 *
 * 위쪽: 사이드바 **뷰**를 고르는 탭들 (Agent / 탐색기 / Teams). 활성 뷰의 아이콘을
 * 다시 누르면 사이드바가 접힌다 — VS Code 와 같은 규칙이고, 접힌 상태에서는
 * 어떤 아이콘을 눌러도 그 뷰로 펼쳐진다. 이 토글 판정은 Workspace 가 한다
 * (여기는 "눌렸다"만 알린다).
 *
 * 그 바로 아래 [앱] 은 사이드바가 아니라 **메인 영역 탭**을 연다(설정과 같은 토글 규칙).
 * 내 앱을 카드로 넓게 보여 주는 화면이라 좁은 사이드바 목록으로는 모자랐다(2026-09-30).
 *
 * 그 아래(구분선 뒤): **IDE 묶음** — 지금 보는 탭이 IDE 로 보일 때만 뜬다. IDE 의
 * 탐색기·찾기·소스 제어와 터미널·채팅 칸 토글이다. 옅은 바탕의 상자로 묶어 "지금 쓸 수
 * 있는 IDE 단추"임을 알린다. 다른 탭으로 가면 사라진다.
 *
 * 아래쪽: 사이드바와 무관한 전역 동작 — 설정, 계정(로그아웃). 아바타 표시·아바타 설정은
 * 설정의 [아바타 설정] 탭으로 들어갔다(2026-09-29).
 */
import React, { useState } from 'react';
import {
  Icon as IdeIcon,
  pressIdeActivity,
  useIdeActivity,
  type IdeActivityItem,
  type IdeStore,
} from '@dex/ide';
import { XgenMark } from '../brand/Logo';
import {
  AppIcon,
  ChatIcon,
  FilesIcon,
  FolderCodeIcon,
  GitBranchIcon,
  LogoutIcon,
  PanelRightIcon,
  SearchIcon,
  SettingsIcon,
  TeamsIcon,
  TerminalIcon,
} from '../brand/icons';
import { restoreSideView, type SideView } from './side-view';

export { restoreSideView, type SideView };

const VIEWS: Array<{ id: SideView; title: string; icon: React.FC<{ size?: number }> }> = [
  { id: 'agent', title: 'Agent', icon: ChatIcon },
  { id: 'explorer', title: '탐색기', icon: FilesIcon },
  { id: 'teams', title: 'Teams', icon: TeamsIcon },
];

/** IDE 단추의 아이콘 — 앱 사이드바의 선 아이콘으로 맞춘다. 모르는 보기(확장)는 IDE 의 것. */
const IDE_ICONS: Record<string, React.FC<{ size?: number }>> = {
  explorer: FolderCodeIcon,
  search: SearchIcon,
  scm: GitBranchIcon,
  terminal: TerminalIcon,
  chat: PanelRightIcon,
};

const IdeGroup: React.FC<{ store: IdeStore }> = ({ store }) => {
  const items = useIdeActivity(store);
  const button = (item: IdeActivityItem) => {
    const Glyph = IDE_ICONS[item.id];
    return (
      <button
        key={item.id}
        className={`ab-btn ab-ide-btn ${item.active ? 'active' : ''}`}
        title={item.title}
        aria-label={item.label}
        aria-pressed={item.active}
        onClick={() => pressIdeActivity(store, item)}
      >
        {Glyph ? <Glyph size={19} /> : <IdeIcon name={item.icon} size={19} />}
        {item.badge > 0 && (
          <span className="ab-badge-dot" aria-label={`변경 ${item.badge}개`}>
            {item.badge > 99 ? '99+' : item.badge}
          </span>
        )}
      </button>
    );
  };
  const views = items.filter((i) => i.kind === 'view');
  const toggles = items.filter((i) => i.kind === 'toggle');
  return (
    <>
      <div className="ab-sep" aria-hidden />
      <div className="ab-ide" role="group" aria-label="IDE">
        <span className="ab-ide-label" aria-hidden>
          IDE
        </span>
        {views.map(button)}
        {toggles.length > 0 && <span className="ab-ide-rule" aria-hidden />}
        {toggles.map(button)}
      </div>
    </>
  );
};

export const ActivityBar: React.FC<{
  view: SideView;
  collapsed: boolean;
  onPressView: (v: SideView) => void;
  /** Teams 안 읽음 총합 — 0 이면 배지를 그리지 않는다. */
  teamsUnread: number;
  /** 지금 보는 탭이 IDE 로 보이면 그 IDE — 있을 때만 IDE 묶음을 그린다. */
  ide: IdeStore | null;
  /** [앱] 탭이 지금 보이는가 — 아이콘에 활성 표시. */
  appsActive: boolean;
  /** [앱] 탭을 열거나(없으면), 보고 있으면 닫는다 — 설정과 같은 토글. */
  onOpenApps: () => void;
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
  ide,
  appsActive,
  onOpenApps,
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
        <button
          className={`ab-btn ${appsActive ? 'active' : ''}`}
          title="앱"
          aria-pressed={appsActive}
          onClick={onOpenApps}
        >
          {appsActive && <span className="ab-ind" />}
          <AppIcon size={22} />
        </button>
        {ide && <IdeGroup store={ide} />}
      </div>

      <div className="ab-bottom">
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
