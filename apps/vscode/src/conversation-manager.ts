/**
 * 채팅 기록 관리 탭의 규칙 (2026-10-10). 사이드바 목록 머리의 ⋯ 가 편집기 자리에 연다.
 *
 * 데스크톱 ConversationManager 와 같은 일·같은 글이다: 상태 필터(전체·활성·배포·삭제됨), 검색, 모두 선택·선택
 * 삭제, 줄마다 열기(보기)·이름 바꾸기·삭제, 에이전트가 사라진 채팅 제거. 목록·검색·필터 규칙은 서버가 정한다.
 *
 * vscode 모듈에 기대지 않는 순수한 부분만 여기 둔다(탭은 conversation-manager-panel). 그래야 테스트가 직접 부른다.
 * 웹뷰(plain JS)는 여기서 만든 줄과 글을 그대로 그린다.
 */
import {
  CONVERSATION_TAG_LABELS,
  conversationDayLabel,
  conversationDisplayTitle,
  conversationKey,
  conversationMatchesKind,
  type Conversation,
  type ConversationKind,
} from '@dex/protocol';
import { purgeDeletedLabel } from './conversation-view';

/** 한 번에 받는 대화 수. */
export const MANAGER_PAGE_SIZE = 50;
/** 검색이 한 번에 받는 결과 수. */
export const MANAGER_SEARCH_LIMIT = 100;
/** 한꺼번에 지울 때 동시에 보내는 요청 수. */
export const DELETE_CONCURRENCY = 4;
/** 안내 한 줄이 떠 있는 시간. */
export const MANAGER_NOTICE_MS = 4000;

export const MANAGER_KINDS: ReadonlyArray<{ value: ConversationKind; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'active', label: '활성' },
  { value: 'deploy', label: '배포' },
  { value: 'deleted', label: '삭제됨' },
];

export const MANAGER_TEXT = {
  title: '채팅 기록 관리',
  nothingToPurge: '정리할 채팅이 없습니다.',
  loading: '불러오는 중…',
  empty: '채팅 기록이 없습니다.',
  noMatch: '맞는 채팅이 없습니다.',
  more: '더 보기',
  loadingMore: '더 불러오는 중',
  searchMore: '맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.',
  loadFailed: '채팅 기록을 불러오지 못했습니다.',
} as const;

/** 웹뷰가 보낸 상태 값. 모르는 값은 전체로 본다. */
export function managerKind(value: unknown): ConversationKind {
  return MANAGER_KINDS.some((k) => k.value === value) ? (value as ConversationKind) : 'all';
}

/**
 * 받은 쪽을 상태 필터로 거른다. 필터를 모르는 옛 엔진은 전부 보내므로 화면에서 같은 판정으로 거른다.
 * `ignored` 면 그 쪽의 총 수는 필터의 수가 아니다(화면은 총 수를 숨긴다).
 */
export function pageForKind(list: Conversation[], kind: ConversationKind): { list: Conversation[]; ignored: boolean } {
  const kept = list.filter((c) => conversationMatchesKind(c, kind));
  return { list: kept, ignored: kept.length !== list.length };
}

/** 관리 탭의 한 줄. */
export interface ManagerRow {
  key: string;
  /** 보일 제목(없으면 "새 대화"). */
  title: string;
  /** 이름 바꾸기 칸의 처음 값(붙인 이름이나 첫 메시지 제목 그대로). */
  draft: string;
  /** 에이전트 이름. 에이전트가 사라졌으면 빈 글이고 [지워짐] 이 붙는다. */
  agentName: string;
  agentDeleted: boolean;
  tagLabel?: string;
  day: string;
  checked: boolean;
  /** [열기], 에이전트가 사라졌으면 [대화 보기]. */
  openLabel: string;
}

export function managerRows(items: Conversation[], selected: ReadonlySet<string>, now?: Date): ManagerRow[] {
  return items.map((c) => {
    const key = conversationKey(c);
    return {
      key,
      title: conversationDisplayTitle(c),
      draft: c.title,
      agentName: c.agentDeleted ? '' : c.workflowName,
      agentDeleted: c.agentDeleted === true,
      ...(c.tag ? { tagLabel: CONVERSATION_TAG_LABELS[c.tag] } : {}),
      day: conversationDayLabel(c.updatedAt || c.createdAt, now),
      checked: selected.has(key),
      openLabel: c.agentDeleted ? '대화 보기' : '열기',
    };
  });
}

/** 지우기 전에 묻는 글. 한 개면 그 제목을 넣는다. */
export function deleteQuestion(targets: readonly Conversation[]): string {
  return targets.length === 1
    ? `"${conversationDisplayTitle(targets[0])}" 대화를 삭제할까요? 되돌릴 수 없습니다.`
    : `선택한 채팅 ${targets.length}개를 삭제할까요? 되돌릴 수 없습니다.`;
}

