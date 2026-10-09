import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  CONVERSATION_TAG_LABELS,
  conversationAgentLabel,
  conversationDisplayTitle,
  conversationKey,
} from '@dex/protocol';
import { publicError } from '@dex/engine';
import type { Conversation } from '@dex/engine';
import { ImeTextInput } from './ime-text-input';

/**
 * 대화 목록 사이드바 (2026-10-09).
 *
 * 예전에는 에이전트를 먼저 고르고 그 에이전트의 대화를 골랐다. 이제는 웹·데스크톱과 같이
 * **대화가 한 줄씩, 마지막으로 말한 순서로** 놓인다. 한 줄은 위에 작은 에이전트 이름(사라졌으면
 * [지워짐])과 꼬리표, 아래에 대화 제목이다. 제목·꼬리표·순서 규칙은 @dex/protocol 의
 * conversation-list 한 곳이 정하고, 여기서는 그대로 그린다.
 */

/** 한 번에 받는 대화 수. 끝까지 내려가면 다음 쪽을 받는다. */
export const CONVERSATION_PAGE_SIZE = 40;
export const SIDEBAR_WIDTH = 32;
export const NEW_CHAT_LABEL = '＋ 새 채팅';
export const PURGE_LABEL = '에이전트가 사라진 채팅 제거';
export const DELETED_AGENT_NOTICE = '지워진 에이전트입니다. 지난 대화만 볼 수 있습니다.';

export type ListRow =
  | { kind: 'new' }
  | { kind: 'purge'; count: number }
  | { kind: 'conversation'; conversation: Conversation };

export function buildRows(conversations: Conversation[], deletedCount: number): ListRow[] {
  return [
    { kind: 'new' },
    ...(deletedCount > 0 ? [{ kind: 'purge' as const, count: deletedCount }] : []),
    ...conversations.map((conversation) => ({ kind: 'conversation' as const, conversation })),
  ];
}

/** 커서는 줄 번호가 아니라 이 열쇠로 붙든다. 목록 앞에 줄이 끼어도 고른 대화가 그대로다. */
export function rowKey(row: ListRow): string {
  if (row.kind === 'conversation') return conversationKey(row.conversation);
  return `\u0000${row.kind}`;
}

/** 대화 줄은 두 줄(에이전트 이름 + 제목). [사라진 채팅 제거] 는 좁은 목록에서 두 줄로 접힌다. */
function rowHeight(row: ListRow): number {
  return row.kind === 'new' ? 1 : 2;
}

/**
 * 커서를 가운데 두고 높이 안에 드는 만큼만 고른다. [시작, 끝).
 *
 * 줄마다 높이가 달라 개수로 자르면 넘친다. 넘치면 ink 이 지우는 자리와 그리는 자리가
 * 어긋나 아래 안내줄까지 밟힌다.
 */
export function windowRows(heights: number[], cursor: number, budget: number): [number, number] {
  if (heights.length === 0) return [0, 0];
  const at = Math.min(Math.max(cursor, 0), heights.length - 1);
  let start = at;
  let end = at + 1;
  let used = heights[at] ?? 1;
  let grew = true;
  while (grew) {
    grew = false;
    if (end < heights.length && used + (heights[end] ?? 1) <= budget) {
      used += heights[end] ?? 1;
      end += 1;
      grew = true;
    }
    if (start > 0 && used + (heights[start - 1] ?? 1) <= budget) {
      start -= 1;
      used += heights[start] ?? 1;
      grew = true;
    }
  }
  return [start, end];
}

/** 줄 위쪽 작은 글: 에이전트 이름(또는 [지워짐])과, 일반 채팅이 아니면 꼬리표. */
export function conversationCaption(conversation: Conversation): string {
  const agent = conversationAgentLabel(conversation);
  return conversation.tag ? `${agent} · ${CONVERSATION_TAG_LABELS[conversation.tag]}` : agent;
}

/**
 * 대화를 언제 했는지.
 *
 * 서버가 주는 문자열을 그대로 쓰지 않는다. `2026-08-31T02:11:09.482Z` 는 목록에서
 * 읽으라고 있는 값이 아니다. 오늘 것은 시각만, 그 밖은 날짜만 보여 준다.
 */
