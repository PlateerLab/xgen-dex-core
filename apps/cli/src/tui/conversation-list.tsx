import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  CONVERSATION_TAG_LABELS,
  DELETED_AGENT_LABEL,
  RECENT_CONVERSATION_STEP,
  conversationAgentLabel,
  conversationDayLabel,
  conversationDisplayTitle,
  conversationKey,
} from '@dex/protocol';
import { publicError } from '@dex/engine';
import type { Conversation, ConversationAgent } from '@dex/engine';
import { ImeTextInput } from './ime-text-input';

/**
 * 대화 목록 사이드바 (2026-10-09, 2026-10-10 [최근 채팅]·[에이전트]).
 *
 * 웹·데스크톱과 같은 모양이다. 맨 위 [＋ 새 채팅] 아래에 두 묶음이 놓인다.
 *
 *   최근 채팅   마지막으로 말한 대화 5개. [더 보기] 로 5개씩 늘리고 [접기] 로 되돌린다.
 *   에이전트    대화가 있는 에이전트(대화 수, 마지막 대화의 제목·날). 최근에 쓴 5개, [더 보기]·[접기] 는 같다.
 *               고르면 그 에이전트의 대화로 들어간다.
 *
 * 묶음 머리(최근 채팅·에이전트)에서 Enter 면 그 묶음을 접고 편다. 새 채팅은 [＋ 새 채팅] 에서만 연다.
 *
 * 대화 한 줄은 위에 작은 에이전트 이름(사라졌으면 [지워짐])과 꼬리표, 아래에 대화 제목이다. 제목·꼬리표·순서·묶음
 * 규칙은 @dex/protocol 의 conversation-list·conversation-agents 가 정하고, 여기서는 그대로 그린다.
 */

/** 한 번에 받는 대화 수. 끝까지 내려가면 다음 쪽을 받는다. */
export const CONVERSATION_PAGE_SIZE = 40;
/** [에이전트] 묶음을 한 번에 받는 수. */
export const AGENT_GROUP_LIMIT = 200;
export const SIDEBAR_WIDTH = 32;
export const NEW_CHAT_LABEL = '＋ 새 채팅';
/** [＋ 새 채팅] 줄 오른쪽: 채팅 검색 열기(목록에서 `/`). */
export const SEARCH_HINT = '⌕ /';
export const PURGE_LABEL = '에이전트가 사라진 채팅 제거';
export const DELETED_AGENT_NOTICE = '지워진 에이전트입니다. 지난 대화만 볼 수 있습니다.';
export const RECENT_LABEL = '최근 채팅';
export const MORE_LABEL = '더 보기';
export const LESS_LABEL = '접기';
export const AGENTS_LABEL = '에이전트';
export const BACK_LABEL = '뒤로';
export const NO_AGENT_CHATS = '아직 채팅이 없습니다';

/** 목록의 두 묶음. */
export type ListSection = 'recent' | 'agents';

export const SECTION_LABELS: Record<ListSection, string> = { recent: RECENT_LABEL, agents: AGENTS_LABEL };

export type ListRow =
  | { kind: 'new' }
  /** 묶음 머리(최근 채팅·에이전트). Enter 로 접고 편다. */
  | { kind: 'section'; section: ListSection; open: boolean }
  /** 두 묶음 사이 빈 줄. 고를 수 없다. */
  | { kind: 'gap' }
  /** `inAgent` 면 에이전트 안의 대화다. 위쪽 작은 글에 에이전트 이름 대신 날을 쓴다. */
  | { kind: 'conversation'; conversation: Conversation; inAgent?: boolean }
  | { kind: 'more'; section: ListSection }
  | { kind: 'less'; section: ListSection }
  | { kind: 'agent'; agent: ConversationAgent }
  /** 빈 자리 안내(아직 채팅이 없습니다). 고를 수 없다. */
  | { kind: 'note'; text: string }
  | { kind: 'back'; agent: ConversationAgent };

