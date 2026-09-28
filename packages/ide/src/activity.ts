/**
 * 활동 막대의 단추들 — 사이드바 보기(탐색기·찾기·소스 제어)와 터미널·채팅 칸 토글.
 *
 * IDE 안의 활동 막대가 그리고, 호스트가 자기 앱 사이드바에 그릴 때도 같은 목록을 쓴다
 * (데스크톱 앱은 IDE 단추를 앱 사이드바로 올린다). 무엇이 켜져 있고 누르면 무엇을 하는지는
 * 여기 한 곳에서 정한다.
 */
import type { IdeState, IdeStore } from './store';
import type { IconName } from './components/icons';
import { changeCount } from './git-model';
import { formatBinding } from './keys';

/** 사이드바 보기의 이름표 — 그리는 부분(render)은 IdeView 가 붙인다. */
export interface IdeViewMeta {
  id: string;
  title: string;
  icon: IconName;
  keybinding?: string;
  badge?: (s: IdeState) => number;
}

export const BASE_VIEW_META: IdeViewMeta[] = [
  { id: 'explorer', title: '탐색기', icon: 'files', keybinding: 'Mod+Shift+E' },
  { id: 'search', title: '찾기', icon: 'search', keybinding: 'Mod+Shift+F' },
  {
    id: 'scm',
    title: '소스 제어',
    icon: 'scm',
    keybinding: 'Mod+Shift+G',
    badge: (s) => Object.values(s.git.statuses).reduce((n, st) => n + changeCount(st), 0),
  },
];

export interface IdeActivityItem {
  /** 보기 id, 또는 토글('terminal'·'chat'). */
  id: string;
  kind: 'view' | 'toggle';
  label: string;
  /** 단축키까지 붙인 풍선 도움말. */
  title: string;
  icon: IconName;
  active: boolean;
  /** 0 이면 그리지 않는다. */
  badge: number;
}

export interface IdeActivityOptions {
  /** 더한 보기(확장 자리). */
  views?: IdeViewMeta[];
  /** 채팅 칸이 있는가 — 없으면 채팅 토글을 뺀다. */
  chat?: boolean;
}

export function ideActivityItems(s: IdeState, opts: IdeActivityOptions = {}): IdeActivityItem[] {
  const views = [...BASE_VIEW_META, ...(opts.views ?? [])];
  const items: IdeActivityItem[] = views.map((v) => ({
    id: v.id,
    kind: 'view',
    label: v.title,
    title: v.keybinding ? `${v.title} (${formatBinding(v.keybinding)})` : v.title,
    icon: v.icon,
    active: s.layout.sideView === v.id,
    badge: v.badge ? v.badge(s) : 0,
  }));
  if (!s.readonly) {
    items.push({
      id: 'terminal',
      kind: 'toggle',
      label: '터미널',
      title: `터미널 (${formatBinding('Mod+`')})`,
      icon: 'terminal',
      active: s.layout.panelOpen,
      badge: 0,
    });
  }
  if (opts.chat !== false) {
    items.push({
      id: 'chat',
      kind: 'toggle',
      label: '에이전트 채팅',
      title: '에이전트 채팅',
      icon: 'chat',
      active: s.layout.chatOpen,
      badge: 0,
    });
  }
  return items;
}

/** 단추를 눌렀을 때 — 보기는 다시 누르면 사이드바를 접는다(VS Code 와 같다). */
export function pressIdeActivity(store: IdeStore, item: Pick<IdeActivityItem, 'id' | 'kind'>): void {
  const s = store.getState();
  if (item.kind === 'view') {
    store.toggleSideView(item.id);
    return;
  }
  if (item.id === 'terminal') {
    if (s.layout.panelOpen) store.togglePanel();
    else store.showTerminal();
    return;
  }
  if (item.id === 'chat') store.setLayout({ chatOpen: !s.layout.chatOpen });
}

/** 두 목록이 화면으로 같은가 — 같으면 다시 그리지 않는다. */
export function sameActivity(a: IdeActivityItem[], b: IdeActivityItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.kind !== y.kind ||
      x.active !== y.active ||
      x.badge !== y.badge ||
      x.title !== y.title ||
      x.icon !== y.icon
    ) {
      return false;
    }
  }
  return true;
}
