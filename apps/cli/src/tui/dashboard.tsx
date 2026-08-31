import { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { publicError } from '../errors';
import type { Agent, Conversation, HistoryTurn } from '../types';
import { chatReducer, initialChatState, type ChatMessage } from './chat-state';
import { CommandPalette, type PaletteAction } from './command-palette';
import { Footer, Header } from './components';
import { HistoryScreen } from './history-screen';
import { ImeTextInput, type CursorOrigin } from './ime-text-input';
import type { TuiEngine, TuiSession } from './model';
import { useTerminalSize } from './use-terminal-size';

interface AgentRef {
  workflowId: string;
  workflowName: string;
}

function AgentSidebar(props: {
  agents: Agent[];
  cursor: number;
  selected?: string;
  focused: boolean;
  height: number;
}): React.ReactNode {
  const radius = Math.max(3, Math.floor((props.height - 4) / 2));
  const start = Math.max(0, props.cursor - radius);
  const visible = props.agents.slice(start, start + radius * 2 + 1);
  return (
    <Box flexDirection="column" width={30} borderStyle="round" borderColor={props.focused ? 'cyan' : 'gray'} paddingX={1}>
      <Text bold>Agents</Text>
      {visible.map((agent) => {
        const index = props.agents.indexOf(agent);
        const cursor = index === props.cursor;
        const selected = agent.workflowId === props.selected;
        return (
          <Text key={agent.workflowId} color={cursor && props.focused ? 'cyan' : undefined} wrap="truncate-end">
            {cursor ? '›' : ' '} {selected ? '●' : '○'} {agent.workflowName}
          </Text>
        );
      })}
      {props.agents.length === 0 ? <Text dimColor>사용 가능한 Agent가 없습니다.</Text> : null}
    </Box>
  );
}

function messageColor(role: ChatMessage['role']): 'cyan' | 'green' | 'yellow' | 'red' | undefined {
  if (role === 'user') return 'cyan';
  if (role === 'assistant') return 'green';
  if (role === 'activity') return 'yellow';
  if (role === 'system') return 'red';
  return undefined;
}

function labelOf(role: ChatMessage['role'], agentName: string): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return agentName;
  if (role === 'activity') return 'Tool';
  return 'System';
}

function ChatPane(props: {
  agent?: AgentRef;
  messages: ChatMessage[];
  status?: string;
  height: number;
}): React.ReactNode {
  const visibleCount = Math.max(4, Math.floor((props.height - 5) / 2));
  const visible = props.messages.slice(-visibleCount);
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold>{props.agent?.workflowName ?? 'Agent를 선택하세요'}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 ? (
          <Text dimColor>{props.agent ? '메시지를 입력해 대화를 시작하세요.' : '왼쪽에서 Agent를 선택하세요.'}</Text>
        ) : null}
        {visible.map((message) => (
          <Box key={message.id} flexDirection="column" marginTop={message.role === 'activity' ? 0 : 1}>
            <Text bold color={messageColor(message.role)}>
              {labelOf(message.role, props.agent?.workflowName ?? 'Agent')}
            </Text>
            <Text dimColor={message.role === 'activity'}>
              {message.text || (message.role === 'assistant' ? '…' : '')}
            </Text>
          </Box>
        ))}
      </Box>
      {props.status ? <Text color="yellow">◆ {props.status}</Text> : null}
    </Box>
  );
}

function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focused: boolean;
  disabled: boolean;
  cursorOrigin: CursorOrigin;
}): React.ReactNode {
  return (
    <Box borderStyle="round" borderColor={props.focused ? 'cyan' : 'gray'} paddingX={1}>
      <Text color="cyan">› </Text>
      {props.disabled ? (
        <Text dimColor>응답을 기다리는 중...</Text>
      ) : (
        <ImeTextInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          focus={props.focused}
          cursorOrigin={props.cursorOrigin}
          placeholder="메시지를 입력하세요"
        />
      )}
    </Box>
  );
}