export function when(conversation: Pick<Conversation, 'updatedAt' | 'createdAt'>): string {
  const raw = conversation.updatedAt || conversation.createdAt;
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) return raw || '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return sameDay
    ? `오늘 ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function SidebarFrame(props: { focused: boolean; title: string; children: ReactNode }): ReactNode {
  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      flexShrink={0}
      borderStyle="round"
      borderColor={props.focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Text bold>{props.title}</Text>
      {props.children}
    </Box>
  );
}

export function ConversationSidebar(props: {
  rows: ListRow[];
  cursor: number;
  /** 지금 대화창에 열린 대화. */
  openKey?: string;
  focused: boolean;
  height: number;
  /** 맨 아래 한 줄: 불러오는 중·지운 결과·오류. */
  status?: { text: string; error?: boolean };
}): ReactNode {
  // 테두리 2줄 + 제목 1줄 + 상태 1줄.
  const budget = Math.max(3, props.height - 4);
  const [start, end] = windowRows(props.rows.map(rowHeight), props.cursor, budget);
  return (
    <SidebarFrame focused={props.focused} title="채팅">
      {props.rows.slice(start, end).map((row, offset) => {
        const index = start + offset;
        const cursor = index === props.cursor;
        const color = cursor && props.focused ? 'cyan' : undefined;
        const mark = cursor ? '›' : ' ';
        if (row.kind === 'new') {
          return (
            <Text key={rowKey(row)} color={color} wrap="truncate-end">
              {mark} {NEW_CHAT_LABEL}
            </Text>
          );
        }
        if (row.kind === 'purge') {
          // 좁은 목록에 한 줄로는 안 들어간다. 낱말 사이에서 두 줄로 접는다.
          const cut = PURGE_LABEL.lastIndexOf(' ');
          return (
            <Box key={rowKey(row)} flexDirection="column">
              <Text color={color ?? 'yellow'} wrap="truncate-end">
                {mark} {PURGE_LABEL.slice(0, cut)}
              </Text>
              <Text color={color ?? 'yellow'} wrap="truncate-end">
                {'  '}
                {PURGE_LABEL.slice(cut + 1)} ({row.count})
              </Text>
            </Box>
          );
        }
        const conversation = row.conversation;
        const open = rowKey(row) === props.openKey;
        return (
          <Box key={rowKey(row)} flexDirection="column">
            <Text dimColor color={conversation.agentDeleted ? 'red' : undefined} wrap="truncate-end">
              {'  '}
              {conversationCaption(conversation)}
            </Text>
            <Text color={color} bold={open} wrap="truncate-end">
              {mark} {conversationDisplayTitle(conversation)}
            </Text>
          </Box>
        );
      })}
      {props.status ? (
        <Text color={props.status.error ? 'red' : undefined} dimColor={!props.status.error} wrap="truncate-end">
          {props.status.text}
        </Text>
      ) : null}
    </SidebarFrame>
  );
}

/**
 * 대화 이름 바꾸기. 비우고 저장하면 붙인 이름을 지워 첫 메시지 제목으로 돌아간다.
 * 이름을 바꿔도 목록 순서는 그대로다(마지막으로 말한 순서).
 */
export function RenamePanel(props: {
  conversation: Conversation;
  onSave: (title: string) => Promise<void>;
  onCancel: () => void;
  nativeIme?: boolean;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
}): ReactNode {
  const [value, setValue] = useState(props.conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    props.onSave(value.trim()).catch((reason: unknown) => {
      setError(publicError(reason).message);
      setBusy(false);
    });
  };

  useInput(
    (_input, key) => {
      if (key.escape) props.onCancel();
    },
    { isActive: !busy },
  );

  return (
    <SidebarFrame focused title="이름 바꾸기">
      <Text dimColor wrap="truncate-end">
        {conversationCaption(props.conversation)}
      </Text>
      <Box>
        <Text color="cyan">› </Text>
        <ImeTextInput
          value={value}
          onChange={setValue}
          onSubmit={save}
          focus={!busy}
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor wrap="truncate-end">
        {busy ? '저장하는 중...' : 'Enter 저장 · Esc 취소'}
      </Text>
    </SidebarFrame>
  );
}

/** 지우기 전에 한 번 묻는다(y/n). 되돌릴 수 없는 일이다. */
export function ConfirmPanel(props: {
  title: string;
  question: string;
  detail?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useInput(
    (input, key) => {
      if (key.escape || input === 'n' || input === 'N' || input === 'ㅜ') {
        props.onCancel();
        return;
      }
      if (input === 'y' || input === 'Y' || input === 'ㅛ') {
        setBusy(true);
        setError(undefined);
        props.onConfirm().catch((reason: unknown) => {
          setError(publicError(reason).message);
          setBusy(false);
        });
      }
    },
    { isActive: !busy },
  );

  return (
    <SidebarFrame focused title={props.title}>
      <Text>{props.question}</Text>
      {props.detail ? (
        <Text dimColor wrap="truncate-end">
          {props.detail}
        </Text>
      ) : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor wrap="truncate-end">
        {busy ? '지우는 중...' : 'y 지우기 · n 취소'}
      </Text>
    </SidebarFrame>
  );
}
