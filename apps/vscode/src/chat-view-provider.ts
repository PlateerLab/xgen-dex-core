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
  MODEL_PICKER_TEXT,
  THINKING_PICKER_TEXT,
  applyModelNotice,
  orderedChoices,
  sameModel,
  selectedThinking,
  thinkingChipLabel,
  thinkingValueLabel,
  type ConversationModelState,
  type ModelChoice,
  type ThinkingValue,
} from '@dex/protocol';

/** 창을 껐다 켠 뒤 되찾을 대화가 적히는 자리(globalState). */
const LAST_CONVERSATION_KEY = 'xgenDex.lastConversation';

type ViewScreen = 'loading' | 'setup' | 'login' | 'offline' | 'agents' | 'chat' | 'settings' | 'error';


interface ChatViewState {
  screen: ViewScreen;
  profiles: ProfileSummary[];
  auth?: AuthStatus;
  agents: Agent[];
  agentTotal: number;
  agent?: Agent;
  messages: ChatMessage[];
  running: boolean;
  refreshing: boolean;
  status?: string;
  error?: string;
  initialSearch?: string;
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
  private initialSearch: string | undefined;
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
        this.screen = previousScreen === 'settings' ? 'settings' : auth.reason === 'network' ? 'offline' : 'login';
        return;
      }

      const result = await this.service.request<AgentListResult>('agents/list', {
        profile: auth.profile,
        page: 1,
        pageSize: 100,
      });
      if (version !== this.refreshVersion) return;
      this.agents = result.items;
      this.agentTotal = result.pagination.totalCount;
      if (this.selectedAgent) {
        const updated = this.agents.find((agent) => agent.workflowId === this.selectedAgent?.workflowId);
        if (updated) this.selectedAgent = updated;
        else {
          this.selectedAgent = undefined;
          this.messages = [];
          this.interactionId = undefined;
          this.draftInteractionId = undefined;
        }
      }
      // 에이전트 목록까지 온 뒤에 되살린다 — 목록이 있어야 자리표시가 아닌
      // 진짜 에이전트로 붙는다. 화면 결정보다 **먼저** 와야 복원한 대화가
      // 곧바로 보인다.
      await this.restoreLastConversation();
      if (version !== this.refreshVersion) return;
      if (previousScreen === 'settings') this.screen = 'settings';
      else this.screen = this.selectedAgent ? 'chat' : 'agents';
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

  async selectAgent(agent: Agent): Promise<void> {
    if (this.streamId) return;
    const changed = this.selectedAgent?.workflowId !== agent.workflowId;
    if (changed) await this.clearConversation();
    this.selectedAgent = agent;
    this.screen = 'chat';
    this.status = undefined;
    this.initialSearch = undefined;
    this.postState();
    await vscode.commands.executeCommand('xgenDex.chat.focus');
  }

  async showAgents(search?: string): Promise<void> {
    if (this.streamId) return;
    if (!this.auth?.authenticated) await this.refreshSession();
    if (!this.auth?.authenticated) return;
    this.screen = 'agents';
    this.initialSearch = search?.trim() || undefined;
    this.postState();
    this.view?.show(true);
  }

  async showSettings(): Promise<void> {
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
    this.screen = 'loading';
    await this.refreshSession();
  }

  async newChat(): Promise<void> {
    await this.clearConversation();
    this.screen = this.selectedAgent ? 'chat' : this.auth?.authenticated ? 'agents' : this.screen;
    this.postState();
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

  async openHistory(): Promise<void> {
    try {
      const conversations = await this.service.request<Conversation[]>('history/conversations', this.activeProfileParams());
      if (conversations.length === 0) {
        await vscode.window.showInformationMessage('저장된 XGEN Dex 대화가 없습니다.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        conversations.map((conversation) => ({
          label: conversation.workflowName,
          description: new Date(conversation.updatedAt).toLocaleString(),
          detail: `${conversation.interactionCount} turns · ${conversation.interactionId}`,
          conversation,
        })),
        { placeHolder: '불러올 대화를 선택하세요', matchOnDescription: true, matchOnDetail: true },
      );
      if (!picked) return;
      const conversation = picked.conversation;
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
  }

  private async clearConversation(): Promise<void> {
    this.stopWatchingRemoteRun();
    const activeStream = this.streamId;
    this.streamId = undefined;
    this.assistantMessageId = undefined;
    this.interactionId = undefined;
    this.draftInteractionId = undefined;
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

  private async send(input: string): Promise<void> {
    const text = input.trim();
    if ((!text && this.attachments.length === 0) || !this.selectedAgent || this.streamId || this.uploadingAttachments) return;
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
    if (!agent || this.streamId || this.uploadingAttachments) return;
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
    if (next && agent && this.watchedInteraction !== next) {
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
  private async restoreLastConversation(): Promise<void> {
    if (this.restoredLastConversation) return;
    this.restoredLastConversation = true;
    if (this.interactionId) return; // 이미 대화 중 — 덮지 않는다
    const saved = this.context.globalState.get<{
      workflowId?: string;
      workflowName?: string;
      interactionId?: string;
    }>(LAST_CONVERSATION_KEY);
    if (!saved?.interactionId || !saved.workflowId) return;
    const name = saved.workflowName || saved.workflowId;
    const snapshot = await this.service
      .request<ConversationSnapshot>('history/snapshot', {
        ...this.activeProfileParams(),
        workflowId: saved.workflowId,
        workflowName: name,
        interactionId: saved.interactionId,
      })
      .catch(() => undefined);
    if (!snapshot) return;
    const turns = snapshot.turns ?? [];
    // 돌고 있지도 않고 남긴 것도 없는 대화는 되살릴 값이 없다.
    if (!snapshot.running && turns.length === 0) return;
    this.selectedAgent =
      this.agents.find((agent) => agent.workflowId === saved.workflowId) ??
      agentFromConversation({
        workflowId: saved.workflowId,
        workflowName: name,
        interactionId: saved.interactionId,
        interactionCount: turns.length,
        createdAt: '',
        updatedAt: '',
      } as Conversation);
    this.interactionId = saved.interactionId;
    this.syncConversationWatch();
    this.messages = historyTurnMessages(turns, name);
    this.screen = 'chat';
    if (snapshot.running) {
      this.status = '다른 곳에서 시작한 응답이 진행 중입니다.';
      this.watchRemoteRun();
    }
  }

  private onNotification(notification: RpcNotification): void {
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
    else if (data.type === 'selectAgent' && typeof data.workflowId === 'string') {
      const agent = this.agents.find((item) => item.workflowId === data.workflowId);
      if (agent) void this.selectAgent(agent);
    } else if (data.type === 'showAgents') void this.showAgents();
    else if (data.type === 'showSettings') void this.showSettings();
    else if (data.type === 'back') {
      this.screen = this.selectedAgent
        ? 'chat'
        : this.auth?.authenticated
          ? 'agents'
          : this.auth?.reason === 'network'
            ? 'offline'
            : this.profiles.length
              ? 'login'
              : 'setup';
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
    const state: ChatViewState = {
      screen: this.screen,
      profiles: this.profiles,
      auth: this.auth,
      agents: this.agents,
      agentTotal: this.agentTotal,
      agent: this.selectedAgent,
      messages: this.messages,
      running: !!this.streamId || this.remoteRunning,
      refreshing: this.refreshing,
      status: this.status,
      error: this.error,
      initialSearch: this.initialSearch,
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
    const agent = this.screen === 'chat' ? this.selectedAgent : undefined;
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

  <section id="agents-screen" class="screen agents-screen hidden">
    <header class="workspace-header">
      <div class="brand-lockup"><span class="brand-mark" aria-hidden="true">✦</span><div><b>XGEN Dex</b><small id="agents-connection"></small></div></div>
      <div class="header-actions">
        <button id="agents-refresh" class="icon-button" type="button" title="새로 고침" aria-label="새로 고침">↻</button>
        <button id="agents-settings" class="account-button" type="button" title="계정 및 연결 설정"><span id="account-avatar">?</span><span id="account-name"></span><i>›</i></button>
      </div>
    </header>
    <main class="agents-content">
      <div class="agents-heading">
        <div><h1>어떤 Agent와 대화할까요?</h1><p>업무에 맞는 Agent를 선택하면 바로 새 대화를 시작합니다.</p></div>
        <span id="agent-count" class="count-badge"></span>
      </div>
      <div class="agent-toolbar">
        <label class="search-box"><span aria-hidden="true">⌕</span><input id="agent-search" type="search" placeholder="Agent 이름 또는 설명 검색" autocomplete="off"></label>
        <div id="agent-filters" class="filter-group" role="group" aria-label="Agent 범위">
          <button class="filter active" type="button" data-filter="all">전체</button>
          <button class="filter" type="button" data-filter="personal">개인</button>
          <button class="filter" type="button" data-filter="shared">공유</button>
        </div>
      </div>
      <div id="agent-list" class="agent-grid"></div>
    </main>
  </section>

  <section id="chat-screen" class="screen chat-screen hidden">
    <header class="agent-header">
      <div class="agent-copy">
        <div class="agent-line">
          <div id="agent-name" class="agent-name"></div>
          <span id="agent-scope" class="meta-badge"></span>
          <span id="agent-status" class="meta-badge subtle"></span>
          <span id="agent-folders" class="meta-badge subtle"></span>
        </div>
        <div class="agent-meta"><span id="agent-id" class="agent-id"></span><span id="agent-description" class="agent-description"></span></div>
      </div>
      <div class="agent-actions">
        <button id="change-agent" class="secondary-button compact" type="button">Agent 변경</button>
        <button id="chat-settings" class="icon-button" type="button" title="계정 및 연결 설정" aria-label="계정 및 연결 설정">⚙</button>
      </div>
    </header>
    <main id="messages" class="messages" aria-live="polite"></main>
    <div id="status" class="status hidden" role="status"><span class="status-dot" aria-hidden="true"></span><span id="status-text"></span></div>
    <footer class="composer-shell">
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
