import { randomUUID } from 'node:crypto';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { publicError } from '@dex/engine';
import {
  MODEL_PICKER_TEXT,
  UNSUPPORTED_MODEL_STATE,
  applyModelNotice,
  sameModel,
  type ConversationModelState,
  type ModelChoice,
  THINKING_PICKER_TEXT,
  selectedThinking,
  thinkingChipLabel,
  type ThinkingValue,
  CONVERSATION_TAG_LABELS,
  RECENT_CONVERSATION_STEP,
  UNTITLED_CONVERSATION,
  agentsWithoutConversations,
  conversationAgentLabel,
  conversationDisplayTitle,
  conversationKey,
  conversationListChange,
  conversationTitleFromMetadata,
  dropFromConversationAgents,
  groupConversationsByAgent,
  mergeConversationPage,
  removeConversation,
  renameConversationInList,
  renameInConversationAgents,
  touchConversation,
  touchConversationAgent,
} from '@dex/protocol';
import type {
  Agent,
  ChatAttachmentDescriptor,
  Conversation,
  ConversationAgent,
  ConversationSnapshot,
  ResolvedChatInput,
} from '@dex/engine';
import { chatReducer, initialChatState, type ChatMessage } from './chat-state';
import { useMeasured } from './measure';
import { maximumScroll, renderTranscript, viewportOf } from './transcript';
import { CommandPalette, type PaletteAction } from './command-palette';
import { ModelPicker, ThinkingPicker } from './model-picker';
import { Composer, Footer, Header } from './components';
import { HistoryScreen } from './history-screen';
import { StartScreen, type AgentRef } from './start-screen';
import {
  AGENT_GROUP_LIMIT,
  BACK_LABEL,
  CONVERSATION_PAGE_SIZE,
  ConfirmPanel,
  ConversationSidebar,
  DELETED_AGENT_NOTICE,
  PURGE_LABEL,
  RenamePanel,
  agentRowKey,
  buildRows,
  fixedRowKey,
  nearestSelectable,
  rowKey,
  stepSelectable,
  type ListRow,
} from './conversation-list';
import { SEARCH_LIMIT, SearchPanel } from './conversation-search';
import { ConversationManagerScreen, MANAGER_TITLE, type ManagerChange } from './conversation-manager';
import type { TuiEngine, TuiSession } from './model';
import type { LastChat } from './preferences';
import { useTerminalSize } from './use-terminal-size';
import { defaultWorkingFolders } from '../folders';

/** 사이드바 맨 아래로 내려가기 몇 줄 전에 다음 쪽을 받아 둔다(에이전트 안의 대화). */
const PREFETCH_ROWS = 3;

/** 에이전트 안으로 들어갔다: 그 에이전트의 대화(workflowId 로 받은 쪽들). */
interface Drill {
  agent: ConversationAgent;
  items: Conversation[];
  nextCursor: string | null;
  /** 받은 쪽 수. 0 이면 아직 첫 쪽도 못 받았다. */
  pages: number;
  loading: boolean;
  error?: string;
}

/** 목록에서 빠질 대화(지움). 지운 대화 그 자체이거나 소켓이 알려 준 열쇠다. */
type RemovedRef = Pick<Conversation, 'workflowId' | 'interactionId'> & { agentDeleted?: boolean };

/** 서버가 아직 모르는 새 대화(첫 말을 막 보냈다)의 목록 한 줄. 첫 쪽을 다시 읽으면 서버 것으로 바뀐다. */
function draftConversation(resolved: ResolvedChatInput, text: string, now: string): Conversation {
  return {
    id: 0,
    interactionId: resolved.interactionId,
    workflowId: resolved.workflowId,
    workflowName: resolved.workflowName,
    interactionCount: 0,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    // 제목 규칙은 서버와 같은 것을 쓴다(첫 메시지 한 줄).
    title: conversationTitleFromMetadata({ first_message: text }).title,
    customTitle: false,
    tag: null,
    agentDeleted: false,
    agentOwnerId: null,
    compare: [],
  };
}

type Dialog =
  | { kind: 'search' }
  | { kind: 'rename'; conversation: Conversation }
  | { kind: 'delete'; conversation: Conversation }
  | { kind: 'purge'; count: number };

