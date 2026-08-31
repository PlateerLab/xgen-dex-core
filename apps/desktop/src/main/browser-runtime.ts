import { BrowserWindow, session, webContents, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  BrowserConnectionEvent,
  BrowserCreateRequest,
  BrowserNavigateRequest,
  BrowserPageInfo,
  BrowserPopupPermission,
  BrowserPopupPermissions,
  BrowserPopupRequest,
  BrowserPopupResolveRequest,
  BrowserSelectionBeginRequest,
  BrowserSelectionCompleteRequest,
  BrowserSelectionInspectRequest,
  BrowserSelectionPreview,
  BrowserSelectionResult,
  BrowserSelectionSession,
  BrowserState,
} from '@dex/protocol/browser';
import { browserOrigin, sanitizedBrowserUrl } from '@dex/protocol/browser';
import { AgentBrowserRunner } from './agent-browser-runner';
import {
  captureBrowserSelection,
  collectBrowserSelection,
  inspectBrowserSelection,
} from './browser-selection';
import { CdpPageProxy } from './cdp-page-proxy';
import { allowedBrowserUrl, browserPartition } from './browser-security';
import type { BrowserHistoryRuntimeEvent } from './browser-history';

interface BrowserPageRuntime {
  info: BrowserPageInfo;
  contents: WebContents | null;
  window: BrowserWindow | null;
  proxy: CdpPageProxy | null;
  automationReset: Promise<void> | null;
}

interface PendingBrowserConnection {
  promise: Promise<WebContents>;
  resolve: (contents: WebContents) => void;
  reject: (error: BrowserRuntimeError) => void;
  noticeTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

interface PendingBrowserPopup {
  request: BrowserPopupRequest;
  targetUrl: string;
  openerGeneration: number;
  openerContentsId: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

interface PendingBrowserSelection extends BrowserSelectionSession {
  ownerId: number;
}

const POPUP_REQUEST_TTL_MS = 60_000;
const MAX_PENDING_POPUPS = 12;
const BROWSER_SELECTION_TTL_MS = 60_000;

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code:
      | 'browser_disabled'
      | 'browser_no_page'
      | 'browser_page_not_found'
      | 'browser_stale_ref'
      | 'browser_timeout'
      | 'browser_denied',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BrowserRuntimeError';
  }
}

export class BrowserRuntime {
  private enabled = false;
  private accountPartition = '';
  private sharedNewTabUrl = 'about:blank';
  private pages = new Map<string, BrowserPageRuntime>();
  private activeByWorkflow = new Map<string, string>();
  private runner = new AgentBrowserRunner();
  private notify: (state: BrowserState) => void = () => {};
  private notifyConnection: (event: BrowserConnectionEvent) => void = () => {};
  private persistPopupPermission: (
    partition: string,
    origin: string,
    permission: BrowserPopupPermission,
  ) => void = () => {};
  private notifyHistory: (event: BrowserHistoryRuntimeEvent) => void = () => {};
  private pendingConnections = new Map<string, PendingBrowserConnection>();
  private alertedConnections = new Set<string>();
  private hardenedPartitions = new Set<string>();
  private allowedSharedContents = new Set<number>();
  private downloadPermit: { pageId: string; path: string; expiresAt: number } | null = null;
  private popupPermissions = new Map<string, BrowserPopupPermission>();
  private sessionPopupPermissions = new Set<string>();
  private pendingPopups = new Map<string, PendingBrowserPopup>();
  private pendingSelections = new Map<string, PendingBrowserSelection>();

  setStateListener(listener: (state: BrowserState) => void): void {
    this.notify = listener;
  }

  setConnectionListener(listener: (event: BrowserConnectionEvent) => void): void {
    this.notifyConnection = listener;
  }

  setPopupPermissionListener(
    listener: (partition: string, origin: string, permission: BrowserPopupPermission) => void,
  ): void {
    this.persistPopupPermission = listener;
  }

  setHistoryListener(listener: (event: BrowserHistoryRuntimeEvent) => void): void {
    this.notifyHistory = listener;
  }

