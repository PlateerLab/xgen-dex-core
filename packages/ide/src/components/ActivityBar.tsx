/**
 * 활동 막대 — 사이드바 보기(탐색기·찾기·소스 제어)를 고른다. 아래쪽은 터미널·채팅.
 *
 * 보기는 등록부(`views`)로 받는다. 지금은 셋이지만 확장(테스트·환경 변수·미리보기 등)이
 * 같은 자리에 들어올 수 있게 IdeView 가 더한 보기를 넘긴다. 단추 목록과 누름은 activity.ts 가
 * 정한다 — 호스트가 자기 앱 사이드바에 IDE 단추를 그릴 때도 같은 것을 쓴다.
 */
import type { ReactElement } from 'react';
import { Icon } from './icons';
import { useIdeActivity, useStore } from './hooks';
import { pressIdeActivity, type IdeViewMeta } from '../activity';

export interface SideView extends IdeViewMeta {
  render: () => ReactElement;
}

export function ActivityBar({ extraViews, chat }: { extraViews?: IdeViewMeta[]; chat: boolean }) {
  const store = useStore();
  const items = useIdeActivity(store, { views: extraViews, chat });
  const top = items.filter((i) => i.kind === 'view');
  const bottom = items.filter((i) => i.kind === 'toggle');
  const button = (item: (typeof items)[number]) => (
    <button
      key={item.id}
      type="button"
      className={`xide-activity-btn${item.active ? ' xide--active' : ''}`}
      title={item.title}
      aria-label={item.label}
      aria-pressed={item.active}
      onClick={() => pressIdeActivity(store, item)}
    >
      <Icon name={item.icon} size={21} />
      {item.badge ? <span className="xide-activity-badge">{item.badge > 999 ? '999+' : item.badge}</span> : null}
    </button>
  );
  return (
    <nav className="xide-activity" aria-label="보기">
      <div className="xide-activity-top">{top.map(button)}</div>
      <div className="xide-activity-bottom">{bottom.map(button)}</div>
    </nav>
  );
}