function ChatPane(props: {
  /** 대화 제목(붙인 이름, 없으면 첫 메시지). */
  title: string;
  /** 제목 옆 작은 글: 에이전트 이름(사라졌으면 [지워짐])과 꼬리표. */
  caption?: string;
  /** 대화창에서 답한 쪽의 이름. */
  agentName: string;
  /** 이 대화의 지금 모델 — "제공자: 모델". Ctrl+O 로 바꾼다. */
  model?: string;
  /** 모델 오른쪽 — `생각: 높게` 또는 `생각 조절 불가`. */
  thinking?: string;
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
  const lines = renderTranscript(props.messages, props.agentName, width);
  const view = viewportOf(lines, height, props.scrollUp);

  useEffect(() => {
    props.onViewport(lines.length, height);
  }, [lines.length, height]);

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="blue" paddingX={1}>
      <Box>
        <Text bold wrap="truncate-end">
          {props.title}
        </Text>
        {props.caption ? (
          <Text dimColor wrap="truncate-end">
            {' '}
            · {props.caption}
          </Text>
        ) : null}
        {props.model ? (
          <Text wrap="truncate-end">
            <Text color="magenta"> · {props.model}</Text>
            <Text dimColor> Ctrl+O</Text>
          </Text>
        ) : null}
        {props.thinking ? (
          <Text wrap="truncate-end">
            <Text color="magenta"> · {props.thinking}</Text>
            <Text dimColor> /thinking</Text>
          </Text>
        ) : null}
        {view.below > 0 ? <Text dimColor> · ↓{view.below}줄</Text> : null}
      </Box>
      {/* 잰 높이 안에서만 그린다. 넘치면 ink 이 지우는 자리와 그리는 자리가
          어긋나 입력창과 안내줄까지 밟힌다. */}
      <Box ref={ref} flexDirection="column" flexGrow={1} overflow="hidden">
        {view.lines.length === 0 ? (
          <Text dimColor wrap="truncate-end">
            메시지를 입력해 대화를 시작하세요.
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

export function Dashboard(props: {
  engine: TuiEngine;
  session: TuiSession;
  onProfiles: () => void;
  onLogout: () => void;
  preferences?: {
    nativeIme?: boolean;
    imeShortcut?: 'Caps Lock' | 'Ctrl+Space';
    hangulMode: boolean;
    onHangulModeChange?: (enabled: boolean) => void;
    onModeKey?: (listener: () => void) => () => void;
    /** 지난 실행에서 마지막으로 보던 대화 — 아직 돌고 있으면 되찾는다. */
    lastChat?: LastChat;
    onLastChatChange?: (value: LastChat | undefined) => void;
  };
}): React.ReactNode {
  const { exit } = useApp();
  const size = useTerminalSize();
  const bodyHeight = Math.max(12, size.rows - 5);
  // 'list' 는 왼쪽 대화 목록, 'main' 은 오른쪽(시작 화면 또는 대화창). 처음에는 시작 화면에
  // 있어 바로 적을 수 있다.
  const [focus, setFocus] = useState<'list' | 'main'>('main');
  /** 오른쪽 자리: 시작 화면(새 채팅) 또는 열린 대화. */
  const [view, setView] = useState<'start' | 'chat'>('start');
  /** 시작 화면에서 고를 에이전트. 시작 화면에서 새로 세운 것도 여기 들어간다. */
  const [agents, setAgents] = useState<Agent[]>(props.session.agents);
  const [selected, setSelected] = useState<AgentRef | undefined>();
  /** 시작 화면에서 고른 있는 에이전트(새 에이전트면 없다). 첫 말 전에도 Ctrl+O 로 모델을 고른다. */
  const [startAgent, setStartAgent] = useState<AgentRef | undefined>();
  /** 연 대화(목록에 아직 없을 수 있다: 되찾은 대화, 기록 화면의 오래된 대화). */
  const [opened, setOpened] = useState<Conversation | undefined>();
  const [input, setInput] = useState('');
  const attachmentEpoch = useRef(0);
  const uploadBusy = useRef(false);
  const [attachments, setAttachments] = useState<ChatAttachmentDescriptor[]>([]);
  const [attachmentInteractionId, setAttachmentInteractionId] = useState<string>();
  const [attachmentNotice, setAttachmentNotice] = useState('');
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  /**
   * 화면을 옮길 때마다(다른 대화를 열거나 새 채팅) 하나씩 오른다. 손을 뗀 턴의 스트림이 늦게
   * 끝나며 보내는 소식이, 그 사이 연 다른 대화에 [중단됨] 을 덧붙이지 않게 한다.
   */
  const viewEpoch = useRef(0);

  // ── 대화 목록 ──
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** [최근 채팅] 에 보이는 수. [더 보기] 가 5개씩 늘리고 [접기] 가 되돌린다. */
  const [recentShown, setRecentShown] = useState(RECENT_CONVERSATION_STEP);
  /** 에이전트가 사라진 대화 수(첫 쪽이 알려 준다). 0 이면 Ctrl+K 에 [제거] 가 없다. */
  const [deletedCount, setDeletedCount] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [listError, setListError] = useState<string>();
  const [listNotice, setListNotice] = useState<string>();
  const pagesLoaded = useRef(0);
  /** 서버가 아직 모르는 새 대화 줄(첫 말을 막 보냈다). 첫 쪽을 다시 읽어 서버 것이 오면 지운다. */
  const localDrafts = useRef(new Set<string>());
  const [cursorKey, setCursorKey] = useState(fixedRowKey('new'));
  const lastRowIndex = useRef(0);
  const [dialog, setDialog] = useState<Dialog>();

  // ── [에이전트] 묶음 ──
  /**
   * 서버가 센 묶음(conversationAgents). 아직 못 받았으면 undefined. 이 함수가 없는 엔진이거나 받지 못했으면
   * 받아 둔 대화 목록으로 묶는다(groupConversationsByAgent). 소식으로 고칠 때는 ref 로 바로 읽는다.
   */
  const [fetchedAgents, setFetchedAgents] = useState<ConversationAgent[]>();
  const fetchedAgentsRef = useRef<ConversationAgent[] | undefined>(undefined);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const agentsSeq = useRef(0);
  const [othersOpen, setOthersOpen] = useState(false);
  /** 에이전트 안으로 들어갔다(그 에이전트의 대화만 보인다). */
  const [drill, setDrill] = useState<Drill>();
  const drillRef = useRef(drill);
  drillRef.current = drill;
  /** 들어갈 때마다 오른다. 나온 뒤에 늦게 온 쪽이 목록을 덮지 않게 한다. */
  const drillSeq = useRef(0);
  const drillLoadingRef = useRef(false);
  /**
   * 여기서 지운 대화. 같은 지움이 목록 소켓으로 다시 오면 [에이전트] 수를 두 번 줄이지 않게 한 번 건너뛴다.
   */
  const locallyRemoved = useRef(new Set<string>());
  /** 시작 화면에 미리 골라 둘 에이전트([＋ 이 에이전트로 새 채팅]·[다른 에이전트]). nonce 가 바뀌면 다시 고른다. */
  const [startPreselect, setStartPreselect] = useState<{ workflowId: string; nonce: number }>();
  const preselectNonce = useRef(0);
  const [manager, setManager] = useState(false);
  /** 시작 화면이 키를 쥐고 있다(에이전트 찾기 목록). */
  const [startCapture, setStartCapture] = useState(false);

  // 대화 소켓 push — 서버 주입 턴(트리거 반응)을 열린 대화에 실시간 반영.
  const chatInteractionRef = useRef<string | undefined>(undefined);
  chatInteractionRef.current = chat.interactionId;
  useEffect(() => {
    props.engine.onConversationTurn = (turn) => {
      if (turn.interactionId !== chatInteractionRef.current) return;
      if (turn.source !== 'subagent_report' || !turn.output) return;
      dispatch({ type: 'server_turn', ioId: turn.ioId, input: turn.input, output: turn.output });
    };
    // 같은 소켓이 "지금 도는 턴이 있는가" 와 그 턴의 진행분을 알려 준다.
    props.engine.onConversationRunning = (event) => {
      if (event.interactionId !== chatInteractionRef.current) return;
      dispatch({
        type: 'remote_running',
        interactionId: event.interactionId,
        running: event.running,
        text: typeof event.live?.text === 'string' ? event.live.text : undefined,
      });
    };
    // 다른 화면(웹·앱·VS Code)에서 이 대화의 모델을 바꿨다 — 제목 줄이 곧바로 따라간다.
    props.engine.onConversationModel = (event) => {
      if (event.interactionId !== modelTargetRef.current) return;
      setModel((current) => applyModelNotice(current, event.notice));
    };
    return () => {
      props.engine.onConversationTurn = null;
      props.engine.onConversationRunning = null;
      props.engine.onConversationModel = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [palette, setPalette] = useState(false);
  const [history, setHistory] = useState(false);
  /**
   * 이 대화의 모델(Ctrl+O · /model). 아직 첫 말을 보내지 않은 새 대화도 고를 수 있게
   * 그 대화가 쓸 번호를 미리 정해 둔다(draft) — 첫 턴이 이 번호로 나가므로 고른 모델이
   * 그대로 붙는다.
   */
  const [model, setModel] = useState<ConversationModelState>(UNSUPPORTED_MODEL_STATE);
  const [modelPicker, setModelPicker] = useState(false);
  const [thinkingPicker, setThinkingPicker] = useState(false);
  const draftInteractionId = useRef(randomUUID());
  const modelTarget = chat.interactionId ?? attachmentInteractionId ?? draftInteractionId.current;
  const modelTargetRef = useRef(modelTarget);
  modelTargetRef.current = modelTarget;
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
  const nativeIme = props.preferences?.nativeIme === true;
  const imeShortcut = props.preferences?.imeShortcut ?? (nativeIme ? 'Caps Lock' : 'Ctrl+Space');
  const [hangulMode, setHangulMode] = useState(
    nativeIme ? false : (props.preferences?.hangulMode ?? false),
  );
  const changeHangulMode = (enabled: boolean): void => {
    if (nativeIme) return;
    setHangulMode(enabled);
    props.preferences?.onHangulModeChange?.(enabled);
  };

  // 한/영 키(오른쪽 Alt 자리)와 Caps Lock. 글자를 만들지 않는 키라 stdin 을 읽는
  // 자리에서만 보이고, 되는 터미널에서만 온다.
  useEffect(() => {
    if (nativeIme) return undefined;
    return props.preferences?.onModeKey?.(() =>
      setHangulMode((current) => {
        props.preferences?.onHangulModeChange?.(!current);
        return !current;
      }),
    );
  }, [nativeIme, props.preferences]);
  const viewport = useRef({ lineCount: 0, height: 0 });
  const [opening, setOpening] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const stopping = useRef(false);

  useEffect(() => () => controller.current?.abort(), []);

  /** 지금 대화창에 열린 대화의 열쇠(아직 첫 말을 보내지 않은 새 채팅이면 없다). */
  const openKey =
    view === 'chat' && selected && chat.interactionId
      ? conversationKey({ workflowId: selected.workflowId, interactionId: chat.interactionId })
      : undefined;
  /** 제목 줄에 보일 대화: 목록에 있으면 목록의 것(이름이 바뀌면 따라간다), 없으면 연 그대로. */
  const shown =
    (openKey ? conversations.find((item) => conversationKey(item) === openKey) : undefined) ??
    (opened && openKey === conversationKey(opened) ? opened : undefined);
  /** 에이전트가 사라진 대화는 지난 대화만 본다. 보낼 수 없다. */
  const readOnly = view === 'chat' && (shown?.agentDeleted ?? opened?.agentDeleted ?? false);
  /**
   * 모델을 고를 에이전트: 대화창이면 그 대화의 것, 시작 화면이면 고른 에이전트. 시작 화면의
   * 새 대화는 미리 정해 둔 번호(draft)로 나가므로 거기서 고른 모델이 첫 턴부터 붙는다.
   */
  const modelAgent = view === 'start' ? startAgent : readOnly ? undefined : selected;

  // 에이전트나 대화가 바뀌면 그 대화의 모델을 다시 읽는다. 옛 서버·Geny 가 아닌
  // 에이전트는 supported:false — 제목 줄에 모델이 없고 Ctrl+O 도 조용하다.
  useEffect(() => {
    setModel(UNSUPPORTED_MODEL_STATE);
    if (!modelAgent || !props.engine.conversationModel) return;
    let alive = true;
    void props.engine
      .conversationModel(modelAgent.workflowId, modelTarget, props.session.profile)
      .then((next) => alive && setModel(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [modelAgent?.workflowId, modelTarget, props.engine, props.session.profile]);

  // ── 대화 목록 읽기 ──

  /** 첫 쪽. 처음 열 때와 지운 뒤에는 통째로 바꾼다. */
  const loadFirstPage = async (): Promise<void> => {
    const page = await props.engine.conversationPage({ limit: CONVERSATION_PAGE_SIZE }, props.session.profile);
    localDrafts.current = new Set();
    pagesLoaded.current = 1;
    setConversations(page.conversations);
    setNextCursor(page.nextCursor);
    setDeletedCount(page.agentDeletedCount ?? page.conversations.filter((item) => item.agentDeleted).length);
    setListError(undefined);
  };

  const storeAgents = (list: ConversationAgent[] | undefined): void => {
    fetchedAgentsRef.current = list;
    setFetchedAgents(list);
  };

  /** [에이전트] 묶음을 서버에서 다시 받는다. 받는 함수가 없는 엔진이면 할 일이 없다(목록으로 묶는다). */
  const loadAgents = async (): Promise<void> => {
    const engine = props.engine;
    if (!engine.conversationAgents) return;
    const seq = ++agentsSeq.current;
    try {
      const list = await engine.conversationAgents({ limit: AGENT_GROUP_LIMIT }, props.session.profile);
      if (seq !== agentsSeq.current) return;
      storeAgents(list);
      setAgentsFailed(false);
    } catch {
      // 받지 못하면 받아 둔 대화 목록으로 묶어 보여 준다.
      if (seq === agentsSeq.current) setAgentsFailed(true);
    }
  };

  /**
   * 받아 둔 묶음을 고친다(소식, 여기서 한 일). 규칙이 서버에 다시 물어야 한다고 하면 true.
   * 아직 못 받았으면 고칠 것이 없다(곧 올 것이 새 값이다).
   */
  const editAgents = (
    edit: (list: ConversationAgent[]) => { agents: ConversationAgent[]; reload: boolean },
  ): boolean => {
    const list = fetchedAgentsRef.current;
    if (!list) return false;
    const next = edit(list);
    storeAgents(next.agents);
    return next.reload;
  };

  useEffect(() => {
    let alive = true;
    setListLoading(true);
    props.engine
      .conversationPage({ limit: CONVERSATION_PAGE_SIZE }, props.session.profile)
      .then((page) => {
        if (!alive) return;
        pagesLoaded.current = 1;
        setConversations(page.conversations);
        setNextCursor(page.nextCursor);
        setDeletedCount(page.agentDeletedCount ?? page.conversations.filter((item) => item.agentDeleted).length);
      })
      .catch((reason: unknown) => alive && setListError(publicError(reason).message))
      .finally(() => alive && setListLoading(false));
    void loadAgents();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.engine, props.session.profile]);

  /**
   * 첫 쪽을 다시 읽어 합친다(새 대화가 생겼다). 받아 둔 뒤쪽은 지킨다. 한 쪽만 받아 둔 동안에는
   * 그 쪽을 새 것으로 바꾸되, 서버가 아직 모르는 새 대화 줄은 남긴다.
   */
  const refreshFirstPage = async (): Promise<void> => {
    try {
      const page = await props.engine.conversationPage({ limit: CONVERSATION_PAGE_SIZE }, props.session.profile);
      const fresh = new Set(page.conversations.map(conversationKey));
      const drafts = new Set(localDrafts.current);
      for (const key of fresh) localDrafts.current.delete(key);
      if (pagesLoaded.current <= 1) {
        setConversations((list) => [
          ...list.filter((item) => drafts.has(conversationKey(item)) && !fresh.has(conversationKey(item))),
          ...page.conversations,
        ]);
        setNextCursor(page.nextCursor);
        pagesLoaded.current = 1;
      } else {
        setConversations((list) => mergeConversationPage(list, page.conversations, 'head'));
      }
      if (typeof page.agentDeletedCount === 'number') setDeletedCount(page.agentDeletedCount);
      setListError(undefined);
    } catch (reason) {
      setListError(publicError(reason).message);
    }
  };

  // ── 에이전트 안 ──

  /** 들어가 있는 에이전트의 대화 한 쪽. cursor 가 없으면 첫 쪽이다(목록을 통째로 바꾼다). */
  const loadDrillPage = async (cursor: string | null): Promise<void> => {
    const open = drillRef.current;
    if (!open || drillLoadingRef.current) return;
    const seq = drillSeq.current;
    drillLoadingRef.current = true;
    setDrill((current) => current && { ...current, loading: true, error: undefined });
    try {
      const page = await props.engine.conversationPage(
        { limit: CONVERSATION_PAGE_SIZE, cursor, workflowId: open.agent.workflowId },
        props.session.profile,
      );
      if (seq !== drillSeq.current) return;
      setDrill(
        (current) =>
          current && {
            ...current,
            items: cursor ? mergeConversationPage(current.items, page.conversations, 'append') : page.conversations,
            nextCursor: page.nextCursor,
            pages: cursor ? current.pages + 1 : 1,
            loading: false,
          },
      );
    } catch (reason) {
      if (seq === drillSeq.current) {
        setDrill((current) => current && { ...current, loading: false, error: publicError(reason).message });
      }
    } finally {
      if (seq === drillSeq.current) drillLoadingRef.current = false;
    }
  };

  /** 들어가 있는 에이전트의 첫 쪽을 다시 읽어 합친다(소식). 받아 둔 뒤쪽은 지킨다. */
  const refreshDrill = async (): Promise<void> => {
    const open = drillRef.current;
    if (!open || open.pages === 0) return;
    const seq = drillSeq.current;
    try {
      const page = await props.engine.conversationPage(
        { limit: CONVERSATION_PAGE_SIZE, workflowId: open.agent.workflowId },
        props.session.profile,
      );
      if (seq !== drillSeq.current) return;
      setDrill(
        (current) =>
          current && {
            ...current,
            items:
              current.pages <= 1 ? page.conversations : mergeConversationPage(current.items, page.conversations, 'head'),
            nextCursor: current.pages <= 1 ? page.nextCursor : current.nextCursor,
          },
      );
    } catch {
      // 다음 소식에 다시 읽는다. 목록을 깨지 않는다.
    }
  };

  /** 에이전트 줄에서 Enter: 그 에이전트의 대화로 들어간다. */
  const openDrill = (agent: ConversationAgent): void => {
    drillSeq.current += 1;
    drillLoadingRef.current = false;
    const fresh: Drill = { agent, items: [], nextCursor: null, pages: 0, loading: true };
    drillRef.current = fresh;
    setDrill(fresh);
    setCursorKey(fixedRowKey(agent.agentDeleted ? 'back' : 'agentNew'));
    void loadDrillPage(null);
  };

  /** [← 에이전트] · Esc · ←: 에이전트 묶음으로 돌아간다. 커서는 그 에이전트 줄에 선다. */
  const closeDrill = (): void => {
    const open = drillRef.current;
    drillSeq.current += 1;
    drillLoadingRef.current = false;
    drillRef.current = undefined;
    setDrill(undefined);
    if (open) setCursorKey(agentRowKey(open.agent.workflowId));
  };

  // ── 목록 고치기(여기서 한 일과 다른 기기의 소식이 같은 규칙을 탄다) ──

  /** 이름이 바뀌었다: 어디에 있든 제목만 고친다. 순서는 그대로다. */
  const applyRenamed = (workflowId: string, interactionId: string, title: string, customTitle: boolean): void => {
    setConversations((list) => renameConversationInList(list, workflowId, interactionId, title, customTitle));
    setDrill(
      (current) =>
        current && {
          ...current,
          items: renameConversationInList(current.items, workflowId, interactionId, title, customTitle),
        },
    );
    editAgents((list) => ({ agents: renameInConversationAgents(list, workflowId, interactionId, title), reload: false }));
    setOpened((current) =>
      current && current.workflowId === workflowId && current.interactionId === interactionId
        ? { ...current, title, customTitle }
        : current,
    );
  };

  /**
   * 대화가 지워졌다: 어디에 있든 줄을 빼고 [에이전트] 수를 줄인다. 지운 것이 그 에이전트의 마지막 대화였으면
   * 묶음을 서버에 다시 물어야 한다(true). 소켓이 알려 준 지움이 여기서 이미 지운 것이면 수는 다시 줄이지 않는다.
   */
  const applyRemoved = (items: RemovedRef[], fromSocket: boolean): boolean => {
    let reload = false;
    for (const item of items) {
      const key = conversationKey(item);
      if (fromSocket && locallyRemoved.current.has(key)) {
        locallyRemoved.current.delete(key);
        continue;
      }
      if (!fromSocket) locallyRemoved.current.add(key);
      const stale = editAgents((list) => {
        const next = dropFromConversationAgents(list, item.workflowId, item.interactionId);
        return { agents: next.agents, reload: next.stale };
      });
      reload = reload || stale;
    }
    const without = (list: Conversation[]): Conversation[] =>
      items.reduce((rest, item) => removeConversation(rest, item.workflowId, item.interactionId), list);
    setConversations(without);
    setDrill((current) => current && { ...current, items: without(current.items) });
    return reload;
  };

  /** 이 대화에서 방금 말했다: [에이전트] 의 그 줄을 맨 위로. 묶음에 없는 에이전트의 옛 대화면 true(다시 묻는다). */
  const bumpAgent = (conversation: Conversation, created: boolean): boolean =>
    editAgents((list) => {
      const next = touchConversationAgent(list, conversation, created);
      return { agents: next.agents, reload: !next.known };
    });

  // 대화 목록 소켓: 다른 기기(웹·앱·VS Code)에서 생긴 변화를 곧바로 반영한다. 규칙은 데스크톱과 같다:
  // 아는 대화에서 방금 말했으면 맨 위로(에이전트 줄도), 모르는 대화면 첫 쪽과 묶음을 다시 읽고(숨길 대화인지는
  // 서버만 안다), 이름이 바뀌었으면 제목만, 지워졌으면 줄을 빼고 그 에이전트의 수를 줄인다.
  const live = useRef({ refreshFirstPage, loadAgents, refreshDrill, applyRenamed, applyRemoved, bumpAgent });
  live.current = { refreshFirstPage, loadAgents, refreshDrill, applyRenamed, applyRemoved, bumpAgent };
  useEffect(() => {
    const engine = props.engine;
    if (!engine.watchConversationList) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = { head: false, agents: false, drill: false };
    // 지우기·정리 소식이 몰려와도 다시 읽기는 한 번만 한다.
    const schedule = (what: { head?: boolean; agents?: boolean; drill?: boolean }): void => {
      pending.head = pending.head || what.head === true;
      pending.agents = pending.agents || what.agents === true;
      pending.drill = pending.drill || what.drill === true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const run = { ...pending };
        pending.head = false;
        pending.agents = false;
        pending.drill = false;
        if (run.head) void live.current.refreshFirstPage();
        if (run.agents) void live.current.loadAgents();
        if (run.drill) void live.current.refreshDrill();
      }, 400);
    };
    engine.onConversationListChange = (event) => {
      const change = conversationListChange(event.kind, {
        ...(event.data ?? {}),
        interaction_id: event.interactionId,
        workflow_id: event.workflowId,
        ...(typeof event.running === 'boolean' ? { running: event.running } : {}),
      });
      switch (change.type) {
        case 'touched': {
          const conv = change.conversation;
          if (!conv) {
            schedule({ head: true, agents: true, drill: true });
            return;
          }
          const key = conversationKey(conv);
          if (conversationsRef.current.some((item) => conversationKey(item) === key)) {
            setConversations((list) => touchConversation(list, conv).list);
            if (live.current.bumpAgent(conv, false)) schedule({ agents: true });
          } else {
            schedule({ head: true, agents: true });
          }
          const open = drillRef.current;
          if (open && open.agent.workflowId === conv.workflowId) {
            if (open.items.some((item) => conversationKey(item) === key)) {
              setDrill((current) => current && { ...current, items: touchConversation(current.items, conv).list });
            } else {
              schedule({ drill: true });
            }
          }
          return;
        }
        case 'renamed':
          live.current.applyRenamed(change.workflowId, change.interactionId, change.title, change.customTitle);
          return;
        case 'removed': {
          const stale = live.current.applyRemoved(
            [{ workflowId: change.workflowId, interactionId: change.interactionId }],
            true,
          );
          schedule({ head: true, agents: stale });
          return;
        }
        case 'reload':
          schedule({ head: true, agents: true, drill: true });
          return;
        default:
      }
    };
    void engine.watchConversationList(props.session.profile).catch(() => undefined);
    return () => {
      if (timer) clearTimeout(timer);
      engine.onConversationListChange = null;
      engine.unwatchConversationList?.();
    };
  }, [props.engine, props.session.profile]);

  /** [최근 채팅] 의 다음 쪽([더 보기] 가 받아 둔 것보다 더 보여 주려 한다). */
  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await props.engine.conversationPage(
        { limit: CONVERSATION_PAGE_SIZE, cursor: nextCursor },
        props.session.profile,
      );
      pagesLoaded.current += 1;
      setConversations((list) => mergeConversationPage(list, page.conversations, 'append'));
      setNextCursor(page.nextCursor);
      setListError(undefined);
    } catch (reason) {
      setListError(publicError(reason).message);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  /** [에이전트] 묶음: 서버가 센 것. 그 함수가 없는 엔진이거나 받지 못했으면 받아 둔 대화 목록으로 묶는다. */
  const chatAgents = useMemo(
    () =>
      props.engine.conversationAgents && !agentsFailed
        ? (fetchedAgents ?? [])
        : groupConversationsByAgent(conversations),
    [props.engine, agentsFailed, fetchedAgents, conversations],
  );
  /** [다른 에이전트]: 쓸 수 있지만 아직 대화가 없는 에이전트. */
  const otherAgents = useMemo(() => agentsWithoutConversations(chatAgents, agents), [chatAgents, agents]);
  const rows: ListRow[] = useMemo(
    () =>
      buildRows({
        conversations,
        recentShown,
        hasMore: nextCursor != null,
        agents: chatAgents,
        others: otherAgents,
        othersOpen,
        drill: drill && {
          agent: drill.agent,
          conversations: drill.items,
          done: drill.pages > 0 && !drill.nextCursor && !drill.loading,
        },
      }),
    [conversations, recentShown, nextCursor, chatAgents, otherAgents, othersOpen, drill],
  );
  // 커서는 열쇠로 붙든다. 그 줄이 사라졌으면(지움·접기) 같은 자리 근처의 고를 수 있는 줄에 선다.
  let rowIndex = rows.findIndex((row) => rowKey(row) === cursorKey);
  if (rowIndex < 0) rowIndex = nearestSelectable(rows, lastRowIndex.current);
  lastRowIndex.current = rowIndex;
  const cursorRow = rows[rowIndex];

  // 에이전트 안에서 끝 가까이 내려오면 그 에이전트의 다음 쪽을 받아 둔다.
  useEffect(() => {
    if (drill?.nextCursor && !drill.loading && !drill.error && rowIndex >= rows.length - PREFETCH_ROWS) {
      void loadDrillPage(drill.nextCursor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIndex, rows.length, drill?.nextCursor, drill?.loading, drill?.error]);

  const moveCursor = (delta: 1 | -1): void => {
    const next = stepSelectable(rows, rowIndex, delta);
    const row = rows[next];
    if (row) setCursorKey(rowKey(row));
    // 에이전트 안의 맨 끝에서 한 번 더 내리면 못 받은 다음 쪽을 다시 청한다(오류였어도).
    if (delta === 1 && next === rowIndex && drill?.nextCursor) void loadDrillPage(drill.nextCursor);
  };

  /** [더 보기]: 5개 더. 받아 둔 것이 모자라면 다음 쪽을 받는다. 커서는 [더 보기] 에 남는다. */
  const showMore = (): void => {
    const next = recentShown + RECENT_CONVERSATION_STEP;
    setRecentShown(next);
    if (conversationsRef.current.length < next && nextCursor) {
      setListError(undefined);
      void loadMore();
    }
  };

  /** [접기]: 처음 5개로. 커서는 [더 보기] 에 선다. */
  const showLess = (): void => {
    setRecentShown(RECENT_CONVERSATION_STEP);
    setCursorKey(fixedRowKey('more'));
  };

  const openModelPicker = (): void => {
    if (!modelAgent) return;
    if (!model.supported || !model.current) {
      setAttachmentNotice('이 Agent는 모델을 고를 수 없습니다.');
      return;
    }
    if (model.locked) {
      setAttachmentNotice(MODEL_PICKER_TEXT.locked);
      return;
    }
    setPalette(false);
    setModelPicker(true);
  };

  const openThinkingPicker = (): void => {
    if (!modelAgent) return;
    const thinking = model.supported ? model.thinking : null;
    if (!thinking) {
      setAttachmentNotice('이 Agent는 생각 정도를 고를 수 없습니다.');
      return;
    }
    if (!thinking.supported) {
      setAttachmentNotice(THINKING_PICKER_TEXT.unsupportedHint);
      return;
    }
    if (model.locked) {
      setAttachmentNotice(THINKING_PICKER_TEXT.locked);
      return;
    }
    setPalette(false);
    setThinkingPicker(true);
  };

  const chooseThinking = async (value: ThinkingValue): Promise<void> => {
    setThinkingPicker(false);
    const thinking = model.thinking;
    if (!modelAgent || !thinking || !props.engine.setConversationThinking || value === selectedThinking(thinking)) return;
    try {
      const next = await props.engine.setConversationThinking(modelAgent.workflowId, modelTarget, value, props.session.profile);
      setModel(next);
      setAttachmentNotice(`${thinkingChipLabel(next.thinking)} · ${THINKING_PICKER_TEXT.nextTurn}`);
    } catch (error) {
      setAttachmentNotice(`${THINKING_PICKER_TEXT.failed}: ${publicError(error).message}`);
    }
  };

  const chooseModel = async (choice: ModelChoice): Promise<void> => {
    setModelPicker(false);
    if (!modelAgent || !props.engine.setConversationModel || sameModel(choice, model.current)) return;
    try {
      const next = await props.engine.setConversationModel(
        modelAgent.workflowId,
        modelTarget,
        { provider: choice.provider, model: choice.model },
        props.session.profile,
      );
      setModel(next);
      setAttachmentNotice(`모델: ${next.current?.label ?? choice.label} · ${MODEL_PICKER_TEXT.nextTurn}`);
    } catch (error) {
      setAttachmentNotice(`${MODEL_PICKER_TEXT.failed}: ${publicError(error).message}`);
    }
  };

  /**
   * 다른 곳에서 도는 턴을 지켜본다 — 끝나면 그 답을 히스토리에서 받아 그린다.
   *
   * 이 CLI 는 그 스트림을 쥐고 있지 않아 이벤트가 오지 않는다. 서버도 진행 중인
   * 턴의 토큰을 재전송하지 않는다(완결된 턴만 execution_io 에 남는다). 그래서
   * 할 수 있는 정직한 일은 [진행 중] 을 보여 주고 완결을 기다리는 것이다.
   */
  useEffect(() => {
    if (!chat.remote || !chat.interactionId || !selected) return;
    const interactionId = chat.interactionId;
    const ref = selected;
    let alive = true;
    const timer = setInterval(() => {
      void props.engine
        .historySnapshot(ref.workflowId, interactionId, ref.workflowName, props.session.profile)
        .then((snapshot) => {
          if (!alive || snapshot.running) return;
          dispatch({ type: 'remote_finished', interactionId, turns: snapshot.turns });
        })
        // 서버에 못 닿았다 — 다음 회차에 다시 본다. 폴링 실패로 화면을 깨지 않는다.
        .catch(() => undefined);
    }, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [chat.remote, chat.interactionId, selected, props.engine, props.session.profile]);

  /** 첨부와 입력을 비운다(다른 대화로 옮기거나 새 채팅). */
  const clearComposer = (): void => {
    setInput('');
    attachmentEpoch.current += 1;
    setAttachments([]);
    setAttachmentInteractionId(undefined);
    setAttachmentNotice('');
  };

  /** 이 대화를 **그만 본다**. 서버 실행은 계속된다(다른 화면으로 옮길 때). */
  const detachTurn = (): void => {
    controller.current?.abort();
    dispatch({ type: 'turn_cancelled' });
  };

  /**
   * 시작 화면(새 채팅)을 연다: [＋ 새 채팅] · Ctrl+N · 팔레트.
   *
   * 지금 도는 턴이 있으면 손만 뗀다. 서버 실행은 계속되고, 그 대화를 목록에서 다시 열면
   * [진행 중] 이 돌아온다. `agent` 가 있으면([＋ 이 에이전트로 새 채팅]·[다른 에이전트]) 시작 화면이
   * 그 에이전트를 골라 둔다.
   */
  const openStart = (options: { focusMain?: boolean; agent?: AgentRef } = {}): void => {
    if (chat.running) detachTurn();
    viewEpoch.current += 1;
    // 이미 시작 화면이면 번호를 지킨다: 거기서 Ctrl+O 로 고른 모델이 그 번호에 붙어 있다.
    if (view !== 'start') draftInteractionId.current = randomUUID();
    dispatch({ type: 'reset' });
    clearComposer();
    setScrollUp(0);
    setPalette(false);
    setSelected(undefined);
    setOpened(undefined);
    setView('start');
    if (options.agent) {
      preselectNonce.current += 1;
      setStartPreselect({ workflowId: options.agent.workflowId, nonce: preselectNonce.current });
    } else {
      // 그냥 새 채팅이면 미리 고른 것을 거둔다. 시작 화면에서 사람이 고른 것은 그대로 둔다.
      setStartPreselect(undefined);
      setCursorKey(fixedRowKey('new'));
    }
    if (options.focusMain !== false) setFocus('main');
  };

  const openHistory = (conversation: Conversation, snapshot: ConversationSnapshot): void => {
    viewEpoch.current += 1;
    setSelected({ workflowId: conversation.workflowId, workflowName: conversation.workflowName });
    setOpened(conversation);
    setView('chat');
    clearComposer();
    // running 을 그대로 싣는다 — 웹·앱·VSCode 에서 시작한 턴이 아직 돌고 있으면
    // 여기서도 [진행 중] 이어야 하고, 그 위에 새 턴을 얹어서는 안 된다.
    dispatch({
      type: 'history_loaded',
      interactionId: conversation.interactionId,
      turns: snapshot.turns,
      running: snapshot.running,
    });
    // 지워진 에이전트의 대화는 이어 갈 수 없다. 지켜볼 것도 없다.
    if (!conversation.agentDeleted) {
      void props.engine.watchConversation?.(
        conversation.workflowId,
        conversation.workflowName,
        conversation.interactionId,
        props.session.profile,
      );
    }
    // 불러온 대화는 맨 아래(가장 최근)부터 보여 준다.
    setScrollUp(0);
    setCursorKey(conversationKey(conversation));
    setHistory(false);
    setFocus('main');
  };

  /** 목록에서 고른 대화를 연다. 지난 턴과 함께 지금 도는 턴이 있는지도 읽는다. */
  const openConversation = async (conversation: Conversation): Promise<void> => {
    if (opening) return;
    if (chat.running) detachTurn();
    setOpening(true);
    setListNotice(undefined);
    try {
      const snapshot = await props.engine.historySnapshot(
        conversation.workflowId,
        conversation.interactionId,
        conversation.workflowName,
        props.session.profile,
      );
      openHistory(conversation, snapshot);
    } catch (reason) {
      setListError(publicError(reason).message);
    } finally {
      setOpening(false);
    }
  };

  /**
   * 지금 보는 대화를 적어 둔다 — 터미널을 닫았다 다시 열 때 되찾을 자리.
   *
   * [새 대화] 로 비운 사이에는 지우지 않는다. 그때도 "마지막으로 보던 대화" 는
   * 여전히 직전 그것이고, 새 대화는 첫 턴에서 제 값으로 덮는다.
   */
  useEffect(() => {
    if (!chat.interactionId || !selected) return;
    props.preferences?.onLastChatChange?.({
      workflowId: selected.workflowId,
      workflowName: selected.workflowName,
      interactionId: chat.interactionId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.interactionId, selected?.workflowId]);

  /**
   * 터미널을 닫았다 다시 연다 — 그때 **돌고 있던** 대화가 그대로 돌아온다.
   *
   * 끝난 대화는 열지 않는다. CLI 는 매번 새로 시작하는 자리라, 묻지도 않고 지난
   * 대화를 펼치는 것은 놀라운 일이다. 되찾을 값이 있는 것은 아직 도는 실행뿐이고
   * — 그건 열어 줘야 [진행 중] 과 Esc(정지) 가 돌아온다.
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const last = props.preferences?.lastChat;
    if (!last) return;
    let alive = true;
    void props.engine
      .historySnapshot(last.workflowId, last.interactionId, last.workflowName, props.session.profile)
      .then((snapshot) => {
        // 그 사이 사용자가 직접 대화를 시작했으면 그쪽이 이긴다.
        if (!alive || !snapshot.running || chatInteractionRef.current) return;
        // 목록에 이 대화가 있으면 제목 줄은 목록의 것을 쓴다. 아직 없으면 첫 말로 제목을 짓는다.
        openHistory(
          {
            id: 0,
            workflowId: last.workflowId,
            workflowName: last.workflowName,
            interactionId: last.interactionId,
            interactionCount: snapshot.turns.length,
            metadata: {},
            createdAt: '',
            updatedAt: '',
            title: conversationTitleFromMetadata({ first_message: snapshot.turns[0]?.input ?? '' }).title,
            customTitle: false,
            tag: null,
            agentDeleted: false,
            agentOwnerId: null,
            compare: [],
          },
          snapshot,
        );
      })
      // 서버에 못 닿았다 — 되찾기 실패로 화면을 막지 않는다.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 사람이 누른 [정지] (Esc) — 스트림에서 손을 떼고 **서버 실행도** 멈춘다.
   *
   * abort 만으로는 멈추지 않는다. 서버는 연결 끊김을 더 이상 취소로 읽지
   * 않으므로(그렇게 읽던 시절엔 화면 잠금·기기 이동이 실행 중단이었다),
   * 버려진 턴은 끝까지 돌아 대화에 답을 적는다.
   */
  const stopTurn = (): void => {
    if (stopping.current) return;
    const interactionId = chat.interactionId;
    const active = controller.current;
    if (!interactionId) return;
    stopping.current = true;
    void props.engine.stopChat(interactionId, props.session.profile).then((result) => {
      if (result.stopped || result.reason === 'not_running') {
        active?.abort();
        dispatch({ type: 'turn_cancelled' });
      } else {
        setAttachmentNotice('중단을 확인하지 못했습니다. 실행 상태를 확인한 뒤 다시 시도해 주세요.');
      }
    }).catch(() => {
      setAttachmentNotice('중단 요청을 보내지 못했습니다. 연결 상태를 확인해 주세요.');
    }).finally(() => { stopping.current = false; });
  };

  /**
   * 메시지를 보낸다. `target` 은 시작 화면이 고른(또는 막 세운) 에이전트다. 그 자리에서는
   * 아직 이 화면의 `selected` 가 바뀌기 전이라 직접 넘긴다.
   */
  const send = async (value: string, target: AgentRef | undefined = selected): Promise<void> => {
    const text = value.trim();
    if (!target || readOnly || chat.running || stopping.current || uploadBusy.current) return;
    if (text.startsWith('/attach ')) {
      const path = text.slice('/attach '.length).trim().replace(/^['"]|['"]$/g, '');
      if (!path) return;
      const epoch = attachmentEpoch.current;
      uploadBusy.current = true;
      setAttachmentNotice('파일을 업로드하는 중…');
      try {
        const seed = await props.engine.resolveChatInput({
          profile: props.session.profile, workflowId: target.workflowId,
          workflowName: target.workflowName, interactionId: modelTarget,
          input: '',
        });
        const uploaded = await props.engine.uploadChatAttachment({
          profile: props.session.profile, workflowId: target.workflowId,
          interactionId: seed.interactionId, path,
        });
        if (attachmentEpoch.current !== epoch) return;
        setAttachmentInteractionId(seed.interactionId);
        setAttachments((current) => [...current, uploaded]);
        setAttachmentNotice(`첨부됨: ${uploaded.name} · 총 ${attachments.length + 1}개`);
        setInput('');
      } catch (error) {
        if (attachmentEpoch.current === epoch) setAttachmentNotice(`첨부 실패: ${publicError(error).message}`);
      } finally {
        uploadBusy.current = false;
      }
      return;
    }
    if (text === '/model') {
      setInput('');
      openModelPicker();
      return;
    }
    if (text === '/thinking') {
      setInput('');
      openThinkingPicker();
      return;
    }
    if (text === '/attachments') {
      setAttachmentNotice(attachments.length ? attachments.map((a) => a.name).join(', ') : '첨부된 파일이 없습니다.');
      setInput('');
      return;
    }
    if (text === '/detach') {
      attachmentEpoch.current += 1;
      setAttachments([]);
      setAttachmentInteractionId(undefined);
      setAttachmentNotice('첨부를 모두 제거했습니다.');
      setInput('');
      return;
    }
    if (!text && attachments.length === 0) return;
    const epoch = viewEpoch.current;
    /** 이 턴을 보낸 화면에 아직 있는가. 다른 대화로 옮겼으면 그 화면을 건드리지 않는다. */
    const here = (): boolean => viewEpoch.current === epoch;
    let known = true;
    try {
      const resolved = await props.engine.resolveChatInput({
        profile: props.session.profile,
        workflowId: target.workflowId,
        workflowName: target.workflowName,
        // 새 대화면 미리 정해 둔 번호 — Ctrl+O 로 먼저 고른 모델이 첫 턴부터 붙는다.
        interactionId: modelTarget,
        input: text,
        attachments,
        // TUI 를 연 폴더가 이 대화의 작업 공간이다(홈·루트에서 열었으면 없음).
        localFolders: defaultWorkingFolders(),
      });
      if (!here()) return;
      setInput('');
      setScrollUp(0);
      dispatch({ type: 'turn_started', interactionId: resolved.interactionId, input: text });
      attachmentEpoch.current += 1;
      setAttachments([]);
      setAttachmentInteractionId(undefined);
      setAttachmentNotice('');
      // 방금 말한 대화는 목록 맨 위로, 그 에이전트 줄도 맨 위로. 처음 말한 대화면 서버가 알기 전이라
      // 여기서 한 줄을 세운다(그 에이전트의 대화 수도 하나 는다).
      const key = conversationKey(resolved);
      const now = new Date().toISOString();
      const same = (item: Conversation): boolean => conversationKey(item) === key;
      const inRecent = conversationsRef.current.find(same);
      known = inRecent !== undefined;
      // [최근 채팅] 에 없어도 아는 대화일 수 있다(에이전트 안이나 기록·검색에서 연 오래된 대화).
      const base = inRecent ?? drillRef.current?.items.find(same) ?? (opened && same(opened) ? opened : undefined);
      const touched = base ? { ...base, updatedAt: now } : draftConversation(resolved, text, now);
      if (inRecent) {
        setConversations((list) => touchConversation(list, touched).list);
      } else {
        localDrafts.current.add(key);
        setConversations((list) => [touched, ...list.filter((item) => !same(item))]);
      }
      if (bumpAgent(touched, !base)) void loadAgents();
      if (drillRef.current?.agent.workflowId === resolved.workflowId) {
        setDrill(
          (current) =>
            current && {
              ...current,
              items: current.items.some(same)
                ? touchConversation(current.items, touched).list
                : [touched, ...current.items],
            },
        );
      }
      setCursorKey(key);
      void props.engine.watchConversation?.(
        resolved.workflowId,
        resolved.workflowName,
        resolved.interactionId,
        props.session.profile,
      );
      const active = new AbortController();
      controller.current = active;
      let detached = false;
      for await (const event of props.engine.chat(resolved, active.signal)) {
        if (event.kind === 'detached') detached = true;
        if (here()) dispatch({ type: 'event_received', event });
      }
      if (!here()) {
        // 다른 대화로 옮겼다. 서버 실행은 계속되고, 그 대화를 다시 열면 이력으로 돌아온다.
      } else if (active.signal.aborted) dispatch({ type: 'turn_cancelled' });
      // 분리는 종료가 아니다 — reducer 가 이미 [진행 중] 으로 넘겼고, 대화 소켓이
      // 완결 턴을 밀어 주면 그때 답이 채워진다. 여기서 turn_completed 를 보내면
      // 그 상태를 도로 꺼 버린다.
      else if (!detached) dispatch({ type: 'turn_completed' });
    } catch (error) {
      if (!here()) return;
      if (controller.current?.signal.aborted) dispatch({ type: 'turn_cancelled' });
      else {
        if (attachments.length > 0) {
          setAttachments(attachments);
          setAttachmentInteractionId(chat.interactionId ?? attachmentInteractionId);
          setAttachmentNotice(`${attachments.length}개 파일을 다시 보낼 수 있습니다.`);
        }
        dispatch({ type: 'turn_failed', message: publicError(error).message });
      }
    } finally {
      if (here()) controller.current = null;
      // 처음 말한 대화: 이제 서버가 안다. 서버가 지은 제목·순서로 목록을 맞춘다.
      if (!known) void refreshFirstPage();
    }
  };

  /** 시작 화면에서 보냈다: 고른(또는 막 세운) 에이전트와 새 대화를 열고 첫 말을 보낸다. */
  const startChat = (agent: AgentRef, text: string): void => {
    setSelected(agent);
    setOpened(undefined);
    setView('chat');
    setFocus('main');
    void send(text, agent);
  };

  /** 이름 바꾸기. 빈 이름이면 서버가 첫 메시지 제목으로 돌려준다. 목록 순서는 그대로다. */
  const renameConversation = async (conversation: Conversation, title: string): Promise<void> => {
    const result = await props.engine.renameConversation(
      conversation.workflowId,
      conversation.interactionId,
      title,
      props.session.profile,
    );
    applyRenamed(conversation.workflowId, conversation.interactionId, result.title, result.customTitle);
    setDialog(undefined);
  };

  /** 대화 지우기. 비교 채팅이면 딸린 대화까지 서버가 함께 지운다. */
  const deleteConversation = async (conversation: Conversation): Promise<void> => {
    await props.engine.deleteConversation(
      conversation.workflowId,
      conversation.interactionId,
      conversation.workflowName,
      props.session.profile,
    );
    const key = conversationKey(conversation);
    // 커서는 지운 줄의 아래(없으면 위) 고를 수 있는 줄로.
    const at = rows.findIndex((row) => rowKey(row) === key);
    if (at >= 0) {
      const below = stepSelectable(rows, at, 1);
      const neighbor = rows[below !== at ? below : stepSelectable(rows, at, -1)];
      if (neighbor && neighbor !== rows[at]) setCursorKey(rowKey(neighbor));
    }
    if (applyRemoved([conversation], false)) void loadAgents();
    if (conversation.agentDeleted) setDeletedCount((count) => Math.max(0, count - 1));
    setDialog(undefined);
    if (key === openKey) openStart({ focusMain: false });
  };

  /** 에이전트가 사라진 대화를 모두 지운 뒤(여기서, 채팅 기록 관리에서): 목록과 묶음에서 빼고 묶음을 다시 받는다. */
  const afterPurge = (): void => {
    setConversations((list) => list.filter((item) => !item.agentDeleted));
    setDeletedCount(0);
    editAgents((list) => ({ agents: list.filter((agent) => !agent.agentDeleted), reload: false }));
    if (drillRef.current?.agent.agentDeleted) closeDrill();
    else setDrill((current) => current && { ...current, items: current.items.filter((item) => !item.agentDeleted) });
    if (readOnly) openStart({ focusMain: false });
    void loadAgents();
  };

  /** 에이전트가 사라진 대화를 모두 지운다. */
  const purgeDeletedAgents = async (): Promise<void> => {
    const removed = await props.engine.purgeDeletedAgentConversations(props.session.profile);
    setDialog(undefined);
    setListNotice(`${removed}개를 지웠습니다.`);
    afterPurge();
    // 지운 만큼 비었다: 첫 쪽부터 다시 받는다.
    await loadFirstPage().catch((reason: unknown) => setListError(publicError(reason).message));
  };

  /** 채팅 기록 관리에서 바꾼 것을 목록에 곧바로 싣는다. */
  const applyManagerChange = (change: ManagerChange): void => {
    if (change.type === 'renamed') {
      applyRenamed(change.workflowId, change.interactionId, change.title, change.customTitle);
      return;
    }
    if (change.type === 'removed') {
      if (applyRemoved(change.items, false)) void loadAgents();
      const gone = change.items.filter((item) => item.agentDeleted).length;
      if (gone > 0) setDeletedCount((count) => Math.max(0, count - gone));
      if (openKey && change.items.some((item) => conversationKey(item) === openKey)) openStart({ focusMain: false });
      return;
    }
    afterPurge();
    void loadFirstPage().catch((reason: unknown) => setListError(publicError(reason).message));
  };

  /** 채팅 기록 관리(목록에서 m, Ctrl+K). 몸통 자리를 쓴다. */
  const openManager = (): void => {
    setPalette(false);
    setManager(true);
  };

  const openPurge = (): void => {
    if (deletedCount <= 0) return;
    setPalette(false);
    setFocus('list');
    setDialog({ kind: 'purge', count: deletedCount });
  };

  /** 채팅 검색을 목록 자리에 연다(목록에서 `/`, Ctrl+K › 채팅 검색). */
  const openSearch = (): void => {
    setPalette(false);
    setFocus('list');
    setDialog({ kind: 'search' });
  };

  /** 목록 줄에서 Enter. */
  const activateRow = (): void => {
    const row = cursorRow;
    if (!row) return;
    switch (row.kind) {
      case 'new':
        openStart();
        return;
      case 'conversation':
        void openConversation(row.conversation);
        return;
      case 'more':
        showMore();
        return;
      case 'less':
        showLess();
        return;
      case 'agent':
        openDrill(row.agent);
        return;
      case 'others':
        setOthersOpen((open) => !open);
        return;
      case 'other':
        openStart({ agent: { workflowId: row.agent.workflowId, workflowName: row.agent.workflowName } });
        return;
      case 'agentNew':
        openStart({ agent: { workflowId: row.agent.workflowId, workflowName: row.agent.workflowName } });
        return;
      case 'back':
        closeDrill();
        return;
      default:
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

  const overlay = palette || history || modelPicker || thinkingPicker || manager;

  useInput(
    (keyInput, key) => {
      if (key.ctrl && keyInput === 'k') setPalette(true);
      else if (key.ctrl && keyInput === 'o') openModelPicker();
      else if (key.ctrl && keyInput === 'p') {
        controller.current?.abort();
        props.onProfiles();
      } else if (key.ctrl && keyInput === 'h') {
        if (chat.running) detachTurn();
        setHistory(true);
      }
      else if (key.ctrl && keyInput === 'n') openStart();
      else if (key.pageUp) scrollBy(-1);
      else if (key.pageDown) scrollBy(1);
      // 에이전트 안의 목록에서 Esc 는 [뒤로] 다. 도는 턴을 멈추는 것보다 가까운 일이다.
      else if (key.escape && focus === 'list' && drill && !opening) closeDrill();
      else if (key.escape && chat.running) stopTurn();
      else if (key.escape) setFocus('list');
      else if (key.tab) setFocus((current) => (current === 'list' ? 'main' : 'list'));
      else if (focus !== 'list' || opening) return;
      else if (key.leftArrow && drill) closeDrill();
      else if (key.upArrow) moveCursor(-1);
      else if (key.downArrow) moveCursor(1);
      else if (key.return) activateRow();
      else if (keyInput === '/') openSearch();
      // 두벌식 한글 자판이 켜져 있어도 같은 자리의 키(ㅡ=m)로 듣는다.
      else if (keyInput === 'm' || keyInput === 'ㅡ') openManager();
      else if (cursorRow?.kind !== 'conversation') return;
      // 두벌식 한글 자판이 켜져 있어도 같은 자리의 키(ㄱ=r, ㅇ=d)로 듣는다.
      else if (keyInput === 'r' || keyInput === 'ㄱ') setDialog({ kind: 'rename', conversation: cursorRow.conversation });
      else if (keyInput === 'd' || keyInput === 'ㅇ' || key.delete) {
        setDialog({ kind: 'delete', conversation: cursorRow.conversation });
      }
    },
    // 팔레트·기록·선택 창이나 목록의 묻는 칸이 떠 있으면 그 화면이 키를 갖는다. 여기서도
    // 받으면 방향키 하나가 두 곳에서 움직인다.
    { isActive: !overlay && !dialog && !startCapture },
  );

  const paletteActions: PaletteAction[] = [
    { id: 'new', label: '새 채팅', run: () => openStart() },
    { id: 'search', label: '채팅 검색', run: openSearch },
    { id: 'manage', label: MANAGER_TITLE, run: openManager },
    ...(model.supported && model.current && !model.locked
      ? [{ id: 'model', label: `모델 바꾸기 (${model.current.label})`, run: openModelPicker }]
      : []),
    ...(model.supported && model.thinking?.supported && !model.locked
      ? [{ id: 'thinking', label: `생각 바꾸기 (${thinkingChipLabel(model.thinking)})`, run: openThinkingPicker }]
      : []),
      {
        id: 'history',
        label: '대화 기록',
        run: () => {
          if (chat.running) detachTurn();
          setPalette(false);
          setHistory(true);
        },
      },
    ...(deletedCount > 0 ? [{ id: 'purge', label: `${PURGE_LABEL} (${deletedCount})`, run: openPurge }] : []),
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

  let overlayBody: React.ReactNode = null;
  if (thinkingPicker) {
    overlayBody = (
      <ThinkingPicker
        state={model}
        height={bodyHeight}
        onPick={(value) => void chooseThinking(value)}
        onCancel={() => setThinkingPicker(false)}
      />
    );
  } else if (modelPicker) {
    overlayBody = (
      <ModelPicker
        state={model}
        height={bodyHeight}
        onPick={(choice) => void chooseModel(choice)}
        onCancel={() => setModelPicker(false)}
      />
    );
  } else if (palette) {
    overlayBody = <CommandPalette actions={paletteActions} onCancel={() => setPalette(false)} />;
  } else if (history) {
    overlayBody = (
      <HistoryScreen
        engine={props.engine}
        profile={props.session.profile}
        onOpen={openHistory}
        onCancel={() => setHistory(false)}
      />
    );
  } else if (manager) {
    overlayBody = (
      <ConversationManagerScreen
        engine={props.engine}
        profile={props.session.profile}
        height={bodyHeight}
        onOpen={(conversation) => {
          setManager(false);
          void openConversation(conversation);
        }}
        onChange={applyManagerChange}
        onClose={() => setManager(false)}
        nativeIme={nativeIme}
        hangulMode={hangulMode}
        onHangulModeChange={changeHangulMode}
      />
    );
  }

  const listStatus = opening
    ? { text: '대화를 불러오는 중...' }
    : drill
      ? drill.loading
        ? { text: drill.pages > 0 ? '더 불러오는 중...' : '불러오는 중...' }
        : drill.error
          ? { text: drill.error, error: true }
          : undefined
      : listLoading
      ? { text: '불러오는 중...' }
      : loadingMore
        ? { text: '더 불러오는 중...' }
        : listError
          ? { text: listError, error: true }
          : listNotice
            ? { text: listNotice }
            : conversations.length === 0
              ? { text: '대화가 없습니다.' }
              : undefined;

  // 묻는 칸(이름 바꾸기·지우기)은 목록 자리에 뜬다. 오른쪽(적던 시작 화면·대화)은 그대로 둔다.
  const sidebar = dialog?.kind === 'search' ? (
    <SearchPanel
      recent={conversations}
      search={(query) => props.engine.searchConversations(query, { limit: SEARCH_LIMIT }, props.session.profile)}
      onOpen={(conversation) => {
        setDialog(undefined);
        void openConversation(conversation);
      }}
      onCancel={() => setDialog(undefined)}
      height={bodyHeight}
      nativeIme={nativeIme}
      hangulMode={hangulMode}
      onHangulModeChange={changeHangulMode}
    />
  ) : dialog?.kind === 'rename' ? (
    <RenamePanel
      conversation={dialog.conversation}
      onSave={(title) => renameConversation(dialog.conversation, title)}
      onCancel={() => setDialog(undefined)}
      nativeIme={nativeIme}
      hangulMode={hangulMode}
      onHangulModeChange={changeHangulMode}
    />
  ) : dialog?.kind === 'delete' ? (
    <ConfirmPanel
      title="채팅 지우기"
      question="이 채팅을 지울까요?"
      detail={conversationDisplayTitle(dialog.conversation)}
      onConfirm={() => deleteConversation(dialog.conversation)}
      onCancel={() => setDialog(undefined)}
    />
  ) : dialog?.kind === 'purge' ? (
    <ConfirmPanel
      title={PURGE_LABEL}
      question={`에이전트가 사라진 채팅 ${dialog.count}개를 지울까요?`}
      onConfirm={purgeDeletedAgents}
      onCancel={() => setDialog(undefined)}
    />
  ) : (
    <ConversationSidebar
      rows={rows}
      cursor={rowIndex}
      openKey={openKey}
      focused={focus === 'list'}
      height={bodyHeight}
      status={listStatus}
    />
  );

  const mainActive = focus === 'main' && !overlay && !dialog;
  const caption = shown
    ? `${conversationAgentLabel(shown)}${shown.tag ? ` · ${CONVERSATION_TAG_LABELS[shown.tag]}` : ''}`
    : selected?.workflowName;
  const main =
    view === 'start' ? (
      <StartScreen
        engine={props.engine}
        profile={props.session.profile}
        agents={agents}
        focused={mainActive}
        height={bodyHeight}
        nativeIme={nativeIme}
        hangulMode={hangulMode}
        onHangulModeChange={changeHangulMode}
        onCapture={setStartCapture}
        onAgentChange={setStartAgent}
        preselect={startPreselect}
        modelLabel={model.supported ? model.current?.label : undefined}
        onCreated={(agent) =>
          setAgents((current) =>
            current.some((item) => item.workflowId === agent.workflowId)
              ? current
              : [
                  {
                    id: 0,
                    workflowId: agent.workflowId,
                    workflowName: agent.workflowName,
                    nodeCount: 1,
                    isShared: false,
                    isDeployed: false,
                    isCompleted: true,
                    description: '',
                    username: props.session.username,
                    fullName: '',
                    createdAt: '',
                    updatedAt: '',
                  },
                  ...current,
                ],
          )
        }
        onStart={startChat}
      />
    ) : (
      <Box flexDirection="column" flexGrow={1}>
        <ChatPane
          title={shown ? conversationDisplayTitle(shown) : UNTITLED_CONVERSATION}
          caption={caption}
          agentName={selected?.workflowName ?? 'Agent'}
          model={model.supported ? model.current?.label : undefined}
          thinking={model.supported && model.thinking ? thinkingChipLabel(model.thinking) : undefined}
          messages={chat.messages}
          status={chat.status}
          scrollUp={scrollUp}
          onViewport={(lineCount, height) => {
            viewport.current = { lineCount, height };
          }}
        />
        {attachmentNotice ? <Text color="cyan">📎 {attachmentNotice}</Text> : null}
        {readOnly ? (
          // 지워진 에이전트의 대화: 지난 대화만 본다. 입력창이 없다.
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="yellow" wrap="truncate-end">
              {DELETED_AGENT_NOTICE}
            </Text>
          </Box>
        ) : (
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={(value) => void send(value)}
            focused={mainActive}
            disabled={chat.running || !selected}
            nativeIme={nativeIme}
            hangulMode={hangulMode}
            onHangulModeChange={changeHangulMode}
          />
        )}
      </Box>
    );

  // 좁은 터미널에서는 한 쪽만 보인다. 안 보이는 쪽도 그려 둔 채 숨긴다: 시작 화면에 적던
  // 이름과 첫 말이 목록을 잠깐 보는 사이 사라지면 안 된다.
  const showList = size.wide || focus === 'list' || !!dialog;
  const showMain = size.wide || (focus === 'main' && !dialog);
  const layout = (
    <Box height={bodyHeight}>
      <Box display={showList ? 'flex' : 'none'} flexShrink={0}>
        {sidebar}
      </Box>
      <Box display={showMain ? 'flex' : 'none'} flexGrow={1}>
        {main}
      </Box>
    </Box>
  );
  // 팔레트·기록·선택 창은 몸통 자리를 쓴다. 그 아래 화면도 숨긴 채 남겨 두어 돌아오면 그대로다.
  // (늘 같은 자리에 두어야 React 가 다시 만들지 않는다. 자리가 바뀌면 적던 것이 사라진다.)
  const body = (
    <Box flexDirection="column">
      {overlayBody}
      <Box display={overlayBody ? 'none' : 'flex'}>{layout}</Box>
    </Box>
  );

  const listHelp = drill
    ? `↑↓ 이동 · Enter 열기 · Esc·← ${BACK_LABEL} · r 이름 바꾸기 · d 지우기 · / 검색 · m 기록 관리`
    : '↑↓ 이동 · Enter 열기 · / 검색 · r 이름 바꾸기 · d 지우기 · m 기록 관리';
  // 채팅 기록 관리는 제 안내줄이 있다. 여기서는 그 화면에서도 듣는 키만 적는다.
  const footer = manager
    ? `${imeShortcut} 한/영 · Esc 닫기 · Ctrl+Q 종료`
    : focus === 'list'
      ? `${listHelp} · Ctrl+N 새 채팅 · Ctrl+K 명령 · Ctrl+H 기록 · Tab 대화 · Ctrl+P 프로필 · Ctrl+Q 종료`
      : `${imeShortcut} 한/영 · Ctrl+O 모델 · Ctrl+N 새 채팅 · Ctrl+K 명령 · Ctrl+H 기록 · Tab 목록 · PgUp/PgDn 스크롤 · /attach 경로 · /attachments · /detach · Ctrl+P 프로필 · Esc 취소 · Ctrl+Q 종료`;

  return (
    <Box flexDirection="column">
      <Header
        profile={props.session.profile}
        username={props.session.username}
        connected
      />
      {body}
      <Footer mode={nativeIme ? undefined : hangulMode ? '한' : 'EN'} text={footer} />
    </Box>
  );
}
