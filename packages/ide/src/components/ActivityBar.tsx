/**
 * 활동 막대 — 사이드바 보기(탐색기·찾기·소스 제어)를 고른다. 아래쪽은 채팅·터미널.
 *
 * 보기는 등록부(`views`)로 받는다. 지금은 셋이지만 확장(테스트·환경 변수·미리보기 등)이
 * 같은 자리에 들어올 수 있게 IdeView 가 목록을 넘긴다.
 */
import type { ReactElement } from 'react';
import { Icon, type IconName } from './icons';
import { useIde, useStore } from './hooks';
import { formatBinding } from '../keys';
import type { IdeState } from '../store';

export interface SideView {
  id: string;
  title: string;
  icon: IconName;
  keybinding?: string;
  badge?: (s: IdeState) => number;
  render: () => ReactElement;
}

export function ActivityBar({ views }: { views: SideView[] }) {
  const store = useStore();
  const side = useIde((s) => s.layout.sideView);
  const chatOpen = useIde((s) => s.layout.chatOpen);
  const panelOpen = useIde((s) => s.layout.panelOpen);
  const readonly = useIde((s) => s.readonly);
  const badges = useIde((s) => views.map((v) => (v.badge ? v.badge(s) : 0)));
  return (
    <nav className="xide-activity" aria-label="보기">
      <div className="xide-activity-top">
        {views.map((v, i) => (
          <button
            key={v.id}
            type="button"
            className={`xide-activity-btn${side === v.id ? ' xide--active' : ''}`}
            title={v.keybinding ? `${v.title} (${formatBinding(v.keybinding)})` : v.title}
            aria-label={v.title}
            aria-pressed={side === v.id}
            onClick={() => store.toggleSideView(v.id)}
          >
            <Icon name={v.icon} size={21} />
            {badges[i] ? <span className="xide-activity-badge">{badges[i] > 999 ? '999+' : badges[i]}</span> : null}
          </button>
        ))}
      </div>
      <div className="xide-activity-bottom">
        {!readonly ? (
          <button
            type="button"
            className={`xide-activity-btn${panelOpen ? ' xide--active' : ''}`}
            title={`터미널 (${formatBinding('Mod+`')})`}
            aria-label="터미널"
            aria-pressed={panelOpen}
            onClick={() => (panelOpen ? store.togglePanel() : store.showTerminal())}
          >
            <Icon name="terminal" size={21} />
          </button>
        ) : null}
        <button
          type="button"
          className={`xide-activity-btn${chatOpen ? ' xide--active' : ''}`}
          title="에이전트 채팅"
          aria-label="에이전트 채팅"
          aria-pressed={chatOpen}
          onClick={() => store.setLayout({ chatOpen: !chatOpen })}
        >
          <Icon name="chat" size={21} />
        </button>
      </div>
    </nav>
  );
}