  configure(options: {
    enabled: boolean;
    serverUrl?: string;
    userId?: string;
    newTabUrl?: string;
    popupPermissions?: BrowserPopupPermissions;
  }): void {
    this.sharedNewTabUrl = allowedBrowserUrl(options.newTabUrl ?? 'about:blank') ?? 'about:blank';
    const partition =
      options.serverUrl && options.userId
        ? browserPartition(options.serverUrl, options.userId)
        : '';
    if (!options.enabled || !partition) {
      this.enabled = false;
      this.popupPermissions.clear();
      this.sessionPopupPermissions.clear();
      this.pendingSelections.clear();
      this.clearPendingPopups(false);
      void this.closeAll();
      this.accountPartition = '';
      this.emit();
      return;
    }
    if (this.accountPartition && this.accountPartition !== partition) {
      this.sessionPopupPermissions.clear();
      this.clearPendingPopups(false);
      void this.closeAll();
    }
    this.enabled = true;
    this.accountPartition = partition;
    this.popupPermissions = this.normalizedPopupPermissions(options.popupPermissions?.[partition]);
    this.hardenPartition(partition);
    this.emit();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  partition(): string | null {
    return this.enabled ? this.accountPartition : null;
  }

  state(): BrowserState {
    return {
      enabled: this.enabled,
      pages: [...this.pages.values()].map((page) => ({ ...page.info })),
      activeByWorkflow: Object.fromEntries(this.activeByWorkflow),
      popupRequests: [...this.pendingPopups.values()].map(({ request }) => ({ ...request })),
    };
  }

  private normalizedPopupPermissions(
    permissions: Record<string, BrowserPopupPermission> | undefined,
  ): Map<string, BrowserPopupPermission> {
    const normalized = new Map<string, BrowserPopupPermission>();
    for (const [rawOrigin, permission] of Object.entries(permissions ?? {})) {
      const origin = browserOrigin(rawOrigin);
      if (origin && (permission === 'allow' || permission === 'block')) {
        normalized.set(origin, permission);
      }
    }
    return normalized;
  }

  private emit(): void {
    this.notify(this.state());
  }

  private requireEnabled(): void {
    if (!this.enabled || !this.accountPartition) {
      throw new BrowserRuntimeError('browser_disabled', '브라우저 접근이 꺼져 있습니다.');
    }
  }

  private emitConnection(
    runtime: BrowserPageRuntime,
    phase: BrowserConnectionEvent['phase'],
  ): void {
    this.notifyConnection({
      phase,
      pageId: runtime.info.pageId,
      workflowId: runtime.info.workflowId,
      workflowName: runtime.info.workflowName,
    });
  }

  private connectedContents(runtime: BrowserPageRuntime): WebContents | null {
    const contents = runtime.contents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private requireConnectedContents(
    runtime: BrowserPageRuntime,
    timeoutMs = 15_000,
  ): Promise<WebContents> {
    const connected = this.connectedContents(runtime);
    if (connected) return Promise.resolve(connected);
    if (runtime.info.mode !== 'shared') {
      return Promise.reject(
        new BrowserRuntimeError('browser_no_page', '페이지가 아직 연결되지 않았습니다.'),
      );
    }
    const existing = this.pendingConnections.get(runtime.info.pageId);
    if (existing) return existing.promise;

    let resolve!: (contents: WebContents) => void;
    let reject!: (error: BrowserRuntimeError) => void;
    const promise = new Promise<WebContents>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const pending: PendingBrowserConnection = { promise, resolve, reject };
    pending.noticeTimer = setTimeout(() => {
      if (this.pendingConnections.get(runtime.info.pageId) !== pending) return;
      this.alertedConnections.add(runtime.info.pageId);
      this.emitConnection(runtime, 'required');
    }, 300);
    pending.timeoutTimer = setTimeout(() => {
      if (this.pendingConnections.get(runtime.info.pageId) !== pending) return;
      this.pendingConnections.delete(runtime.info.pageId);
      if (pending.noticeTimer) clearTimeout(pending.noticeTimer);
      this.emitConnection(runtime, 'timeout');
      reject(
        new BrowserRuntimeError(
          'browser_no_page',
          '브라우저 연결 시간이 초과되었습니다. 연결된 에이전트를 연 뒤 다시 시도해 주세요.',
        ),
      );
    }, timeoutMs);
    this.pendingConnections.set(runtime.info.pageId, pending);
    return promise;
  }

  private resolvePendingConnection(runtime: BrowserPageRuntime, contents: WebContents): void {
    const pending = this.pendingConnections.get(runtime.info.pageId);
    if (pending) {
      this.pendingConnections.delete(runtime.info.pageId);
      if (pending.noticeTimer) clearTimeout(pending.noticeTimer);
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
      pending.resolve(contents);
    }
    if (this.alertedConnections.delete(runtime.info.pageId)) {
      this.emitConnection(runtime, 'connected');
    }
  }

  private rejectPendingConnection(runtime: BrowserPageRuntime): void {
    const pending = this.pendingConnections.get(runtime.info.pageId);
    if (pending) {
      this.pendingConnections.delete(runtime.info.pageId);
      if (pending.noticeTimer) clearTimeout(pending.noticeTimer);
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
      pending.reject(new BrowserRuntimeError('browser_no_page', '브라우저 페이지가 닫혔습니다.'));
    }
    if (this.alertedConnections.delete(runtime.info.pageId)) {
      this.emitConnection(runtime, 'cancelled');
    }
  }

  private hardenPartition(partition: string): void {
    const browserSession = session.fromPartition(partition);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    browserSession.setPermissionCheckHandler(() => false);
    if (this.hardenedPartitions.has(partition)) return;
    this.hardenedPartitions.add(partition);
    // A page cannot initiate an unreviewed local download. BrowserAdvanced can
    // temporarily opt into one explicitly scoped path.
    browserSession.on('will-download', (event, item, contents) => {
      const permit = this.downloadPermit;
      const page = permit ? this.pages.get(permit.pageId) : null;
      if (!permit || permit.expiresAt < Date.now() || page?.contents?.id !== contents.id) {
        event.preventDefault();
        return;
      }
      this.downloadPermit = null;
      item.setSavePath(permit.path);
    });
  }

  async create(request: BrowserCreateRequest): Promise<BrowserPageInfo> {
    this.requireEnabled();
    const workflowId = String(request.workflowId ?? '').trim();
    if (!workflowId) throw new BrowserRuntimeError('browser_no_page', 'workflow_id가 필요합니다.');
    const mode = request.mode === 'background' ? 'background' : 'shared';
    const initialUrl = request.url ?? (mode === 'shared' ? this.sharedNewTabUrl : 'about:blank');
    const url = allowedBrowserUrl(initialUrl);
    if (!url)
      throw new BrowserRuntimeError(
        'browser_denied',
        'http/https/about:blank 주소만 열 수 있습니다.',
      );
    const pageId = randomUUID();
    const info: BrowserPageInfo = {
      pageId,
      workflowId,
      workflowName: String(request.workflowName ?? workflowId),
      mode,
      url,
      title: mode === 'shared' ? '새 탭' : '백그라운드 페이지',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition: this.accountPartition,
      generation: 0,
    };
    const runtime: BrowserPageRuntime = {
      info,
      contents: null,
      window: null,
      proxy: null,
      automationReset: null,
    };
    this.pages.set(pageId, runtime);
    this.activeByWorkflow.set(workflowId, pageId);
    if (mode === 'background') {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: this.accountPartition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      runtime.window = win;
      this.bindContents(runtime, win.webContents);
      await win.loadURL(url).catch((error) => {
        this.patch(runtime, {
          loading: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.emit();
    return { ...runtime.info };
  }

  async ensureShared(workflowId: string, workflowName?: string): Promise<BrowserPageInfo> {
    const current = [...this.pages.values()].find(
      (page) => page.info.workflowId === workflowId && page.info.mode === 'shared',
    );
    return current
      ? { ...current.info }
      : this.create({ workflowId, workflowName, mode: 'shared' });
  }

  /** Called only from the main window's did-attach-webview security gate. */
  registerSharedGuest(contents: WebContents): void {
    if (!this.enabled || contents.session !== session.fromPartition(this.accountPartition)) return;
    this.allowedSharedContents.add(contents.id);
    contents.once('destroyed', () => this.allowedSharedContents.delete(contents.id));
  }

  bindSharedPage(pageId: string, webContentsId: number): BrowserPageInfo {
    this.requireEnabled();
    const runtime = this.pages.get(pageId);
    if (!runtime || runtime.info.mode !== 'shared') {
      throw new BrowserRuntimeError(
        'browser_page_not_found',
        `공유 페이지 ${pageId}를 찾지 못했습니다.`,
      );
    }
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) {
      throw new BrowserRuntimeError('browser_page_not_found', 'webview가 이미 종료되었습니다.');
    }
    if (!this.allowedSharedContents.has(webContentsId)) {
      throw new BrowserRuntimeError('browser_denied', '허용되지 않은 브라우저 partition입니다.');
    }
    this.bindContents(runtime, contents);
    return { ...runtime.info };
  }

  private bindContents(runtime: BrowserPageRuntime, contents: WebContents): void {
    if (runtime.contents?.id === contents.id) return;
    if (runtime.contents && runtime.contents.id !== contents.id) {
      runtime.info.generation += 1;
      void this.resetAutomation(runtime);
    }
    runtime.contents = contents;
    this.resolvePendingConnection(runtime, contents);
    const isCurrent = () => runtime.contents?.id === contents.id;
    this.installPopupHandler(runtime, contents);
    const updateLocation = () => {
      if (!isCurrent() || contents.isDestroyed()) return;
      const next = allowedBrowserUrl(contents.getURL());
      if (!next) return;
      this.patch(runtime, {
        url: next,
        title: contents.getTitle() || runtime.info.title,
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      });
    };
    const emitHistory = (type: BrowserHistoryRuntimeEvent['type']) => {
      if (
        !isCurrent() ||
        contents.isDestroyed() ||
        runtime.info.mode !== 'shared' ||
        runtime.info.url === 'about:blank'
      ) {
        return;
      }
      this.notifyHistory({
        type,
        partition: runtime.info.partition,
        url: runtime.info.url,
        title: runtime.info.title,
        visitedAt: type === 'visit' ? Date.now() : undefined,
      });
    };
    contents.on('will-navigate', (event, url) => {
      if (!allowedBrowserUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!allowedBrowserUrl(url)) event.preventDefault();
    });
    contents.on('did-start-loading', () => {
      if (isCurrent()) this.patch(runtime, { loading: 'loading', error: undefined });
    });
    contents.on('did-stop-loading', () => {
      if (!isCurrent()) return;
      updateLocation();
      this.patch(runtime, { loading: 'idle', error: undefined });
    });
    contents.on('did-finish-load', () => {
      if (!isCurrent()) return;
      updateLocation();
      emitHistory('visit');
    });
    const navigated = () => {
      if (!isCurrent()) return;
      this.clearPendingPopupsForPage(runtime.info.pageId, false);
      runtime.info.generation += 1;
      updateLocation();
    };
    contents.on('did-navigate', navigated);
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return;
      navigated();
      emitHistory('visit');
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!isCurrent()) return;
      this.patch(runtime, { title: title || runtime.info.title });
      emitHistory('title');
    });
    contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isCurrent() || !isMainFrame || code === -3) return;
      this.patch(runtime, {
        loading: 'error',
        error: description,
        url: allowedBrowserUrl(validatedUrl) ?? runtime.info.url,
      });
    });
    contents.on('render-process-gone', (_event, details) => {
      if (!isCurrent()) return;
      runtime.info.generation += 1;
      this.patch(runtime, { loading: 'error', error: `renderer ${details.reason}` });
      // Keep the page-scoped CDP proxy alive. The same WebContents can recover
      // after a renderer replacement/reload, and retaining its loopback port
      // prevents agent-browser from racing a newly allocated port.
    });
    contents.once('destroyed', () => {
      if (!isCurrent()) return;
      this.clearPendingPopupsForPage(runtime.info.pageId, false);
      runtime.info.generation += 1;
      runtime.contents = null;
      void this.resetAutomation(runtime);
      if (runtime.info.mode === 'background') void this.close(runtime.info.pageId);
      else this.emit();
    });
    updateLocation();
    this.emit();
  }