/** 목록이 그릴 것. 에이전트 안으로 들어갔으면 `drill` 이 있고 그 에이전트의 대화만 보인다. */
export interface ListModel {
  conversations: Conversation[];
  /** [최근 채팅] 에 보일 수(5개씩 는다). */
  recentShown: number;
  /** 서버에 받을 쪽이 더 있다. */
  hasMore: boolean;
  agents: ConversationAgent[];
  /** [에이전트] 에 보일 수(5개씩 는다). */
  agentsShown: number;
  /** 접어 둔 묶음. */
  closed: readonly ListSection[];
  drill?: {
    agent: ConversationAgent;
    conversations: Conversation[];
    /** 다 받았다(빈 목록이면 [아직 채팅이 없습니다]). */
    done: boolean;
  };
}

/** 묶음 하나: 머리, 펴져 있으면 줄들과 [더 보기]·[접기]. */
function sectionRows<T>(
  section: ListSection,
  items: T[],
  shownCount: number,
  hasMore: boolean,
  open: boolean,
  toRow: (item: T) => ListRow,
): ListRow[] {
  const rows: ListRow[] = [{ kind: 'section', section, open }];
  if (!open) return rows;
  const shown = items.slice(0, shownCount);
  for (const item of shown) rows.push(toRow(item));
  if (items.length > shown.length || hasMore) rows.push({ kind: 'more', section });
  if (shown.length > RECENT_CONVERSATION_STEP) rows.push({ kind: 'less', section });
  return rows;
}

export function buildRows(model: ListModel): ListRow[] {
  if (model.drill) {
    const { agent, conversations, done } = model.drill;
    const rows: ListRow[] = [{ kind: 'back', agent }];
    for (const conversation of conversations) rows.push({ kind: 'conversation', conversation, inAgent: true });
    if (done && conversations.length === 0) rows.push({ kind: 'note', text: NO_AGENT_CHATS });
    return rows;
  }
  const rows: ListRow[] = [{ kind: 'new' }];
  const open = (section: ListSection): boolean => !model.closed.includes(section);
  if (model.conversations.length > 0) {
    const toRow = (conversation: Conversation): ListRow => ({ kind: 'conversation', conversation });
    rows.push(...sectionRows('recent', model.conversations, model.recentShown, model.hasMore, open('recent'), toRow));
  }
  if (model.agents.length > 0) {
    // 두 묶음 사이는 한 줄 띄운다.
    if (model.conversations.length > 0) rows.push({ kind: 'gap' });
    const toRow = (agent: ConversationAgent): ListRow => ({ kind: 'agent', agent });
    rows.push(...sectionRows('agents', model.agents, model.agentsShown, false, open('agents'), toRow));
  }
  return rows;
}

/** 하나뿐인 줄([＋ 새 채팅]·[←])의 열쇠. */
export function fixedRowKey(kind: 'new' | 'back'): string {
  return `\u0000${kind}`;
}

/** 묶음마다 하나인 줄(머리·[더 보기]·[접기])의 열쇠. */
export function sectionRowKey(kind: 'section' | 'more' | 'less', section: ListSection): string {
  return `\u0000${kind}\u0000${section}`;
}

/** [에이전트] 묶음의 한 줄 열쇠. */
export function agentRowKey(workflowId: string): string {
  return `\u0000agent\u0000${workflowId}`;
}

/** 커서는 줄 번호가 아니라 이 열쇠로 붙든다. 목록 앞에 줄이 끼어도 고른 줄이 그대로다. */
export function rowKey(row: ListRow): string {
  switch (row.kind) {
    case 'conversation':
      return conversationKey(row.conversation);
    case 'section':
    case 'more':
    case 'less':
      return sectionRowKey(row.kind, row.section);
    case 'gap':
      return '\u0000gap';
    case 'note':
      return `\u0000note\u0000${row.text}`;
    case 'agent':
      return agentRowKey(row.agent.workflowId);
    default:
      return fixedRowKey(row.kind);
  }
}

/** 커서가 설 수 있는 줄인가. 묶음 사이 빈 줄과 빈 자리 안내는 건너뛴다. */
export function selectableRow(row: ListRow): boolean {
  return row.kind !== 'gap' && row.kind !== 'note';
}

/** `from` 에서 `delta` 쪽으로 가장 가까운 고를 수 있는 줄. 없으면 `from` 그대로. */
export function stepSelectable(rows: ListRow[], from: number, delta: 1 | -1): number {
  for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
    if (selectableRow(rows[i])) return i;
  }
  return from;
}

