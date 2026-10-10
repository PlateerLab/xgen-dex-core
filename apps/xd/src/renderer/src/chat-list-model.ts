/**
 * 사이드바 [최근 채팅]·[에이전트] 와 채팅 기록 관리의 규칙(2026-10-10). 순수 함수라 시험이 그대로 부른다.
 *
 * 묶음·[더 보기] 수·날 표시는 웹·Dex 와 같은 @dex/protocol 규칙을 쓴다. 문구도 Dex 데스크톱과 같다.
 * XD 에는 서버가 없고 에이전트를 지우면 대화도 지워지므로 [지워짐]·배포 대화·상태 필터는 없다.
 */
import { RECENT_CONVERSATION_STEP, conversationDayLabel } from '@dex/protocol';
import type { XdConversation, XdConversationAgent } from '../../main/store';
import { conversationTitle } from './start-model';

export const LIST_TEXT = {
  recent: '최근 채팅',
  more: '더 보기',
  collapse: '접기',
  agents: '에이전트',
  back: '뒤로',
  noChats: '아직 채팅이 없습니다',
  noAgents: '최근에 쓴 에이전트가 없습니다',
  manage: '채팅 기록 관리',
} as const;

/**
 * [최근 채팅]·[에이전트] 에 보일 줄: 처음 `RECENT_CONVERSATION_STEP` 개, [더 보기] 마다 그만큼 더. [접기] 는 그보다
 * 많이 보일 때만.
 */
export function recentSlice<T>(items: readonly T[], shown: number): { rows: T[]; canMore: boolean; canCollapse: boolean } {
  const rows = items.slice(0, Math.max(RECENT_CONVERSATION_STEP, shown));
  return { rows, canMore: items.length > rows.length, canCollapse: rows.length > RECENT_CONVERSATION_STEP };
}

/** 에이전트 줄의 둘째 줄: "마지막 대화 제목 · 날". */
export function agentLastLine(group: Pick<XdConversationAgent, 'lastTitle' | 'lastActivity'>, now: Date = new Date()): string {
  const day = conversationDayLabel(group.lastActivity, now);
  const title = conversationTitle({ title: group.lastTitle });
  return day ? `${title} · ${day}` : title;
}

/** 접은 칸. 껐다 켜도 그대로다(localStorage). */
export interface CollapsedSections {
  recent: boolean;
  agents: boolean;
}

export const COLLAPSED_KEY = 'xd.sidebar.collapsed';

/** 기억해 둔 접은 칸. 없거나 읽지 못하면 둘 다 펼친다. */
export function loadCollapsed(storage: () => Pick<Storage, 'getItem'> = () => window.localStorage): CollapsedSections {
  try {
    const raw: unknown = JSON.parse(storage().getItem(COLLAPSED_KEY) ?? '{}');
    const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return { recent: v.recent === true, agents: v.agents === true };
  } catch {
    return { recent: false, agents: false };
  }
}

export function saveCollapsed(value: CollapsedSections, storage: () => Pick<Storage, 'setItem'> = () => window.localStorage): void {
  try {
    storage().setItem(COLLAPSED_KEY, JSON.stringify(value));
  } catch {
    /* 기억 못 해도 동작엔 지장 없다 */
  }
}

/** 채팅 기록 관리의 삭제 확인(Dex 데스크톱과 같은 문구). */
export function deleteQuestion(targets: readonly Pick<XdConversation, 'title'>[]): string {
  return targets.length === 1
    ? `"${conversationTitle(targets[0])}" 대화를 삭제할까요? 되돌릴 수 없습니다.`
    : `선택한 채팅 ${targets.length}개를 삭제할까요? 되돌릴 수 없습니다.`;
}

/**
 * 지운 뒤 알림 한 줄(없으면 null). 하나를 지운 것은 줄이 사라지는 것으로 충분하다(Dex 와 같다). 답을 만드는 중인
 * 대화는 지울 수 없어 못 지운 수에 들고, 그 까닭을 덧붙인다.
 */
export function deleteNotice(result: { deleted: number; failed: number; running: number }): string | null {
  if (result.failed > 0) {
    const why = result.running > 0 ? ' 답을 만드는 중인 채팅은 지울 수 없습니다.' : '';
    return `채팅 ${result.failed}개는 삭제하지 못했습니다.${why}`;
  }
  if (result.deleted > 1) return `채팅 ${result.deleted}개를 삭제했습니다.`;
  return null;
}

/**
 * 찾은 대화를 지금 목록에 맞춘다: 그 사이 이름이 바뀐 것은 새 이름으로, 지워진 것은 뺀다. 순서는 찾은 순서 그대로.
 */
export function freshFound<T extends { id: string }>(found: readonly T[], list: readonly T[]): T[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  return found.flatMap((c) => {
    const now = byId.get(c.id);
    return now ? [now] : [];
  });
}
