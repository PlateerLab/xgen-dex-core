import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { publicError } from '../errors';
import type { Conversation, HistoryTurn } from '../types';
import type { TuiEngine } from './model';
import { Footer, Loading, Notice } from './components';

export function HistoryScreen(props: {
  engine: TuiEngine;
  profile: string;
  onOpen: (conversation: Conversation, turns: HistoryTurn[]) => void;
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
          .historyTurns(
            conversation.workflowId,
            conversation.interactionId,
            conversation.workflowName,
            props.profile,
          )
          .then((turns) => props.onOpen(conversation, turns))
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
            return (
              <Text key={item.interactionId} color={index === cursor ? 'cyan' : undefined}>
                {index === cursor ? '›' : ' '} {item.workflowName} ·{' '}
                <Text dimColor>{item.updatedAt || item.createdAt}</Text>
              </Text>
            );
          })
        : null}
      {error ? <Notice error>{error}</Notice> : null}
      <Footer text="↑↓ 이동 · Enter 열기 · Esc 돌아가기" />
    </Box>
  );
}