/** `at` 자리(아니면 그 아래, 없으면 위)의 고를 수 있는 줄. 커서가 붙든 줄이 사라졌을 때 설 곳이다. */
export function nearestSelectable(rows: ListRow[], at: number): number {
  if (rows.length === 0) return 0;
  const index = Math.min(Math.max(at, 0), rows.length - 1);
  if (selectableRow(rows[index])) return index;
  const below = stepSelectable(rows, index, 1);
  return below !== index ? below : stepSelectable(rows, index, -1);
}

/** 대화 줄과 에이전트 줄은 두 줄이다. */
function rowHeight(row: ListRow): number {
  return row.kind === 'conversation' || row.kind === 'agent' ? 2 : 1;
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

/** 에이전트 안의 대화 줄 위쪽 작은 글: 에이전트 이름은 머리에 있으니 꼬리표와 날만. */
export function agentConversationCaption(conversation: Conversation): string {
  const day = conversationDayLabel(conversation.updatedAt || conversation.createdAt);
  const tag = conversation.tag ? CONVERSATION_TAG_LABELS[conversation.tag] : '';
  return [tag, day].filter(Boolean).join(' · ') || conversationAgentLabel(conversation);
}

/** 에이전트 줄 아래쪽: 마지막 대화의 제목과 날. */
export function agentSummary(agent: ConversationAgent): string {
  const day = conversationDayLabel(agent.lastActivity);
  const title = conversationDisplayTitle({ title: agent.lastTitle });
  return day ? `${title} · ${day}` : title;
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
          // 오른쪽 끝의 ⌕ / 는 채팅 검색(목록에서 / 를 누른다). 웹·데스크톱의 [새 채팅] 옆 돋보기 자리다.
          return (
            <Box key={rowKey(row)} justifyContent="space-between">
              <Text color={color} wrap="truncate-end">
                {mark} {NEW_CHAT_LABEL}
              </Text>
              <Text dimColor>{SEARCH_HINT}</Text>
            </Box>
          );
        }
        if (row.kind === 'section') {
          // 묶음 머리: 굵게, ▾ 펴짐 · ▸ 접힘.
          return (
            <Text key={rowKey(row)} color={color} bold wrap="truncate-end">
              {mark} {row.open ? '▾' : '▸'} {SECTION_LABELS[row.section]}
            </Text>
          );
        }
        if (row.kind === 'gap') return <Text key={rowKey(row)}> </Text>;
        if (row.kind === 'note') {
          return (
            <Text key={rowKey(row)} dimColor wrap="truncate-end">
              {'  '}
              {row.text}
            </Text>
          );
        }
        if (row.kind === 'more' || row.kind === 'less') {
          return (
            <Text key={rowKey(row)} color={color} dimColor={!color} wrap="truncate-end">
              {mark} {row.kind === 'more' ? MORE_LABEL : LESS_LABEL}
            </Text>
          );
        }
        if (row.kind === 'agent') {
          const agent = row.agent;
          // 고른 줄은 두 줄 다 커서 색이다.
          return (
            <Box key={rowKey(row)} flexDirection="column">
              <Box justifyContent="space-between">
                <Text color={color} wrap="truncate-end">
                  {mark} {agent.agentDeleted ? <Text color="red">[{DELETED_AGENT_LABEL}] </Text> : null}
                  {agent.workflowName || 'Agent'}
                </Text>
                <Text color={color} dimColor={!color}> {agent.conversationCount}</Text>
              </Box>
              <Text color={color} dimColor={!color} wrap="truncate-end">
                {'  '}
                {agentSummary(agent)}
              </Text>
            </Box>
          );
        }
        if (row.kind === 'back') {
          return (
            <Text key={rowKey(row)} color={color} bold wrap="truncate-end">
              {mark} ← {row.agent.agentDeleted ? <Text color="red">[{DELETED_AGENT_LABEL}] </Text> : null}
              {row.agent.workflowName || 'Agent'}
            </Text>
          );
        }
        const conversation = row.conversation;
        const open = rowKey(row) === props.openKey;
        return (
          <Box key={rowKey(row)} flexDirection="column">
            <Text
              color={color ?? (conversation.agentDeleted && !row.inAgent ? 'red' : undefined)}
              dimColor={!color}
              wrap="truncate-end"
            >
              {'  '}
              {row.inAgent ? agentConversationCaption(conversation) : conversationCaption(conversation)}
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
