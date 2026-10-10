import { describeStreamError, formatErrorLine } from '@dex/protocol';
import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { DexService } from './dex-service';
import type {
  Agent,
  AgentListResult,
  AuthStatus,
  ChatCompleteNotification,
  ChatErrorNotification,
  ChatEvent,
  ChatAttachmentDescriptor,
  ChatEventNotification,
  ChatStartResult,
  Conversation,
  ConversationSnapshot,
  LocalToolBridgeStatus,
  LocalToolsConfig,
  LocalToolsStatus,
  ProfileSummary,
  RpcNotification,
  ToolEvent,
} from '@dex/rpc';
import { describeTool, historyTurnMessages, message, type ChatMessage } from './chat-messages';
import {
  CONVERSATION_PAGE_LIMIT,
  START_TEXT,
  applyFirstPage,
  conversationRows,
  conversationStub,
  createdAgent,
  historyPickItem,
  normalizeConversations,
  recentPickItem,
  searchPickItem,
  SEARCH_TEXT,
  prepareCreateOptions,
  purgeDeletedLabel,
  sanitizeCreateSettings,
  startAgentChoices,
  startComposerLock,
  startSendBlocked,
  touchAfterSend,
  type ConversationRow,
  type StartCreateOptions,
  type StartLock,
} from './conversation-view';
import {
  MODEL_PICKER_TEXT,
  THINKING_PICKER_TEXT,
  applyModelNotice,
  conversationDisplayTitle,
  conversationKey,
  conversationListChange,
  mergeConversationPage,
  orderedChoices,
  removeConversation,
  renameConversationInList,
  sameModel,
  selectedThinking,
  thinkingChipLabel,
  thinkingValueLabel,
  touchConversation,
  SEARCH_DELAY_MS,
  SEARCH_RECENT_COUNT,
  searchConversationList,
  type AgentCreateOptions,
  type ConversationModelState,
  type ConversationPage,
  type ConversationSearchPage,
  type ModelChoice,
  type ThinkingValue,
} from '@dex/protocol';

/** 창을 껐다 켠 뒤 되찾을 대화가 적히는 자리(globalState). */
const LAST_CONVERSATION_KEY = 'xgenDex.lastConversation';

/** 새 에이전트 이름을 적는 동안 기다렸다가 묻는 시간. 글자마다 묻지 않는다. */
const NAME_CHECK_DELAY_MS = 300;

/**
 * 화면. 로그인한 뒤의 첫 화면은 대화 목록(conversations)이다. [+ 새 채팅] 은 시작 화면(start)에서
 * 에이전트를 고르거나 새로 만들고 첫 말을 보낸다. 대화를 누르면 채팅(chat).
 */
type ViewScreen = 'loading' | 'setup' | 'login' | 'offline' | 'conversations' | 'start' | 'chat' | 'settings' | 'error';
/** 설정 화면에서 [이전] 으로 돌아갈 자리. */
type MainScreen = 'conversations' | 'start' | 'chat';

/** 시작 화면이 그릴 것. 입력 칸의 글은 웹뷰가 쥐고, 잠금·검사 결과만 여기서 정한다. */
interface StartViewState {
  /** 바뀌면 웹뷰가 칸을 비운다(새 시작 화면). */
  session: number;
  /** 처음 골라 둘 에이전트. 빈 글이면 새 에이전트. */
  agentId: string;
  /** 엔진이 에이전트를 만들 수 있는가(옛 dex-cli 는 없다). */
  canCreate: boolean;
  choices: Array<{ value: string; label: string }>;
  options?: StartCreateOptions;
  optionsLoading: boolean;
  /** 이름 칸 아래 글(겹치는 이름). */
  nameError?: string;
  lock: StartLock;
  busy: boolean;
  message?: { text: string; tone: 'error' | 'progress' };
}

/** 시작 화면의 상태. 이름은 겹치는지 묻기 위해서만 따라 적는다. */
interface StartForm {
  session: number;
  agentId: string;
  name: string;
  /** 마지막으로 답을 받은 이름 검사. */
  nameCheck?: { name: string; taken: boolean };
  busy: boolean;
  message?: { text: string; tone: 'error' | 'progress' };
}

