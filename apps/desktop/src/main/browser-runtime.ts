import { app, BrowserWindow, WebContentsView, session, webContents, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  BrowserSelectionRect,
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
import { BrowserSessionStore } from './browser-session';
import { runFrameCommand, snapshotFrames } from './browser-frames';
import { diag } from './diag-log';

interface BrowserPageRuntime {
  info: BrowserPageInfo;
  contents: WebContents | null;
  window: BrowserWindow | null;
  proxy: CdpPageProxy | null;
  automationReset: Promise<void> | null;
  view?: WebContentsView;
  /** 마지막 스냅샷이 iframe 요소에 매긴 번호 → DOM 노드(browser-frames). */
  frameRefs?: Map<string, number>;
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

/** 사용자 대신 누르는 명령 직후의 새 창은 팝업 차단 없이 연다. */
const GESTURE_COMMANDS = new Set(['click', 'press', 'dblclick']);
const AGENT_POPUP_WINDOW_MS = 3_000;
const FOCUS_PROBE_MS = 500;
/** 키보드 초점으로 전달되는 agent-browser 명령. */
const KEYBOARD_COMMANDS = new Set(['fill', 'type', 'press', 'keyboard', 'keydown', 'keyup']);

/**
 * 웹뷰 게스트에 키보드 초점을 준다. 게스트의 focus() 만으로는 앱 창(임베더) 안의 DOM 초점이 채팅 입력창에
 * 그대로 남는다 — 임베더가 이 게스트를 품은 <webview> 요소에 초점을 줘야 한다.
 */
async function focusGuest(contents: WebContents): Promise<void> {
  const host = (contents as WebContents & { hostWebContents?: WebContents }).hostWebContents;
  if (host && !host.isDestroyed()) {
    // 임베더 초점을 이 <webview> 로 옮겨도 게스트 초점은 다른 탭에 남을 수 있다 — 페이지가 연 새 탭(팝업)이 뜨면
    // 숨은 원래 탭이 게스트 초점을 쥔 채 남아 입력이 사라졌다(10/16 BO 브랜드 찾기 팝업). focus() 만으로는 안 넘어가고
    // blur() 뒤 focus() 를 해야 넘어갔다(실측). 게스트에 초점이 없으면 그렇게 한다.
    // 메인 프레임에 묻는다 — contents.executeJavaScript 는 로딩이 끝나길 기다려, 끝나지 않는 요청이 남은 페이지에서
    // 글자 넣기가 100초 넘게 멈췄다(10/18 element.eleme.io). 알림창으로 멈춘 페이지도 오래 기다리지 않는다.
    const guestFocused = await Promise.race([
      contents.mainFrame.executeJavaScript('document.hasFocus()', true) as Promise<boolean>,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), FOCUS_PROBE_MS)),
    ]).catch(() => true);
    await host
      .executeJavaScript(
        `(() => { const w = [...document.querySelectorAll('webview')].find((v) => v.getWebContentsId && v.getWebContentsId() === ${contents.id}); if (!w) return false; if (document.activeElement !== w) w.focus(); if (${!guestFocused}) { w.blur(); w.focus(); } return true; })()`,
        true,
      )
      .catch(() => false);
  }
  contents.focus();
}

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
  private pageScope = new AsyncLocalStorage<{ pageId: string; signal: AbortSignal }>();

  /** A fill may touch its form and its popups, never a different visible tab. */
  withPageScope<T>(pageId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return this.pageScope.run({ pageId, signal }, run);
  }

  get actionSignal(): AbortSignal | undefined {
    return this.pageScope.getStore()?.signal;
  }

  private assertPageScope(pageId?: string): void {
    const scope = this.pageScope.getStore();
    if (!scope) return;
    if (scope.signal.aborted) throw new BrowserRuntimeError('browser_denied', '폼 입력이 중단되었습니다.');
    let page = pageId ? this.pages.get(pageId)?.info : undefined;
    for (let depth = 0; page && depth <= this.pages.size; depth++) {
      if (page.pageId === scope.pageId && this.pages.has(scope.pageId)) return;
      page = page.mode === 'popup' && page.openerPageId ? this.pages.get(page.openerPageId)?.info : undefined;
    }
    throw new BrowserRuntimeError('browser_denied', 'BrowserFill 대상 폼과 그 팝업만 조작할 수 있습니다.');
  }

  private sessionPersistence = false;

  constructor(private readonly sessionStore?: BrowserSessionStore) {}

  suspendSessionPersistence(): void {
    if (this.sessionPersistence && this.accountPartition)
      this.sessionStore?.save(this.accountPartition, this.state());
    this.sessionPersistence = false;
  }

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
  private downloadPermits = new Map<string, {
    path: string;
    expiresAt: number;
    started: boolean;
    completed: boolean;
    cancel?: () => void;
    done: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private downloadQueues = new Map<string, Promise<unknown>>();
  private popupPermissions = new Map<string, BrowserPopupPermission>();
  private sessionPopupPermissions = new Set<string>();
  private pendingPopups = new Map<string, PendingBrowserPopup>();
  /**
   * 에이전트가 사용자 대신 누른 직후(페이지별 시각까지)의 새 창은 막지 않고 연다 — 사용자가 시킨
   * 조작이다("블로그 들어가 봐" → 네이버 메뉴 링크는 새 창으로 열려 팝업 차단에 걸렸다, 10/5).
   */
  private agentGestureUntil = new Map<string, number>();
  private pendingSelections = new Map<string, PendingBrowserSelection>();
  private popupHostWindow: BrowserWindow | null = null;

  setPopupHostWindow(window: BrowserWindow): void {
    this.popupHostWindow = window;
    window.once('closed', () => {
      if (this.popupHostWindow !== window) return;
      this.popupHostWindow = null;
      for (const page of this.pages.values()) {
        if (page.view) void this.close(page.info.pageId);
      }
    });
  }

  updatePopupSurface(pageId: string, rect: BrowserSelectionRect | null): void {
    const page = this.pages.get(pageId);
    const host = this.popupHostWindow;
    if (!page?.view || !host || host.isDestroyed()) return;
    if (!rect || this.activeByWorkflow.get(page.info.workflowId) !== pageId) {
      page.view.setVisible(false);
      return;
    }
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width < 0 ||
      rect.height < 0
    ) {
      throw new BrowserRuntimeError('browser_denied', '올바른 브라우저 표시 영역이 필요합니다.');
    }
    const zoom = host.webContents.getZoomFactor();
    const bounds = host.getContentBounds();
    const x = Math.max(0, Math.min(bounds.width, Math.round(rect.x * zoom)));
    const y = Math.max(0, Math.min(bounds.height, Math.round(rect.y * zoom)));
    const width = Math.max(0, Math.min(bounds.width - x, Math.round(rect.width * zoom)));
    const height = Math.max(0, Math.min(bounds.height - y, Math.round(rect.height * zoom)));
    page.view.setBounds({ x, y, width, height });
    page.view.setVisible(width > 0 && height > 0);
  }

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
    const restoreSession = this.accountPartition !== partition || !this.sessionPersistence;
    this.enabled = true;
    this.accountPartition = partition;
    this.popupPermissions = this.normalizedPopupPermissions(options.popupPermissions?.[partition]);
    this.hardenPartition(partition);
    if (restoreSession) {
      const saved = this.sessionStore?.load(partition);
      for (const info of saved?.pages ?? []) {
        this.pages.set(info.pageId, {
          info,
          contents: null,
          window: null,
          proxy: null,
          automationReset: null,
        });
      }
      this.activeByWorkflow = new Map(Object.entries(saved?.activeByWorkflow ?? {}));
    }
    this.sessionPersistence = true;
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
    const state = this.state();
    if (this.sessionPersistence && this.accountPartition)
      this.sessionStore?.save(this.accountPartition, state);
    this.notify(state);
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
      const pageId = [...this.pages.values()].find((page) => page.contents?.id === contents.id)?.info.pageId;
      const permit = pageId ? this.downloadPermits.get(pageId) : undefined;
      if (!permit || permit.expiresAt < Date.now() || permit.started) {
        event.preventDefault();
        return;
      }
      permit.started = true;
      permit.cancel = () => item.cancel();
      item.setSavePath(permit.path);
      item.once('done', (_event, state) => {
        if (state === 'completed') { permit.completed = true; permit.resolve(); }
        else permit.reject(new BrowserRuntimeError('browser_denied', `다운로드가 ${state} 상태로 끝났습니다.`));
      });
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
      if (runtime.info.mode !== 'shared') void this.close(runtime.info.pageId);
      else this.emit();
    });
    updateLocation();
    this.emit();
  }

  // Let Chromium keep the original WindowProxy/opener; replaying only the URL breaks selection dialogs.
  private installPopupHandler(runtime: BrowserPageRuntime, contents: WebContents): void {
    contents.setWindowOpenHandler(({ url, postBody, referrer }) => {
      const targetUrl = allowedBrowserUrl(url);
      const openerOrigin = browserOrigin(contents.getURL());
      const targetOrigin = browserOrigin(targetUrl);
      if (
        !this.enabled ||
        !this.popupHostWindow ||
        this.popupHostWindow.isDestroyed() ||
        this.pages.get(runtime.info.pageId) !== runtime ||
        runtime.info.partition !== this.accountPartition ||
        runtime.info.mode === 'background' ||
        runtime.contents?.id !== contents.id ||
        Boolean(postBody) ||
        !targetUrl ||
        targetUrl === 'about:blank' ||
        !openerOrigin ||
        !targetOrigin
      ) {
        return { action: 'deny' };
      }

      const byAgent = (this.agentGestureUntil.get(runtime.info.pageId) ?? 0) > Date.now();
      if (byAgent) this.agentGestureUntil.delete(runtime.info.pageId); // 누름 한 번에 새 창 하나
      const permission = this.popupPermissions.get(openerOrigin);
      if (
        permission !== 'block' &&
        (byAgent || permission === 'allow' || this.sessionPopupPermissions.has(openerOrigin))
      ) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              partition: runtime.info.partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              webSecurity: true,
              allowRunningInsecureContent: false,
              webviewTag: false,
            },
          },
          createWindow: (options) => {
            const view = new WebContentsView(options);
            this.bindPopupView(runtime, view, targetUrl);
            // Noopener links may arrive without an existing WebContents to adopt.
            if (!('webContents' in options) || !options.webContents) {
              void view.webContents
                .loadURL(targetUrl, { httpReferrer: referrer })
                .catch(() => undefined);
            }
            return view.webContents;
          },
        };
      } else {
        this.queueBlockedPopup(runtime, contents, openerOrigin, targetOrigin, targetUrl);
      }
      return { action: 'deny' };
    });
  }

  private bindPopupView(runtime: BrowserPageRuntime, view: WebContentsView, url: string): void {
    const host = this.popupHostWindow;
    if (
      !host ||
      host.isDestroyed() ||
      !this.enabled ||
      this.pages.get(runtime.info.pageId) !== runtime ||
      view.webContents.session !== runtime.contents?.session
    ) {
      view.webContents.close();
      throw new BrowserRuntimeError('browser_stale_ref', '팝업을 요청한 페이지가 변경되었습니다.');
    }
    const pageId = randomUUID();
    const popup: BrowserPageRuntime = {
      info: {
        ...runtime.info,
        pageId,
        mode: 'popup',
        url,
        title: '팝업',
        loading: 'loading',
        error: undefined,
        canGoBack: false,
        canGoForward: false,
        generation: 0,
        openerPageId: runtime.info.pageId,
      },
      contents: null,
      window: null,
      view,
      proxy: null,
      automationReset: null,
    };
    view.setVisible(false);
    host.contentView.addChildView(view);
    this.pages.set(pageId, popup);
    this.bindContents(popup, view.webContents);
    view.webContents.on('focus', () => {
      if (this.pages.get(pageId) !== popup) return;
      this.activeByWorkflow.set(popup.info.workflowId, pageId);
      this.emit();
    });
    this.activate(pageId);
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
    // A denied window.open() cannot be resumed with its opener intact. The user must retry it.
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
    if (runtime.view && runtime.contents && !runtime.contents.isDestroyed()) {
      runtime.contents.focus();
    }
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
    this.assertPageScope(pageId);
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

  /**
   * 페이지에서 읽기 전용 스크립트를 실행한다(빠른 조작의 칸 이름 읽기). 알림창 등으로 페이지가 멈추면
   * timeoutMs 뒤 포기한다.
   *
   * contents.executeJavaScript 는 페이지가 로딩 중이면 로딩이 끝날 때까지 기다린다. 끝나지 않는 요청이 남은
   * 페이지(10/18 element.eleme.io 폼 문서)에서는 매번 timeoutMs 를 넘겨 칸 이름이 하나도 붙지 않았다. 메인 프레임에
   * 바로 실행한다.
   */
  async pageScript<T>(workflowId: string, pageId: string, code: string, timeoutMs: number): Promise<T> {
    const runtime = await this.resolvePage(workflowId, pageId, false);
    const contents = await this.requireConnectedContents(runtime);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.assertPageScope(pageId);
      return await Promise.race([
        contents.mainFrame.executeJavaScript(code) as Promise<T>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new BrowserRuntimeError('browser_timeout', '페이지 스크립트가 시간 안에 끝나지 않았습니다.')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async runAgentCommand(
    workflowId: string,
    pageId: string | undefined,
    command: string[],
    timeoutMs?: number,
    generation?: number,
    context?: { signal?: AbortSignal },
  ): Promise<{ page: BrowserPageInfo; result: unknown; openedPages?: BrowserPageInfo[] }> {
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
    // 글자 넣기·키 누르기는 키보드 초점을 따라간다 — 앱 창의 채팅 입력창에 초점이 있으면 CDP 로 보낸
    // 글자와 Enter 가 웹뷰가 아니라 채팅 입력창으로 들어가 그대로 전송된다(10/5 실측: 검색어 "원피스" 가
    // 채팅 메시지로 나감). 키보드 명령 전에는 이 탭(게스트)에 초점을 준다.
    if (KEYBOARD_COMMANDS.has(command[0] ?? '') && !contents.isDestroyed())
      await focusGuest(contents);
    if (GESTURE_COMMANDS.has(command[0] ?? '')) {
      this.agentGestureUntil.set(runtime.info.pageId, Date.now() + AGENT_POPUP_WINDOW_MS);
    }
    if (command[0] === 'snapshot') {
      // Every snapshot replaces agent-browser's @eN registry. Advancing the
      // public generation makes refs from an earlier snapshot reject locally.
      runtime.info.generation += 1;
      this.emit();
    }
    const closedPopupResult = () => {
      const opener = this.pages.get(runtime.info.openerPageId ?? '');
      if (
        runtime.info.mode !== 'popup' ||
        !GESTURE_COMMANDS.has(command[0] ?? '') ||
        this.pages.has(runtime.info.pageId) ||
        !opener
      )
        return null;
      return {
        page: { ...opener.info },
        result: {
          popup_closed: true,
          message:
            'Popup closed during the interaction. Inspect the parent page to verify the result.',
        },
      };
    };
    const send = (method: string, params?: Record<string, unknown>) => contents.debugger.sendCommand(method, params);
    const execute = async () => {
      // 연결·초기화를 기다리는 사이 사용자가 멈췄으면 실행하지 않는다 — 저장 가드를 걷어낼 때 이 검사도 같이 빠졌다(10/22 리뷰).
      if (context?.signal?.aborted) throw new BrowserRuntimeError('browser_denied', 'Browser action cancelled.');
      this.assertPageScope(runtime.info.pageId);
      if (command[0] !== 'snapshot' && generation !== undefined && generation !== runtime.info.generation)
        throw new BrowserRuntimeError('browser_stale_ref', '페이지가 변경되어 snapshot ref가 만료되었습니다.');
      const pagesBefore = new Set(this.pages.keys());
      const interactionResult = async (result: unknown) => {
        const newlyOpened = () => this.list(workflowId).filter((page) =>
          page.openerPageId === runtime.info.pageId && !pagesBefore.has(page.pageId));
        let openedPages = newlyOpened();
        // A new WebContents may still report about:blank before its first navigation.
        const until = Date.now() + 1500;
        while (openedPages.some(page => !page.url || page.url === 'about:blank') && Date.now() < until && !context?.signal?.aborted) {
          await new Promise(resolve => setTimeout(resolve, 50));
          openedPages = newlyOpened();
        }
        return { page: { ...runtime.info }, result,
          ...(openedPages.length ? { openedPages } : {}) };
      };
      const proxy = runtime.proxy!;
      const frameRef = command.find((arg) => /^@e\d+$/.test(arg))?.slice(1);
      const frameNode = frameRef ? runtime.frameRefs?.get(frameRef) : undefined;
      if (frameNode !== undefined) {
        await proxy.start(); // debugger 를 붙인다(이미 붙었으면 그대로)
        const result = await runFrameCommand(send, frameNode, command).catch((error) => {
          throw new BrowserRuntimeError('browser_denied', `iframe 요소 조작 실패: ${error instanceof Error ? error.message : String(error)}`);
        });
        if (result === null)
          throw new BrowserRuntimeError('browser_denied', `iframe 안 요소에는 ${command[0]} 를 쓸 수 없습니다(click·fill·type·get value 만).`);
        return interactionResult(result);
      }
      try {
        const result = await this.runner.run(
          runtime.info.pageId,
          proxy,
          command,
          timeoutMs,
          () => {
            runtime.info.generation += 1;
            this.emit();
          },
        );
        if (command[0] === 'snapshot') await this.addFrameElements(runtime, send, result);
        return closedPopupResult() ?? interactionResult(result);
      } catch (error) {
        // window.close() can cancel the CLI before its successful click response exits.
        const closed = closedPopupResult();
        if (closed) return closed;
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
    };
    return execute();
  }

  /** 스냅샷 끝에 iframe 속 요소 줄을 붙인다 — 번호는 agent-browser 가 매긴 마지막 번호 다음부터. */
  private async addFrameElements(
    runtime: BrowserPageRuntime,
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    result: unknown,
  ): Promise<void> {
    runtime.frameRefs = new Map();
    const data = (result as { data?: { refs?: Record<string, unknown>; snapshot?: string } } | undefined)?.data;
    if (!data) return;
    try {
      const last = Math.max(0, ...Object.keys(data.refs ?? {}).map((k) => Number(k.slice(1)) || 0));
      const frames = await snapshotFrames(send, last + 1);
      if (!frames.lines.length) return;
      // 요소가 없으면 agent-browser 는 "(no interactive elements)" 한 줄만 준다.
      const text = (data.snapshot ?? '').trim();
      data.snapshot = [...(text && !/^\(.*\)$/.test(text) ? [text] : []), ...frames.lines].join('\n');
      data.refs = { ...data.refs, ...frames.refs };
      runtime.frameRefs = frames.targets;
    } catch (error) {
      diag('browser-frames', 'snapshot-failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Stop a file command when its connected-folder grant is revoked. */
  async cancelAgentCommand(pageId: string): Promise<void> {
    await this.runner.cancelPage(pageId);
    const runtime = this.pages.get(pageId);
    if (runtime) {
      runtime.info.generation += 1;
      this.emit();
    }
    this.revokeDownload(pageId);
  }

  async close(pageId: string): Promise<void> {
    const runtime = this.pages.get(pageId);
    if (!runtime) return;
    this.revokeDownload(pageId);
    for (const [token, pending] of this.pendingSelections) {
      if (pending.pageId === pageId) this.pendingSelections.delete(token);
    }
    this.rejectPendingConnection(runtime);
    this.clearPendingPopupsForPage(pageId, false);
    this.pages.delete(pageId);
    if (runtime.view) {
      if (this.popupHostWindow && !this.popupHostWindow.isDestroyed()) {
        runtime.view.setVisible(false);
        this.popupHostWindow.contentView.removeChildView(runtime.view);
      }
    }
    const next =
      this.pages.get(runtime.info.openerPageId ?? '') ??
      [...this.pages.values()].find((page) => page.info.workflowId === runtime.info.workflowId);
    if (this.activeByWorkflow.get(runtime.info.workflowId) === pageId) {
      if (next) this.activeByWorkflow.set(runtime.info.workflowId, next.info.pageId);
      else this.activeByWorkflow.delete(runtime.info.workflowId);
      if (next?.contents && runtime.info.mode === 'popup') {
        if (next.window) next.window.focus();
        else void focusGuest(next.contents).catch(() => undefined);
      }
    }
    this.emit();
    await Promise.all(
      [...this.pages.values()]
        .filter((page) => page.info.openerPageId === pageId)
        .map((page) => this.close(page.info.pageId)),
    );
    await runtime.automationReset;
    await this.runner.cancelPage(pageId);
    await runtime.proxy?.stop();
    runtime.proxy = null;
    const win = runtime.window;
    runtime.window = null;
    if (win && !win.isDestroyed()) win.destroy();
    if (runtime.view && runtime.contents && !runtime.contents.isDestroyed())
      runtime.contents.close();
  }

  private revokeDownload(pageId: string): void {
    const permit = this.downloadPermits.get(pageId);
    if (!permit) return;
    this.downloadPermits.delete(pageId);
    if (permit.started && !permit.completed) {
      try { permit.cancel?.(); } catch { /* already ended */ }
      permit.reject(new BrowserRuntimeError('browser_denied', '다운로드가 중단되었습니다.'));
    }
  }

  /** Electron and agent-browser may each save a download; callers give them separate private paths. */
  async runDownloadCommand(
    workflowId: string,
    pageId: string,
    command: string[],
    electronPath: string,
    timeoutMs?: number,
    generation?: number,
  ): Promise<{ page: BrowserPageInfo; result: unknown; electronSaved: boolean }> {
    const previous = this.downloadQueues.get(pageId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      let resolveDone!: () => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      // An unsuccessful command may never start a download; suppress an orphan rejection.
      void done.catch(() => undefined);
      const permit = {
        path: electronPath,
        expiresAt: Date.now() + 120_000,
        started: false,
        completed: false,
        done,
        resolve: resolveDone,
        reject: rejectDone,
      };
      this.downloadPermits.set(pageId, permit);
      try {
        const run = await this.runAgentCommand(workflowId, pageId, command, timeoutMs, generation);
        if (permit.started) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              done,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new BrowserRuntimeError('browser_timeout', '다운로드 완료를 기다리는 시간이 지났습니다.')), 120_000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        return { ...run, electronSaved: permit.started };
      } finally {
        this.revokeDownload(pageId);
      }
    });
    const tail = task.then(() => undefined, () => undefined);
    this.downloadQueues.set(pageId, tail);
    try { return await task; }
    finally { if (this.downloadQueues.get(pageId) === tail) this.downloadQueues.delete(pageId); }
  }

  async closeWorkflow(workflowId: string): Promise<void> {
    const ids = [...this.pages.values()]
      .filter((page) => page.info.workflowId === workflowId)
      .map((page) => page.info.pageId);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    this.suspendSessionPersistence();
    const pages = [...this.pages.values()];
    for (const runtime of pages) this.rejectPendingConnection(runtime);
    this.pages.clear();
    this.activeByWorkflow.clear();
    for (const pageId of this.downloadPermits.keys()) this.revokeDownload(pageId);
    this.downloadQueues.clear();
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
        if (runtime.view) {
          if (this.popupHostWindow && !this.popupHostWindow.isDestroyed()) {
            this.popupHostWindow.contentView.removeChildView(runtime.view);
          }
          if (runtime.contents && !runtime.contents.isDestroyed()) runtime.contents.close();
        }
      }),
    );
  }
}

let runtime: BrowserRuntime | null = null;

export function getBrowserRuntime(): BrowserRuntime {
  if (!runtime) runtime = new BrowserRuntime(new BrowserSessionStore(app.getPath('userData')));
  return runtime;
}
