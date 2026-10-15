import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  CONVERSATION_TAG_LABELS,
  DELETED_AGENT_LABEL,
  SEARCH_DELAY_MS,
  conversationDayLabel,
  conversationDisplayTitle,
  conversationKey,
  mergeConversationPage,
} from '@dex/protocol';
import { publicError } from '@dex/engine';
import type { Conversation, ConversationKind } from '@dex/engine';
import type { TuiEngine } from './model';
import { ImeTextInput } from './ime-text-input';
import { PURGE_LABEL, windowRows } from './conversation-list';

/**
 * 채팅 기록 관리 (2026-10-10). 목록에서 m, 또는 Ctrl+K › 채팅 기록 관리. 몸통 자리를 다 쓴다.
 *
 * 데스크톱의 채팅 기록 관리 탭과 같은 일을 터미널에서 한다: 상태 필터(전체·활성·배포·삭제됨, Tab),
 * 검색(제목·에이전트 이름·내용), 고르기(Space 한 줄, a 모두), 열기·이름 바꾸기·삭제, 에이전트가 사라진 채팅 제거.
 * 목록·검색·필터 규칙은 서버가 정한다(kind). 바꾼 것은 onChange 로 알려 왼쪽 목록이 곧바로 따라간다.
 *
 * 검색 줄에 글을 적는 동안에는 글자가 검색어가 된다. 목록으로 내려와야(↓, Enter, Esc) 글자 키가 명령이 된다.
 */

export const MANAGER_TITLE = '채팅 기록 관리';
export const MANAGER_SEARCH_PLACEHOLDER = '제목·에이전트 이름·내용으로 검색';
/** 한 번에 받는 대화 수(검색이 아닐 때). */
const PAGE_SIZE = 50;
/** 검색 결과 수. */
export const MANAGER_SEARCH_LIMIT = 100;
/** 한꺼번에 지울 때 동시에 보내는 요청 수. */
const DELETE_CONCURRENCY = 4;
/** 끝에서 몇 줄 전에 다음 쪽을 받아 둔다. */
const PREFETCH_ROWS = 3;

export const KIND_OPTIONS: ReadonlyArray<{ value: ConversationKind; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'active', label: '활성' },
  { value: 'deploy', label: '배포' },
  { value: 'deleted', label: '삭제됨' },
];

/** 여기서 바꾼 것. 대시보드가 왼쪽 목록에 싣는다. */
export type ManagerChange =
  | { type: 'renamed'; workflowId: string; interactionId: string; title: string; customTitle: boolean }
  | { type: 'removed'; items: Conversation[] }
  | { type: 'purged' };

/** 아래 한 줄에서 묻는 것. */
type Prompt =
  | { kind: 'rename'; conversation: Conversation; value: string }
  | { kind: 'delete'; targets: Conversation[] }
  | { kind: 'purge'; count: number };

/** 지우기 전에 묻는 글(데스크톱과 같다). */
export function deleteQuestion(targets: Conversation[]): string {
  return targets.length === 1
    ? `"${conversationDisplayTitle(targets[0])}" 대화를 삭제할까요? 되돌릴 수 없습니다.`
    : `선택한 채팅 ${targets.length}개를 삭제할까요? 되돌릴 수 없습니다.`;
}