interface ChatViewState {
  screen: ViewScreen;
  profiles: ProfileSummary[];
  auth?: AuthStatus;
  agents: Agent[];
  agent?: Agent;
  messages: ChatMessage[];
  running: boolean;
  refreshing: boolean;
  status?: string;
  error?: string;
  /** 대화 목록 한 줄씩(마지막으로 말한 순서). */
  conversations: ConversationRow[];
  conversationsLoading: boolean;
  conversationsLoadingMore: boolean;
  conversationsHasMore: boolean;
  conversationsError?: string;
  /** 이름 바꾸기·지우기·사라진 에이전트 대화 정리를 쓸 수 있는가(엔진의 conversationList). */
  conversationActions: boolean;
  /** 에이전트가 사라진 대화 수(첫 쪽이 알려 준다). */
  agentDeletedCount: number;
  /** 목록 머리 ⋯ 메뉴의 [에이전트가 사라진 채팅 제거 (N)]. 엔진이 모르면 없다(⋯ 도 없다). 0 이면 눌리지 않는다. */
  purgeLabel?: string;
  /** 열린 대화의 제목. 첫 말을 보내기 전이면 없다. */
  conversationTitle?: string;
  /** 에이전트가 사라진 대화: 지난 대화만 보이고 입력창이 없다. */
  readOnly: boolean;
  start: StartViewState;
  /** 열린 작업 영역 폴더 — 대화를 시작하면 그 대화의 작업 공간으로 연결된다. */
  workspaceFolders: string[];
  localTools?: LocalToolsStatus;
  localToolsSaving: boolean;
  localToolsMessage?: string;
  attachments: ChatAttachmentDescriptor[];
  /** 이 대화의 지금 모델 — 입력창 아래 칩. 없으면(옛 서버·Geny 아닌 에이전트) 칩도 없다. */
  model?: { label: string; locked: boolean; saving: boolean };
  /** 모델 칩 오른쪽 생각 칩 — 이름표·조절 가능 여부. */
  thinking?: { label: string; supported: boolean; locked: boolean; saving: boolean };
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private screen: ViewScreen = 'loading';
  private profiles: ProfileSummary[] = [];
  private auth: AuthStatus | undefined;
  private agents: Agent[] = [];
  private agentTotal = 0;
  private selectedAgent: Agent | undefined;
  private messages: ChatMessage[] = [];
  private interactionId: string | undefined;
  /**
   * 첫 말을 보내기 전의 새 대화가 쓸 번호. 모델을 먼저 고를 수 있어야 하고, 그 선택은
   * 대화 번호에 붙으므로 번호를 미리 정해 두고 첫 턴도 이 번호로 보낸다.
   */
  private draftInteractionId: string | undefined;
  /** 이 대화의 모델 — `modelKey`(에이전트:대화) 가 바뀔 때만 다시 읽는다. */
  private model: ConversationModelState | undefined;
  private modelKey = '';
  private modelSaving = false;
  private attachments: ChatAttachmentDescriptor[] = [];
  private uploadingAttachments = false;
  private streamId: string | undefined;
  /**
   * 이 확장이 아니라 **다른 곳**(웹·앱·CLI)에서 시작한 턴이 이 대화에서 돌고
   * 있는가. 서버 실행은 연결이 아니라 대화에 매여 있어서, 여기서 스트림을 쥐고
   * 있지 않아도 대화는 진행 중일 수 있다.
   */
  private remoteRunning = false;
  private remotePoll: ReturnType<typeof setInterval> | undefined;
  /** 마지막 대화 복원은 확장 활성화당 한 번 — refreshSession 은 여러 번 돈다. */
  private restoredLastConversation = false;
  private assistantMessageId: string | undefined;
  private status: string | undefined;
  /** 다른 곳에서 도는 턴의 진행분을 담은 말풍선 — 매번 덮어쓸 대상. */
  private remotePartialId: string | undefined;
  private error: string | undefined;
  /** 설정에서 [이전] 을 누르면 돌아갈 화면. */
  private returnScreen: MainScreen = 'conversations';
  /** 에이전트가 사라진 대화를 열었다: 기록만 보이고 보낼 수 없다. */
  private readOnly = false;
  /** 목록이나 대화 기록에서 연 대화. 목록에 없을 때 제목을 여기서 읽는다. */
  private openedConversation: Conversation | undefined;
  // ── 대화 목록 ──
  private conversations: Conversation[] = [];
  private conversationCursor: string | null = null;
  /** 받아 둔 쪽 수. 2 이상이면 첫 쪽을 다시 받을 때 뒤쪽을 지킨다. */
  private conversationPages = 0;
  private conversationsLoading = false;
  private conversationsLoadingMore = false;
  private conversationsError: string | undefined;
  private conversationsVersion = 0;
  private agentDeletedCount = 0;
  /** 이 창에서 방금 시작해 서버 목록에 아직 없는 대화. 첫 쪽을 다시 받아도 지우지 않는다. */
  private readonly localConversations = new Set<string>();
  /** 엔진이 대화 목록 쪽 나누기·이름 바꾸기·지우기를 아는가(옛 dex-cli 는 모른다). */
  private canPageConversations = false;
  /** 엔진이 에이전트를 만들 수 있는가. */
  private canCreateAgent = false;
  /** 엔진이 대화 목록 소켓(conversations/watch)을 열 수 있는가. 열면 다른 기기의 변화가 곧바로 보인다. */
  private canWatchConversationList = false;
  /** 엔진이 채팅 검색(history/search)을 아는가. 모르면 받아 둔 목록의 제목·이름으로 찾는다. */
  private canSearchConversations = false;
  /** 대화 목록 소식이 몰려올 때 첫 쪽을 한 번만 다시 읽도록 모은다. */
  private conversationHeadTimer: NodeJS.Timeout | undefined;
  // ── 시작 화면 ──
  private start: StartForm = { session: 0, agentId: '', name: '', busy: false };
  private createOptions: StartCreateOptions | undefined;
  private createOptionsLoading = false;
  private createOptionsError: string | undefined;
  private nameTimer: NodeJS.Timeout | undefined;
  private localTools: LocalToolsStatus | undefined;
  private localToolsSaving = false;
  private localToolsMessage: string | undefined;
  private refreshing = false;
  private refreshVersion = 0;
  private renderTimer: NodeJS.Timeout | undefined;
  private readonly toolMessages = new Map<string, string>();
  private readonly removeNotificationListener: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: DexService,
  ) {
    this.removeNotificationListener = service.rpc.onNotification((notification) => this.onNotification(notification));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: unknown) => this.onWebviewMessage(message), undefined, this.context.subscriptions);
    // 작업 영역 폴더를 더하거나 빼면 화면의 폴더 표시도 바로 따라간다. 다음 요청부터
    // 그 목록이 대화의 폴더로 실린다.
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.postState(), undefined, this.context.subscriptions);
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    this.postState();
    void this.refreshSession();
  }

  async refreshSession(): Promise<void> {
    const version = ++this.refreshVersion;
    const previousScreen = this.screen;
    this.refreshing = true;
    this.error = undefined;
    if (this.profiles.length === 0 && !this.auth) this.screen = 'loading';
    this.postState();

    try {
      const [profiles, localTools] = await Promise.all([
        this.service.request<ProfileSummary[]>('profile/list'),
        this.service.request<LocalToolsStatus>('localTools/status').catch((error: unknown) => {
          this.localToolsMessage = `로컬 도구 상태를 불러오지 못했습니다: ${errorMessage(error)}`;
          return undefined;
        }),
      ]);
      if (version !== this.refreshVersion) return;
      this.profiles = profiles;
      if (localTools) {
        this.localTools = localTools;
        this.localToolsMessage = undefined;
      }
      if (profiles.length === 0) {
        this.auth = undefined;
        this.agents = [];
        this.agentTotal = 0;
        this.selectedAgent = undefined;
        this.resetConversationList();
        this.screen = previousScreen === 'settings' ? 'settings' : 'setup';
        return;
      }

      const configured = this.service.profileParams().profile;
      const profile = profiles.find((item) => item.name === configured) ?? profiles.find((item) => item.current) ?? profiles[0];
      if (!profile) {
        this.screen = 'setup';
        return;
      }
      const auth = await this.service.request<AuthStatus>('auth/status', { profile: profile.name });
      if (version !== this.refreshVersion) return;
      this.auth = auth;
      if (!auth.authenticated) {
        this.agents = [];
        this.agentTotal = 0;
        this.selectedAgent = undefined;
        this.resetConversationList();
        // 로그아웃했다: 대화 목록 소켓도 닫는다(토큰 없이 다시 붙으려고 애쓰지 않게).
        if (this.canWatchConversationList) void this.service.request('conversations/unwatch', {}).catch(() => undefined);
        this.screen = previousScreen === 'settings' ? 'settings' : auth.reason === 'network' ? 'offline' : 'login';
        return;
      }

      await this.updateCapabilities();
      if (version !== this.refreshVersion) return;
      this.watchConversationList();
      // 에이전트 목록과 대화 목록 첫 쪽을 함께 받는다. 대화 목록을 못 받아도 화면은 연다(목록 자리에 오류).
      const [result] = await Promise.all([
        this.service.request<AgentListResult>('agents/list', {
          profile: auth.profile,
          page: 1,
          pageSize: 100,
        }),
        this.loadConversations('replace'),
      ]);
      if (version !== this.refreshVersion) return;
      this.agents = result.items;
      this.agentTotal = result.pagination.totalCount;
      if (this.selectedAgent) {
        const updated = this.agents.find((agent) => agent.workflowId === this.selectedAgent?.workflowId);
        if (updated) this.selectedAgent = updated;
        // 목록을 끝까지 받았는데도 없으면 에이전트가 사라졌다. 지워진 에이전트의 대화를
        // 일부러 열어 둔 것(readOnly)은 그대로 둔다.
        else if (!this.readOnly && this.agents.length >= this.agentTotal) {
          this.selectedAgent = undefined;
          this.messages = [];
          this.interactionId = undefined;
          this.draftInteractionId = undefined;
          this.openedConversation = undefined;
        }
      }
      // 에이전트 목록까지 온 뒤에 되살린다 — 목록이 있어야 자리표시가 아닌
      // 진짜 에이전트로 붙는다. 화면 결정보다 **먼저** 와야 복원한 대화가
      // 곧바로 보인다.
      const restored = await this.restoreLastConversation();
      if (version !== this.refreshVersion) return;
      if (previousScreen === 'settings') this.screen = 'settings';
      else if (previousScreen === 'start') {
        this.screen = 'start';
        void this.ensureCreateOptions();
      } else if (this.selectedAgent && (restored || previousScreen === 'chat')) this.screen = 'chat';
      else this.screen = 'conversations';
    } catch (error) {
      if (version !== this.refreshVersion) return;
      this.error = errorMessage(error);
      this.screen = previousScreen === 'settings' ? 'settings' : 'error';
    } finally {
      if (version === this.refreshVersion) {
        this.refreshing = false;
        this.postState();
      }
    }
  }

  /** 대화 목록: 로그인한 뒤의 첫 화면. 돌아올 때마다 첫 쪽을 다시 받는다(다른 곳에서 말한 대화가 위로 온다). */
  async showConversations(): Promise<void> {
    if (!this.auth?.authenticated) await this.refreshSession();
    if (!this.auth?.authenticated) return;
    this.screen = 'conversations';
    this.postState();
    this.view?.show(true);
    void this.loadConversations('head');
  }

  /**
   * 시작 화면: 에이전트를 고르거나(처음 값은 "새 에이전트로 시작") 새로 만들고 첫 말을 보낸다.
   * `agentId` 를 주면 그 에이전트를 골라 둔 채 연다.
   */
  async showStart(agentId?: string): Promise<void> {
    if (!this.auth?.authenticated) await this.refreshSession();
    if (!this.auth?.authenticated) return;
    // 만드는 중이면 칸을 비우지 않는다. 다 만들면 그 대화가 열린다.
    if (!this.start.busy) {
      const known = agentId && this.agents.some((agent) => agent.workflowId === agentId) ? agentId : '';
      this.resetStart(known);
    }
    this.screen = 'start';
    void this.ensureCreateOptions();
    this.postState();
    this.view?.show(true);
  }

  /** 다른 곳(명령·트리 등)에서 에이전트를 골라 왔다: 그 에이전트를 골라 둔 시작 화면. */
  async selectAgent(agent: Agent): Promise<void> {
    if (!this.agents.some((item) => item.workflowId === agent.workflowId)) this.agents = [agent, ...this.agents];
    await this.showStart(agent.workflowId);
    await vscode.commands.executeCommand('xgenDex.chat.focus');
  }

  /** Agent 검색: VS Code 빠른 선택으로 골라 시작 화면에 골라 둔다. */
  async pickAgent(): Promise<void> {
    if (!this.auth?.authenticated) await this.refreshSession();
    if (!this.auth?.authenticated) return;
    if (this.agents.length === 0) {
      void vscode.window.showInformationMessage('사용할 수 있는 Agent가 없습니다.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.agents.map((agent) => ({
        label: agent.workflowName,
        description: agent.isShared ? '공유' : '개인',
        detail: agent.description?.trim() || undefined,
        agent,
      })),
      { title: 'XGEN Dex Agent 검색', placeHolder: 'Agent 이름 또는 설명', matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) return;
    await this.showStart(picked.agent.workflowId);
  }

  async showSettings(): Promise<void> {
    if (this.screen === 'conversations' || this.screen === 'start' || this.screen === 'chat') this.returnScreen = this.screen;
    this.screen = 'settings';
    this.postState();
    this.view?.show(true);
  }

  async connectionChanged(): Promise<void> {
    await this.clearConversation();
    this.selectedAgent = undefined;
    this.auth = undefined;
    this.agents = [];
    this.agentTotal = 0;
    this.resetConversationList();
    this.createOptions = undefined;
    this.createOptionsError = undefined;
    this.resetStart();
    this.screen = 'loading';
    await this.refreshSession();
  }

  /** [+ 새 채팅]: 시작 화면. 지금 대화는 목록에 남고, 도는 답변도 서버에서 계속된다. */
  async newChat(): Promise<void> {
    await this.showStart();
  }

  /**
   * 사람이 누른 [응답 중지] — 스트림에서 손을 떼는 것으로는 부족하다.
   *
   * 서버는 더 이상 연결 끊김을 취소로 읽지 않는다(그렇게 읽던 시절엔 화면
   * 잠금·기기 이동이 실행 중단이었다). 그래서 `chat/cancel` 만 부르면 버려진
   * 턴이 끝까지 돌아 대화에 답을 적는다. 정지는 **대화**를 향해야 한다 —
   * 그래서 다른 기기에서 시작한 턴(remoteRunning)도 여기서 멈출 수 있다.
   */
  async cancel(): Promise<void> {
    if (!this.streamId && !this.remoteRunning) return;
    this.status = '응답을 중지하는 중...';
    this.postState();
    try {
      const result = await this.service.request<{ stopped: boolean; reason?: string }>('chat/stop', {
        ...this.activeProfileParams(),
        ...(this.streamId ? { streamId: this.streamId } : {}),
        ...(this.interactionId ? { interactionId: this.interactionId } : {}),
      });
      if (!result.stopped && result.reason !== 'not_running') {
        this.status = '중단을 확인하지 못했습니다. 실행 상태를 확인한 뒤 다시 시도해 주세요.';
        this.postState();
        return;
      }
    } catch (error) {
      this.status = `중지하지 못했습니다: ${errorMessage(error)}`;
      this.postState();
      return;
    }
    if (this.remoteRunning) {
      // 원격 턴은 이 확장이 스트림을 쥐고 있지 않아 chat/complete 가 오지 않는다.
      // 폴링이 다음 회차에 히스토리를 다시 읽어 마지막 상태를 그린다.
      this.status = '중지를 요청했습니다.';
      this.postState();
    }
  }

  /**
   * 채팅 검색(2026-10-10): 목록 머리의 돋보기. VS Code 빠른 선택 창이 뜬다. 비면 최근 채팅, 적으면 잠깐 뒤
   * 엔진(history/search)이 제목·에이전트 이름·대화 내용으로 찾는다. 고르면 그 대화가 열린다.
   */
  async searchConversations(): Promise<void> {
    type Item = vscode.QuickPickItem & { conversation?: Conversation };
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = SEARCH_TEXT.title;
    pick.placeholder = SEARCH_TEXT.placeholder;
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    const note = (label: string): Item => ({ label, alwaysShow: true });
    const recent = (): Item[] => {
      const list = this.conversations.slice(0, SEARCH_RECENT_COUNT);
      return list.length
        ? [
            { label: SEARCH_TEXT.recent, kind: vscode.QuickPickItemKind.Separator },
            ...list.map((conversation) => ({ ...recentPickItem(conversation), conversation })),
          ]
        : [];
    };
    pick.items = recent();
    let seq = 0;
    let timer: NodeJS.Timeout | undefined;
    pick.onDidChangeValue((value) => {
      if (timer) clearTimeout(timer);
      const mine = ++seq;
      const query = value.trim();
      if (!query) {
        pick.busy = false;
        pick.items = recent();
        return;
      }
      pick.busy = true;
      timer = setTimeout(() => {
        const request: Promise<ConversationSearchPage> = this.canSearchConversations
          ? this.service.request<ConversationSearchPage>('history/search', { ...this.activeProfileParams(), query, limit: 50 })
          : Promise.resolve(searchConversationList(this.conversations, query, 50));
        request
          .then((page) => {
            if (mine !== seq) return;
            const items: Item[] = page.hits.map((hit) => ({ ...searchPickItem(hit), conversation: hit.conversation }));
            if (!items.length) items.push(note(SEARCH_TEXT.empty));
            else if (!page.contentSearched) items.push(note(SEARCH_TEXT.titleOnly));
            else if (page.hasMore) items.push(note(SEARCH_TEXT.more));
            pick.items = items;
          })
          .catch((error: unknown) => {
            if (mine === seq) pick.items = [note(`${SEARCH_TEXT.failed}: ${errorMessage(error)}`)];
          })
          .finally(() => {
            if (mine === seq) pick.busy = false;
          });
      }, SEARCH_DELAY_MS);
    });
    pick.onDidAccept(() => {
      const conversation = pick.selectedItems[0]?.conversation;
      if (!conversation) return;
      pick.hide();
      void this.openConversation(conversation);
    });
    pick.onDidHide(() => {
      if (timer) clearTimeout(timer);
      seq += 1;
      pick.dispose();
    });
    pick.show();
  }

  /** 대화 기록(빠른 선택): 제목으로 찾고, 옆에 에이전트 · 꼬리표 · 시각. */
  async openHistory(): Promise<void> {
    try {
      const conversations = normalizeConversations(
        await this.service.request<unknown>('history/conversations', this.activeProfileParams()),
      );
      if (conversations.length === 0) {
        await vscode.window.showInformationMessage('저장된 XGEN Dex 대화가 없습니다.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        conversations.map((conversation) => ({
          ...historyPickItem(conversation, (iso) => new Date(iso).toLocaleString()),
          conversation,
        })),
        { placeHolder: '불러올 대화를 선택하세요', matchOnDescription: true },
      );
      if (!picked) return;
      await this.openConversation(picked.conversation);
    } catch (error) {
      await vscode.window.showErrorMessage(`대화 기록을 불러오지 못했습니다: ${errorMessage(error)}`);
    }
  }

  /**
   * 대화 하나를 연다(목록·대화 기록). 에이전트가 사라진 대화는 기록만 보이고 입력창이 없다.
   * 지금 열려 있는 대화면 다시 읽지 않고 채팅으로 돌아간다(도는 답변도 그대로 이어진다).
   */
  async openConversation(conversation: Conversation): Promise<void> {
    if (this.isOpenConversation(conversation.workflowId, conversation.interactionId)) {
      this.screen = 'chat';
      this.postState();
      return;
    }
    try {
      // 지난 턴과 함께 **지금 도는 턴이 있는가**도 읽는다 — 웹이나 앱에서
      // 시작한 턴이 아직 돌고 있을 수 있다. 이걸 모르면 끝난 대화처럼 보이고,
      // 그 위에 새 턴을 보내 같은 대화에서 두 실행이 겹친다.
      const snapshot = await this.service.request<ConversationSnapshot>('history/snapshot', {
        ...this.activeProfileParams(),
        workflowId: conversation.workflowId,
        workflowName: conversation.workflowName,
        interactionId: conversation.interactionId,
      });
      const turns = snapshot.turns ?? [];
      await this.clearConversation();
      this.selectedAgent = this.agents.find((agent) => agent.workflowId === conversation.workflowId) ?? agentFromConversation(conversation);
      this.readOnly = conversation.agentDeleted === true;
      this.openedConversation = conversation;
      this.interactionId = conversation.interactionId;
      this.attachments = [];
      this.syncConversationWatch();
      this.messages = historyTurnMessages(turns, conversation.workflowName);
      this.status = snapshot.running
        ? '다른 곳에서 시작한 응답이 진행 중입니다.'
        : `${turns.length}개의 이전 대화를 불러왔습니다.`;
      this.screen = 'chat';
      if (snapshot.running) this.watchRemoteRun();
      this.postState();
      await vscode.commands.executeCommand('xgenDex.chat.focus');
    } catch (error) {
      await vscode.window.showErrorMessage(`대화 기록을 불러오지 못했습니다: ${errorMessage(error)}`);
    }
  }

  dispose(): void {
    this.stopWatchingRemoteRun();
    this.removeNotificationListener();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.nameTimer) clearTimeout(this.nameTimer);
  }

  private async clearConversation(): Promise<void> {
    this.stopWatchingRemoteRun();
    const activeStream = this.streamId;
    this.streamId = undefined;
    this.assistantMessageId = undefined;
    this.interactionId = undefined;
    this.draftInteractionId = undefined;
    this.readOnly = false;
    this.openedConversation = undefined;
    this.attachments = [];
    this.messages = [];
    this.toolMessages.clear();
    this.status = undefined;
    // 대화를 비웠으니 구독도 놓고 기억도 지운다 — 안 그러면 다음 실행에서
    // 사용자가 이미 떠난 대화가 되살아난다.
    this.syncConversationWatch();
    await this.setRunning(false);
    if (activeStream) await this.service.request('chat/cancel', { streamId: activeStream }).catch(() => undefined);
  }

  /** 열린 대화를 닫고(지웠다) 채팅 화면이었으면 목록으로. */
  private async leaveConversation(): Promise<void> {
    await this.clearConversation();
    this.selectedAgent = undefined;
    if (this.screen === 'chat') this.screen = 'conversations';
  }

  private isOpenConversation(workflowId: string, interactionId: string): boolean {
    return this.selectedAgent?.workflowId === workflowId && this.interactionId === interactionId;
  }

  // ── 대화 목록 ────────────────────────────────────────────────────

  private async updateCapabilities(): Promise<void> {
    const capabilities = await this.service.capabilities().catch(() => undefined);
    const canCreate = capabilities?.agentCreate === true;
    if (canCreate !== this.canCreateAgent) {
      this.createOptions = undefined;
      this.createOptionsError = undefined;
    }
    this.canPageConversations = capabilities?.conversationList === true;
    this.canCreateAgent = canCreate;
    this.canWatchConversationList = capabilities?.conversationListWatch === true;
    this.canSearchConversations = capabilities?.conversationSearch === true;
  }

  /** 대화 목록 소켓을 연다(로그인한 프로필로). 옛 엔진이면 아무것도 하지 않는다. */
  private watchConversationList(): void {
    if (!this.canWatchConversationList || !this.auth?.authenticated) return;
    void this.service.request('conversations/watch', this.activeProfileParams()).catch(() => undefined);
  }

  private scheduleConversationHead(): void {
    if (this.conversationHeadTimer) clearTimeout(this.conversationHeadTimer);
    this.conversationHeadTimer = setTimeout(() => {
      this.conversationHeadTimer = undefined;
      void this.loadConversations('head');
    }, 400);
  }

  /**
   * 대화 목록 소식(conversations/changed) → 목록이 할 일. 규칙은 데스크톱과 같다(@dex/protocol conversationListChange):
   * 아는 대화에서 방금 말했으면 맨 위로, 모르는 대화면 첫 쪽을 다시 읽고(숨길 대화인지는 서버만 안다),
   * 이름이 바뀌었으면 제목만, 지워졌으면 줄을 뺀다.
   */
  private applyConversationListEvent(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const e = params as { kind?: string; interactionId?: string; workflowId?: string; running?: boolean; data?: Record<string, unknown> };
    const change = conversationListChange(String(e.kind ?? ''), {
      ...(e.data ?? {}),
      interaction_id: e.interactionId ?? '',
      workflow_id: e.workflowId ?? '',
      ...(typeof e.running === 'boolean' ? { running: e.running } : {}),
    });
    switch (change.type) {
      case 'touched': {
        const conv = change.conversation;
        if (conv && this.conversations.some((c) => conversationKey(c) === conversationKey(conv))) {
          this.conversations = touchConversation(this.conversations, conv).list;
          this.postState();
        } else {
          this.scheduleConversationHead();
        }
        return;
      }
      case 'renamed':
        this.conversations = renameConversationInList(this.conversations, change.workflowId, change.interactionId, change.title, change.customTitle);
        if (this.openedConversation && conversationKey(this.openedConversation) === conversationKey(change)) {
          this.openedConversation = { ...this.openedConversation, title: change.title, customTitle: change.customTitle };
        }
        this.postState();
        return;
      case 'removed':
        this.conversations = removeConversation(this.conversations, change.workflowId, change.interactionId);
        this.postState();
        // 사라진 에이전트 대화 수도 함께 맞춘다.
        this.scheduleConversationHead();
        return;
      case 'reload':
        this.scheduleConversationHead();
        return;
      default:
    }
  }

  private resetConversationList(): void {
    this.conversationsVersion += 1;
    this.conversations = [];
    this.conversationCursor = null;
    this.conversationPages = 0;
    this.conversationsLoading = false;
    this.conversationsLoadingMore = false;
    this.conversationsError = undefined;
    this.agentDeletedCount = 0;
    this.localConversations.clear();
  }

  private findConversation(workflowId: string, interactionId: string): Conversation | undefined {
    const key = conversationKey({ workflowId, interactionId });
    const listed = this.conversations.find((c) => conversationKey(c) === key);
    if (listed) return listed;
    return this.openedConversation && conversationKey(this.openedConversation) === key ? this.openedConversation : undefined;
  }

  /**
   * 대화 목록을 받는다.
   * - `replace`: 처음부터(로그인·새로 고침·정리 뒤).
   * - `head`: 첫 쪽만 다시(목록으로 돌아올 때·답변이 끝났을 때). 받아 둔 뒤쪽은 지킨다.
   * - `more`: 다음 쪽(더 보기·끝까지 내렸을 때).
   * 옛 dex-cli 는 쪽 나누기가 없어 history/conversations 로 전부 받는다(더 보기 없음).
   */
  private async loadConversations(mode: 'replace' | 'head' | 'more'): Promise<void> {
    if (!this.auth?.authenticated) return;
    const params = this.activeProfileParams();
    if (mode === 'more') {
      const cursor = this.conversationCursor;
      if (!this.canPageConversations || !cursor || this.conversationsLoadingMore || this.conversationsLoading) return;
      const version = this.conversationsVersion;
      this.conversationsLoadingMore = true;
      this.postState();
      try {
        const page = await this.service.request<ConversationPage>('history/conversationPage', {
          ...params,
          limit: CONVERSATION_PAGE_LIMIT,
          cursor,
        });
        if (version !== this.conversationsVersion) return;
        this.conversations = mergeConversationPage(this.conversations, normalizeConversations(page.conversations), 'append');
        this.conversationCursor = page.nextCursor ?? null;
        this.conversationPages += 1;
        this.conversationsError = undefined;
      } catch (error) {
        if (version === this.conversationsVersion) this.conversationsError = errorMessage(error);
      } finally {
        this.conversationsLoadingMore = false;
        this.postState();
      }
      return;
    }

    const version = ++this.conversationsVersion;
    this.conversationsLoading = true;
    this.postState();
    try {
      let list: Conversation[];
      if (this.canPageConversations) {
        const page = await this.service.request<ConversationPage>('history/conversationPage', {
          ...params,
          limit: CONVERSATION_PAGE_LIMIT,
        });
        if (version !== this.conversationsVersion) return;
        list = normalizeConversations(page.conversations);
        const pagesLoaded = mode === 'head' ? this.conversationPages : 1;
        this.conversations = applyFirstPage(this.conversations, list, { pagesLoaded, localKeys: this.localConversations });
        if (pagesLoaded <= 1) {
          this.conversationCursor = page.nextCursor ?? null;
          this.conversationPages = 1;
        }
        this.agentDeletedCount =
          typeof page.agentDeletedCount === 'number'
            ? page.agentDeletedCount
            : this.conversations.filter((c) => c.agentDeleted).length;
      } else {
        list = normalizeConversations(
          await this.service.request<unknown>('history/conversations', params),
        );
        if (version !== this.conversationsVersion) return;
        this.conversations = applyFirstPage(this.conversations, list, { pagesLoaded: 1, localKeys: this.localConversations });
        this.conversationCursor = null;
        this.conversationPages = 1;
        this.agentDeletedCount = list.filter((c) => c.agentDeleted).length;
      }
      // 서버 목록에 나타난 대화는 더 이상 이 창만 아는 대화가 아니다.
      for (const c of list) this.localConversations.delete(conversationKey(c));
      this.conversationsError = undefined;
    } catch (error) {
      if (version === this.conversationsVersion) this.conversationsError = errorMessage(error);
    } finally {
      if (version === this.conversationsVersion) {
        this.conversationsLoading = false;
        this.postState();
      }
    }
  }

  private async openConversationByKey(workflowId: string, interactionId: string): Promise<void> {
    const conversation = this.findConversation(workflowId, interactionId);
    if (conversation) await this.openConversation(conversation);
  }

  /** 이름 바꾸기. 비우면 첫 메시지 제목으로 돌아간다. 목록 순서는 그대로다. */
  private async renameConversation(workflowId: string, interactionId: string): Promise<void> {
    const conversation = this.findConversation(workflowId, interactionId);
    if (!conversation || !this.canPageConversations) return;
    const value = await vscode.window.showInputBox({
      title: '대화 이름 바꾸기',
      value: conversation.title,
      valueSelection: [0, conversation.title.length],
    });
    if (value === undefined) return;
    try {
      const result = await this.service.request<{ title: string; customTitle: boolean }>('history/rename', {
        ...this.activeProfileParams(),
        workflowId,
        interactionId,
        title: value.trim(),
      });
      this.conversations = renameConversationInList(this.conversations, workflowId, interactionId, result.title, result.customTitle);
      if (this.openedConversation && conversationKey(this.openedConversation) === conversationKey({ workflowId, interactionId })) {
        this.openedConversation = { ...this.openedConversation, title: result.title, customTitle: result.customTitle };
      }
      this.postState();
      // 붙인 이름을 지웠는데 제목이 비어 왔으면 서버가 정한 첫 메시지 제목을 다시 받는다.
      if (!result.title.trim()) void this.loadConversations('head');
    } catch (error) {
      void vscode.window.showErrorMessage(`대화 이름을 바꾸지 못했습니다: ${errorMessage(error)}`);
    }
  }

  private async deleteConversation(workflowId: string, interactionId: string): Promise<void> {
    const conversation = this.findConversation(workflowId, interactionId);
    if (!conversation || !this.canPageConversations) return;
    const choice = await vscode.window.showWarningMessage(
      '이 대화를 지울까요?',
      { modal: true, detail: conversationDisplayTitle(conversation) },
      '지우기',
    );
    if (choice !== '지우기') return;
    try {
      await this.service.request('history/delete', {
        ...this.activeProfileParams(),
        workflowId,
        interactionId,
        ...(conversation.workflowName ? { workflowName: conversation.workflowName } : {}),
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`대화를 지우지 못했습니다: ${errorMessage(error)}`);
      return;
    }
    this.conversations = removeConversation(this.conversations, workflowId, interactionId);
    this.localConversations.delete(conversationKey(conversation));
    if (conversation.agentDeleted && this.agentDeletedCount > 0) this.agentDeletedCount -= 1;
    if (this.isOpenConversation(workflowId, interactionId)) await this.leaveConversation();
    this.postState();
  }

  /** 에이전트가 사라진 대화를 한 번에 지운다(확인 뒤). */
  private async purgeDeletedAgents(): Promise<void> {
    const count = this.agentDeletedCount;
    if (!this.canPageConversations || count <= 0) return;
    const choice = await vscode.window.showWarningMessage(
      `에이전트가 사라진 채팅 ${count}개를 지울까요?`,
      { modal: true },
      '제거',
    );
    if (choice !== '제거') return;
    try {
      await this.service.request<{ deleted: number }>('history/purgeDeletedAgents', this.activeProfileParams());
    } catch (error) {
      void vscode.window.showErrorMessage(`에이전트가 사라진 채팅을 지우지 못했습니다: ${errorMessage(error)}`);
      return;
    }
    const openWasDeleted = this.readOnly && !!this.interactionId;
    this.conversations = this.conversations.filter((c) => !c.agentDeleted);
    this.agentDeletedCount = 0;
    if (openWasDeleted) await this.leaveConversation();
    this.postState();
    await this.loadConversations('replace');
  }

  /** 방금 보낸 대화를 목록 맨 위로(목록에 없던 새 대화면 첫 말을 제목으로 한 줄을 만든다). */
  private noteSent(agent: Agent, interactionId: string, text: string): void {
    const touched = touchAfterSend(this.conversations, {
      workflowId: agent.workflowId,
      workflowName: agent.workflowName,
      interactionId,
      text,
      now: new Date().toISOString(),
    });
    this.conversations = touched.list;
    if (touched.created) this.localConversations.add(conversationKey({ workflowId: agent.workflowId, interactionId }));
  }

  // ── 시작 화면 ────────────────────────────────────────────────────

  private resetStart(agentId = ''): void {
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = undefined;
    this.start = { session: this.start.session + 1, agentId, name: '', busy: false };
  }

  private startLock(): StartLock {
    return startComposerLock({
      canCreate: this.canCreateAgent,
      agentId: this.start.agentId,
      agentExists: this.agents.some((agent) => agent.workflowId === this.start.agentId),
      name: this.start.name,
      nameCheck: this.start.nameCheck,
      optionsReady: !!this.createOptions,
      optionsFailed: !!this.createOptionsError,
      busy: this.start.busy,
    });
  }

  private startView(): StartViewState {
    const creating = !this.start.agentId && this.canCreateAgent;
    const lock = this.startLock();
    const optionsFailed =
      creating && this.createOptionsError
        ? { text: `${START_TEXT.optionsFailed} ${this.createOptionsError}`, tone: 'error' as const }
        : undefined;
    return {
      session: this.start.session,
      agentId: this.start.agentId,
      canCreate: this.canCreateAgent,
      choices: startAgentChoices(this.agents, this.canCreateAgent),
      options: this.createOptions,
      optionsLoading: this.createOptionsLoading,
      nameError: creating && lock.reason === 'taken' ? START_TEXT.nameTaken : undefined,
      lock,
      busy: this.start.busy,
      message: this.start.message ?? optionsFailed,
    };
  }

  /** 새 에이전트의 제공사·모델·세부 설정(서버가 노드에서 읽어 준다). 한 번 받으면 프로필이 바뀔 때까지 쓴다. */
  private async ensureCreateOptions(): Promise<void> {
    if (!this.canCreateAgent || this.createOptions || this.createOptionsLoading) return;
    const profile = this.auth?.profile;
    this.createOptionsLoading = true;
    this.createOptionsError = undefined;
    this.postState();
    try {
      const options = await this.service.request<AgentCreateOptions>('agents/createOptions', this.activeProfileParams());
      if (profile === this.auth?.profile) this.createOptions = prepareCreateOptions(options);
    } catch (error) {
      if (profile === this.auth?.profile) this.createOptionsError = errorMessage(error);
    } finally {
      this.createOptionsLoading = false;
      this.postState();
    }
  }

  private onStartAgent(agentId: string): void {
    this.start.agentId = this.agents.some((agent) => agent.workflowId === agentId) ? agentId : '';
    if (this.start.message?.tone === 'error') this.start.message = undefined;
    if (!this.start.agentId) void this.ensureCreateOptions();
    this.postState();
  }

  /** 이름을 적는 중. 잠깐 멈추면 그 이름이 겹치는지 묻는다. 잠금이 바뀔 때만 화면을 다시 그린다. */
  private onStartName(name: string): void {
    const lockKey = (): string => JSON.stringify([this.startLock(), this.start.message]);
    const before = lockKey();
    this.start.name = name;
    if (this.start.message?.tone === 'error') this.start.message = undefined;
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = undefined;
    const trimmed = name.trim();
    if (trimmed && this.canCreateAgent && this.start.nameCheck?.name !== trimmed) {
      this.nameTimer = setTimeout(() => {
        this.nameTimer = undefined;
        void this.checkStartName(trimmed);
      }, NAME_CHECK_DELAY_MS);
    }
    if (lockKey() !== before) this.postState();
  }

  /** 이 이름이 겹치는가. 묻지 못했으면 undefined(겹치지 않는 것으로 두고, 만들기 직전에 한 번 더 묻는다). */
  private async checkStartName(name: string): Promise<boolean | undefined> {
    const session = this.start.session;
    let taken: boolean | undefined;
    try {
      const result = await this.service.request<{ taken: boolean }>('agents/nameTaken', { ...this.activeProfileParams(), name });
      taken = result.taken === true;
    } catch {
      taken = undefined;
    }
    // 그사이 이름이 바뀌었으면 이 답은 버린다. 늦게 온 옛 답이 새 이름의 검사를 덮지 않게.
    if (session !== this.start.session || this.start.name.trim() !== name) return taken;
    this.start.nameCheck = { name, taken: taken === true };
    this.postState();
    return taken;
  }

  /**
   * 시작 화면에서 보내기. 잠겨 있으면 그 까닭을 보인다.
   * - 있는 에이전트: 그 에이전트와 새 대화를 열고 보낸다.
   * - 새 에이전트: 이름을 한 번 더 묻고 만든 뒤, 그 에이전트와 새 대화를 열고 보낸다.
   */
  private async startSend(raw: Record<string, unknown>): Promise<void> {
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (this.start.busy || this.screen !== 'start') return;
    if (typeof raw.agentId === 'string') {
      const agentId = raw.agentId;
      this.start.agentId = this.agents.some((agent) => agent.workflowId === agentId) ? agentId : '';
    }
    if (typeof raw.name === 'string') this.start.name = raw.name;
    const lock = this.startLock();
    if (startSendBlocked(lock)) {
      // 이름이 겹치면 이름 칸 아래 글이 이미 말하고 있다.
      this.start.message = lock.reason === 'taken' ? undefined : { text: lock.message ?? '', tone: 'error' };
      this.postState();
      return;
    }
    if (!text) return;
    const session = this.start.session;
    let agent = this.start.agentId ? this.agents.find((item) => item.workflowId === this.start.agentId) : undefined;
    if (!agent) {
      agent = await this.createStartAgent(raw);
      if (!agent) return;
      // 만드는 사이 다른 화면으로 옮겼으면 그 화면을 빼앗지 않는다. 에이전트는 목록에 남는다.
      if (session !== this.start.session || this.screen !== 'start') return;
    }
    await this.clearConversation();
    this.selectedAgent = agent;
    this.screen = 'chat';
    this.resetStart();
    await this.send(text);
  }

  private async createStartAgent(raw: Record<string, unknown>): Promise<Agent | undefined> {
    const options = this.createOptions;
    const name = this.start.name.trim();
    if (!options || !name) return undefined;
    const provider =
      options.providers.find((item) => item.value === raw.provider) ??
      options.providers.find((item) => item.value === options.defaultProvider);
    if (!provider) {
      this.start.message = { text: START_TEXT.optionsFailed, tone: 'error' };
      this.postState();
      return undefined;
    }
    const model =
      typeof raw.model === 'string' && provider.models.some((item) => item.value === raw.model) ? raw.model : provider.defaultModel;
    const settings = sanitizeCreateSettings(options.settings, raw.settings);
    this.start.busy = true;
    this.start.message = { text: START_TEXT.checkingName, tone: 'progress' };
    this.postState();
    try {
      // 적는 동안 물었더라도 만들기 직전에 한 번 더 묻는다. 그사이 같은 이름이 생겼을 수 있다.
      if ((await this.checkStartName(name)) === true) {
        this.start.message = undefined;
        return undefined;
      }
      this.start.message = { text: START_TEXT.creating, tone: 'progress' };
      this.postState();
      const created = await this.service.request<{ workflowId: string; workflowName: string }>('agents/create', {
        ...this.activeProfileParams(),
        name,
        provider: provider.value,
        ...(model ? { model } : {}),
        ...(settings ? { settings } : {}),
      });
      if (!created?.workflowId) throw new Error('서버가 에이전트 번호를 돌려주지 않았습니다.');
      const agent = createdAgent(
        { workflowId: created.workflowId, workflowName: created.workflowName || name },
        new Date().toISOString(),
      );
      this.agents = [agent, ...this.agents.filter((item) => item.workflowId !== agent.workflowId)];
      this.agentTotal += 1;
      this.start.message = undefined;
      return agent;
    } catch (error) {
      this.start.message = { text: `${START_TEXT.createFailed} ${errorMessage(error)}`, tone: 'error' };
      return undefined;
    } finally {
      this.start.busy = false;
      this.postState();
    }
  }

  private async send(input: string): Promise<void> {
    const text = input.trim();
    if ((!text && this.attachments.length === 0) || !this.selectedAgent || this.streamId || this.uploadingAttachments || this.readOnly) {
      return;
    }
    const agent = this.selectedAgent;
    const streamId = randomUUID();
    this.streamId = streamId;
    this.status = '응답을 기다리는 중...';
    const attachments = [...this.attachments];
    this.attachments = [];
    this.messages.push(message('user', '나', text || `첨부 파일 ${attachments.length}개`));
    const assistant = message('assistant', agent.workflowName, '');
    this.messages.push(assistant);
    this.assistantMessageId = assistant.id;
    this.toolMessages.clear();
    await this.setRunning(true);
    this.postState();

    try {
      const started = await this.service.request<ChatStartResult>('chat/start', {
        ...this.activeProfileParams(),
        streamId,
        workflowId: agent.workflowId,
        workflowName: agent.workflowName,
        // 새 대화면 미리 정해 둔 번호 — 먼저 고른 모델이 첫 턴부터 붙는다.
        ...(this.modelTarget() ? { interactionId: this.modelTarget() } : {}),
        input: text,
        attachments,
        // 열린 작업 영역 폴더가 이 대화의 작업 공간이다. 에이전트의 파일·터미널
        // 도구는 이 폴더 안에서만 돈다(폴더를 열지 않았으면 쓰지 않는다).
        localFolders: this.workspaceFolders(),
      });
      if (this.streamId !== streamId) return;
      this.interactionId = started.interactionId;
      this.noteSent(agent, started.interactionId, text);
      this.syncConversationWatch();
      this.status = '응답 생성 중...';
      this.postState();
    } catch (error) {
      if (this.streamId !== streamId) return;
      this.streamId = undefined;
      this.attachments = [...attachments, ...this.attachments];
      this.status = undefined;
      this.updateAssistant(`오류: ${errorMessage(error)}`);
      await this.setRunning(false);
      this.postState();
    }
  }

  private async attachFiles(): Promise<void> {
    const agent = this.selectedAgent;
    if (!agent || this.streamId || this.uploadingAttachments || this.readOnly) return;
    this.uploadingAttachments = true;
    this.interactionId ??= this.modelTarget() ?? randomUUID();
    const interactionId = this.interactionId;
    const profile = this.activeProfileParams();
    const isCurrent = () => this.selectedAgent?.workflowId === agent.workflowId && this.interactionId === interactionId;
    try {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false });
      if (!picked?.length || !isCurrent()) return;
      this.status = '파일을 업로드하는 중...';
      this.postState();
      for (const uri of picked) {
        if (!isCurrent()) return;
        const uploaded = await this.service.request<ChatAttachmentDescriptor>('chat/attachment/upload', {
          ...profile, workflowId: agent.workflowId, interactionId, path: uri.fsPath,
        });
        if (!isCurrent()) return;
        this.attachments.push(uploaded);
        this.postState();
      }
      this.status = undefined;
    } catch (error) {
      if (isCurrent()) this.status = `파일을 첨부하지 못했습니다: ${errorMessage(error)}`;
    } finally {
      this.uploadingAttachments = false;
      this.postState();
    }
  }

  /** 대화 소켓 감시 — 현재 대화의 서버 주입 턴(트리거 반응)을 실시간 수신. */
  private watchedInteraction: string | undefined;
  private syncConversationWatch(): void {
    const agent = this.selectedAgent;
    const next = this.interactionId;
    if (this.watchedInteraction && this.watchedInteraction !== next) {
      void this.service
        .request('chat/unwatch', { interactionId: this.watchedInteraction })
        .catch(() => undefined);
      this.watchedInteraction = undefined;
    }
    // 에이전트가 사라진 대화는 기록만 본다. 이어질 턴이 없으니 지켜보지 않는다.
    if (next && agent && !this.readOnly && this.watchedInteraction !== next) {
      this.watchedInteraction = next;
      void this.service
        .request('chat/watch', {
          ...this.activeProfileParams(),
          workflowId: agent.workflowId,
          workflowName: agent.workflowName,
          interactionId: next,
        })
        .catch(() => undefined);
    }
    this.rememberConversation();
  }

  /**
   * 지금 보고 있는 대화를 적어 둔다 — 창을 껐다 켜도(확장 호스트 재시작) 되찾기
   * 위해서다.
   *
   * 서버 실행은 연결이 아니라 **대화**에 매여 있다. 창을 닫아도 턴은 계속 돌고,
   * 다시 켰을 때 그 대화를 열지 않으면 진행 중인 실행이 화면에 없는 것과 같다 —
   * [중지] 버튼도 없다. 되찾는 데 필요한 것은 workflowId 와 interactionId 뿐이다.
   *
   * globalState 를 쓴다: 대화는 폴더에 속하지 않는다.
   */
  private rememberConversation(): void {
    const agent = this.selectedAgent;
    const value =
      agent && this.interactionId
        ? {
            workflowId: agent.workflowId,
            workflowName: agent.workflowName,
            interactionId: this.interactionId,
          }
        : undefined;
    void this.context.globalState.update(LAST_CONVERSATION_KEY, value);
  }

  /**
   * 확장이 다시 뜰 때 마지막 대화를 되살린다 — 활성화당 한 번만.
   *
   * 실패는 조용히 삼킨다. 지워졌거나 남의 계정 대화일 수 있고, 그때 오류를
   * 띄우면 확장을 켤 때마다 사용자가 모르는 대화의 실패를 본다.
   */
  private async restoreLastConversation(): Promise<boolean> {
    if (this.restoredLastConversation) return false;
    this.restoredLastConversation = true;
    if (this.interactionId) return false; // 이미 대화 중이면 덮지 않는다
    const saved = this.context.globalState.get<{
      workflowId?: string;
      workflowName?: string;
      interactionId?: string;
    }>(LAST_CONVERSATION_KEY);
    if (!saved?.interactionId || !saved.workflowId) return false;
    // 대화 목록에 있으면 그 줄(제목·에이전트가 사라졌는가)을 쓴다.
    const listed = this.findConversation(saved.workflowId, saved.interactionId);
    const name = saved.workflowName || listed?.workflowName || saved.workflowId;
    const snapshot = await this.service
      .request<ConversationSnapshot>('history/snapshot', {
        ...this.activeProfileParams(),
        workflowId: saved.workflowId,
        workflowName: name,
        interactionId: saved.interactionId,
      })
      .catch(() => undefined);
    if (!snapshot) return false;
    const turns = snapshot.turns ?? [];
    // 돌고 있지도 않고 남긴 것도 없는 대화는 되살릴 값이 없다.
    if (!snapshot.running && turns.length === 0) return false;
    const conversation =
      listed ??
      conversationStub({
        workflowId: saved.workflowId,
        workflowName: name,
        interactionId: saved.interactionId,
        interactionCount: turns.length,
      });
    this.selectedAgent =
      this.agents.find((agent) => agent.workflowId === saved.workflowId) ?? agentFromConversation(conversation);
    this.readOnly = conversation.agentDeleted === true;
    this.openedConversation = conversation;
    this.interactionId = saved.interactionId;
    this.syncConversationWatch();
    this.messages = historyTurnMessages(turns, name);
    this.screen = 'chat';
    if (snapshot.running) {
      this.status = '다른 곳에서 시작한 응답이 진행 중입니다.';
      this.watchRemoteRun();
    }
    return true;
  }

  private onNotification(notification: RpcNotification): void {
    if (notification.method === 'conversations/changed') {
      if (this.canPageConversations) this.applyConversationListEvent(notification.params);
      return;
    }
    if (notification.method === 'chat/serverTurn') {
      // 서버가 주입한 완결 턴(트리거 반응) — 새로고침 없이 흐른다.
      const p = notification.params as
        | { interactionId?: string; ioId?: number; input?: string; output?: string; source?: string }
        | undefined;
      if (
        p &&
        p.interactionId === this.interactionId &&
        p.source === 'subagent_report' &&
        p.output
      ) {
        const key = `turn:${p.ioId ?? ''}`;
        if (!this.toolMessages.has(key)) {
          this.toolMessages.set(key, 'seen'); // io_id 중복 push 멱등
          this.messages.push(message('user', '나', String(p.input ?? '')));
          this.messages.push(
            message('assistant', this.selectedAgent?.workflowName ?? 'Agent', String(p.output)),
          );
          this.postState();
        }
      }
      return;
    }
    if (notification.method === 'chat/running') {
      // 이 대화에 도는 턴이 있는가 — 그리고 돌고 있다면 그 턴의 **여기까지**.
      //
      // 예전에는 히스토리를 부르는 순간의 running 만 알고 5초 폴링으로
      // 끝났는지만 물었다. 그래서 다시 붙은 화면에는 "진행 중입니다" 라는
      // 안내와 **빈 자리**가 함께 있었다 — 서버는 열심히 돌고 있는데 보여 줄
      // 것이 없었다. 이제 진행분을 받아 그 자리를 채운다.
      const p = notification.params as
        | { interactionId?: string; running?: boolean; live?: { text?: string } | null }
        | undefined;
      if (!p || p.interactionId !== this.interactionId) return;
      if (!p.running) return; // 끝났다는 소식은 완결 턴/폴링이 다룬다.
      if (!this.remoteRunning) this.watchRemoteRun();
      const text = typeof p.live?.text === 'string' ? p.live.text : '';
      if (text) this.showRemotePartial(text);
      return;
    }
    if (notification.method === 'conversation/modelChanged') {
      // 다른 화면(웹·앱·CLI)에서 이 대화의 모델을 바꿨다 — 칩이 곧바로 따라간다.
      const p = notification.params as { interactionId?: string; notice?: Record<string, unknown> } | undefined;
      if (!p || !this.model || p.interactionId !== this.modelTarget()) return;
      this.model = applyModelNotice(this.model, p.notice);
      this.postState();
      return;
    }
    if (notification.method === 'localTools/status') {
      if (this.localTools && isLocalToolBridgeStatus(notification.params)) {
        this.localTools = { ...this.localTools, bridge: notification.params };
        this.localToolsMessage = localToolsBridgeLabel(this.localTools);
        this.scheduleState();
      }
      return;
    }
    if (notification.method === 'chat/event') {
      const params = notification.params as ChatEventNotification;
      if (params?.streamId !== this.streamId) return;
      this.applyEvent(params.event);
      return;
    }
    if (notification.method === 'chat/complete') {
      const params = notification.params as ChatCompleteNotification;
      if (params?.streamId !== this.streamId) return;
      this.interactionId = params.interactionId;
      this.streamId = undefined;
      this.status = undefined;
      const assistant = this.messages.find((item) => item.id === this.assistantMessageId);
      if (assistant && !assistant.text) assistant.text = '응답 내용이 없습니다.';
      void this.setRunning(false);
      this.postState();
      // 답이 끝났다: 서버가 정한 제목·순서로 목록 첫 쪽을 맞춘다(방금 만든 대화의 제목도 여기서 바로잡힌다).
      if (this.canPageConversations) void this.loadConversations('head');
      return;
    }
    if (notification.method === 'chat/error') {
      const params = notification.params as ChatErrorNotification;
      if (params?.streamId !== this.streamId) return;
      this.streamId = undefined;
      this.status = undefined;
      this.updateAssistant(`오류: ${params.error.message}`);
      void this.setRunning(false);
      this.postState();
    }
  }

  private applyEvent(event: ChatEvent): void {
    if (event.kind === 'text') this.updateAssistant(event.content);
    else if (event.kind === 'summary') this.updateAssistant(event.text);
    else if (event.kind === 'tool') this.updateTool(event.event);
    else if (event.kind === 'node_status') this.status = `${event.event.nodeId} · ${event.event.status}`;
    else if (event.kind === 'quota') this.messages.push(message('system', '사용량', `사용량 ${event.level}`));
    else if (event.kind === 'error')
      this.messages.push(
        message('system', '시스템', formatErrorLine(event.info ?? describeStreamError(event.detail))),
      );
    else if (event.kind === 'status') this.status = event.detail || event.reason || event.surface;
    else if (event.kind === 'detached') {
      // 스트림이 끊겼을 뿐 서버의 턴은 계속 돈다(게이트웨이 1시간 컷·프록시·절전).
      // 이 스트림은 놓되 [진행 중] 은 유지하고, 완결은 대화 소켓으로 받는다.
      this.streamId = undefined;
      this.status = '연결이 끊겼습니다 — 서버에서 계속 진행 중입니다.';
      this.watchRemoteRun();
    }
    this.scheduleState();
  }

  /**
   * 다른 곳에서 도는 턴의 진행분을 화면에 세운다.
   *
   * 스냅샷은 재연결·하트비트마다 **처음부터 다시** 오므로 이어붙이면 같은 글이
   * 여러 번 쌓인다. 그래서 전용 말풍선 하나를 두고 매번 덮어쓴다. 턴이 끝나면
   * 완결 턴이 히스토리로 와서 이 자리를 대신한다(pollRemoteRun 이 다시 그린다).
   */
  private showRemotePartial(text: string): void {
    const name = this.selectedAgent?.workflowName ?? 'Agent';
    const existing = this.messages.find((item) => item.id === this.remotePartialId);
    if (existing) {
      if (existing.text === text) return;
      existing.text = text;
    } else {
      const msg = message('assistant', name, text);
      this.remotePartialId = msg.id;
      this.messages.push(msg);
    }
    this.postState();
  }

  private updateAssistant(chunk: string): void {
    const assistant = this.messages.find((item) => item.id === this.assistantMessageId);
    if (assistant) assistant.text += chunk;
  }

  private updateTool(event: ToolEvent): void {
    // 전체 로그의 원천 — 답변 메시지에 이벤트를 수신 순으로 쌓는다
    // (데스크톱 세션 스토어와 같은 모델).
    const assistant = this.messages.find((item) => item.id === this.assistantMessageId);
    let index = -1;
    if (assistant) {
      assistant.tools = assistant.tools ?? [];
      assistant.tools.push(event);
      index = assistant.tools.length - 1;
    }
    const key = event.runId || `${event.toolName ?? 'tool'}:${event.eventType}`;
    const existingId = this.toolMessages.get(key);
    const text = describeTool(event);
    const existing = existingId ? this.messages.find((item) => item.id === existingId) : undefined;
    if (existing) {
      existing.text = text;
      // 같은 실행의 후속 이벤트(완료/실패) — 클릭이 최신 상태 항목을 열도록 갱신.
      if (assistant && index >= 0) existing.toolRef = { assistantId: assistant.id, index };
      return;
    }
    const item = message('activity', 'Tool', text);
    if (assistant && index >= 0) item.toolRef = { assistantId: assistant.id, index };
    this.messages.push(item);
    this.toolMessages.set(key, item.id);
  }

  private onWebviewMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const data = raw as Record<string, unknown>;
    if (data.type === 'ready') this.postState();
    else if (data.type === 'send' && typeof data.text === 'string') void this.send(data.text);
    else if (data.type === 'attach') void this.attachFiles();
    else if (data.type === 'pickModel') void this.pickModel();
    else if (data.type === 'pickThinking') void this.pickThinking();
    else if (data.type === 'removeAttachment' && typeof data.id === 'string') {
      this.attachments = this.attachments.filter((item) => item.attachment_id !== data.id);
      this.postState();
    }
    else if (data.type === 'showConversations') void this.showConversations();
    else if (data.type === 'openConversation' && typeof data.workflowId === 'string' && typeof data.interactionId === 'string') {
      void this.openConversationByKey(data.workflowId, data.interactionId);
    } else if (data.type === 'renameConversation' && typeof data.workflowId === 'string' && typeof data.interactionId === 'string') {
      void this.renameConversation(data.workflowId, data.interactionId);
    } else if (data.type === 'deleteConversation' && typeof data.workflowId === 'string' && typeof data.interactionId === 'string') {
      void this.deleteConversation(data.workflowId, data.interactionId);
    } else if (data.type === 'purgeDeletedAgents') void this.purgeDeletedAgents();
    else if (data.type === 'loadMoreConversations') void this.loadConversations('more');
    else if (data.type === 'searchConversations') void this.searchConversations();
    else if (data.type === 'startAgent' && typeof data.workflowId === 'string') this.onStartAgent(data.workflowId);
    else if (data.type === 'startName' && typeof data.name === 'string') this.onStartName(data.name);
    else if (data.type === 'startSend') void this.startSend(data);
    else if (data.type === 'showSettings') void this.showSettings();
    else if (data.type === 'back') {
      if (this.auth?.authenticated) {
        this.screen =
          this.returnScreen === 'chat' && this.selectedAgent ? 'chat' : this.returnScreen === 'start' ? 'start' : 'conversations';
      } else {
        this.screen = this.auth?.reason === 'network' ? 'offline' : this.profiles.length ? 'login' : 'setup';
      }
      this.postState();
    } else if (data.type === 'cancel') void this.cancel();
    else if (data.type === 'newChat') void this.newChat();
    else if (data.type === 'history') void this.openHistory();
    else if (data.type === 'refresh') void vscode.commands.executeCommand('xgenDex.refresh');
    else if (data.type === 'login') void vscode.commands.executeCommand('xgenDex.login');
    else if (data.type === 'logout') void vscode.commands.executeCommand('xgenDex.logout');
    else if (data.type === 'setupProfile') void vscode.commands.executeCommand('xgenDex.setupProfile');
    else if (data.type === 'editProfile' && typeof data.profile === 'string') {
      void vscode.commands.executeCommand('xgenDex.setupProfile', data.profile);
    } else if (data.type === 'useProfile' && typeof data.profile === 'string') {
      void vscode.commands.executeCommand('xgenDex.switchProfile', data.profile);
    } else if (data.type === 'configureLocalTools') {
      void this.configureLocalTools(data.config);
    } else if (data.type === 'restartEngine') void vscode.commands.executeCommand('xgenDex.restartEngine');
    else if (data.type === 'openExtensionSettings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xgen.xgen-dex-vscode');
    } else if (data.type === 'showOutput') this.service.showOutput();
  }

  private activeProfileParams(): { profile?: string } {
    return this.auth?.profile ? { profile: this.auth.profile } : this.service.profileParams();
  }

  private async configureLocalTools(raw: unknown): Promise<void> {
    if (this.localToolsSaving) return;
    try {
      const patch = localToolsConfigInput(raw, this.localTools?.config);
      if (patch.allowDangerous && !this.localTools?.config.allowDangerous) {
        const approved = await vscode.window.showWarningMessage(
          '위험 명령을 미리 승인하면 Agent가 연결된 폴더에서 되돌리기 어려운 명령을 확인 없이 실행할 수 있습니다.',
          { modal: true },
          '위험 명령 허용',
        );
        if (approved !== '위험 명령 허용') {
          this.localToolsMessage = '위험 명령 허용이 취소되었습니다.';
          this.postState();
          return;
        }
      }
      this.localToolsSaving = true;
      this.localToolsMessage = '로컬 도구 설정을 저장하는 중입니다...';
      this.postState();
      let status = await this.service.request<LocalToolsStatus>('localTools/configure', {
        ...this.activeProfileParams(),
        ...patch,
      });
      if (this.auth?.authenticated) {
        status = await this.service.request<LocalToolsStatus>('localTools/start', {
          ...this.activeProfileParams(),
          waitMs: 3_000,
        });
      }
      this.localTools = status;
      this.localToolsMessage = localToolsBridgeLabel(status);
    } catch (error) {
      this.localToolsMessage = `저장하지 못했습니다: ${errorMessage(error)}`;
      void vscode.window.showErrorMessage(`로컬 도구 설정을 저장하지 못했습니다: ${errorMessage(error)}`);
    } finally {
      this.localToolsSaving = false;
      this.postState();
    }
  }

  /** 디스크에 있는 작업 영역 폴더(원격·가상 파일 시스템은 이 PC 의 폴더가 아니다). */
  private workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);
  }

  /**
   * 다른 곳에서 도는 턴을 지켜본다 — 끝나면 히스토리를 다시 읽어 답을 그린다.
   *
   * 이 확장은 그 스트림을 쥐고 있지 않으므로 `chat/complete` 가 오지 않는다.
   * 서버가 진행 중인 턴의 토큰을 재전송해 주지는 않으니(완결된 턴만 남는다),
   * 할 수 있는 정직한 일은 "진행 중" 을 보여 주고 완결을 기다리는 것이다.
   */
  private watchRemoteRun(): void {
    this.stopWatchingRemoteRun();
    this.remoteRunning = true;
    void this.setRunning(true);
    this.remotePoll = setInterval(() => void this.pollRemoteRun(), 5_000);
  }

  private stopWatchingRemoteRun(): void {
    if (this.remotePoll) clearInterval(this.remotePoll);
    this.remotePoll = undefined;
    // 진행분 말풍선은 여기서 놓는다 — 호출자가 곧 히스토리로 다시 그리거나
    // 대화를 바꾼다. 남겨 두면 다음 턴의 진행분이 지난 턴 자리에 덮인다.
    this.remotePartialId = undefined;
    if (this.remoteRunning) {
      this.remoteRunning = false;
      void this.setRunning(!!this.streamId);
    }
  }

  private async pollRemoteRun(): Promise<void> {
    const agent = this.selectedAgent;
    const interactionId = this.interactionId;
    if (!agent || !interactionId) return this.stopWatchingRemoteRun();
    try {
      const snapshot = await this.service.request<ConversationSnapshot>('history/snapshot', {
        ...this.activeProfileParams(),
        workflowId: agent.workflowId,
        workflowName: agent.workflowName,
        interactionId,
      });
      if (snapshot.running) return;
      // 끝났다 — 이 대화가 화면에서 바뀌지 않았을 때만 다시 그린다.
      if (this.interactionId !== interactionId) return this.stopWatchingRemoteRun();
      this.stopWatchingRemoteRun();
      this.messages = historyTurnMessages(snapshot.turns ?? [], agent.workflowName);
      this.status = undefined;
      this.postState();
    } catch {
      // 서버에 못 닿았다 — 다음 회차에 다시 본다. 폴링 실패로 화면을 깨지 않는다.
    }
  }

  private async setRunning(running: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'xgenDex.chatRunning', running);
  }

  private scheduleState(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.postState();
    }, 33);
  }

  private postState(): void {
    this.syncModel();
    const agent = this.selectedAgent;
    const activeKey = agent && this.interactionId ? conversationKey({ workflowId: agent.workflowId, interactionId: this.interactionId }) : undefined;
    const current = agent && this.interactionId ? this.findConversation(agent.workflowId, this.interactionId) : undefined;
    const state: ChatViewState = {
      screen: this.screen,
      profiles: this.profiles,
      auth: this.auth,
      agents: this.agents,
      agent,
      messages: this.messages,
      running: !!this.streamId || this.remoteRunning,
      refreshing: this.refreshing,
      status: this.status,
      error: this.error,
      conversations: conversationRows(this.conversations, activeKey),
      conversationsLoading: this.conversationsLoading,
      conversationsLoadingMore: this.conversationsLoadingMore,
      conversationsHasMore: this.canPageConversations && !!this.conversationCursor,
      conversationsError: this.conversationsError,
      conversationActions: this.canPageConversations,
      agentDeletedCount: this.agentDeletedCount,
      purgeLabel: this.canPageConversations ? purgeDeletedLabel(this.agentDeletedCount) : undefined,
      conversationTitle: current ? conversationDisplayTitle(current) : undefined,
      readOnly: this.readOnly,
      start: this.startView(),
      workspaceFolders: this.workspaceFolders(),
      localTools: this.localTools,
      localToolsSaving: this.localToolsSaving,
      localToolsMessage: this.localToolsMessage,
      attachments: this.attachments,
      model:
        this.model?.supported && this.model.current
          ? { label: this.model.current.label, locked: this.model.locked, saving: this.modelSaving }
          : undefined,
      // 모델 칩 오른쪽 생각 칩 — 조절할 수 없는 모델은 눌리지 않는 "생각 조절 불가".
      thinking:
        this.model?.supported && this.model.current && this.model.thinking
          ? {
              label: thinkingChipLabel(this.model.thinking),
              supported: this.model.thinking.supported,
              locked: this.model.locked,
              saving: this.modelSaving,
            }
          : undefined,
    };
    void this.view?.webview.postMessage({ type: 'state', state });
  }

  // ── 이 대화의 모델 ────────────────────────────────────────────────
  //
  // 세션은 그대로다 — 서버가 다음 턴 시작에 바꿔 끼운다. 이름("제공자: 모델")과 순서
  // (지금 모델이 맨 앞)는 서버가 정하고, 여기서는 VS Code 의 빠른 선택으로 보여 준다.

  /** 모델이 붙는 대화 번호 — 진행 중인 대화, 없으면 새 대화용으로 미리 정한 번호. */
  private modelTarget(): string | undefined {
    if (!this.selectedAgent) return undefined;
    return this.interactionId ?? (this.draftInteractionId ??= randomUUID());
  }

  private syncModel(): void {
    // 에이전트가 사라진 대화는 이어 갈 수 없으니 모델도 묻지 않는다.
    const agent = this.screen === 'chat' && !this.readOnly ? this.selectedAgent : undefined;
    const target = agent ? this.modelTarget() : undefined;
    const key = agent && target ? `${agent.workflowId}:${target}` : '';
    if (key === this.modelKey) return;
    // 같은 에이전트의 다른 대화로 넘어갈 때는 새 값이 올 때까지 칩을 그대로 둔다(깜빡임 방지).
    if (!key || !this.modelKey.startsWith(`${agent?.workflowId}:`)) this.model = undefined;
    this.modelKey = key;
    if (!agent || !target) return;
    void this.service
      .request<ConversationModelState>('conversation/model', {
        ...this.activeProfileParams(),
        workflowId: agent.workflowId,
        interactionId: target,
      })
      .then((next) => {
        if (this.modelKey !== key) return;
        this.model = next;
        this.postState();
      })
      // 옛 엔진(메서드 없음)·옛 서버 — 칩 없이 예전처럼 쓴다.
      .catch(() => {
        if (this.modelKey === key) this.model = undefined;
      });
  }

  private async pickModel(): Promise<void> {
    const agent = this.selectedAgent;
    const state = this.model;
    const target = this.modelTarget();
    if (!agent || !target || !state?.supported || !state.current || this.modelSaving) return;
    if (state.locked) {
      void vscode.window.showInformationMessage(MODEL_PICKER_TEXT.locked);
      return;
    }
    type Item = vscode.QuickPickItem & { choice?: ModelChoice };
    const current = state.current;
    const choices = orderedChoices(state);
    const items: Item[] = [];
    choices.forEach((choice, index) => {
      const isCurrent = sameModel(choice, current);
      const prev = choices[index - 1];
      // 지금 모델이 맨 위, 그 아래로 제공자 묶음마다 구분선.
      if (index === 0 && isCurrent) items.push({ label: MODEL_PICKER_TEXT.current, kind: vscode.QuickPickItemKind.Separator });
      else if (!prev || sameModel(prev, current) || prev.group !== choice.group) {
        items.push({ label: choice.group, kind: vscode.QuickPickItemKind.Separator });
      }
      items.push({
        label: isCurrent ? `$(check) ${choice.label}` : choice.label,
        description: isCurrent ? MODEL_PICKER_TEXT.current : undefined,
        choice,
      });
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: `${MODEL_PICKER_TEXT.title} · ${agent.workflowName}`,
      placeHolder: MODEL_PICKER_TEXT.nextTurn,
      matchOnDescription: true,
    });
    const choice = picked?.choice;
    if (!choice || sameModel(choice, current)) return;
    // 고르는 사이 다른 대화로 옮겼으면 그 대화에 붙이지 않는다.
    if (this.selectedAgent?.workflowId !== agent.workflowId || this.modelTarget() !== target) return;
    this.modelSaving = true;
    this.postState();
    try {
      const next = await this.service.request<ConversationModelState>('conversation/model/set', {
        ...this.activeProfileParams(),
        workflowId: agent.workflowId,
        interactionId: target,
        provider: choice.provider,
        model: choice.model,
      });
      if (this.modelKey === `${agent.workflowId}:${target}`) this.model = next;
    } catch (error) {
      void vscode.window.showErrorMessage(`${MODEL_PICKER_TEXT.failed}: ${errorMessage(error)}`);
    } finally {
      this.modelSaving = false;
      this.postState();
    }
  }

  /** 생각(추론) 값 고르기 — 지금 모델이 받는 값만(서버가 준 선택지), VS Code 빠른 선택. */
  private async pickThinking(): Promise<void> {
    const agent = this.selectedAgent;
    const state = this.model;
    const target = this.modelTarget();
    const thinking = state?.thinking;
    if (!agent || !target || !state?.supported || !thinking || this.modelSaving) return;
    if (!thinking.supported) {
      void vscode.window.showInformationMessage(THINKING_PICKER_TEXT.unsupportedHint);
      return;
    }
    if (state.locked) {
      void vscode.window.showInformationMessage(THINKING_PICKER_TEXT.locked);
      return;
    }
    type Item = vscode.QuickPickItem & { value?: ThinkingValue };
    const pressed = selectedThinking(thinking);
    const items: Item[] = thinking.options.map((value) => ({
      label: value === pressed ? `$(check) ${thinkingValueLabel(value)}` : thinkingValueLabel(value),
      description: value === 'auto' ? THINKING_PICKER_TEXT.autoHint : undefined,
      value,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `${THINKING_PICKER_TEXT.title} · ${agent.workflowName}`,
      placeHolder: thinking.canDisable ? THINKING_PICKER_TEXT.nextTurn : `${THINKING_PICKER_TEXT.alwaysOn}. ${THINKING_PICKER_TEXT.nextTurn}`,
    });
    const value = picked?.value;
    if (!value || value === pressed) return;
    if (this.selectedAgent?.workflowId !== agent.workflowId || this.modelTarget() !== target) return;
    this.modelSaving = true;
    this.postState();
    try {
      const next = await this.service.request<ConversationModelState>('conversation/thinking/set', {
        ...this.activeProfileParams(),
        workflowId: agent.workflowId,
        interactionId: target,
        thinking: value,
      });
      if (this.modelKey === `${agent.workflowId}:${target}`) this.model = next;
    } catch (error) {
      void vscode.window.showErrorMessage(`${THINKING_PICKER_TEXT.failed}: ${errorMessage(error)}`);
    } finally {
      this.modelSaving = false;
      this.postState();
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>XGEN Dex</title>
</head>
<body>
  <section id="loading-screen" class="screen loading-screen">
    <div class="brand-mark large" aria-hidden="true">✦</div>
    <strong>XGEN Dex를 준비하는 중</strong>
    <span>CLI 엔진과 연결 정보를 확인하고 있습니다.</span>
    <div class="loading-bar" aria-hidden="true"><i></i></div>
  </section>

  <section id="gate-screen" class="screen gate-screen hidden">
    <div class="gate-card">
      <div id="gate-icon" class="brand-mark large" aria-hidden="true">✦</div>
      <div class="eyebrow">XGEN DEX FOR VS CODE</div>
      <h1 id="gate-title"></h1>
      <p id="gate-description"></p>
      <div id="gate-connection" class="gate-connection hidden"></div>
      <div class="gate-actions">
        <button id="gate-primary" type="button"></button>
        <button id="gate-settings" class="secondary-button" type="button">연결 설정</button>
      </div>
    </div>
  </section>

  <section id="conversations-screen" class="screen list-screen hidden">
    <header class="workspace-header">
      <div class="brand-lockup"><span class="brand-mark" aria-hidden="true">✦</span><div><b>XGEN Dex</b><small id="list-connection"></small></div></div>
      <div class="header-actions">
        <button id="list-refresh" class="icon-button" type="button" title="새로 고침" aria-label="새로 고침">↻</button>
        <button id="list-settings" class="account-button" type="button" title="계정 및 연결 설정"><span id="account-avatar">?</span><span id="account-name"></span><i>›</i></button>
      </div>
    </header>
    <main id="list-content" class="list-content">
      <div class="list-inner">
        <div class="list-head">
          <button id="list-new" class="new-chat-button" type="button"><span aria-hidden="true">+</span><span>새 채팅</span></button>
          <button id="list-search" class="icon-button" type="button" title="채팅 검색" aria-label="채팅 검색"></button>
          <div class="list-menu-wrap">
            <button id="list-menu" class="icon-button hidden" type="button" title="채팅 목록 메뉴" aria-label="채팅 목록 메뉴" aria-haspopup="menu" aria-expanded="false"></button>
            <div id="list-menu-panel" class="list-menu hidden" role="menu">
              <button id="list-purge" class="list-menu-item danger" type="button" role="menuitem"></button>
            </div>
          </div>
        </div>
        <div id="conversation-list" class="conversation-list" role="list" aria-label="대화 목록"></div>
        <div id="list-status" class="list-status hidden" role="status"></div>
        <button id="list-more" class="secondary-button list-more hidden" type="button">더 보기</button>
      </div>
    </main>
  </section>

  <section id="start-screen" class="screen start-screen hidden">
    <header class="workspace-header">
      <div class="header-title"><button id="start-back" class="icon-button" type="button" title="대화 목록" aria-label="대화 목록">‹</button><div><b>새 채팅</b><small id="start-connection"></small></div></div>
      <button id="start-settings" class="icon-button" type="button" title="계정 및 연결 설정" aria-label="계정 및 연결 설정">⚙</button>
    </header>
    <main class="start-content">
      <div class="start-inner">
        <h1 class="start-heading">오늘은 무엇을 해볼까요?</h1>
        <label class="start-field"><span>에이전트</span><select id="start-agent" class="start-control"></select></label>
        <div id="start-create" class="start-create">
          <label class="start-field"><span>이름</span><input id="start-name" class="start-control" type="text" autocomplete="off" spellcheck="false" placeholder="에이전트 이름"></label>
          <div id="start-name-error" class="field-error hidden" role="alert"></div>
          <div class="start-row">
            <label class="start-field"><span>AI 제공사</span><select id="start-provider" class="start-control"></select></label>
            <label class="start-field"><span>모델</span><select id="start-model" class="start-control"></select></label>
          </div>
          <details id="start-advanced" class="start-advanced"><summary>세부 설정</summary><div id="start-settings-fields" class="start-settings-fields"></div></details>
        </div>
      </div>
    </main>
    <div id="start-message" class="status hidden" role="status"><span class="status-dot" aria-hidden="true"></span><span id="start-message-text"></span></div>
    <footer class="composer-shell">
      <div class="composer-card">
        <textarea id="start-input" rows="2" placeholder="메시지 보내기" aria-label="메시지"></textarea>
        <div class="composer-actions">
          <span class="hint"><kbd>Enter</kbd> 전송 <span aria-hidden="true">·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈</span>
          <button id="start-send" class="send-button" type="button"><span>전송</span><span class="send-icon" aria-hidden="true">↑</span></button>
        </div>
      </div>
    </footer>
  </section>

  <section id="chat-screen" class="screen chat-screen hidden">
    <header class="agent-header">
      <button id="chat-back" class="icon-button" type="button" title="대화 목록" aria-label="대화 목록">‹</button>
      <div class="agent-copy">
        <div class="agent-line">
          <div id="agent-name" class="agent-name"></div>
          <span id="agent-scope" class="meta-badge"></span>
          <span id="agent-status" class="meta-badge subtle"></span>
          <span id="agent-folders" class="meta-badge subtle"></span>
        </div>
        <div class="agent-meta"><span id="chat-title" class="chat-title"></span><span id="agent-id" class="agent-id"></span><span id="agent-description" class="agent-description"></span></div>
      </div>
      <div class="agent-actions">
        <button id="chat-new" class="secondary-button compact" type="button">새 채팅</button>
        <button id="chat-settings" class="icon-button" type="button" title="계정 및 연결 설정" aria-label="계정 및 연결 설정">⚙</button>
      </div>
    </header>
    <main id="messages" class="messages" aria-live="polite"></main>
    <div id="status" class="status hidden" role="status"><span class="status-dot" aria-hidden="true"></span><span id="status-text"></span></div>
    <div id="chat-readonly" class="readonly-notice hidden" role="note">지워진 에이전트입니다. 지난 대화만 볼 수 있습니다.</div>
    <footer id="chat-composer" class="composer-shell">
      <div class="composer-card">
        <div id="attachments" class="chat-attachments" aria-live="polite"></div>
        <textarea id="input" rows="2" placeholder="Agent에게 메시지 보내기" aria-label="메시지"></textarea>
        <div class="composer-actions">
          <button id="model-chip" class="model-chip hidden" type="button" aria-haspopup="listbox"><span id="model-icon" class="model-chip-icon" aria-hidden="true"></span><span id="model-label" class="model-chip-label"></span><span id="model-chevron" class="model-chip-chevron" aria-hidden="true"></span></button>
          <button id="thinking-chip" class="model-chip thinking-chip hidden" type="button" aria-haspopup="listbox"><span id="thinking-icon" class="model-chip-icon" aria-hidden="true"></span><span id="thinking-label" class="model-chip-label"></span><span id="thinking-chevron" class="model-chip-chevron" aria-hidden="true"></span></button>
          <span class="hint"><kbd>Enter</kbd> 전송 <span aria-hidden="true">·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈</span>
          <button id="attach" class="secondary-button compact" type="button" title="파일 첨부">📎 첨부</button>
          <button id="cancel" class="secondary-button hidden" type="button">응답 중지</button>
          <button id="send" class="send-button" type="button"><span>전송</span><span class="send-icon" aria-hidden="true">↑</span></button>
        </div>
      </div>
    </footer>
  </section>

  <section id="settings-screen" class="screen settings-screen hidden">
    <header class="workspace-header">
      <div class="header-title"><button id="settings-back" class="icon-button" type="button" aria-label="이전 화면">‹</button><div><b>계정 및 연결 설정</b><small>XGEN Dex가 사용하는 회사 환경과 계정을 관리합니다.</small></div></div>
      <button id="settings-refresh" class="icon-button" type="button" title="새로 고침" aria-label="새로 고침">↻</button>
    </header>
    <main class="settings-content">
      <section class="settings-section">
        <div class="section-heading"><div><span>계정</span><small>현재 로그인 정보</small></div><span id="account-state" class="state-pill"></span></div>
        <div class="settings-card identity-card">
          <div id="settings-avatar" class="identity-avatar">?</div>
          <div class="identity-copy"><b id="settings-username">로그인하지 않음</b><span id="settings-user-id"></span><div id="settings-roles" class="role-list"></div></div>
          <button id="account-action" class="secondary-button" type="button"></button>
        </div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>연결된 회사 / 환경</span><small>프로필 이름을 회사 또는 환경 구분으로 사용합니다.</small></div></div>
        <div class="settings-card connection-card">
          <div class="connection-icon" aria-hidden="true">⌂</div>
          <div class="connection-copy"><b id="connection-name">연결 없음</b><span id="connection-host"></span><code id="connection-url"></code></div>
          <button id="edit-connection" class="secondary-button" type="button">연결 수정</button>
        </div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>회사 / 환경 프로필</span><small>다른 XGEN 서버로 전환하거나 새 연결을 추가합니다.</small></div><button id="add-profile" class="text-button" type="button">+ 프로필 추가</button></div>
        <div id="profiles-list" class="profiles-list"></div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>이 PC의 파일과 터미널</span><small>대화를 시작하면 열린 작업 영역 폴더가 그 대화의 작업 공간이 되고, Agent는 그 안에서만 파일과 터미널을 사용합니다.</small></div><span id="local-tools-state" class="state-pill">확인 필요</span></div>
        <div class="settings-card local-tools-card">
          <div class="local-tools-summary">
            <div class="local-tools-icon" aria-hidden="true">⌘</div>
            <div><b>연결되는 폴더</b><span id="local-tools-description">작업 영역에 폴더를 열면 여기 표시됩니다.</span></div>
          </div>
          <ul id="local-tools-folders" class="local-tools-folders"></ul>
          <div class="local-tools-form">
            <label class="dangerous-setting field-wide"><input id="local-tools-dangerous" type="checkbox"><span><b>위험 명령 미리 승인</b><small>되돌리기 어려운 명령도 확인 없이 실행합니다. 필요한 경우에만 켜세요.</small></span></label>
          </div>
          <div class="local-tools-footer"><span id="local-tools-message">이 PC 연결 상태를 확인하고 있습니다.</span><button id="save-local-tools" type="button">설정 저장</button></div>
        </div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>CLI 엔진</span><small>확장은 dex-cli를 백그라운드 엔진으로 사용합니다.</small></div></div>
        <div class="settings-card engine-card">
          <div><b>dex-cli 연결</b><span id="engine-description">프로세스 및 확장 설정을 관리합니다.</span></div>
          <div class="inline-actions"><button id="show-output" class="secondary-button" type="button">로그 보기</button><button id="extension-settings" class="secondary-button" type="button">확장 설정</button><button id="restart-engine" type="button">엔진 재시작</button></div>
        </div>
      </section>
    </main>
  </section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}


function agentFromConversation(conversation: Conversation): Agent {
  return {
    id: 0,
    workflowId: conversation.workflowId,
    workflowName: conversation.workflowName,
    nodeCount: 0,
    isShared: false,
    isDeployed: true,
    isCompleted: true,
    description: '이전 대화에서 불러온 Agent',
    username: '',
    fullName: '',
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localToolsConfigInput(raw: unknown, current: LocalToolsConfig | undefined): LocalToolsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('설정 값이 올바르지 않습니다.');
  const value = raw as Record<string, unknown>;
  return {
    allowDangerous: typeof value.allowDangerous === 'boolean' ? value.allowDangerous : current?.allowDangerous === true,
  };
}

function isLocalToolBridgeStatus(value: unknown): value is LocalToolBridgeStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.running === 'boolean' &&
    typeof status.connected === 'boolean' &&
    typeof status.catalogSynced === 'boolean' &&
    typeof status.advertisedTools === 'number' &&
    typeof status.serverTools === 'number'
  );
}

function localToolsBridgeLabel(status: LocalToolsStatus): string {
  if (status.bridge.catalogSynced) return `연결됨 · ${status.bridge.serverToolCount || status.tools.length}개 도구 사용 가능`;
  if (status.bridge.error) return `연결 확인 필요 · ${status.bridge.error}`;
  if (status.bridge.connected) return '서버와 도구 목록을 동기화하는 중입니다.';
  if (status.bridge.enabled) return 'XGEN 서버에 연결하는 중입니다.';
  return '설정됨 · 로그인 후 브리지가 자동으로 연결됩니다.';
}