  /**
   * Page-created windows never become native Electron children. A permitted
   * request is replayed through create(), which gives it the normal sandbox,
   * account partition, workflow ownership and renderer binding.
   */
  private installPopupHandler(runtime: BrowserPageRuntime, contents: WebContents): void {
    contents.setWindowOpenHandler(({ url, postBody }) => {
      const targetUrl = allowedBrowserUrl(url);
      const openerOrigin = browserOrigin(contents.getURL());
      const targetOrigin = browserOrigin(targetUrl);
      if (
        runtime.info.mode !== 'shared' ||
        runtime.contents?.id !== contents.id ||
        Boolean(postBody) ||
        !targetUrl ||
        targetUrl === 'about:blank' ||
        !openerOrigin ||
        !targetOrigin
      ) {
        return { action: 'deny' };
      }

      if (
        this.popupPermissions.get(openerOrigin) === 'allow' ||
        this.sessionPopupPermissions.has(openerOrigin)
      ) {
        const generation = runtime.info.generation;
        setImmediate(() => {
          void this.openManagedPopup(runtime, targetUrl, generation, contents.id).catch(
            () => undefined,
          );
        });
      } else {
        this.queueBlockedPopup(runtime, contents, openerOrigin, targetOrigin, targetUrl);
      }
      return { action: 'deny' };
    });
  }

