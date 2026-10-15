/**
 * 채팅 기록 관리 탭 (2026-10-10). 사이드바 목록 머리의 ⋯ 가 편집기 자리에 연다(이미 열려 있으면 앞으로).
 *
 * 데스크톱 ConversationManager 와 같은 일·같은 글이다. 상태는 여기(확장)가 들고, 웹뷰(media/manager.js)는
 * 받은 줄을 그리고 누른 것을 알릴 뿐이다. 엔진은 this.service.request 로만 부른다. 바꾼 것(지우기·이름 바꾸기·
 * 정리)은 곧바로 사이드바에 알려 두 화면이 같은 목록을 보인다.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  SEARCH_DELAY_MS,
  conversationKey,
  conversationMatchesKind,
  searchConversationList,
  type Conversation,
  type ConversationKind,
  type ConversationPage,
  type ConversationSearchPage,
} from '@dex/protocol';
import type { DexService } from './dex-service';
import {
  MANAGER_NOTICE_MS,
  MANAGER_PAGE_SIZE,
  MANAGER_SEARCH_LIMIT,
  MANAGER_TEXT,
  deleteInBatches,
  deleteNotice,
  deleteQuestion,
  managerKind,
  managerView,
  pageForKind,
  purgeQuestion,
  renameDraft,
} from './conversation-manager';
import { normalizeConversations } from './conversation-view';

/** 관리 탭이 사이드바에 기대는 것. */
export interface ConversationManagerHost {
  /** 지금 로그인한 프로필. */
  profileParams(): { profile?: string };
  /** 엔진이 채팅 검색(history/search)을 아는가. 모르면 사이드바가 받아 둔 목록에서 찾는다. */
  canSearch(): boolean;
  /** 사이드바가 받아 둔 대화(옛 엔진의 검색). */
  loadedConversations(): Conversation[];
  /** 사이드바 채팅에서 연다. */
  openConversation(conversation: Conversation): Promise<void>;
  /** 지웠다: 사이드바 목록에서도 뺀다(열려 있던 대화면 닫는다). */
  conversationsRemoved(list: Conversation[]): Promise<void>;
  /** 이름을 바꿨다. */
  conversationRenamed(conversation: Conversation, title: string, customTitle: boolean): void;
  /** 사라진 에이전트의 대화를 정리했다. */
  conversationsPurged(): Promise<void>;
}