/** 사라진 에이전트의 대화를 정리하기 전에 묻는 글. */
export function purgeQuestion(count: number): string {
  return `에이전트가 사라진 채팅 ${count}개를 모두 지웁니다. 되돌릴 수 없습니다.`;
}

/**
 * 여러 대화를 지운다. 한 번에 `concurrency` 개씩 보내고 다 돌아온 뒤 다음 묶음을 보낸다.
 * 실패한 것은 따로 모은다(하나가 실패해도 나머지는 지운다).
 */
export async function deleteInBatches<T>(
  targets: readonly T[],
  remove: (target: T) => Promise<unknown>,
  concurrency = DELETE_CONCURRENCY,
): Promise<{ gone: T[]; failed: T[] }> {
  const size = Math.max(1, Math.floor(concurrency));
  const gone: T[] = [];
  const failed: T[] = [];
  for (let i = 0; i < targets.length; i += size) {
    const batch = targets.slice(i, i + size);
    const results = await Promise.allSettled(batch.map((target) => remove(target)));
    results.forEach((result, j) => (result.status === 'fulfilled' ? gone : failed).push(batch[j]));
  }
  return { gone, failed };
}

/** 지운 뒤 안내 한 줄. 실패가 있으면 실패만, 여러 개를 다 지웠으면 그 수. */
export function deleteNotice(gone: number, failed: number): string | undefined {
  if (failed > 0) return `채팅 ${failed}개는 삭제하지 못했습니다.`;
  if (gone > 1) return `채팅 ${gone}개를 삭제했습니다.`;
  return undefined;
}

/** 이름 칸에 적은 글 → 보낼 이름(공백은 하나로). 비우면 첫 메시지 제목으로 돌아간다. */
export function renameDraft(draft: string): string {
  return String(draft ?? '').split(/\s+/).filter(Boolean).join(' ');
}

/** 관리 탭이 들고 있는 것. */
export interface ManagerState {
  kind: ConversationKind;
  query: string;
  items: Conversation[];
  cursor: string | null;
  total: number | null;
  searchHasMore: boolean;
  deletedCount: number;
  loading: boolean;
  loadingMore: boolean;
  error?: string;
  selected: ReadonlySet<string>;
  busy: boolean;
  notice?: string;
}

/** 웹뷰가 그릴 것. 글은 전부 여기서 정한다. */
export interface ManagerView {
  kind: ConversationKind;
  kinds: ReadonlyArray<{ value: ConversationKind; label: string }>;
  busy: boolean;
  notice?: string;
  /** 불러오지 못했다([다시 시도] 와 함께). */
  error?: string;
  /** 줄이 없을 때의 글(불러오는 중, 없음). */
  status?: string;
  rows: ManagerRow[];
  /** "총 N개". 모르면 없다. */
  total?: string;
  allSelected: boolean;
  /** [모두 선택] 을 누를 수 있는가. */
  canSelectAll: boolean;
  /** "M개 선택". 고른 것이 없으면 없다. */
  selectedLabel?: string;
  purge: { label: string; disabled: boolean; title?: string };
  /** [더 보기](검색 중이 아닐 때, 다음 쪽이 있으면). */
  more?: { label: string; disabled: boolean };
  /** 검색이 보낸 수보다 더 맞았다. */
  searchMore?: string;
}

export function managerView(state: ManagerState, now?: Date): ManagerView {
  const searching = !!state.query.trim();
  const rows = managerRows(state.items, state.selected, now);
  const selectedCount = rows.filter((row) => row.checked).length;
  let status: string | undefined;
  if (!state.error && rows.length === 0) {
    status = state.loading ? MANAGER_TEXT.loading : searching ? MANAGER_TEXT.noMatch : MANAGER_TEXT.empty;
  }
  return {
    kind: state.kind,
    kinds: MANAGER_KINDS,
    busy: state.busy,
    ...(state.notice ? { notice: state.notice } : {}),
    ...(state.error ? { error: `${MANAGER_TEXT.loadFailed} ${state.error}` } : {}),
    ...(status ? { status } : {}),
    rows,
    ...(state.total != null ? { total: `총 ${state.total}개` } : {}),
    allSelected: rows.length > 0 && selectedCount === rows.length,
    canSelectAll: rows.length > 0 && !state.busy,
    ...(selectedCount > 0 ? { selectedLabel: `${selectedCount}개 선택` } : {}),
    purge: {
      label: purgeDeletedLabel(state.deletedCount),
      disabled: state.busy || state.deletedCount <= 0,
      ...(state.deletedCount <= 0 ? { title: MANAGER_TEXT.nothingToPurge } : {}),
    },
    ...(state.cursor && !searching && !state.error
      ? { more: { label: state.loadingMore ? MANAGER_TEXT.loadingMore : MANAGER_TEXT.more, disabled: state.loadingMore } }
      : {}),
    ...(searching && state.searchHasMore && !state.error ? { searchMore: MANAGER_TEXT.searchMore } : {}),
  };
}