export function Dashboard(props: {
  engine: TuiEngine;
  session: TuiSession;
  onProfiles: () => void;
  onLogout: () => void;
}): React.ReactNode {
  const { exit } = useApp();
  const size = useTerminalSize();
  const bodyHeight = Math.max(12, size.rows - 5);
  const [focus, setFocus] = useState<'agents' | 'composer'>('agents');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<AgentRef | undefined>(() => {
    const first = props.session.agents[0];
    return first ? { workflowId: first.workflowId, workflowName: first.workflowName } : undefined;
  });
  const [input, setInput] = useState('');
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const [palette, setPalette] = useState(false);
  const [history, setHistory] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const selectAgent = (): void => {
    const agent = props.session.agents[cursor];
    if (!agent || chat.running) return;
    setSelected({ workflowId: agent.workflowId, workflowName: agent.workflowName });
    dispatch({ type: 'reset' });
    setFocus('composer');
  };

  const openHistory = (conversation: Conversation, turns: HistoryTurn[]): void => {
    setSelected({ workflowId: conversation.workflowId, workflowName: conversation.workflowName });
    dispatch({ type: 'history_loaded', interactionId: conversation.interactionId, turns });
    const index = props.session.agents.findIndex((agent) => agent.workflowId === conversation.workflowId);
    if (index >= 0) setCursor(index);
    setHistory(false);
    setFocus('composer');
  };

  const cancelTurn = (): void => {
    controller.current?.abort();
    dispatch({ type: 'turn_cancelled' });
  };

  const newConversation = (): void => {
    if (chat.running) return;
    dispatch({ type: 'reset' });
    setInput('');
    setPalette(false);
    setFocus('composer');
  };

  const send = async (value: string): Promise<void> => {
    const text = value.trim();
    if (!text || !selected || chat.running) return;
    try {
      const resolved = await props.engine.resolveChatInput({
        profile: props.session.profile,
        workflowId: selected.workflowId,
        workflowName: selected.workflowName,
        interactionId: chat.interactionId,
        input: text,
      });
      setInput('');
      dispatch({ type: 'turn_started', interactionId: resolved.interactionId, input: text });
      const active = new AbortController();
      controller.current = active;
      for await (const event of props.engine.chat(resolved, active.signal)) {
        dispatch({ type: 'event_received', event });
      }
      if (active.signal.aborted) dispatch({ type: 'turn_cancelled' });
      else dispatch({ type: 'turn_completed' });
    } catch (error) {
      if (controller.current?.signal.aborted) dispatch({ type: 'turn_cancelled' });
      else dispatch({ type: 'turn_failed', message: publicError(error).message });
    } finally {
      controller.current = null;
    }
  };

  useInput(
    (keyInput, key) => {
      if (key.ctrl && keyInput === 'k') setPalette(true);
      else if (key.ctrl && keyInput === 'p') {
        controller.current?.abort();
        props.onProfiles();
      } else if (key.ctrl && keyInput === 'h') {
        if (chat.running) cancelTurn();
        setHistory(true);
      }
      else if (key.ctrl && keyInput === 'n') newConversation();
      else if (key.escape && chat.running) cancelTurn();
      else if (key.escape) setFocus('agents');
      else if (key.tab) setFocus((current) => (current === 'agents' ? 'composer' : 'agents'));
      else if (focus === 'agents' && key.upArrow) setCursor((current) => Math.max(0, current - 1));
      else if (focus === 'agents' && key.downArrow && props.session.agents.length > 0) {
        setCursor((current) => Math.min(props.session.agents.length - 1, current + 1));
      } else if (focus === 'agents' && key.return) selectAgent();
    },
    { isActive: !palette && !history },
  );

  const paletteActions: PaletteAction[] = [
    { id: 'new', label: '새 대화', run: newConversation },
      {
        id: 'history',
        label: '대화 기록',
        run: () => {
          if (chat.running) cancelTurn();
          setPalette(false);
          setHistory(true);
        },
      },
      {
        id: 'profile',
        label: '프로필 전환',
        run: () => {
          controller.current?.abort();
          setPalette(false);
          props.onProfiles();
        },
      },
    {
      id: 'logout',
      label: '로그아웃',
      run: () => {
        controller.current?.abort();
        props.onLogout();
      },
    },
    { id: 'quit', label: '종료', run: exit },
  ];

  let body: React.ReactNode;
  if (palette) {
    body = <CommandPalette actions={paletteActions} onCancel={() => setPalette(false)} />;
  } else if (history) {
    body = (
      <HistoryScreen
        engine={props.engine}
        profile={props.session.profile}
        onOpen={openHistory}
        onCancel={() => setHistory(false)}
      />
    );
  } else {
    const sidebar = (
      <AgentSidebar
        agents={props.session.agents}
        cursor={cursor}
        selected={selected?.workflowId}
        focused={focus === 'agents'}
        height={bodyHeight}
      />
    );
    const conversation = (
      <Box flexDirection="column" flexGrow={1}>
        <ChatPane agent={selected} messages={chat.messages} status={chat.status} height={bodyHeight - 3} />
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={(value) => void send(value)}
          focused={focus === 'composer'}
          disabled={chat.running || !selected}
          cursorOrigin={{ x: size.wide ? 34 : 4, y: bodyHeight - 1 }}
        />
      </Box>
    );
    body = size.wide ? (
      <Box height={bodyHeight}>{sidebar}{conversation}</Box>
    ) : focus === 'agents' ? (
      <Box height={bodyHeight}>{sidebar}</Box>
    ) : (
      <Box height={bodyHeight}>{conversation}</Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header
        profile={props.session.profile}
        username={props.session.username}
        connected
      />
      {body}
      <Footer text="Tab 패널 · Ctrl+K 명령 · Ctrl+H 기록 · Ctrl+P 프로필 · Esc 취소 · Ctrl+Q 종료" />
    </Box>
  );
}
