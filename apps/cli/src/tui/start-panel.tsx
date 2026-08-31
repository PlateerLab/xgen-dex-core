import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { publicError } from '@dex/engine';
import type { Conversation, HistoryTurn } from '@dex/engine';
import type { TuiEngine } from './model';
import { Loading, Notice } from './components';

/**
 * 에이전트를 고른 직후의 갈림길 — **새로 시작할까, 하던 걸 이어갈까.**
 *
 * 예전에는 Enter 를 누르면 바로 빈 대화가 열렸다. 이어서 하려면 그걸 안 하고
 * Ctrl+H 를 눌러 **모든 에이전트의** 대화 목록에서 찾아야 했다. 방금 고른 에이전트가
 * 이미 화면에 있는데도.
 *
 * 그래서 고른 에이전트의 대화만 여기 보여 준다.
 *
 * **이력이 없으면 이 화면은 뜨지 않는다.** 선택지가 하나뿐인 질문을 던지는 것은
 * 도움이 아니라 한 번 더 누르게 하는 일이다 — 부모가 그때는 바로 대화를 연다.
 */

interface Row {
  kind: 'new' | 'conversation';
  conversation?: Conversation;
}

export function StartPanel(props: {
  engine: TuiEngine;
  profile: string;
  agentName: string;
  conversations: Conversation[];
  onNew: () => void;
  onOpen: (conversation: Conversation, turns: HistoryTurn[]) => void;
  onCancel: () => void;
}): React.ReactNode {
  const rows: Row[] = [
    { kind: 'new' },
    ...props.conversations.map((conversation) => ({ kind: 'conversation' as const, conversation })),
  ];
  const [cursor, setCursor] = useState(0);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();

  // 목록이 바뀌면 커서가 범위를 벗어날 수 있다.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        props.onCancel();
        return;
      }
      if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
      if (key.downArrow) setCursor((current) => Math.min(rows.length - 1, current + 1));
      if (!key.return) return;

      const row = rows[cursor];
      if (!row) return;
      if (row.kind === 'new' || !row.conversation) {
        props.onNew();
        return;
      }
      const conversation = row.conversation;
      setOpening(true);
      setError(undefined);
      props.engine
        .historyTurns(
          conversation.workflowId,
          conversation.interactionId,
          conversation.workflowName,
          props.profile,
        )
        .then((turns) => props.onOpen(conversation, turns))
        .catch((reason: unknown) => {
          setError(publicError(reason).message);
          setOpening(false);
        });
    },
    { isActive: !opening },
  );

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>{props.agentName}</Text>
      <Text dimColor>어떻게 시작할까요?</Text>

      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, index) => {
          const active = index === cursor;
          const mark = active ? '›' : ' ';
          if (row.kind === 'new') {
            return (
              <Text key="new" color={active ? 'cyan' : undefined}>
                {mark} 새 대화
              </Text>
            );
          }
          const conversation = row.conversation;
          if (!conversation) return null;
          return (
            <Text key={conversation.interactionId} color={active ? 'cyan' : undefined}>
              {mark} {when(conversation)} <Text dimColor>· {conversation.interactionCount}턴</Text>
            </Text>
          );
        })}
      </Box>

      {opening ? <Loading label="대화를 불러오는 중..." /> : null}
      {error ? <Notice error>{error}</Notice> : null}

      <Box marginTop={1}>
        <Text dimColor>↑↓ 이동 · Enter 선택 · Esc 목록으로</Text>
      </Box>
    </Box>
  );
}

/**
 * 대화를 언제 했는지.
 *
 * 서버가 주는 문자열을 그대로 쓰지 않는다 — `2026-08-31T02:11:09.482Z` 는 목록에서
 * 읽으라고 있는 값이 아니다. 오늘 것은 시각만, 그 밖은 날짜만 보여 준다.
 */
function when(conversation: Conversation): string {
  const raw = conversation.updatedAt || conversation.createdAt;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw || '(시각 없음)';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return sameDay
    ? `오늘 ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
