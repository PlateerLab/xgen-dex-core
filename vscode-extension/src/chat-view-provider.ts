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
  ChatEventNotification,
  ChatStartResult,
  Conversation,
  HistoryTurn,
  LocalToolBridgeStatus,
  LocalToolsConfig,
  LocalToolsStatus,
  ProfileSummary,
  RpcNotification,
  ToolEvent,
} from './protocol';

type MessageRole = 'user' | 'assistant' | 'activity' | 'system';
type ViewScreen = 'loading' | 'setup' | 'login' | 'offline' | 'agents' | 'chat' | 'settings' | 'error';

interface ChatMessage {
  id: string;
  role: MessageRole;
  label: string;
  text: string;
}

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
  workspaceRoot?: string;
  localTools?: LocalToolsStatus;
  localToolsSaving: boolean;
  localToolsMessage?: string;
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
  private streamId: string | undefined;
  private assistantMessageId: string | undefined;
  private status: string | undefined;
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
        includeHarness: true,
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
        }
      }
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

  async cancel(): Promise<void> {
    if (!this.streamId) return;
    this.status = '응답을 취소하는 중...';
    this.postState();
    await this.service.request('chat/cancel', { streamId: this.streamId });
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
      const turns = await this.service.request<HistoryTurn[]>('history/turns', {
        ...this.activeProfileParams(),
        workflowId: conversation.workflowId,
        workflowName: conversation.workflowName,
        interactionId: conversation.interactionId,
      });
      await this.clearConversation();
      this.selectedAgent = this.agents.find((agent) => agent.workflowId === conversation.workflowId) ?? agentFromConversation(conversation);
      this.interactionId = conversation.interactionId;
      this.messages = turns.flatMap((turn) => [
        message('user', '나', turn.input),
        message('assistant', conversation.workflowName, turn.output),
      ]);
      this.status = `${turns.length}개의 이전 대화를 불러왔습니다.`;
      this.screen = 'chat';
      this.postState();
      await vscode.commands.executeCommand('xgenDex.chat.focus');
    } catch (error) {
      await vscode.window.showErrorMessage(`대화 기록을 불러오지 못했습니다: ${errorMessage(error)}`);
    }
  }

  dispose(): void {
    this.removeNotificationListener();
    if (this.renderTimer) clearTimeout(this.renderTimer);
  }

  private async clearConversation(): Promise<void> {
    const activeStream = this.streamId;
    this.streamId = undefined;
    this.assistantMessageId = undefined;
    this.interactionId = undefined;
    this.messages = [];
    this.toolMessages.clear();
    this.status = undefined;
    await this.setRunning(false);
    if (activeStream) await this.service.request('chat/cancel', { streamId: activeStream }).catch(() => undefined);
  }

  private async send(input: string): Promise<void> {
    const text = input.trim();
    if (!text || !this.selectedAgent || this.streamId) return;
    const agent = this.selectedAgent;
    const streamId = randomUUID();
    this.streamId = streamId;
    this.status = '응답을 기다리는 중...';
    this.messages.push(message('user', '나', text));
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
        ...(this.interactionId ? { interactionId: this.interactionId } : {}),
        input: text,
      });
      if (this.streamId !== streamId) return;
      this.interactionId = started.interactionId;
      this.status = '응답 생성 중...';
      this.postState();
    } catch (error) {
      if (this.streamId !== streamId) return;
      this.streamId = undefined;
      this.status = undefined;
      this.updateAssistant(`오류: ${errorMessage(error)}`);
      await this.setRunning(false);
      this.postState();
    }
  }

  private onNotification(notification: RpcNotification): void {
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
    else if (event.kind === 'error') this.messages.push(message('system', '시스템', event.detail));
    else if (event.kind === 'status') this.status = event.detail || event.reason || event.surface;
    this.scheduleState();
  }

  private updateAssistant(chunk: string): void {
    const assistant = this.messages.find((item) => item.id === this.assistantMessageId);
    if (assistant) assistant.text += chunk;
  }

  private updateTool(event: ToolEvent): void {
    const key = event.runId || `${event.toolName ?? 'tool'}:${event.eventType}`;
    const existingId = this.toolMessages.get(key);
    const text = describeTool(event);
    const existing = existingId ? this.messages.find((item) => item.id === existingId) : undefined;
    if (existing) {
      existing.text = text;
      return;
    }
    const item = message('activity', 'Tool', text);
    this.messages.push(item);
    this.toolMessages.set(key, item.id);
  }

  private onWebviewMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const data = raw as Record<string, unknown>;
    if (data.type === 'ready') this.postState();
    else if (data.type === 'send' && typeof data.text === 'string') void this.send(data.text);
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
      const patch = localToolsConfigInput(raw, this.localTools?.config, this.workspaceRoot());
      if (patch.allowDangerous && !this.localTools?.config.allowDangerous) {
        const approved = await vscode.window.showWarningMessage(
          '위험 명령 패턴 차단을 해제하면 Agent가 되돌리기 어려운 로컬 명령을 실행할 수 있습니다.',
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
      if (status.config.enabled && this.auth?.authenticated) {
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

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    const state: ChatViewState = {
      screen: this.screen,
      profiles: this.profiles,
      auth: this.auth,
      agents: this.agents,
      agentTotal: this.agentTotal,
      agent: this.selectedAgent,
      messages: this.messages,
      running: !!this.streamId,
      refreshing: this.refreshing,
      status: this.status,
      error: this.error,
      initialSearch: this.initialSearch,
      workspaceRoot: this.workspaceRoot(),
      localTools: this.localTools,
      localToolsSaving: this.localToolsSaving,
      localToolsMessage: this.localToolsMessage,
    };
    void this.view?.webview.postMessage({ type: 'state', state });
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
        <div><div class="eyebrow">SELECT AN AGENT</div><h1>어떤 Agent와 대화할까요?</h1><p>업무에 맞는 Agent를 선택하면 바로 새 대화를 시작합니다.</p></div>
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
      <div class="agent-avatar" aria-hidden="true">✦</div>
      <div class="agent-copy">
        <div class="agent-eyebrow">ACTIVE AGENT</div>
        <div id="agent-name" class="agent-name"></div>
        <div class="agent-meta">
          <span id="agent-scope" class="meta-badge"></span>
          <span id="agent-status" class="meta-badge subtle"></span>
          <span id="agent-id" class="agent-id"></span>
        </div>
        <div id="agent-description" class="agent-description"></div>
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
        <textarea id="input" rows="2" placeholder="Agent에게 메시지 보내기" aria-label="메시지"></textarea>
        <div class="composer-actions">
          <span class="hint"><kbd>Enter</kbd> 전송 <span aria-hidden="true">·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈</span>
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
        <div class="section-heading"><div><span>로컬 도구</span><small>Agent가 이 컴퓨터의 프로젝트 파일과 명령을 사용할 수 있게 합니다.</small></div><span id="local-tools-state" class="state-pill">꺼짐</span></div>
        <div class="settings-card local-tools-card">
          <div class="local-tools-summary">
            <div class="local-tools-icon" aria-hidden="true">⌘</div>
            <div><b>CLI 로컬 도구 브리지</b><span id="local-tools-description">Shell, 파일 읽기·쓰기, 목록, 검색, 열기 도구를 제공합니다.</span></div>
            <label class="switch-control"><input id="local-tools-enabled" type="checkbox"><span aria-hidden="true"></span><em>사용</em></label>
          </div>
          <div class="local-tools-form">
            <label class="settings-field field-wide"><span>작업 폴더</span><div class="field-with-action"><input id="local-tools-cwd" class="settings-input" type="text" spellcheck="false" placeholder="/path/to/project"><button id="use-workspace-root" class="secondary-button" type="button">현재 Workspace</button></div><small>Shell 명령의 기본 실행 위치입니다.</small></label>
            <label class="settings-field field-wide"><span>허용 경로</span><textarea id="local-tools-roots" class="settings-textarea" rows="2" spellcheck="false" placeholder="한 줄에 하나씩 입력"></textarea><small>파일 도구와 Open이 접근할 수 있는 폴더입니다.</small></label>
            <label class="settings-field"><span>명령 제한 시간</span><div class="input-suffix"><input id="local-tools-timeout" class="settings-input" type="number" min="1000" max="3600000" step="1000"><span>ms</span></div></label>
            <label class="settings-field"><span>차단 명령</span><input id="local-tools-blocked" class="settings-input" type="text" spellcheck="false" placeholder="sudo, rm"><small>쉼표 또는 줄바꿈으로 구분합니다.</small></label>
            <label class="dangerous-setting field-wide"><input id="local-tools-dangerous" type="checkbox"><span><b>위험 명령 패턴 허용</b><small>파괴적 명령 차단을 해제합니다. 필요한 경우에만 사용하세요.</small></span></label>
          </div>
          <div class="local-tools-footer"><span id="local-tools-message">로컬 도구는 기본적으로 꺼져 있습니다.</span><button id="save-local-tools" type="button">설정 저장</button></div>
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

function message(role: MessageRole, label: string, text: string): ChatMessage {
  return { id: randomUUID(), role, label, text };
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
    workflowType: 'history',
    description: '이전 대화에서 불러온 Agent',
    username: '',
    fullName: '',
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function describeTool(event: ToolEvent): string {
  const name = event.toolName || 'tool';
  if (event.eventType === 'tool_result') return `${name} · 완료${event.durationMs ? ` · ${event.durationMs}ms` : ''}`;
  if (event.eventType === 'tool_error') return `${name} · 실패${event.error ? ` · ${event.error}` : ''}`;
  return `${name} · 실행 중`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localToolsConfigInput(
  raw: unknown,
  current: LocalToolsConfig | undefined,
  workspaceRoot: string | undefined,
): LocalToolsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('로컬 도구 설정이 올바르지 않습니다.');
  const value = raw as Record<string, unknown>;
  const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : current?.cwd || workspaceRoot || '';
  if (!cwd) throw new Error('작업 폴더를 입력하세요.');
  const timeoutMs = Number(value.timeoutMs ?? current?.timeoutMs ?? 120_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new Error('명령 제한 시간은 1,000~3,600,000ms 사이여야 합니다.');
  }
  const stringList = (input: unknown, fallback: string[]): string[] => {
    if (!Array.isArray(input)) return fallback;
    return [...new Set(input.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
  };
  const allowedRoots = stringList(value.allowedRoots, current?.allowedRoots ?? []);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : current?.enabled === true,
    cwd,
    timeoutMs,
    allowedRoots: allowedRoots.length ? allowedRoots : [cwd],
    blockedCommands: stringList(value.blockedCommands, current?.blockedCommands ?? []),
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
  if (!status.config.enabled) return '로컬 도구가 꺼져 있습니다.';
  if (status.bridge.catalogSynced) return `연결됨 · ${status.bridge.serverTools || status.tools.length}개 도구 사용 가능`;
  if (status.bridge.error) return `연결 확인 필요 · ${status.bridge.error}`;
  if (status.bridge.connected) return '서버와 도구 목록을 동기화하는 중입니다.';
  if (status.bridge.running) return 'XGEN 서버에 연결하는 중입니다.';
  return '설정됨 · 로그인 후 브리지가 자동으로 연결됩니다.';
}