export function ConversationManagerScreen(props: {
  engine: TuiEngine;
  profile: string;
  /** 이 화면이 쓸 높이(몸통 높이). */
  height: number;
  onOpen: (conversation: Conversation) => void;
  onChange: (change: ManagerChange) => void;
  onClose: () => void;
  nativeIme?: boolean;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
}): ReactNode {
  const [kind, setKind] = useState<ConversationKind>('all');
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const [items, setItems] = useState<Conversation[]>([]);
  /** 다음 쪽 커서(검색 중에는 없다). */
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [deletedCount, setDeletedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [at, setAt] = useState(0);
  /** 키를 받는 자리: 검색 줄(글을 적는다) 또는 목록(명령 키). */
  const [zone, setZone] = useState<'list' | 'search'>('list');
  const [prompt, setPrompt] = useState<Prompt>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  /** 필터·검색어가 바뀔 때마다 오른다. 늦게 온 옛 답이 새 목록을 덮지 않게 한다. */
  const seq = useRef(0);

  const load = async (): Promise<void> => {
    const mine = ++seq.current;
    setLoading(true);
    setError(undefined);
    try {
      if (trimmed) {
        const page = await props.engine.searchConversations(
          trimmed,
          { limit: MANAGER_SEARCH_LIMIT, kind },
          props.profile,
        );
        if (mine !== seq.current) return;
        setItems(page.hits.map((hit) => hit.conversation));
        setCursor(null);
        setTotal(page.hits.length);
        setSearchHasMore(page.hasMore);
      } else {
        const page = await props.engine.conversationPage({ limit: PAGE_SIZE, kind }, props.profile);
        if (mine !== seq.current) return;
        setItems(page.conversations);
        setCursor(page.nextCursor);
        setTotal(page.total ?? null);
        setSearchHasMore(false);
        setDeletedCount(page.agentDeletedCount ?? 0);
      }
    } catch (reason) {
      if (mine === seq.current) setError(publicError(reason).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  // 필터·검색어가 바뀌면 처음부터 다시 읽는다(검색은 적기를 멈춘 뒤). 고른 것은 비운다.
  useEffect(() => {
    seq.current += 1;
    setSelected(new Set());
    setAt(0);
    const timer = setTimeout(() => void loadRef.current(), trimmed ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [kind, trimmed]);

  // 안내 한 줄은 잠시 뒤 사라진다.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** 다음 쪽(검색이 아닐 때, 끝 가까이 내려왔다). */
  const loadMore = async (): Promise<void> => {
    if (!cursor || trimmed || loadingMoreRef.current) return;
    const mine = seq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await props.engine.conversationPage({ limit: PAGE_SIZE, kind, cursor }, props.profile);
      if (mine !== seq.current) return;
      setItems((current) => mergeConversationPage(current, page.conversations, 'append'));
      setCursor(page.nextCursor);
    } catch (reason) {
      if (mine === seq.current) setNotice({ text: `더 불러오지 못했습니다. ${publicError(reason).message}`, error: true });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const index = items.length ? Math.min(at, items.length - 1) : 0;

  useEffect(() => {
    if (cursor && !trimmed && !loading && !error && items.length > 0 && index >= items.length - PREFETCH_ROWS) {
      void loadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items.length, cursor, trimmed, loading, error]);

  const cycleKind = (step: 1 | -1): void => {
    setKind((value) => {
      const i = KIND_OPTIONS.findIndex((option) => option.value === value);
      return KIND_OPTIONS[(i + step + KIND_OPTIONS.length) % KIND_OPTIONS.length].value;
    });
  };

  const toggleOne = (conversation: Conversation): void => {
    const key = conversationKey(conversation);
    setSelected((value) => {
      const next = new Set(value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (list: Conversation[]): void => {
    setSelected((value) =>
      list.length > 0 && list.every((item) => value.has(conversationKey(item)))
        ? new Set()
        : new Set(list.map(conversationKey)),
    );
  };

  const deleteMany = async (targets: Conversation[]): Promise<void> => {
    setBusy(true);
    const failed: Conversation[] = [];
    try {
      for (let i = 0; i < targets.length; i += DELETE_CONCURRENCY) {
        const batch = targets.slice(i, i + DELETE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((item) =>
            props.engine.deleteConversation(item.workflowId, item.interactionId, item.workflowName, props.profile),
          ),
        );
        results.forEach((result, j) => {
          if (result.status === 'rejected') failed.push(batch[j]);
        });
      }
      const failedKeys = new Set(failed.map(conversationKey));
      const gone = targets.filter((item) => !failedKeys.has(conversationKey(item)));
      const goneKeys = new Set(gone.map(conversationKey));
      setItems((list) => list.filter((item) => !goneKeys.has(conversationKey(item))));
      setSelected((value) => new Set([...value].filter((key) => !goneKeys.has(key))));
      setTotal((count) => (count == null ? count : Math.max(0, count - gone.length)));
      const goneDeleted = gone.filter((item) => item.agentDeleted).length;
      if (goneDeleted) setDeletedCount((count) => Math.max(0, count - goneDeleted));
      if (gone.length) props.onChange({ type: 'removed', items: gone });
      if (failed.length) setNotice({ text: `채팅 ${failed.length}개는 삭제하지 못했습니다.`, error: true });
      else setNotice({ text: `채팅 ${gone.length}개를 삭제했습니다.` });
    } finally {
      setBusy(false);
      setPrompt(undefined);
    }
  };

  const purge = async (): Promise<void> => {
    setBusy(true);
    try {
      const removed = await props.engine.purgeDeletedAgentConversations(props.profile);
      setDeletedCount(0);
      props.onChange({ type: 'purged' });
      setNotice({ text: `채팅 ${removed}개를 정리했습니다.` });
      await loadRef.current();
    } catch (reason) {
      setNotice({ text: `채팅 정리에 실패했습니다. ${publicError(reason).message}`, error: true });
    } finally {
      setBusy(false);
      setPrompt(undefined);
    }
  };

  /** 이름 바꾸기. 비우면 서버가 첫 메시지 제목으로 돌려준다. 그대로면 묻지 않는다. */
  const rename = async (conversation: Conversation, value: string): Promise<void> => {
    setPrompt(undefined);
    const next = value.split(/\s+/).filter(Boolean).join(' ');
    if (next === conversation.title) return;
    setBusy(true);
    try {
      const result = await props.engine.renameConversation(
        conversation.workflowId,
        conversation.interactionId,
        next,
        props.profile,
      );
      const key = conversationKey(conversation);
      setItems((list) =>
        list.map((item) =>
          conversationKey(item) === key ? { ...item, title: result.title, customTitle: result.customTitle } : item,
        ),
      );
      props.onChange({
        type: 'renamed',
        workflowId: conversation.workflowId,
        interactionId: conversation.interactionId,
        title: result.title,
        customTitle: result.customTitle,
      });
    } catch (reason) {
      setNotice({ text: `이름을 바꾸지 못했습니다. ${publicError(reason).message}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  // 키 처리기는 그린 뒤에야 새것으로 바뀐다. 막 그려진 순간의 키가 옛 값을 보지 않게 지금 값은 ref 로 읽는다.
  const live = useRef({ items, index, selected, deletedCount, prompt, zone, busy });
  live.current = { items, index, selected, deletedCount, prompt, zone, busy };

  useInput((input, key) => {
    const now = live.current;
    if (now.busy) return;
    const asking = now.prompt;
    if (asking?.kind === 'delete' || asking?.kind === 'purge') {
      if (key.escape || input === 'n' || input === 'N' || input === 'ㅜ') setPrompt(undefined);
      else if (input === 'y' || input === 'Y' || input === 'ㅛ') {
        void (asking.kind === 'delete' ? deleteMany(asking.targets) : purge());
      }
      return;
    }
    // 이름 칸은 Enter 를 스스로 받는다(onSubmit). 여기서는 Esc 만.
    if (asking?.kind === 'rename') {
      if (key.escape) setPrompt(undefined);
      return;
    }
    if (key.tab) {
      cycleKind(key.shift ? -1 : 1);
      return;
    }
    if (now.zone === 'search') {
      // 글자는 검색 칸이 받는다. Enter 는 검색 칸의 onSubmit 이 목록으로 내린다.
      if (key.escape || key.downArrow) setZone('list');
      return;
    }
    const row = now.items[now.index];
    // 두벌식 한글 자판이 켜져 있어도 같은 자리의 키(ㅁ=a, ㄱ=r, ㅇ=d, ㅔ=p)로 듣는다.
    if (key.escape) props.onClose();
    else if (key.upArrow) {
      if (now.index <= 0) setZone('search');
      else setAt(now.index - 1);
    } else if (key.downArrow) setAt(Math.min(Math.max(0, now.items.length - 1), now.index + 1));
    else if (input === '/') setZone('search');
    else if (input === 'p' || input === 'ㅔ') {
      if (now.deletedCount > 0) setPrompt({ kind: 'purge', count: now.deletedCount });
      else setNotice({ text: '정리할 채팅이 없습니다.' });
    } else if (input === 'a' || input === 'ㅁ') toggleAll(now.items);
    else if (!row) return;
    else if (key.return) props.onOpen(row);
    else if (input === ' ') toggleOne(row);
    else if (input === 'r' || input === 'ㄱ') setPrompt({ kind: 'rename', conversation: row, value: row.title });
    else if (input === 'd' || input === 'ㅇ' || key.delete) {
      const chosen = now.items.filter((item) => now.selected.has(conversationKey(item)));
      setPrompt({ kind: 'delete', targets: chosen.length ? chosen : [row] });
    }
  });

  const allSelected = items.length > 0 && items.every((item) => selected.has(conversationKey(item)));
  const selectedCount = items.filter((item) => selected.has(conversationKey(item))).length;

  // 테두리 2 + 제목 1 + 상태 1 + 검색 1 + 모두 선택 줄 1 + 아래 한 줄 1 + 안내 1.
  const budget = Math.max(3, props.height - 8);
  const [start, end] = windowRows(
    items.map(() => 1),
    index,
    budget,
  );

  let empty: { text: string; error?: boolean } | undefined;
  if (error) empty = { text: `채팅 기록을 불러오지 못했습니다. ${error}`, error: true };
  else if (loading && items.length === 0) empty = { text: '불러오는 중...' };
  else if (items.length === 0) empty = { text: trimmed ? '맞는 채팅이 없습니다.' : '채팅 기록이 없습니다.' };

  let bottom: ReactNode = null;
  if (prompt?.kind === 'delete') {
    bottom = (
      <Text color="yellow" wrap="truncate-end">
        {deleteQuestion(prompt.targets)}
      </Text>
    );
  } else if (prompt?.kind === 'purge') {
    bottom = (
      <Text color="yellow" wrap="truncate-end">
        에이전트가 사라진 채팅 {prompt.count}개를 모두 지웁니다. 되돌릴 수 없습니다.
      </Text>
    );
  } else if (prompt?.kind === 'rename') {
    const target = prompt.conversation;
    bottom = (
      <Box>
        <Text color="cyan">이름 바꾸기 › </Text>
        <ImeTextInput
          value={prompt.value}
          onChange={(value) => setPrompt((asking) => (asking?.kind === 'rename' ? { ...asking, value } : asking))}
          onSubmit={(value) => void rename(target, value)}
          focus={!busy}
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
      </Box>
    );
  } else if (notice) {
    bottom = (
      <Text color={notice.error ? 'red' : 'cyan'} wrap="truncate-end">
        {notice.text}
      </Text>
    );
  } else if (loadingMore) {
    bottom = <Text dimColor>더 불러오는 중...</Text>;
  } else if (trimmed && searchHasMore && !error) {
    bottom = (
      <Text dimColor wrap="truncate-end">
        맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.
      </Text>
    );
  }

  const help = busy
    ? prompt?.kind === 'purge'
      ? '지우는 중...'
      : prompt?.kind === 'delete'
        ? '삭제하는 중...'
        : '저장하는 중...'
    : prompt?.kind === 'delete'
      ? 'y 삭제 · n 취소'
      : prompt?.kind === 'purge'
        ? 'y 지우기 · n 취소'
        : prompt?.kind === 'rename'
          ? 'Enter 저장 · Esc 취소'
          : zone === 'search'
            ? '적으면 찾습니다 · ↓·Enter 목록으로 · Tab 상태 · Esc 목록으로'
            : '↑↓ 이동 · Space 고르기 · a 모두 · Enter 열기 · r 이름 바꾸기 · d 삭제 · p 정리 · / 검색 · Tab 상태 · Esc 닫기';

  return (
    <Box flexDirection="column" flexGrow={1} height={props.height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{MANAGER_TITLE}</Text>
      <Text wrap="truncate-end">
        <Text dimColor>상태 </Text>
        {KIND_OPTIONS.map((option) =>
          option.value === kind ? (
            <Text key={option.value} color="cyan" bold>
              [{option.label}]
            </Text>
          ) : (
            <Text key={option.value} dimColor>
              {' '}
              {option.label}{' '}
            </Text>
          ),
        )}
        <Text dimColor> · Tab 바꾸기</Text>
      </Text>
      <Box>
        <Text color={zone === 'search' && !prompt ? 'cyan' : undefined}>⌕ </Text>
        <ImeTextInput
          value={query}
          onChange={setQuery}
          onSubmit={() => setZone('list')}
          focus={zone === 'search' && !prompt && !busy}
          placeholder={MANAGER_SEARCH_PLACEHOLDER}
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
      </Box>
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          {allSelected ? '[x]' : '[ ]'} 모두 선택
          {total != null ? <Text dimColor> · 총 {total}개</Text> : null}
          {selectedCount > 0 ? <Text color="cyan"> · {selectedCount}개 선택</Text> : null}
        </Text>
        <Text dimColor={deletedCount === 0} color={deletedCount > 0 ? 'yellow' : undefined} wrap="truncate-end">
          p {PURGE_LABEL} ({deletedCount})
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {empty ? (
          <Text color={empty.error ? 'red' : undefined} dimColor={!empty.error} wrap="truncate-end">
            {empty.text}
          </Text>
        ) : (
          items.slice(start, end).map((item, offset) => {
            const active = start + offset === index;
            const checked = selected.has(conversationKey(item));
            const day = conversationDayLabel(item.updatedAt || item.createdAt);
            return (
              <Text
                key={conversationKey(item)}
                color={active && zone === 'list' ? 'cyan' : undefined}
                wrap="truncate-end"
              >
                {active ? '›' : ' '} {checked ? '[x]' : '[ ]'} {conversationDisplayTitle(item)}
                <Text dimColor> · </Text>
                {item.agentDeleted ? (
                  <Text color="red">{DELETED_AGENT_LABEL}</Text>
                ) : (
                  <Text dimColor>{item.workflowName}</Text>
                )}
                {item.tag ? <Text dimColor> · {CONVERSATION_TAG_LABELS[item.tag]}</Text> : null}
                {day ? <Text dimColor> · {day}</Text> : null}
              </Text>
            );
          })
        )}
      </Box>
      {bottom ?? <Text> </Text>}
      <Text dimColor wrap="truncate-end">
        {help}
      </Text>
    </Box>
  );
}