export class ConversationManagerPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private kind: ConversationKind = 'all';
  private query = '';
  private items: Conversation[] = [];
  private cursor: string | null = null;
  private total: number | null = null;
  private searchHasMore = false;
  private deletedCount = 0;
  private loading = false;
  private loadingMore = false;
  private error: string | undefined;
  private selected = new Set<string>();
  private busy = false;
  private notice: string | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private queryTimer: NodeJS.Timeout | undefined;
  /** 늦게 온 옛 답이 새 목록을 덮지 않게 읽을 때마다 올린다. */
  private seq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: DexService,
    private readonly host: ConversationManagerHost,
  ) {}

  /** 탭을 연다. 이미 열려 있으면 앞으로 가져오고 다시 읽는다. */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      void this.load();
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('xgenDex.conversationManager', MANAGER_TEXT.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'xgen-dex.svg');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message), undefined, this.context.subscriptions);
    panel.onDidDispose(() => {
      if (this.panel === panel) this.reset();
    });
    void this.load();
  }

  /** 열려 있으면 처음부터 다시 읽는다(프로필이 바뀌었을 때). */
  reload(): void {
    if (this.panel) void this.load();
  }

  dispose(): void {
    const panel = this.panel;
    this.reset();
    panel?.dispose();
  }

  private reset(): void {
    this.panel = undefined;
    this.seq += 1;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.noticeTimer = undefined;
    this.queryTimer = undefined;
    this.kind = 'all';
    this.query = '';
    this.items = [];
    this.cursor = null;
    this.total = null;
    this.searchHasMore = false;
    this.deletedCount = 0;
    this.loading = false;
    this.loadingMore = false;
    this.error = undefined;
    this.selected = new Set();
    this.busy = false;
    this.notice = undefined;
  }

  // ── 읽기 ──────────────────────────────────────────────────────

  /** 처음부터 다시 읽는다. 검색어가 있으면 검색, 없으면 첫 쪽. */
  private async load(): Promise<void> {
    const seq = ++this.seq;
    const kind = this.kind;
    const query = this.query.trim();
    this.loading = true;
    this.error = undefined;
    this.post();
    try {
      if (query) {
        const page: ConversationSearchPage = this.host.canSearch()
          ? await this.service.request<ConversationSearchPage>('history/search', {
              ...this.host.profileParams(),
              query,
              limit: MANAGER_SEARCH_LIMIT,
              kind,
            })
          : searchConversationList(
              this.host.loadedConversations().filter((c) => conversationMatchesKind(c, kind)),
              query,
              MANAGER_SEARCH_LIMIT,
            );
        if (seq !== this.seq) return;
        this.items = pageForKind(normalizeConversations(page.hits.map((hit) => hit.conversation)), kind).list;
        this.cursor = null;
        this.total = this.items.length;
        this.searchHasMore = page.hasMore;
      } else {
        const page = await this.service.request<ConversationPage>('history/conversationPage', {
          ...this.host.profileParams(),
          limit: MANAGER_PAGE_SIZE,
          kind,
        });
        if (seq !== this.seq) return;
        const filtered = pageForKind(normalizeConversations(page.conversations), kind);
        this.items = filtered.list;
        this.cursor = page.nextCursor ?? null;
        this.total = filtered.ignored ? null : (page.total ?? null);
        this.searchHasMore = false;
        this.deletedCount =
          typeof page.agentDeletedCount === 'number' ? page.agentDeletedCount : this.items.filter((c) => c.agentDeleted).length;
      }
    } catch (error) {
      if (seq === this.seq) this.error = errorMessage(error);
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.post();
      }
    }
  }

  private async loadMore(): Promise<void> {
    const cursor = this.cursor;
    if (!cursor || this.loadingMore || this.query.trim()) return;
    const seq = this.seq;
    const kind = this.kind;
    this.loadingMore = true;
    this.post();
    try {
      const page = await this.service.request<ConversationPage>('history/conversationPage', {
        ...this.host.profileParams(),
        limit: MANAGER_PAGE_SIZE,
        kind,
        cursor,
      });
      if (seq !== this.seq) return;
      const seen = new Set(this.items.map(conversationKey));
      const next = pageForKind(normalizeConversations(page.conversations), kind).list;
      this.items = [...this.items, ...next.filter((c) => !seen.has(conversationKey(c)))];
      this.cursor = page.nextCursor ?? null;
    } catch (error) {
      if (seq === this.seq) this.setNotice(`더 불러오지 못했습니다. ${errorMessage(error)}`);
    } finally {
      this.loadingMore = false;
      this.post();
    }
  }

  // ── 웹뷰에서 온 것 ────────────────────────────────────────────

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const data = raw as Record<string, unknown>;
    const key = typeof data.key === 'string' ? data.key : '';
    switch (data.type) {
      case 'ready':
        this.post();
        return;
      case 'kind':
        this.kind = managerKind(data.kind);
        this.selected = new Set();
        void this.load();
        return;
      case 'query':
        if (typeof data.query === 'string') this.onQuery(data.query);
        return;
      case 'refresh':
        void this.load();
        return;
      case 'more':
        void this.loadMore();
        return;
      case 'toggle':
        this.toggle(key);
        return;
      case 'toggleAll':
        this.toggleAll();
        return;
      case 'deleteSelected':
        void this.deleteMany(this.items.filter((c) => this.selected.has(conversationKey(c))));
        return;
      case 'delete': {
        const target = this.find(key);
        if (target) void this.deleteMany([target]);
        return;
      }
      case 'open': {
        const target = this.find(key);
        if (target && !this.busy) void this.host.openConversation(target);
        return;
      }
      case 'rename': {
        const target = this.find(key);
        if (target && typeof data.title === 'string') void this.rename(target, data.title);
        return;
      }
      case 'purge':
        void this.purge();
        return;
      default:
    }
  }

  /** 검색어가 바뀌었다. 적기를 멈추면 다시 읽는다(비우면 곧바로). 고른 것은 비운다. */
  private onQuery(value: string): void {
    const before = this.query.trim();
    this.query = value.slice(0, 200);
    const trimmed = this.query.trim();
    if (trimmed === before) return;
    this.selected = new Set();
    // 읽는 중인 옛 답은 버린다.
    this.seq += 1;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(
      () => {
        this.queryTimer = undefined;
        void this.load();
      },
      trimmed ? SEARCH_DELAY_MS : 0,
    );
  }

  private find(key: string): Conversation | undefined {
    return key ? this.items.find((c) => conversationKey(c) === key) : undefined;
  }

  private toggle(key: string): void {
    if (this.busy || !this.find(key)) return;
    const next = new Set(this.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.selected = next;
    this.post();
  }

  private toggleAll(): void {
    if (this.busy || this.items.length === 0) return;
    const all = this.items.every((c) => this.selected.has(conversationKey(c)));
    this.selected = all ? new Set() : new Set(this.items.map(conversationKey));
    this.post();
  }

  // ── 바꾸기 ────────────────────────────────────────────────────

  private async deleteMany(targets: Conversation[]): Promise<void> {
    if (!targets.length || this.busy) return;
    const choice = await vscode.window.showWarningMessage(deleteQuestion(targets), { modal: true }, '삭제');
    if (choice !== '삭제') return;
    this.busy = true;
    this.post();
    try {
      const { gone, failed } = await deleteInBatches(targets, (c) =>
        this.service.request('history/delete', {
          ...this.host.profileParams(),
          workflowId: c.workflowId,
          interactionId: c.interactionId,
          ...(c.workflowName ? { workflowName: c.workflowName } : {}),
        }),
      );
      const goneKeys = new Set(gone.map(conversationKey));
      this.items = this.items.filter((c) => !goneKeys.has(conversationKey(c)));
      this.selected = new Set([...this.selected].filter((key) => !goneKeys.has(key)));
      if (this.total != null) this.total = Math.max(0, this.total - gone.length);
      const goneDeleted = gone.filter((c) => c.agentDeleted).length;
      if (goneDeleted) this.deletedCount = Math.max(0, this.deletedCount - goneDeleted);
      if (gone.length) await this.host.conversationsRemoved(gone);
      const notice = deleteNotice(gone.length, failed.length);
      if (notice) this.setNotice(notice);
    } finally {
      this.busy = false;
      this.post();
    }
  }

  private async purge(): Promise<void> {
    const count = this.deletedCount;
    if (count <= 0 || this.busy) return;
    const choice = await vscode.window.showWarningMessage(purgeQuestion(count), { modal: true }, '제거');
    if (choice !== '제거') return;
    this.busy = true;
    this.post();
    try {
      const result = await this.service.request<{ deleted: number }>('history/purgeDeletedAgents', this.host.profileParams());
      this.deletedCount = 0;
      this.setNotice(`채팅 ${typeof result?.deleted === 'number' ? result.deleted : count}개를 정리했습니다.`);
      await this.host.conversationsPurged();
      this.busy = false;
      await this.load();
    } catch (error) {
      this.setNotice(`채팅 정리에 실패했습니다. ${errorMessage(error)}`);
    } finally {
      this.busy = false;
      this.post();
    }
  }

  private async rename(target: Conversation, draft: string): Promise<void> {
    const next = renameDraft(draft);
    if (next === target.title) return;
    try {
      const result = await this.service.request<{ title: string; customTitle: boolean }>('history/rename', {
        ...this.host.profileParams(),
        workflowId: target.workflowId,
        interactionId: target.interactionId,
        title: next,
      });
      const key = conversationKey(target);
      this.items = this.items.map((c) =>
        conversationKey(c) === key ? { ...c, title: result.title, customTitle: result.customTitle } : c,
      );
      this.host.conversationRenamed(target, result.title, result.customTitle);
    } catch (error) {
      this.setNotice(`이름을 바꾸지 못했습니다. ${errorMessage(error)}`);
    } finally {
      this.post();
    }
  }

  /** 안내 한 줄. 잠시 뒤 사라진다. */
  private setNotice(text: string): void {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      this.notice = undefined;
      this.post();
    }, MANAGER_NOTICE_MS);
  }

  private post(): void {
    if (!this.panel) return;
    const view = managerView({
      kind: this.kind,
      query: this.query,
      items: this.items,
      cursor: this.cursor,
      total: this.total,
      searchHasMore: this.searchHasMore,
      deletedCount: this.deletedCount,
      loading: this.loading,
      loadingMore: this.loadingMore,
      error: this.error,
      selected: this.selected,
      busy: this.busy,
      notice: this.notice,
    });
    void this.panel.webview.postMessage({ type: 'state', state: view });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'manager.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'manager.css'));
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>${MANAGER_TEXT.title}</title>
</head>
<body>
  <main class="manager">
    <div class="manager-head">
      <h1 class="manager-title">${MANAGER_TEXT.title}</h1>
      <button id="manager-refresh" class="icon-button" type="button" title="새로고침" aria-label="새로고침">↻</button>
    </div>
    <div class="manager-toolbar">
      <select id="manager-kind" class="manager-kind" aria-label="상태"></select>
      <label class="manager-search"><span id="manager-search-icon" class="manager-search-icon" aria-hidden="true"></span><input id="manager-query" type="text" placeholder="제목·에이전트 이름·내용으로 검색" aria-label="채팅 기록 검색" maxlength="200" autocomplete="off" spellcheck="false"></label>
      <button id="manager-purge" class="manager-purge" type="button"></button>
    </div>
    <div class="manager-bar">
      <label class="manager-check"><input id="manager-all" type="checkbox"><span>모두 선택</span></label>
      <span id="manager-total" class="manager-muted"></span>
      <span id="manager-selected" class="manager-selected hidden"><strong id="manager-selected-label"></strong><button id="manager-delete" class="manager-delete" type="button">선택 삭제</button></span>
    </div>
    <div id="manager-notice" class="manager-notice hidden" role="status"></div>
    <div id="manager-list" class="manager-list" role="list" aria-label="채팅 기록"></div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