  private queueBlockedPopup(
    runtime: BrowserPageRuntime,
    contents: WebContents,
    openerOrigin: string,
    targetOrigin: string,
    targetUrl: string,
  ): void {
    const duplicate = [...this.pendingPopups.values()].find(
      (pending) =>
        pending.request.pageId === runtime.info.pageId &&
        pending.request.openerOrigin === openerOrigin &&
        pending.targetUrl === targetUrl,
    );
    if (duplicate) return;

    while (this.pendingPopups.size >= MAX_PENDING_POPUPS) {
      const oldest = this.pendingPopups.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removePendingPopup(oldest, false);
    }

    const requestId = randomUUID();
    const request: BrowserPopupRequest = {
      requestId,
      pageId: runtime.info.pageId,
      workflowId: runtime.info.workflowId,
      openerOrigin,
      targetOrigin,
      targetDisplayUrl: sanitizedBrowserUrl(targetUrl),
      createdAt: Date.now(),
    };
    const timeoutTimer = setTimeout(() => {
      this.removePendingPopup(requestId, true);
    }, POPUP_REQUEST_TTL_MS);
    (timeoutTimer as NodeJS.Timeout).unref?.();
    this.pendingPopups.set(requestId, {
      request,
      targetUrl,
      openerGeneration: runtime.info.generation,
      openerContentsId: contents.id,
      timeoutTimer,
    });
    this.emit();
  }

