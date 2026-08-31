import { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { publicError } from '@dex/engine';
import type { Agent, Conversation, HistoryTurn } from '@dex/engine';
import { chatReducer, initialChatState, type ChatMessage } from './chat-state';
import { useMeasured } from './measure';
import { maximumScroll, renderTranscript, viewportOf } from './transcript';
import { CommandPalette, type PaletteAction } from './command-palette';
import { Footer, Header } from './components';
import { HistoryScreen } from './history-screen';
import { StartPanel } from './start-panel';
import { ImeTextInput } from './ime-text-input';
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

function ChatPane(props: {
  agent?: AgentRef;
  messages: ChatMessage[];
  status?: string;
  scrollUp: number;
  onViewport: (lineCount: number, height: number) => void;
}): React.ReactNode {
  const [ref, box] = useMeasured();
  // 첫 프레임에는 아직 잰 값이 없다. 넉넉히 잡으면 그 한 프레임이 넘쳐 화면을
  // 밟으므로, 확실히 안 넘칠 만큼만 잡고 다음 프레임에서 맞춘다.
  const width = box?.width ?? 20;
  const height = box?.height ?? 1;
  const lines = renderTranscript(props.messages, props.agent?.workflowName ?? 'Agent', width);
  const view = viewportOf(lines, height, props.scrollUp);

  useEffect(() => {
    props.onViewport(lines.length, height);
  }, [lines.length, height]);

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="blue" paddingX={1}>
      <Box>
        <Text bold wrap="truncate-end">
          {props.agent?.workflowName ?? 'Agent를 선택하세요'}
        </Text>
        {view.below > 0 ? <Text dimColor> · ↓{view.below}줄</Text> : null}
      </Box>
      {/* 잰 높이 안에서만 그린다. 넘치면 ink 이 지우는 자리와 그리는 자리가
          어긋나 입력창과 안내줄까지 밟힌다. */}
      <Box ref={ref} flexDirection="column" flexGrow={1} overflow="hidden">
        {view.lines.length === 0 ? (
          <Text dimColor wrap="truncate-end">
            {props.agent ? '메시지를 입력해 대화를 시작하세요.' : '왼쪽에서 Agent를 선택하세요.'}
          </Text>
        ) : null}
        {view.lines.map((line) => (
          <Text
            key={line.key}
            wrap="truncate-end"
            bold={line.role === 'label'}
            dimColor={line.role === 'activity'}
            color={line.color}
          >
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      {props.status ? (
        <Text color="yellow" wrap="truncate-end">
          ◆ {props.status}
        </Text>
      ) : null}
    </Box>
  );
}

function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focused: boolean;
  disabled: boolean;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
}): React.ReactNode {
  return (
    <Box borderStyle="round" borderColor={props.focused ? 'cyan' : 'gray'} paddingX={1}>
      {/* 지금 무엇이 쳐지는지 늘 보이게 둔다 — 모르고 치면 `dkssud` 이 나온다. */}
      <Text color={props.hangulMode ? 'yellow' : undefined} dimColor={!props.hangulMode}>
        {props.hangulMode ? '한' : 'EN'}
      </Text>
      <Text color="cyan"> › </Text>
      {props.disabled ? (
        <Text dimColor>응답을 기다리는 중...</Text>
      ) : (
        <ImeTextInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          focus={props.focused}
          placeholder="메시지를 입력하세요"
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
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
  preferences?: {
    hangulMode: boolean;
    onHangulModeChange?: (enabled: boolean) => void;
    onModeKey?: (listener: () => void) => () => void;
  };
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
  /** 에이전트를 고른 직후의 갈림길. 이력이 있을 때만 채워진다. */
  const [start, setStart] = useState<{ agent: AgentRef; conversations: Conversation[] }>();
  /**
   * 대화창을 맨 아래에서 몇 줄 올려 뒀는지.
   *
   * 0 이면 늘 최신에 붙어 있다 — 응답이 흘러도 따라간다. 사용자가 올려 둔 동안에는
   * 새 줄이 와도 그 자리를 지킨다. 읽던 곳이 튀어 내려가면 읽을 수가 없다.
   */
  const [scrollUp, setScrollUp] = useState(0);
  /**
   * 한글 조합 켬/끔.
   *
   * 터미널 IME 에 맡기던 것을 CLI 안으로 들여왔다 — 터미널마다 다르고 SSH·tmux 를
   * 거치면 아예 안 오던 자리라, 우리가 조합해야 어디서든 같게 동작한다.
   */
  const [hangulMode, setHangulMode] = useState(props.preferences?.hangulMode ?? false);
  const changeHangulMode = (enabled: boolean): void => {
    setHangulMode(enabled);
    props.preferences?.onHangulModeChange?.(enabled);
  };

  // 한/영 키(오른쪽 Alt 자리)와 Caps Lock. 글자를 만들지 않는 키라 stdin 을 읽는
  // 자리에서만 보이고, 되는 터미널에서만 온다.
  useEffect(
    () =>
      props.preferences?.onModeKey?.(() =>
        setHangulMode((current) => {
          props.preferences?.onHangulModeChange?.(!current);
          return !current;
        }),
      ),
    [props.preferences],
  );
  const viewport = useRef({ lineCount: 0, height: 0 });
  const [starting, setStarting] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  /**
   * 에이전트를 고른다.
   *
   * 이 에이전트에 **이전 대화가 있으면** 갈림길을 보여 준다(새로 시작 / 이어가기).
   * 없으면 바로 새 대화를 연다 — 선택지가 하나뿐인 질문은 한 번 더 누르게 하는
   * 일일 뿐이다.
   *
   * 목록 조회가 실패해도 막지 않는다. 이력을 못 읽는 것과 대화를 못 하는 것은
   * 다른 일이고, 후자를 전자 때문에 막으면 안 된다 — 그냥 새 대화로 연다.
   */
  const selectAgent = async (): Promise<void> => {
    const agent = props.session.agents[cursor];
    if (!agent || chat.running || starting) return;
    const ref: AgentRef = { workflowId: agent.workflowId, workflowName: agent.workflowName };

    setStarting(true);
    let conversations: Conversation[] = [];
    try {
      const all = await props.engine.listConversations(props.session.profile);
      conversations = all.filter((item) => item.workflowId === ref.workflowId);
    } catch {
      conversations = [];
    } finally {
      setStarting(false);
    }

    if (conversations.length === 0) {
      openNewChat(ref);
      return;
    }
    setSelected(ref);
    setStart({ agent: ref, conversations });
  };

  /** 빈 대화를 연다 — 갈림길에서 [새 대화] 를 고른 것과 같은 자리. */
  const openNewChat = (ref: AgentRef): void => {
    setSelected(ref);
    dispatch({ type: 'reset' });
    setInput('');
    setScrollUp(0);
    setStart(undefined);
    setFocus('composer');
  };

  const openHistory = (conversation: Conversation, turns: HistoryTurn[]): void => {
    setSelected({ workflowId: conversation.workflowId, workflowName: conversation.workflowName });
    dispatch({ type: 'history_loaded', interactionId: conversation.interactionId, turns });
    // 불러온 대화는 맨 아래(가장 최근)부터 보여 준다.
    setScrollUp(0);
    const index = props.session.agents.findIndex((agent) => agent.workflowId === conversation.workflowId);
    if (index >= 0) setCursor(index);
    setHistory(false);
    setStart(undefined);
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
    setScrollUp(0);
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
      setScrollUp(0);
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

  /**
   * 대화창을 한 화면의 절반씩 움직인다. `direction` 이 -1 이면 과거로.
   *
   * 한 화면을 통째로 넘기면 앞뒤가 이어지지 않아 읽던 자리를 놓친다.
   */
  const scrollBy = (direction: -1 | 1): void => {
    const { lineCount, height } = viewport.current;
    const step = Math.max(1, Math.floor(height / 2));
    const limit = maximumScroll(lineCount, height);
    setScrollUp((current) => Math.min(limit, Math.max(0, current - direction * step)));
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
      else if (key.pageUp) scrollBy(-1);
      else if (key.pageDown) scrollBy(1);
      else if (key.escape && chat.running) cancelTurn();
      else if (key.escape) setFocus('agents');
      else if (key.tab) setFocus((current) => (current === 'agents' ? 'composer' : 'agents'));
      else if (focus === 'agents' && key.upArrow) setCursor((current) => Math.max(0, current - 1));
      else if (focus === 'agents' && key.downArrow && props.session.agents.length > 0) {
        setCursor((current) => Math.min(props.session.agents.length - 1, current + 1));
      } else if (focus === 'agents' && key.return) void selectAgent();
    },
    // 갈림길·팔레트·이력 화면이 떠 있으면 그 화면이 키를 갖는다 — 여기서도 받으면
    // 방향키 하나가 두 곳에서 움직인다.
    { isActive: !palette && !history && !start },
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
    // 갈림길이 열려 있으면 대화창 자리를 그것이 쓴다 — 목록은 그대로 옆에 남아
    // 어느 에이전트를 고른 것인지 보인다.
    const conversation = start ? (
      <StartPanel
        engine={props.engine}
        profile={props.session.profile}
        agentName={start.agent.workflowName}
        conversations={start.conversations}
        onNew={() => openNewChat(start.agent)}
        onOpen={openHistory}
        onCancel={() => {
          setStart(undefined);
          setFocus('agents');
        }}
      />
    ) : (
      <Box flexDirection="column" flexGrow={1}>
        <ChatPane
          agent={selected}
          messages={chat.messages}
          status={chat.status}
          scrollUp={scrollUp}
          onViewport={(lineCount, height) => {
            viewport.current = { lineCount, height };
          }}
        />
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={(value) => void send(value)}
          focused={focus === 'composer'}
          disabled={chat.running || !selected}
          hangulMode={hangulMode}
          onHangulModeChange={changeHangulMode}
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
      <Footer
        mode={hangulMode ? '한' : 'EN'}
        text="Ctrl+Space 한/영 · Tab 패널 · PgUp/PgDn 스크롤 · Ctrl+K 명령 · Ctrl+H 기록 · Ctrl+P 프로필 · Esc 취소 · Ctrl+Q 종료"
      />
    </Box>
  );
}
