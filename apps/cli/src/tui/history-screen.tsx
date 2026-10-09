import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { conversationDisplayTitle } from '@dex/protocol';
import { publicError } from '@dex/engine';
import type { Conversation, ConversationSnapshot } from '@dex/engine';
import type { TuiEngine } from './model';
import { Footer, Loading, Notice } from './components';
import { conversationCaption, when } from './conversation-list';

/**
 * 대화 기록(Ctrl+H): 내 대화 전부를 마지막으로 말한 순서로(서버가 정한 순서 그대로).
 * 한 줄 = 제목 + 작은 에이전트 이름(사라졌으면 [지워짐])과 꼬리표 + 언제.
 */
export function HistoryScreen(props: {
  engine: TuiEngine;
  profile: string;
  onOpen: (conversation: Conversation, snapshot: ConversationSnapshot) => void;
  onCancel: () => void;
}): React.ReactNode {
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    props.engine
      .listConversations(props.profile)
      .then((result) => alive && setItems(result))
      .catch((reason: unknown) => alive && setError(publicError(reason).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [props.engine, props.profile]);

  useInput(
    (_input, key) => {
      if (key.escape) props.onCancel();
      if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
      if (key.downArrow && items.length > 0) {
        setCursor((current) => Math.min(items.length - 1, current + 1));
      }
      if (key.return && items[cursor]) {
        const conversation = items[cursor];
        setLoading(true);
        setError(undefined);
        props.engine
          // turns 만이 아니라 running 도 함께 읽는다 — 웹·앱에서 시작한 턴이
          // 아직 돌고 있으면 그 사실을 그대로 복원해야 한다.
          .historySnapshot(
            conversation.workflowId,
            conversation.interactionId,
            conversation.workflowName,
            props.profile,
          )
          .then((snapshot) => props.onOpen(conversation, snapshot))
          .catch((reason: unknown) => setError(publicError(reason).message))
          .finally(() => setLoading(false));
      }
    },
    { isActive: !loading },
  );

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>대화 기록</Text>
      {loading ? <Loading /> : null}
      {!loading && items.length === 0 ? <Text dimColor>대화 기록이 없습니다.</Text> : null}
      {!loading
        ? items.slice(Math.max(0, cursor - 8), cursor + 9).map((item) => {
            const index = items.indexOf(item);
            const active = index === cursor;
            const stamp = when(item);
            return (
              <Text key={`${item.workflowId}/${item.interactionId}`} color={active ? 'cyan' : undefined} wrap="truncate-end">
                {active ? '›' : ' '} {conversationDisplayTitle(item)}{' '}
                <Text dimColor color={item.agentDeleted ? 'red' : undefined}>
                  · {conversationCaption(item)}
                  {stamp ? ` · ${stamp}` : ''}
                </Text>
              </Text>
            );
          })
        : null}
      {error ? <Notice error>{error}</Notice> : null}
      <Footer text="↑↓ 이동 · Enter 열기 · Esc 돌아가기" />
    </Box>
  );
}