  private removePendingPopup(requestId: string, emit: boolean): void {
    const pending = this.pendingPopups.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutTimer);
    this.pendingPopups.delete(requestId);
    if (emit) this.emit();
  }

  private clearPendingPopupsForPage(pageId: string, emit: boolean): void {
    let removed = false;
    for (const [requestId, pending] of this.pendingPopups) {
      if (pending.request.pageId !== pageId) continue;
      clearTimeout(pending.timeoutTimer);
      this.pendingPopups.delete(requestId);
      removed = true;
    }
    if (removed && emit) this.emit();
  }

  private clearPendingPopups(emit: boolean): void {
    if (!this.pendingPopups.size) return;
    for (const pending of this.pendingPopups.values()) clearTimeout(pending.timeoutTimer);
    this.pendingPopups.clear();
    if (emit) this.emit();
  }

  private async openManagedPopup(
    opener: BrowserPageRuntime,
    targetUrl: string,
    openerGeneration: number,
    openerContentsId: number,
  ): Promise<BrowserPageInfo> {
    if (
      !this.enabled ||
      this.pages.get(opener.info.pageId) !== opener ||
      opener.info.generation !== openerGeneration ||
      opener.contents?.id !== openerContentsId ||
      opener.contents.isDestroyed()
    ) {
      throw new BrowserRuntimeError('browser_stale_ref', '팝업을 요청한 페이지가 변경되었습니다.');
    }
    return this.create({
      workflowId: opener.info.workflowId,
      workflowName: opener.info.workflowName,
      mode: 'shared',
      url: targetUrl,
    });
  }

  async resolvePopup(request: BrowserPopupResolveRequest): Promise<boolean> {
    this.requireEnabled();
    const requestId = String(request?.requestId ?? '').trim();
    const decision = request?.decision;
    if (
      !requestId ||
      (decision !== 'allow_always' && decision !== 'allow_session' && decision !== 'block')
    ) {
      throw new BrowserRuntimeError('browser_denied', '올바른 팝업 권한 선택이 필요합니다.');
    }

    const pending = this.pendingPopups.get(requestId);
    if (!pending) return false;
    const opener = this.pages.get(pending.request.pageId);
    if (
      !opener ||
      opener.info.generation !== pending.openerGeneration ||
      opener.contents?.id !== pending.openerContentsId ||
      opener.contents.isDestroyed()
    ) {
      this.removePendingPopup(requestId, true);
      return false;
    }

    if (decision === 'allow_always' || decision === 'block') {
      const permission: BrowserPopupPermission = decision === 'allow_always' ? 'allow' : 'block';
      this.persistPopupPermission(this.accountPartition, pending.request.openerOrigin, permission);
      this.popupPermissions.set(pending.request.openerOrigin, permission);
    } else {
      this.sessionPopupPermissions.add(pending.request.openerOrigin);
    }

    this.removePendingPopup(requestId, false);
    this.emit();
    if (decision === 'block') return true;
    await this.openManagedPopup(
      opener,
      pending.targetUrl,
      pending.openerGeneration,
      pending.openerContentsId,
    );
    return true;
  }

  private patch(runtime: BrowserPageRuntime, patch: Partial<BrowserPageInfo>): void {
    runtime.info = { ...runtime.info, ...patch };
    this.emit();
  }

  private resetAutomation(runtime: BrowserPageRuntime): Promise<void> {
    if (runtime.automationReset) return runtime.automationReset;
    const proxy = runtime.proxy;
    runtime.proxy = null;
    let reset: Promise<void>;
    reset = (async () => {
      // Let agent-browser close while the old loopback port still exists; only
      // then tear down the proxy. Reversing this order creates ECONNREFUSED.
      await this.runner.cancelPage(runtime.info.pageId);
      await proxy?.stop();
    })().finally(() => {
      if (runtime.automationReset === reset) runtime.automationReset = null;
    });
    runtime.automationReset = reset;
    return reset;
  }

  list(workflowId?: string): BrowserPageInfo[] {
    this.requireEnabled();
    return [...this.pages.values()]
      .filter((page) => !workflowId || page.info.workflowId === workflowId)
      .map((page) => ({ ...page.info }));
  }

  get(pageId: string): BrowserPageInfo | null {
    return this.pages.has(pageId) ? { ...this.pages.get(pageId)!.info } : null;
  }

  activate(pageId: string): BrowserPageInfo {
    this.requireEnabled();
    const runtime = this.pages.get(pageId);
    if (!runtime)
      throw new BrowserRuntimeError(
        'browser_page_not_found',
        `페이지 ${pageId}를 찾지 못했습니다.`,
      );
    this.activeByWorkflow.set(runtime.info.workflowId, pageId);
    this.emit();
    return { ...runtime.info };
  }

  async beginSelection(
    request: BrowserSelectionBeginRequest,
    ownerId: number,
  ): Promise<BrowserSelectionSession> {
    const runtime = await this.resolvePage('', request.pageId, false);
    if (runtime.info.mode !== 'shared') {
      throw new BrowserRuntimeError(
        'browser_denied',
        '보이는 공유 페이지에서만 선택할 수 있습니다.',
      );
    }
    if (this.activeByWorkflow.get(runtime.info.workflowId) !== runtime.info.pageId) {
      throw new BrowserRuntimeError('browser_denied', '현재 활성 브라우저 페이지가 아닙니다.');
    }
    if (request.generation !== runtime.info.generation) {
      throw new BrowserRuntimeError(
        'browser_stale_ref',
        '페이지가 변경되었습니다. 다시 선택해 주세요.',
      );
    }
    if (request.mode !== 'element' && request.mode !== 'region') {
      throw new BrowserRuntimeError('browser_denied', '지원하지 않는 브라우저 선택 방식입니다.');
    }
    await this.requireConnectedContents(runtime);
    for (const [token, pending] of this.pendingSelections) {
      if (pending.ownerId === ownerId && pending.pageId === request.pageId) {
        this.pendingSelections.delete(token);
      }
    }
    const session: PendingBrowserSelection = {
      token: randomUUID(),
      pageId: runtime.info.pageId,
      generation: runtime.info.generation,
      mode: request.mode,
      expiresAt: Date.now() + BROWSER_SELECTION_TTL_MS,
      ownerId,
    };
    this.pendingSelections.set(session.token, session);
    const { ownerId: _ownerId, ...publicSession } = session;
    return publicSession;
  }

  private selectionRuntime(token: string, ownerId: number): BrowserPageRuntime {
    const pending = this.pendingSelections.get(String(token ?? ''));
    if (!pending || pending.ownerId !== ownerId) {
      throw new BrowserRuntimeError(
        'browser_denied',
        '브라우저 선택 권한이 없거나 만료되었습니다.',
      );
    }
    if (pending.expiresAt < Date.now()) {
      this.pendingSelections.delete(pending.token);
      throw new BrowserRuntimeError('browser_timeout', '브라우저 선택 시간이 만료되었습니다.');
    }
    const runtime = this.pages.get(pending.pageId);
    if (!runtime || runtime.info.mode !== 'shared') {
      this.pendingSelections.delete(pending.token);
      throw new BrowserRuntimeError('browser_page_not_found', '선택하던 페이지가 닫혔습니다.');
    }
    if (runtime.info.generation !== pending.generation) {
      this.pendingSelections.delete(pending.token);
      throw new BrowserRuntimeError(
        'browser_stale_ref',
        '페이지가 변경되었습니다. 다시 선택해 주세요.',
      );
    }
    if (this.activeByWorkflow.get(runtime.info.workflowId) !== runtime.info.pageId) {
      this.pendingSelections.delete(pending.token);
      throw new BrowserRuntimeError(
        'browser_denied',
        '선택하던 페이지가 더 이상 활성 상태가 아닙니다.',
      );
    }
    return runtime;
  }

  async inspectSelection(
    request: BrowserSelectionInspectRequest,
    ownerId: number,
  ): Promise<BrowserSelectionPreview | null> {
    const runtime = this.selectionRuntime(request.token, ownerId);
    const pending = this.pendingSelections.get(request.token)!;
    if (pending.mode !== 'element') return null;
    const contents = await this.requireConnectedContents(runtime);
    return inspectBrowserSelection(contents, request.point);
  }

  async completeSelection(
    request: BrowserSelectionCompleteRequest,
    ownerId: number,
  ): Promise<BrowserSelectionResult> {
    const runtime = this.selectionRuntime(request.token, ownerId);
    const pending = this.pendingSelections.get(request.token)!;
    this.pendingSelections.delete(request.token);
    const contents = await this.requireConnectedContents(runtime);
    const dom = await collectBrowserSelection(contents, pending.mode, {
      point: request.point,
      rect: request.rect,
    });
    if (!dom || !dom.elements.length) {
      throw new BrowserRuntimeError(
        'browser_denied',
        pending.mode === 'element'
          ? '선택한 위치에서 전송할 요소를 찾지 못했습니다.'
          : '선택 영역에서 전송할 요소를 찾지 못했습니다.',
      );
    }
    const id = randomUUID();
    const image = await captureBrowserSelection(contents, dom, `browser-selection-${id}`);
    return {
      id,
      workflowId: runtime.info.workflowId,
      pageId: runtime.info.pageId,
      generation: runtime.info.generation,
      kind: pending.mode,
      title: runtime.info.title,
      url: sanitizedBrowserUrl(runtime.info.url),
      rect: dom.rect,
      viewport: dom.viewport,
      elements: dom.elements,
      image,
    };
  }

  cancelSelection(token: string, ownerId: number): boolean {
    const pending = this.pendingSelections.get(String(token ?? ''));
    if (!pending || pending.ownerId !== ownerId) return false;
    this.pendingSelections.delete(pending.token);
    return true;
  }

  async resolvePage(
    workflowId: string,
    pageId?: string,
    createBackground = true,
  ): Promise<BrowserPageRuntime> {
    this.requireEnabled();
    if (pageId) {
      const exact = this.pages.get(pageId);
      if (!exact || (workflowId && exact.info.workflowId !== workflowId)) {
        throw new BrowserRuntimeError(
          'browser_page_not_found',
          `페이지 ${pageId}를 찾지 못했습니다.`,
        );
      }
      return exact;
    }
    // Untargeted agent calls always use the workflow's private background page.
    // Shared pages are controllable only through an explicit page_id so an
    // agent cannot unexpectedly click in the user's visible page.
    const existing = [...this.pages.values()].find(
      (page) => page.info.workflowId === workflowId && page.info.mode === 'background',
    );
    if (existing) return existing;
    if (!createBackground)
      throw new BrowserRuntimeError('browser_no_page', 'workflow에 열린 페이지가 없습니다.');
    const created = await this.create({ workflowId, mode: 'background' });
    return this.pages.get(created.pageId)!;
  }

  async navigate(request: BrowserNavigateRequest): Promise<BrowserPageInfo> {
    const runtime = await this.resolvePage('', request.pageId, false);
    const contents = await this.requireConnectedContents(runtime);
    if (request.action === 'goto') {
      const url = allowedBrowserUrl(request.url);
      if (!url)
        throw new BrowserRuntimeError(
          'browser_denied',
          'http/https/about:blank 주소만 열 수 있습니다.',
        );
      await contents.loadURL(url);
    } else if (request.action === 'back' && contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    } else if (request.action === 'forward' && contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    } else if (request.action === 'reload') {
      contents.reload();
    } else if (request.action === 'stop') {
      contents.stop();
    }
    return { ...runtime.info };
  }

  async runAgentCommand(
    workflowId: string,
    pageId: string | undefined,
    command: string[],
    timeoutMs?: number,
    generation?: number,
  ): Promise<{ page: BrowserPageInfo; result: unknown }> {
    const runtime = await this.resolvePage(workflowId, pageId, true);
    await runtime.automationReset;
    if (generation !== undefined && generation !== runtime.info.generation) {
      throw new BrowserRuntimeError(
        'browser_stale_ref',
        '페이지가 변경되어 snapshot ref가 만료되었습니다.',
      );
    }
    const contents = await this.requireConnectedContents(runtime);
    if (!runtime.proxy) {
      runtime.proxy = new CdpPageProxy(runtime.info.pageId, contents, () => {
        runtime.info.generation += 1;
        this.emit();
      });
    }
    if (command[0] === 'snapshot') {
      // Every snapshot replaces agent-browser's @eN registry. Advancing the
      // public generation makes refs from an earlier snapshot reject locally.
      runtime.info.generation += 1;
      this.emit();
    }
    try {
      const result = await this.runner.run(
        runtime.info.pageId,
        runtime.proxy,
        command,
        timeoutMs,
        () => {
          runtime.info.generation += 1;
          this.emit();
        },
      );
      return { page: { ...runtime.info }, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('browser_timeout:')) {
        throw new BrowserRuntimeError(
          'browser_timeout',
          message.slice('browser_timeout:'.length).trim(),
        );
      }
      if (/(@e\d+|ref|element).*(stale|not found|unknown)|stale.*(@e\d+|ref)/i.test(message)) {
        throw new BrowserRuntimeError('browser_stale_ref', message);
      }
      if (/(connect|target|page).*(closed|missing|not found|refused)|no page/i.test(message)) {
        throw new BrowserRuntimeError('browser_no_page', message);
      }
      throw new BrowserRuntimeError('browser_denied', message);
    }
  }

  async close(pageId: string): Promise<void> {
    const runtime = this.pages.get(pageId);
    if (!runtime) return;
    for (const [token, pending] of this.pendingSelections) {
      if (pending.pageId === pageId) this.pendingSelections.delete(token);
    }
    this.rejectPendingConnection(runtime);
    this.clearPendingPopupsForPage(pageId, false);
    this.pages.delete(pageId);
    await runtime.automationReset;
    await this.runner.cancelPage(pageId);
    await runtime.proxy?.stop();
    runtime.proxy = null;
    const win = runtime.window;
    runtime.window = null;
    if (win && !win.isDestroyed()) win.destroy();
    const next = [...this.pages.values()].find(
      (page) => page.info.workflowId === runtime.info.workflowId,
    );
    if (this.activeByWorkflow.get(runtime.info.workflowId) === pageId) {
      if (next) this.activeByWorkflow.set(runtime.info.workflowId, next.info.pageId);
      else this.activeByWorkflow.delete(runtime.info.workflowId);
    }
    this.emit();
  }

  allowNextDownload(pageId: string, path: string): void {
    if (!this.pages.has(pageId)) {
      throw new BrowserRuntimeError(
        'browser_page_not_found',
        `페이지 ${pageId}를 찾지 못했습니다.`,
      );
    }
    this.downloadPermit = { pageId, path, expiresAt: Date.now() + 30_000 };
  }

  async closeWorkflow(workflowId: string): Promise<void> {
    const ids = [...this.pages.values()]
      .filter((page) => page.info.workflowId === workflowId)
      .map((page) => page.info.pageId);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    const pages = [...this.pages.values()];
    for (const runtime of pages) this.rejectPendingConnection(runtime);
    this.pages.clear();
    this.activeByWorkflow.clear();
    this.downloadPermit = null;
    this.allowedSharedContents.clear();
    this.sessionPopupPermissions.clear();
    this.pendingSelections.clear();
    this.clearPendingPopups(false);
    await Promise.all(pages.map((runtime) => runtime.automationReset));
    await this.runner.closeAll();
    this.emit();
    await Promise.all(
      pages.map(async (runtime) => {
        await runtime.proxy?.stop();
        const win = runtime.window;
        runtime.window = null;
        if (win && !win.isDestroyed()) win.destroy();
      }),
    );
  }
}

let runtime: BrowserRuntime | null = null;

export function getBrowserRuntime(): BrowserRuntime {
  if (!runtime) runtime = new BrowserRuntime();
  return runtime;
}
