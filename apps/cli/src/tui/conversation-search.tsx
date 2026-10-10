import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  CONVERSATION_TAG_LABELS,
  DELETED_AGENT_LABEL,
  SEARCH_DELAY_MS,
  SEARCH_RECENT_COUNT,
  conversationDayLabel,
  conversationDisplayTitle,
  conversationKey,
  searchHasHit,
} from '@dex/protocol';
import type { ConversationSearchMatch, SearchTextPart } from '@dex/protocol';
import { publicError } from '@dex/engine';
import type { Conversation, ConversationSearchPage } from '@dex/engine';
import { ImeTextInput } from './ime-text-input';
import { SidebarFrame, windowRows } from './conversation-list';

/**
 * 채팅 검색 (2026-10-10). 목록에서 `/`(또는 Ctrl+K › 채팅 검색)를 누르면 목록 자리에 뜬다.
 *
 * 웹·데스크톱의 검색 창과 같은 일을 한다: 검색어가 비면 최근 채팅, 적으면 잠깐 뒤 서버에 묻는다.
 * 제목·에이전트 이름·대화 내용으로 찾고(규칙은 서버 한 곳, @dex/protocol conversation-search), 맞은
 * 낱말은 노랗게 칠한다. ↑↓ 로 고르고 Enter 로 열고, Esc 로 목록에 돌아간다.
 */

export const SEARCH_TITLE = '채팅 검색';
/** 한 번에 받는 결과 수. */
export const SEARCH_LIMIT = 50;

interface Row {
  conversation: Conversation;
  match?: ConversationSearchMatch;
}

function Parts(props: { parts: SearchTextPart[] }): ReactNode {
  return (
    <>
      {props.parts.map((p, i) =>
        p.hit ? (
          <Text key={i} color="yellow" bold>
            {p.text}
          </Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </>
  );
}

/** 줄 위쪽 작은 글: 에이전트 이름(맞은 자리는 칠한다), 꼬리표, 마지막으로 말한 날. */
function Caption(props: { row: Row }): ReactNode {
  const { conversation, match } = props.row;
  const agentParts = match?.agent ?? [{ text: conversation.workflowName, hit: false }];
  const showName = !conversation.agentDeleted || searchHasHit(match?.agent);
  const tag = conversation.tag ? ` · ${CONVERSATION_TAG_LABELS[conversation.tag]}` : '';
  const day = conversationDayLabel(conversation.updatedAt || conversation.createdAt);
  return (
    <Text dimColor wrap="truncate-end">
      {'  '}
      {conversation.agentDeleted ? <Text color="red">{DELETED_AGENT_LABEL} </Text> : null}
      {showName ? <Parts parts={agentParts} /> : null}
      {tag}
      {day ? ` · ${day}` : ''}
    </Text>
  );
}

function rowHeight(row: Row): number {
  return row.match?.snippet ? 3 : 2;
}

export function SearchPanel(props: {
  /** 지금 목록(마지막으로 말한 순서). 검색어가 비면 맨 위 몇 개. */
  recent: Conversation[];
  search: (query: string) => Promise<ConversationSearchPage>;
  onOpen: (conversation: Conversation) => void;
  onCancel: () => void;
  height: number;
  nativeIme?: boolean;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<ConversationSearchPage>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const seq = useRef(0);
  const trimmed = query.trim();

  useEffect(() => {
    const mine = ++seq.current;
    if (!trimmed) {
      setPage(undefined);
      setSearching(false);
      setError(undefined);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      props
        .search(trimmed)
        .then((next) => {
          if (mine !== seq.current) return;
          setPage(next);
          setError(undefined);
          setCursor(0);
        })
        .catch((reason: unknown) => {
          if (mine === seq.current) setError(publicError(reason).message);
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed]);

  const rows: Row[] = trimmed
    ? (page?.hits ?? []).map((hit) => ({ conversation: hit.conversation, match: hit.match }))
    : props.recent.slice(0, SEARCH_RECENT_COUNT).map((conversation) => ({ conversation }));
  const at = rows.length ? Math.min(cursor, rows.length - 1) : 0;
  // Enter 는 입력칸이 받는데, 입력칸의 키 처리기는 그린 뒤에야 새것으로 바뀐다. 결과가 막 그려진 순간의
  // Enter 가 옛 처리기(빈 결과)에 걸리지 않게 지금 줄은 ref 로 읽는다.
  const chosen = useRef<Conversation | undefined>(undefined);
  chosen.current = rows[at]?.conversation;

  useInput((_input, key) => {
    if (key.escape) props.onCancel();
    else if (key.upArrow) setCursor(rows.length ? (at - 1 + rows.length) % rows.length : 0);
    else if (key.downArrow) setCursor(rows.length ? (at + 1) % rows.length : 0);
  });

  let status: { text: string; error?: boolean } | undefined;
  if (!trimmed) status = rows.length ? { text: '최근 채팅' } : undefined;
  else if (error) status = { text: `검색하지 못했습니다. ${error}`, error: true };
  else if (!page || (searching && rows.length === 0)) status = { text: '검색 중...' };
  else if (rows.length === 0) status = { text: '맞는 채팅이 없습니다.' };

  // 테두리 2 + 제목 1 + 입력 1 + 상태 1 + 안내 1.
  const budget = Math.max(2, props.height - 6);
  const [start, end] = windowRows(rows.map(rowHeight), at, budget);

  return (
    <SidebarFrame focused title={SEARCH_TITLE}>
      <Box>
        <Text color="cyan">⌕ </Text>
        <ImeTextInput
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            if (chosen.current) props.onOpen(chosen.current);
          }}
          focus
          placeholder="검색..."
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
      </Box>
      {status ? (
        <Text color={status.error ? 'red' : undefined} dimColor={!status.error} wrap="truncate-end">
          {status.text}
        </Text>
      ) : null}
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset;
        const selected = index === at;
        const title = row.match?.title.length ? row.match.title : [{ text: conversationDisplayTitle(row.conversation), hit: false }];
        return (
          <Box key={conversationKey(row.conversation)} flexDirection="column">
            <Caption row={row} />
            <Text color={selected ? 'cyan' : undefined} wrap="truncate-end">
              {selected ? '›' : ' '} <Parts parts={title} />
            </Text>
            {row.match?.snippet ? (
              <Text dimColor wrap="truncate-end">
                {'  '}
                <Parts parts={row.match.snippet} />
              </Text>
            ) : null}
          </Box>
        );
      })}
      <Text dimColor wrap="truncate-end">
        {trimmed && page && !page.contentSearched
          ? '이 서버는 제목·에이전트 이름으로만 찾습니다.'
          : trimmed && page?.hasMore
            ? '더 있습니다. 낱말을 더 적어 보세요.'
            : '↑↓ 고르기 · Enter 열기 · Esc 닫기'}
      </Text>
    </SidebarFrame>
  );
}
