/**
 * Electron main process — the native shell of XGen Dex.
 *
 * Owns: the app window, connector.json config, OS-keychain token storage, the
 * auto-updater, and the IPC surface the renderer uses to reach the XGEN API.
 * The renderer never talks to the network or keychain directly — everything
 * goes through the typed `window.xgen` bridge (see preload). The XgenClient
 * transport lives here in the main process (Node fetch), so tokens stay out of
 * the renderer.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  protocol,
  net,
  session,
  clipboard,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import {
  XgenClient,
  TEAMS_ATTACHMENT_EXTENSIONS,
  teamsAttachmentRejectReason,
  type ChatEvent,
  type ChatRequest,
  type TeamsAttachment,
  type TtsSpeakOptions,
  type SshServerInput,
  applyNotificationPreferenceUpdate,
  notificationProfileForAccount,
  shareBodyOf,
  withNotificationProfile,
  type NotificationEvent,
  type NotificationPreferenceUpdate,
  type NotificationProfile,
  type NotificationRendererContext,
  type NotificationTarget,
  type TeamsEvent,
} from '@dex/protocol';
import { bindDesktopHost } from './dex-host';
import {
  loadConfig,
  saveConfig,
  resetConfig,
  normalizeServerUrl,
  type ConnectorConfig,
  type McpServerConfig,
} from './config';
import {
  tokenStore,
  credentialStore,
  storageStatus,
  mcpSecretStore,
  mcpOAuthStore,
} from './keychain';
import { splitServerSecrets, withResolvedSecrets } from '@dex/engine/mcp-secrets';
import { authorizeMcpServer, hasOAuthTokens, clearOAuth } from '@dex/engine/mcp-oauth';
import {
  initUpdater,
  setAutoUpdate,
  setUpdateServer,
  getAutoUpdate,
  checkNow,
  checkForUpdatesAfterLogin,
  disposeUpdater,
} from './updater';
import { CHANNELS } from './ipc';
// ⚠ 정적 import 여야 한다. 런타임 require('./x') 는 번들러가 해석하지 않아
// 패키징본에서 'Cannot find module' 로 죽고, UI 는 조용히 아무 일도 하지
// 않는다 (v1.7.0 에서 에이전트 추가가 먹통이던 원인).
import { FilestoreSyncTransport, HttpSyncTransport, fetchIndexSeqs, WorkspaceWsClient } from './sync-transport';
import { FileSystemController } from './file-system';
import { WorkspaceBridge } from './workspace-bridge-tools';
import {
  consumeInstallOptions,
  resolveDataRoot,
  settleDataRoot,
  writeDataRootMarker,
} from './data-root';
import type { SyncRemote } from './local-sync';
import { isSafeRelPath } from './sync-plan';
import { hostname, userInfo } from 'os';
import { defaultDeviceName } from './device-name';
import { accountKey } from './file-system';
import { TRAY_ICON_B64 } from './tray-icon';
import { getMcpManager, type McpHttpFetch } from '@dex/engine/mcp-manager';
import { getMcpBridge } from '@dex/engine/mcp-bridge';
import {
  getLocalToolProvider,
  mcpAddServerToolSchema,
  mcpRemoveServerToolSchema,
  mcpListServersToolSchema,
  MCP_ADD_TOOL,
  MCP_REMOVE_TOOL,
  MCP_LIST_TOOL,
  type LocalToolDelegate,
  type LocalToolResult,
} from '@dex/engine/local-tools';
import {
  clearMcpRuntimeLogs,
  mcpRuntimeLogs,
  onMcpRuntimeLog,
  setMcpRuntimeLogEnabled,
} from '@dex/engine/mcp-runtime-log';
import {
  buildSsoUrl,
  parseSsoLoginResponse,
  shouldAllowPrivateCertificate,
  shouldIgnorePrivateCertificateError,
} from '@dex/engine/connection-security';
import { createSsoWindowOptions } from './sso-window-options';
import { getBrowserRuntime } from './browser-runtime';
import { BrowserHistoryStore } from './browser-history';
import { getBrowserToolProvider } from './browser-tools';
import { allowedBrowserUrl } from './browser-security';
import type {
  BrowserHistoryListRequest,
  BrowserHistoryRemoveRequest,
  BrowserHistorySuggestionsRequest,
  BrowserPopupPermission,
  BrowserPopupResolveRequest,
} from '@dex/protocol/browser';
import { systemMetricsSampler } from './system-metrics';
import { TeamsSocketHub } from './teams-ws';
import { NotificationCenter } from './notification-center';
import {
  openAttachmentTemp,
  pickFilesToAttach,
  readFileForUpload,
  saveAttachmentAs,
} from './teams-files';

// ⚠ 표시 이름(제품명/설치 파일/창 제목)은 "XGen Dex"로 바뀌었지만, Electron 은
// app.getPath('userData') 등 기본 데이터 경로를 **app.name**(기본값 = package.json
// productName)에서 파생시킨다 — 아무 조치 없이 productName 만 바꾸면 기존
// 사용자의 로그인 세션·로컬 런타임·동기화 상태가 들어있는 데이터 폴더
// (%APPDATA%\XGEN-Connector 등)를 잃어버리고 새 폴더로 조용히 갈라진다.
// 여기서 옛 이름으로 고정해 데이터 연속성을 지킨다(keytar 서비스 이름도
// keychain.ts 에서 별도로 'xgen-connector' 로 고정돼 있어 이 값과 무관하다).
// app.getPath 를 부르는 어떤 코드보다도 먼저 실행돼야 하므로 파일 최상단에 둔다.
app.setName('XGEN-Connector');
// NSIS 가 만드는 Start Menu shortcut 의 AUMID(electron-builder appId)와 반드시
// 같아야 Windows 알림 아이콘/클릭 활성화가 안정적으로 연결된다.
if (process.platform === 'win32') app.setAppUserModelId('com.plateerlab.xgen.connector');

let browserHistoryStore: BrowserHistoryStore | null = null;
function getBrowserHistoryStore(): BrowserHistoryStore {
  if (!browserHistoryStore) browserHistoryStore = new BrowserHistoryStore(app.getPath('userData'));
  return browserHistoryStore;
}

const IS_LINUX = process.platform === 'linux';

// Custom scheme the avatar overlay loads model assets through. Registered
// BEFORE app-ready. The renderer (a file:// / WebGL context) can't reliably
// fetch cross-origin avatar assets from the user's XGEN server (CORS/CSP vary
// by deployment); routing them through the MAIN process (Electron net.fetch, no
// CORS, no CSP) makes it work regardless. `standard` lets relative sibling refs
// (moc3/textures/atlas) resolve; `corsEnabled`+`bypassCSP` keep WebGL happy.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'xgenavatar',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

let tray: Tray | null = null;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let ssoWindow: BrowserWindow | null = null;
let client: XgenClient | null = null;
const aborters = new Map<string, AbortController>();

/** The last avatar/chat state pushed from the main window, replayed to a
 * freshly-opened overlay so it isn't blank until the next stream event. */
let lastOverlayState: unknown = null;

/** Send to a window's renderer only if it (and its webContents) are still
 * alive. During app quit / auto-update restart the window can be torn down
 * while late callbacks (e.g. McpBridge.stop → status emit) still fire, and a
 * bare `win?.webContents.send` throws "Object has been destroyed" and crashes
 * the main process. This guards + swallows that race. */
function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  } catch {
    /* window/webContents torn down mid-send — ignore */
  }
}

/** Broadcast a config change to every window (main + overlay + quick-chat) so
 * live prefs (theme, subtitles, avatarHidden, toggles) apply everywhere. */
function broadcastConfig(next: ConnectorConfig): void {
  for (const w of [mainWindow, overlayWindow, quickChatWindow]) {
    safeSend(w, CHANNELS.configChanged, next);
  }
}

/** Load a renderer page in either dev (Vite server) or prod (bundled file). */
function loadRendererPage(win: BrowserWindow, page: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(`${devUrl}/${page}`);
  else void win.loadFile(join(__dirname, `../renderer/${page}`));
}

function handleAuthFailure(): void {
  getMcpBridge().stop();
  getBrowserRuntime().configure({ enabled: false });
  safeSend(mainWindow, CHANNELS.authFailed);
}

function getClient(): XgenClient {
  const cfg = loadConfig();
  if (!client) {
    client = new XgenClient({
      baseUrl: normalizeServerUrl(cfg.serverUrl),
      // Chromium 네트워크 스택을 사용해 OS 프록시·인증서 정책을 공유한다.
      fetch: (input, init) => net.fetch(input, init),
      onAuthFailure: handleAuthFailure,
      // 토큰이 회전되는 **모든** 지점에서 keychain 을 즉시 갱신한다. 게이트웨이는
      // 회전 시 이전 토큰의 세션 키를 지우므로, 여기서 놓치면 keychain 을 읽는
      // 장수명 소비자(WS 브릿지·워크스페이스 동기화)가 폐기된 토큰으로 접속하다
      // 403(session revoked)에 갇힌다 — 실기에서 채팅은 되는데 WS 만 죽던 원인.
      onTokensRotated: (access, refresh) => {
        void tokenStore.setAccess(access);
        if (refresh) void tokenStore.setRefresh(refresh);
      },
    });
  } else {
    client.setBaseUrl(normalizeServerUrl(cfg.serverUrl));
  }
  return client;
}

/** 기본 세션의 인증서 정책을 현재 서버 설정에 맞춰 설치한다. */
function applyCertificatePolicy(): void {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const cfg = loadConfig();
    const allowed = shouldAllowPrivateCertificate(
      normalizeServerUrl(cfg.serverUrl),
      cfg.allowPrivateCertificate === true,
      request.hostname,
      request.verificationResult,
    );
    // 0은 이번 인증서를 승인하고, -3은 Chromium의 원래 판정을 사용한다.
    callback(allowed ? 0 : -3);
  });
}

function createWindow(): void {
  const cfg = loadConfig();
  mainWindow = new BrowserWindow({
    width: cfg.window?.width ?? 1100,
    height: cfg.window?.height ?? 760,
    x: cfg.window?.x,
    y: cfg.window?.y,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'XGen Dex',
    // Hide the generic File/Edit/View/Window/Help bar (Alt still reveals it on
    // Win/Linux) so the app doesn't read as a raw Electron shell.
    autoHideMenuBar: true,
    // Paint the theme background immediately to avoid a white flash before the
    // renderer's CSS loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 퀵 챗은 메인 창을 깨우지 않고 메시지를 전달한다 — 최소화/숨김 상태의
      // 렌더러도 스트림 이벤트를 즉시 처리하도록 스로틀링을 끈다.
      backgroundThrottling: false,
      // Shared browser pages are sandboxed <webview>s. Attachment is separately
      // allowlisted below; enabling the tag alone grants no URL/partition.
      webviewTag: true,
    },
  });

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const runtime = getBrowserRuntime();
    const expectedPartition = runtime.partition();
    const safeUrl = allowedBrowserUrl(params.src);
    if (
      !runtime.isEnabled() ||
      !expectedPartition ||
      params.partition !== expectedPartition ||
      !safeUrl
    ) {
      event.preventDefault();
      return;
    }
    // Never accept preferences supplied by page markup. The guest has no Node,
    // preload, unmanaged-popup or web-security escape hatch.
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    getBrowserRuntime().registerSharedGuest(guest);
  });
  const browserRuntime = getBrowserRuntime();
  browserRuntime.setStateListener((state) =>
    safeSend(mainWindow, CHANNELS.browserStateEvent, state),
  );
  browserRuntime.setConnectionListener((event) =>
    safeSend(mainWindow, CHANNELS.browserConnectionEvent, event),
  );
  browserRuntime.setHistoryListener((event) => {
    void getBrowserHistoryStore()
      .apply(event)
      .catch((error) => console.error('[browser-history] 기록 실패:', error));
  });
  browserRuntime.setPopupPermissionListener(
    (partition: string, origin: string, permission: BrowserPopupPermission) => {
      const cfg = loadConfig();
      const browser = cfg.browser ?? {};
      const popupPermissions = browser.popupPermissions ?? {};
      const accountPermissions = popupPermissions[partition] ?? {};
      const next = saveConfig({
        browser: {
          ...browser,
          popupPermissions: {
            ...popupPermissions,
            [partition]: { ...accountPermissions, [origin]: permission },
          },
        },
      });
      broadcastConfig(next);
    },
  );

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (e) => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    saveConfig({ window: { width: b.width, height: b.height, x: b.x, y: b.y } });
    // Close-to-tray: closing the window HIDES it (the app keeps running in the
    // tray so the floating avatar + quick-chat hotkey stay alive). Real quit
    // goes through the tray "종료" / Cmd+Q, which sets appQuitting first.
    if (!appQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  attachContentResilience(mainWindow, () => {
    if (mainWindow) loadRendererPage(mainWindow, 'index.html');
  });
  loadRendererPage(mainWindow, 'index.html');
}

// ── Floating avatar overlay (Geny-style) ─────────────────────────
// A transparent, frameless, always-on-top, click-through window that floats the
// avatar (extension point) + a live subtitle of the active chat stream. When no
// avatar renderer is registered it shows just the streaming reply as a floating
// bubble ("아바타가 없으면 채팅만"). TTS/STT/screen-capture are intentionally omitted.
// ── overlay geometry: multi-monitor + mixed-DPI aware (ported from Geny) ──────
// Naive single-bounds persistence breaks across monitors with different scale
// factors: getBounds()/setBounds() round-trips the size through DIP↔physical and
// a WM_DPICHANGED rescale, so the saved width/height is wrong and the window
// "never sticks". The fix (Geny's) is to (1) remember bounds PER MONITOR keyed by
// a display signature, (2) suppress saves while a DPI change is settling, and
// (3) clamp restored bounds onto a currently-connected display.
type WinBounds = { x: number; y: number; width: number; height: number };
type DisplayT = ReturnType<typeof screen.getPrimaryDisplay>;

// Resolve saved bounds onto a CONNECTED display (overlap-most, else nearest), then
// clamp to its work area — a window saved on an unplugged monitor lands visibly on
// the nearest one instead of off-screen.
function restoreWinBounds(saved: WinBounds | undefined, defaults: WinBounds): WinBounds {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite))
    return defaults;
  const wa = screen.getDisplayMatching(saved).workArea;
  const width = Math.max(240, Math.min(Math.round(saved.width), wa.width));
  const height = Math.max(220, Math.min(Math.round(saved.height), wa.height));
  const x = Math.round(Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - width));
  const y = Math.round(Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - height));
  return { x, y, width, height };
}

/** Keep a top-most window truly top-most for its lifetime (Geny 0.16.1 port).
 *
 * A one-shot `setAlwaysOnTop(true, 'screen-saver')` decays under z-order churn:
 * fullscreen/DPI transitions strip the bit, and later-created top-most peers
 * stack above us. Purely event-driven (no heartbeat) — re-assert on the exact
 * signals that can demote us, plus one settle re-check 900ms later because some
 * transitions (fullscreen entry) land after the event fires. */
function armAlwaysOnTop(win: BrowserWindow): void {
  let settle: ReturnType<typeof setTimeout> | null = null;
  const assertNow = (): void => {
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      win.moveTop(); // top of the topmost band — above later-created topmost peers
    } catch {
      /* window mid-teardown */
    }
  };
  const assert = (): void => {
    assertNow();
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      assertNow();
    }, 900);
  };
  assertNow();
  win.on('show', assert);
  win.on('restore', assert);
  // Focus moved elsewhere — exactly when another window may have claimed the
  // top of the topmost band.
  win.on('blur', assert);
  // The OS actively stripped the bit (fullscreen/DPI transitions do this).
  win.on('always-on-top-changed', (_e, isOnTop) => {
    if (!isOnTop) assert();
  });
  // Display topology / fullscreen-driven metric changes (taskbar hide, work-
  // area, DPI) — the signal that fires when another app goes fullscreen.
  const onMetrics = (): void => assert();
  screen.on('display-metrics-changed', onMetrics);
  win.on('closed', () => {
    if (settle) clearTimeout(settle);
    screen.removeListener('display-metrics-changed', onMetrics);
  });
}

/** Self-recover a window's content instead of needing an app restart (Geny port):
 *  retry failed loads with backoff (server briefly down, network blip) and reload
 *  after a renderer crash. */
function attachContentResilience(win: BrowserWindow, reload: () => void): void {
  const wc = win.webContents;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  wc.on('did-finish-load', () => {
    retries = 0;
    clearRetry();
  });
  wc.on('did-fail-load', (_e, errorCode, errorDesc, _url, isMainFrame) => {
    if (!isMainFrame) return; // ignore subresource failures
    if (errorCode === -3) return; // ERR_ABORTED — a superseding navigation, not a failure
    clearRetry();
    const delay = Math.min(2000 * Math.pow(1.6, retries), 20000); // 2s → cap 20s
    retries = Math.min(retries + 1, 10);
    console.warn(
      `[connector] content load failed (${errorCode} ${errorDesc}); retry in ${Math.round(delay)}ms`,
    );
    retryTimer = setTimeout(() => {
      if (!win.isDestroyed()) reload();
    }, delay);
  });
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    console.warn(`[connector] renderer gone (${details.reason}); reloading`);
    clearRetry();
    retries = 0;
    if (!win.isDestroyed()) reload();
  });
  wc.on('destroyed', clearRetry);
}

// Set on display-metrics-changed; saves hold off until this passes so we persist
// SETTLED bounds, not the mid-DPI-rescale ones (which is how position ends up wrong).
let dpiSettleUntil = 0;

function displayKey(d: DisplayT): string {
  return `${d.bounds.x},${d.bounds.y}:${d.size.width}x${d.size.height}@${d.scaleFactor}`;
}
function overlayCurrentDisplay(): DisplayT | null {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  return screen.getDisplayMatching(overlayWindow.getBounds());
}
let lastOverlayDisplayKey = '';
let overlayGeomTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist the overlay's geometry for the monitor it's on. Debounced, and waits
 *  out an in-flight DPI transition. `immediate` writes now (drag/resize END, or
 *  before teardown) so a fast restart can't lose it. */
function saveOverlayGeometry(immediate = false): void {
  if (overlayGeomTimer) {
    clearTimeout(overlayGeomTimer);
    overlayGeomTimer = null;
  }
  const run = () => {
    if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.isMinimized()) return;
    const wait = dpiSettleUntil - Date.now();
    if (wait > 0 && !immediate) {
      overlayGeomTimer = setTimeout(run, wait + 100);
      return;
    }
    const d = overlayCurrentDisplay();
    if (!d) return;
    const b = overlayWindow.getBounds();
    const bounds: WinBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    const cfg = loadConfig();
    saveConfig({
      overlayByDisplay: { ...(cfg.overlayByDisplay || {}), [displayKey(d)]: bounds },
      overlayBounds: bounds,
    });
  };
  if (immediate) run();
  else overlayGeomTimer = setTimeout(run, 450);
}

// On launch: apply the geometry remembered for whichever display the overlay opened on.
function restoreOverlayGeometry(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const d = overlayCurrentDisplay();
  if (!d) return;
  lastOverlayDisplayKey = displayKey(d);
  const cfg = loadConfig();
  const saved = cfg.overlayByDisplay?.[displayKey(d)] ?? asWinBounds(cfg.overlayBounds);
  if (saved) overlayWindow.setBounds(restoreWinBounds(saved, saved));
}
function asWinBounds(
  b: { width: number; height: number; x?: number; y?: number } | undefined,
): WinBounds | undefined {
  if (!b || b.x === undefined || b.y === undefined) return undefined;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// After a move settles on a DIFFERENT monitor, snap to THAT monitor's remembered
// size (keeping the dropped position) — fixes the DPI-move size distortion.
function applyOverlaySizeOnCross(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const d = overlayCurrentDisplay();
  if (!d) return;
  const key = displayKey(d);
  if (key === lastOverlayDisplayKey) return;
  lastOverlayDisplayKey = key;
  const saved = loadConfig().overlayByDisplay?.[key];
  if (!saved) {
    saveOverlayGeometry();
    return;
  }
  const wa = d.workArea;
  const width = Math.min(saved.width, wa.width);
  const height = Math.min(saved.height, wa.height);
  const b = overlayWindow.getBounds();
  const x = Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width));
  const y = Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height));
  overlayWindow.setBounds({ x, y, width, height });
}

// Authoritative drag rect: during a dock-handle drag we track the overlay's
// intended bounds in JS and re-assert a CONSTANT size each frame, instead of
// reading getBounds()/getPosition() (which drifts + grows the window on
// fractional DPI). See the overlay:moveBy handler for the full rationale.
let overlayMoveRect: { x: number; y: number; w: number; h: number } | null = null;
let overlayMoveIdle: ReturnType<typeof setTimeout> | null = null;
function endOverlayMove(): void {
  if (overlayMoveIdle) {
    clearTimeout(overlayMoveIdle);
    overlayMoveIdle = null;
  }
  overlayMoveRect = null;
  onOverlayMoved(); // reconcile size-on-cross + persist the settled bounds
}

// 'moved' fires during a drag + on the DPI cross; debounce, wait out the rescale,
// THEN reconcile size-on-cross and persist.
let overlayMovedTimer: ReturnType<typeof setTimeout> | null = null;
function onOverlayMoved(): void {
  if (overlayMovedTimer) clearTimeout(overlayMovedTimer);
  const run = () => {
    const wait = dpiSettleUntil - Date.now();
    if (wait > 0) {
      overlayMovedTimer = setTimeout(run, wait + 100);
      return;
    }
    applyOverlaySizeOnCross();
    saveOverlayGeometry();
  };
  overlayMovedTimer = setTimeout(run, 350);
}

// Any overlap with a work area = still (at least partly) visible.
function isVisibleOnSomeDisplay(b: WinBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ix = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const iy = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    return ix > 0 && iy > 0;
  });
}

// Monitor unplug/rearrange can leave a window entirely off-screen — pull only
// those back onto the nearest display; leave visible windows where the user put them.
function ensureWindowsOnScreen(): void {
  for (const win of [overlayWindow, mainWindow, quickChatWindow]) {
    if (!win || win.isDestroyed()) continue;
    const b = win.getBounds();
    if (isVisibleOnSomeDisplay(b)) continue;
    win.setBounds(restoreWinBounds(b, b));
  }
}

function createOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  // Start from a sensible default near the cursor's display; restoreOverlay
  // Geometry() then applies the per-monitor remembered bounds after creation.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const saved = loadConfig().overlayBounds;
  const width = saved?.width ?? 340;
  const height = saved?.height ?? 460;
  const x = saved?.x ?? wa.x + wa.width - width - 28;
  const y = saved?.y ?? wa.y + wa.height - height - 28;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 240,
    minHeight: 220,
    transparent: true,
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Float above full-screen apps — armed top-most (z-order churn/DPI 전환에도
  // 이벤트 기반으로 재선점; 일회성 setAlwaysOnTop 은 시간이 지나면 풀린다).
  armAlwaysOnTop(overlayWindow);
  attachContentResilience(overlayWindow, () => {
    if (overlayWindow) loadRendererPage(overlayWindow, 'overlay.html');
  });
  // 기본은 잠금 = 클릭 통과. 컨트롤은 별도 창이라 이 창이 통과여도 눌린다.
  applyOverlayInput();
  createOverlayChip();

  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Per-monitor geometry: restore this display's remembered bounds, then on every
  // move/resize reconcile size-on-cross + persist for the current monitor. On
  // Windows these events fire for programmatic setBounds/setPosition too; the
  // renderer also sends overlay:commitBounds on pointer-up as a cross-platform
  // guarantee (Linux doesn't emit them for programmatic bounds changes).
  restoreOverlayGeometry();
  overlayWindow.on('moved', () => {
    onOverlayMoved();
    syncChipBounds();
  });
  overlayWindow.on('resized', () => {
    saveOverlayGeometry();
    syncChipBounds();
  });
  // 아바타가 숨거나 다시 보이면 컨트롤도 같이 — 잠긴 채 숨은 아바타 위에
  // 버튼만 떠 있으면 사용자는 그게 무엇의 컨트롤인지 알 수 없다.
  overlayWindow.on('show', () => applyChipVisibility());
  overlayWindow.on('hide', () => applyChipVisibility());
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    destroyOverlayChip();
  });
  overlayWindow.once('ready-to-show', () => {
    overlayWindow?.show();
    applyChipVisibility();
    if (lastOverlayState) overlayWindow?.webContents.send(CHANNELS.overlayState, lastOverlayState);
  });

  loadRendererPage(overlayWindow, 'overlay.html');
}

// ── 컨트롤 창 (잠금 시 액션바) ────────────────────────────────────────
//
// 아바타 창 바깥에 있으므로 아바타의 입력 상태와 무관하게 항상 눌린다.
// 아바타를 따라다니고, 아바타가 안 보이면 같이 숨는다.
let overlayChip: BrowserWindow | null = null;
let overlayLocked = true;

/** 컨트롤 창 크기. 렌더러가 실제 내용 폭을 재서 알려 준다 (버튼 수는
 *  STT/TTS 사용 가능 여부에 따라 달라진다). */
// 첫 보고 전 기본값은 **작게** 잡는다. 크게 잡으면 그 남는 영역이 잠깐
// 보이고, 투명해도 그만큼 데스크톱 클릭을 먹는다.
let chipSize = { w: 46, h: 38 };

/** 컨트롤 창 아래 여백 — 아바타 창 바닥에서 이만큼 띄운다. */
const CHIP_MARGIN = 6;

function chipBoundsFor(b: Electron.Rectangle): Electron.Rectangle {
  return {
    x: Math.round(b.x + (b.width - chipSize.w) / 2),
    y: Math.round(b.y + b.height - chipSize.h - CHIP_MARGIN),
    width: chipSize.w,
    height: chipSize.h,
  };
}

/** 컨트롤 창이 아바타 창 바닥을 얼마나 덮고 있는가.
 *
 * 컨트롤은 별도 창이라 아바타 페이지는 그 존재를 알 수 없다. 그대로 두면
 * 자막 말풍선 위에 버튼이 겹쳐 그려진다 — 마지막 대사가 가려진다. 메인만이
 * 두 사각형을 모두 아는 쪽이므로 여기서 알려 주고, 페이지가 바닥 기준
 * 요소들을 그만큼 들어 올린다. 잠금이 풀려 컨트롤이 숨으면 0 이다. */
function chipInsetPx(): number {
  const visible = !!overlayChip && !overlayChip.isDestroyed() && overlayChip.isVisible();
  return visible ? chipSize.h + CHIP_MARGIN * 2 : 0;
}

function publishChipInset(): void {
  try {
    overlayWindow?.webContents.send(CHANNELS.overlayChipInset, chipInsetPx());
  } catch {
    /* 창이 사라졌다 */
  }
}

/** 컨트롤을 아바타 위로 다시 올린다. 싸고 멱등하다. */
function raiseChip(): void {
  if (!overlayChip || overlayChip.isDestroyed() || !overlayChip.isVisible()) return;
  try {
    overlayChip.setAlwaysOnTop(true, 'screen-saver');
    overlayChip.moveTop();
  } catch {
    /* 정리 중 */
  }
}

function syncChipBounds(): void {
  if (!overlayChip || overlayChip.isDestroyed()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    overlayChip.setBounds(chipBoundsFor(overlayWindow.getBounds()));
    raiseChip();
  } catch {
    /* 정리 중 */
  }
}

function applyChipVisibility(): void {
  if (!overlayChip || overlayChip.isDestroyed()) return;
  const shouldShow =
    overlayLocked && !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
  if (shouldShow) {
    syncChipBounds();
    // showInactive: 포커스를 가져가면 아바타가 다시 잠길 때마다 사용자가
    // 하던 일에서 끌려 나온다.
    if (!overlayChip.isVisible()) overlayChip.showInactive();
    raiseChip();
  } else if (overlayChip.isVisible()) {
    overlayChip.hide();
  }
  // 위의 show/hide 뒤에 알린다 — 화면에 실제로 있는 것을 알려야 한다.
  publishChipInset();
}

function createOverlayChip(): void {
  if (overlayChip && !overlayChip.isDestroyed()) return;
  overlayChip = new BrowserWindow({
    width: chipSize.w,
    height: chipSize.h,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // armAlwaysOnTop 은 쓰지 않는다: blur/show 훅과 재선점 타이머를 건다.
  // 아바타 옆의 **두 번째** 최상위 창에 그걸 돌리면 z-order 트래픽만 늘고
  // 얻는 것이 없다 — 컨트롤은 작고, 아바타와 함께 만들어지고 사라진다.
  overlayChip.on('closed', () => {
    overlayChip = null;
  });
  overlayChip.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // 페이지가 그려진 뒤에 띄운다 — 그 전에 show 하면 투명한 빈 사각형이
  // 잠깐 떠서 데스크톱 클릭을 먹는다.
  overlayChip.once('ready-to-show', () => applyChipVisibility());
  loadRendererPage(overlayChip, 'chip.html');
}

function destroyOverlayChip(): void {
  if (overlayChip && !overlayChip.isDestroyed()) overlayChip.destroy();
  overlayChip = null;
}

// ── 잠금과 입력: 컨트롤은 **자기 창**에 산다 ─────────────────────────
//
// 잠긴 아바타는 모든 플랫폼에서 클릭을 데스크톱으로 흘려보내야 한다. 그런데
// 입력이 통과하는 창은 **자기 잠금 해제 버튼을 담을 수 없다.**
//
// 예전에는 한 창 안에서 hover 로 입력을 되살렸다 (`setIgnoreMouseEvents(true,
// {forward:true})` → 마우스가 컨트롤 위에 오면 ignore 를 끈다). 그 방식은
// 무너진다:
//
//   * `forward` 는 darwin/win32 전용이다. 리눅스에서는 이벤트가 아예 안 와서
//     hover 복귀가 영원히 불가능하다 — 잠그면 되돌릴 방법이 없다.
//   * darwin/win32 에서도 forward 되는 것은 **이동 이벤트뿐**이고, hover 감지
//     → IPC 왕복 → ignore 해제 사이에 누른 클릭은 사라진다. 사용자에게는
//     "버튼이 보이는데 눌리지 않는다" 로 보인다.
//
// 그래서 컨트롤을 **작은 별도 창**으로 뺀다. 그 창은 언제나 인터랙티브고
// 아바타를 따라다닌다. 아바타 창은 잠금 여부만으로 입력을 정하면 된다 —
// 플랫폼 분기도, hover 곡예도 없다. (geny-connector 가 같은 버그를 이렇게
// 해결했고, 그 구조를 그대로 가져온다.)
function applyOverlayIgnoreMouse(win: BrowserWindow | null, ignore: boolean): void {
  if (!win || win.isDestroyed()) return;
  // 모든 플랫폼에서 같은 규칙. forward 는 미지원 플랫폼에서 무시된다.
  win.setIgnoreMouseEvents(ignore, IS_LINUX ? undefined : { forward: true });
}

/** 잠금 상태는 **여기가** 소유한다 — 두 창(아바타 + 컨트롤)이 서로 다르게
 *  알고 있으면 안 된다. */
function setOverlayLocked(locked: boolean): void {
  overlayLocked = locked;
  applyOverlayInput();
  applyChipVisibility();
  try {
    overlayWindow?.webContents.send(CHANNELS.overlayLocked, locked);
    overlayChip?.webContents.send(CHANNELS.overlayLocked, locked);
  } catch {
    /* 창이 사라졌다 */
  }
}

/** 오버레이의 입력 상태를 정하는 **유일한** 곳. */
function applyOverlayInput(): void {
  applyOverlayIgnoreMouse(overlayWindow, overlayLocked);
}

/** 무슨 상태에 빠졌든 사용자에게 통제권을 돌려준다 (트레이).
 *  대가는 아바타에 잘못 닿는 클릭 하나; 통제권을 잃는 것보다 싸다. */
function forceOverlayInteractive(): void {
  setOverlayLocked(false);
  try {
    overlayWindow?.setIgnoreMouseEvents(false);
    overlayWindow?.showInactive();
  } catch {
    /* ignore */
  }
}

function setOverlayEnabled(enabled: boolean): void {
  const next = saveConfig({ avatarOverlay: enabled });
  if (enabled) createOverlay();
  else if (overlayWindow && !overlayWindow.isDestroyed()) {
    saveOverlayGeometry(true); // persist last move/resize before tearing the window down
    overlayWindow.destroy();
    overlayWindow = null;
    destroyOverlayChip();
  }
  // Keep the main window's toggle in sync (e.g. when closed via the overlay ✕).
  broadcastConfig(next);
  rebuildTrayMenu();
}

/** Hide only the avatar inside the overlay (the floating chat + subtitle stay). */
function setAvatarHidden(hidden: boolean): void {
  const next = saveConfig({ avatarHidden: hidden });
  broadcastConfig(next);
  rebuildTrayMenu();
}

// ── Quick-chat: Spotlight-style floating input bar (Geny-style) ───────────────
// A permanent, transparent, top-most, click-through window: the WINDOW stays
// alive/on-screen at all times (so it layers above full-screen apps); only its
// card paints while summoned. A global hotkey toggles it; submit relays the text
// into the active agent chat in the main window.
const QUICKCHAT_W = 600;
const QUICKCHAT_H = 176;
// Ctrl + Shift + / (i.e. Ctrl + ?). NOTE: Electron globalShortcut can't tell
// left/right Shift apart — accelerators only have a generic `Shift`.
const DEFAULT_QUICKCHAT = 'Control+Shift+/';
let quickChatWindow: BrowserWindow | null = null;
let quickChatOpen = false;
let quickChatShownAt = 0;
let quickChatPosTimer: ReturnType<typeof setTimeout> | null = null;
let suppressQuickChatPosSave = false;
let appQuitting = false;

function persistQuickChatPos(): void {
  if (suppressQuickChatPosSave) return;
  if (quickChatPosTimer) clearTimeout(quickChatPosTimer);
  quickChatPosTimer = setTimeout(() => {
    if (!quickChatWindow || quickChatWindow.isDestroyed() || !quickChatOpen) return;
    const [x, y] = quickChatWindow.getPosition();
    saveConfig({ quickChatBar: { x, y } });
  }, 350);
}

function positionQuickChat(): void {
  if (!quickChatWindow) return;
  suppressQuickChatPosSave = true;
  const saved = loadConfig().quickChatBar;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // Multi-monitor aware: restore onto whichever display the bar was on, clamped
    // to fit (guards a closed/moved monitor). Size is fixed (QUICKCHAT_W/H).
    const rect = { x: saved.x, y: saved.y, width: QUICKCHAT_W, height: QUICKCHAT_H };
    const b = restoreWinBounds(rect, rect);
    quickChatWindow.setBounds({ x: b.x, y: b.y, width: QUICKCHAT_W, height: QUICKCHAT_H });
  } else {
    const pt = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(pt).workArea;
    const x = Math.round(wa.x + (wa.width - QUICKCHAT_W) / 2);
    const y = Math.round(wa.y + wa.height * 0.22);
    quickChatWindow.setBounds({ x, y, width: QUICKCHAT_W, height: QUICKCHAT_H });
  }
  setTimeout(() => {
    suppressQuickChatPosSave = false;
  }, 120);
}

function createQuickChat(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) return;
  quickChatWindow = new BrowserWindow({
    width: QUICKCHAT_W,
    height: QUICKCHAT_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  armAlwaysOnTop(quickChatWindow);
  attachContentResilience(quickChatWindow, () => {
    if (quickChatWindow) loadRendererPage(quickChatWindow, 'quickchat.html');
  });
  quickChatWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  quickChatWindow.on('blur', () => {
    if (!quickChatOpen) return;
    if (Date.now() - quickChatShownAt < 450) return;
    dismissQuickChat();
  });
  quickChatWindow.on('move', persistQuickChatPos);
  quickChatWindow.on('moved', persistQuickChatPos);
  quickChatWindow.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault();
      dismissQuickChat();
    }
  });
  quickChatWindow.on('closed', () => {
    quickChatWindow = null;
  });
  loadRendererPage(quickChatWindow, 'quickchat.html');
  positionQuickChat();
  // 퀵챗은 hover 복귀가 필요 없다 (핫키 소환 시 ignore=false 를 명시 설정)
  // — 리눅스에선 미지원 forward 옵션만 뺀다.
  if (IS_LINUX) quickChatWindow.setIgnoreMouseEvents(true);
  else quickChatWindow.setIgnoreMouseEvents(true, { forward: true });
  quickChatWindow.showInactive();
}

function dismissQuickChat(): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  quickChatOpen = false;
  if (IS_LINUX) quickChatWindow.setIgnoreMouseEvents(true);
  else quickChatWindow.setIgnoreMouseEvents(true, { forward: true });
  quickChatWindow.webContents.send(CHANNELS.quickChatDismissed);
}

function showQuickChatOnTop(): void {
  if (!quickChatWindow) return;
  quickChatOpen = true;
  quickChatShownAt = Date.now();
  quickChatWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    quickChatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  quickChatWindow.setIgnoreMouseEvents(false);
  quickChatWindow.moveTop();
  quickChatWindow.webContents.send(CHANNELS.quickChatOpened);
  setTimeout(() => {
    if (!quickChatWindow || !quickChatOpen) return;
    quickChatWindow.focus();
    quickChatWindow.moveTop();
  }, 110);
}

function toggleQuickChat(): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) createQuickChat();
  if (quickChatOpen) {
    dismissQuickChat();
    return;
  }
  positionQuickChat();
  showQuickChatOnTop();
}

/** Relay a quick-chat message into the main window's active agent chat. */
function deliverQuickChat(text: string): { ok: boolean; error?: string } {
  const body = (text ?? '').trim();
  if (!body) return { ok: false, error: '메시지를 입력하세요.' };
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '앱 창을 열어주세요.' };
  // 퀵 챗은 퀵 챗일 뿐 — 메인 창의 상태(최소화/숨김/포커스)를 절대 건드리지
  // 않는다. 숨김/최소화 창에도 IPC 는 정상 전달되고 스트림은 main 프로세스가
  // 소유하므로, 대화는 뒤에서 진행되고 나중에 창을 열면 그대로 보인다.
  mainWindow.webContents.send(CHANNELS.quickSend, body);
  return { ok: true };
}

function registerQuickChatHotkey(): void {
  const cfg = loadConfig();
  globalShortcut.unregister(cfg.quickChatHotkey ?? DEFAULT_QUICKCHAT);
  if (!cfg.quickChat) return;
  const acc = cfg.quickChatHotkey ?? DEFAULT_QUICKCHAT;
  try {
    globalShortcut.register(acc, () => toggleQuickChat());
  } catch {
    /* ignore invalid accelerator */
  }
}

function setQuickChatEnabled(enabled: boolean): void {
  const next = saveConfig({ quickChat: enabled });
  if (enabled) {
    createQuickChat();
    registerQuickChatHotkey();
  } else {
    globalShortcut.unregister(next.quickChatHotkey ?? DEFAULT_QUICKCHAT);
    if (quickChatOpen) dismissQuickChat();
  }
  broadcastConfig(next);
  rebuildTrayMenu();
}

// ── Window / app management ──────────────────────────────────────
function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    mainWindow?.once('ready-to-show', () => mainWindow?.show());
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openMainSettings(): void {
  showMain();
  safeSend(mainWindow, CHANNELS.openSettingsModal);
}

/** 로그인 시 자동 시작 적용 — **실효 결과**를 반환한다 (UI 가 거짓 토글을
 *  보여주지 않도록; geny-connector 동형).
 *
 *  Linux: electron 의 setLoginItemSettings 는 no-op 이라 XDG autostart
 *  (.desktop) 파일을 직접 쓴다. AppImage 를 임시 마운트 경로(/tmp/.mount_*)
 *  에서 실행 중이면 재부팅 후 존재하지 않는 경로라 등록을 거부한다.
 *  Desktop-Entry 의 % 는 필드 코드라 %% 로 이스케이프한다. */
function applyAutoLaunch(enabled: boolean): boolean {
  if (!IS_LINUX) {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: ['--hidden'] });
    return enabled;
  }
  const autostartDir = join(homedir(), '.config', 'autostart');
  const desktopPath = join(autostartDir, 'xgen-dex.desktop');
  // 리브랜딩(XGen Dex) 이전에 등록된 옛 이름의 자동 시작 항목이 있으면 함께
  // 정리한다 — 안 하면 새 파일만 추가/삭제되고 옛 파일이 그대로 남아 로그인마다
  // 두 번 실행되거나(옛 파일이 계속 살아있는데 새로 하나 더 생김), 설정에서
  // [끄기]를 눌러도(새 이름 파일만 지워지고) 실제로는 꺼지지 않는 것처럼 보인다.
  const legacyDesktopPath = join(autostartDir, 'xgen-connector.desktop');
  try {
    rmSync(legacyDesktopPath, { force: true });
  } catch {
    /* best-effort */
  }
  if (!enabled) {
    try {
      rmSync(desktopPath, { force: true });
    } catch {
      /* best-effort */
    }
    return false;
  }
  // AppImage 는 $APPIMAGE(영속 파일)를, 그 외는 실행 바이너리를 가리킨다.
  const target = process.env.APPIMAGE || app.getPath('exe');
  if (!target || target.includes(`${sep}.mount_`) || target.startsWith('/tmp/')) {
    // 임시 마운트에서 실행 중 — 재부팅 후 깨진 경로가 된다. 등록 거부.
    return false;
  }
  try {
    mkdirSync(autostartDir, { recursive: true });
    const exec = `"${target.replace(/%/g, '%%')}" --hidden`;
    writeFileSync(
      desktopPath,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=XGen Dex',
        `Exec=${exec}`,
        'X-GNOME-Autostart-enabled=true',
        'NoDisplay=false',
        'Terminal=false',
      ].join('\n') + '\n',
      'utf-8',
    );
    chmodSync(desktopPath, 0o644);
    return true;
  } catch {
    return false;
  }
}

/** Linux-안전 재시작 (geny-connector 이식): `app.relaunch()` 는 리눅스에서
 *  `--type=relauncher` 헬퍼를 거치며 NoNewPrivs 를 설정한다 — 비가역이라
 *  재시작된 프로세스의 SUID chrome-sandbox 가 죽는다 (Ubuntu 24.04 SIGTRAP).
 *  리눅스는 분리된 셸로 1초 뒤 재실행; 그 외 플랫폼은 표준 relaunch. */
function relaunchSelf(): void {
  appQuitting = true;
  if (IS_LINUX) {
    const target = process.env.APPIMAGE || app.getPath('exe');
    try {
      spawn('/bin/sh', ['-c', 'sleep 1; exec "$@"', 'relaunch', target], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      app.relaunch(); // 폴백 — 없는 것보단 낫다
    }
    app.quit();
    return;
  }
  app.relaunch();
  app.quit();
}

function resetPositions(): void {
  saveConfig({ overlayBounds: undefined, overlayByDisplay: undefined, quickChatBar: undefined });
  lastOverlayDisplayKey = '';
  const wa = screen.getPrimaryDisplay().workArea;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const w = 340;
    const h = 460;
    overlayWindow.setBounds({
      x: wa.x + wa.width - w - 28,
      y: wa.y + wa.height - h - 28,
      width: w,
      height: h,
    });
    overlayWindow.show();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds({
      x: Math.round(wa.x + (wa.width - 1100) / 2),
      y: Math.round(wa.y + (wa.height - 760) / 2),
      width: 1100,
      height: 760,
    });
  }
  // quick-chat re-centers on its next summon now that quickChatBar is cleared.
}

/** 로컬 설정과 로그인 정보를 지운 뒤 배포 기본값으로 다시 시작한다. */
async function resetStoredSettings(): Promise<void> {
  getMcpBridge().stop();
  void client?.logout().catch(() => undefined);
  client = null;
  await Promise.allSettled([
    tokenStore.clear(),
    credentialStore.clear(),
    Promise.resolve(fileSystem?.stop()),
  ]);
  applyAutoLaunch(false);
  resetConfig();
  relaunchSelf();
}

// ── System tray (작업 표시줄) ─────────────────────────────────────
/** 트레이 생성 — 실패를 허용한다 (리눅스에서 appindicator 부재 시 throw).
 *  @returns 트레이가 실제로 생겼는지. false 면 호출자는 --hidden 시작을
 *  취소해야 한다 — 트레이도 창도 없는 좀비 프로세스 방지 (geny 동형). */
function createTray(): boolean {
  if (tray) return true;
  try {
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`);
    tray = new Tray(icon);
    tray.setToolTip('XGen Dex');
    rebuildTrayMenu();
    tray.on('click', () => showMain());
    return true;
  } catch {
    tray = null;
    return false;
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const cfg = loadConfig();
  const overlayOn = !!(overlayWindow && !overlayWindow.isDestroyed());
  const menu = Menu.buildFromTemplate([
    { label: '채팅 창 열기', click: () => showMain() },
    { label: '빠른 채팅', click: () => toggleQuickChat() },
    { label: '설정', click: () => openMainSettings() },
    {
      label: overlayOn ? '미니 채팅 숨기기' : '미니 채팅 표시',
      click: () => setOverlayEnabled(!overlayOn),
    },
    {
      label: cfg.avatarHidden ? '아바타 표시' : '아바타 숨기기',
      enabled: overlayOn,
      click: () => setAvatarHidden(!cfg.avatarHidden),
    },
    { type: 'separator' },
    {
      label: '자동 업데이트',
      type: 'checkbox',
      checked: cfg.autoUpdate !== false,
      click: (item) => {
        setAutoUpdate(item.checked);
        saveConfig({ autoUpdate: item.checked });
      },
    },
    { label: '업데이트 확인', click: () => void checkNow() },
    { label: `버전 ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    {
      label: '로그인 시 시작',
      type: 'checkbox',
      checked: cfg.autoLaunch === true,
      click: (item) => {
        // IPC 핸들러와 동일하게 **실효 결과**를 저장 (리눅스 등록 거부 시
        // 체크만 켜진 거짓 상태 방지).
        const effective = applyAutoLaunch(item.checked);
        saveConfig({ autoLaunch: effective });
        rebuildTrayMenu();
      },
    },
    {
      // 비상구. 오버레이가 어떤 상태에 빠졌든 통제권을 돌려준다 — 대가는
      // 아바타에 잘못 닿는 클릭 하나이고, 통제권을 잃는 것보다 싸다.
      label: '아바타 조작 복구',
      click: () => forceOverlayInteractive(),
    },
    { label: '위치 초기화', click: () => resetPositions() },
    { type: 'separator' },
    {
      label: '재시작',
      click: () => relaunchSelf(),
    },
    {
      label: '종료',
      click: () => {
        appQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ── Local MCP (connector-hosted MCP servers → user's agents) ─────
let mcpStatusWired = false;
let mcpRuntimeLogWired = false;
const mcpHttpSession = () => session.fromPartition('xgen-mcp-http');
const mcpHttpFetch: McpHttpFetch = (url, init) =>
  mcpHttpSession().fetch(url instanceof URL ? url.toString() : url, init);

/** HTTP MCP 전용 세션에만 사설 인증서 예외를 설치한다. */
function applyMcpHttpCertificatePolicy(): void {
  mcpHttpSession().setCertificateVerifyProc((request, callback) => {
    const allowed = shouldIgnorePrivateCertificateError(
      loadConfig().allowPrivateCertificate === true,
      request.verificationResult,
    );
    callback(allowed ? 0 : -3);
  });
}

function currentUserId(): string | null {
  return client?.user?.userId ?? null;
}

function currentNotificationAccountKey(): string | null {
  const userId = currentUserId();
  const serverUrl = normalizeServerUrl(loadConfig().serverUrl);
  return userId && serverUrl ? accountKey(serverUrl, userId) : null;
}

/** 현재 계정 설정. 아직 로그인 전이면 저장하지 않는 안전한 기본값을 돌려준다. */
function currentNotificationProfile(): NotificationProfile {
  const cfg = loadConfig();
  const key = currentNotificationAccountKey();
  if (!key) return notificationProfileForAccount(undefined, '');
  // 새 계정 프로필이 생긴 뒤에는 legacy teams.mutedRooms 를 다시 합치지 않는다.
  // 그러지 않으면 새 설정에서 방 음소거를 풀어도 legacy 값이 매번 되살아난다.
  const legacy = cfg.notifications?.accounts?.[key] ? undefined : cfg.teams;
  return notificationProfileForAccount(cfg.notifications, key, legacy);
}

function saveCurrentNotificationPreference(
  update: NotificationPreferenceUpdate,
): NotificationProfile {
  const key = currentNotificationAccountKey();
  if (!key) throw new Error('로그인 후 알림 설정을 변경할 수 있습니다.');
  const cfg = loadConfig();
  const current = currentNotificationProfile();
  const profile = applyNotificationPreferenceUpdate(current, update);
  const next = saveConfig({
    notifications: withNotificationProfile(cfg.notifications, key, profile),
  });
  broadcastConfig(next);
  return profile;
}

const notificationCenter = new NotificationCenter({
  profile: currentNotificationProfile,
  isWindowFocused: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
  revealWindow: showMain,
  navigate: (target) => safeSend(mainWindow, CHANNELS.notificationNavigate, target),
});
getLocalToolProvider().configureNotificationHandler(async (title, body, context) => {
  const target: NotificationTarget =
    context?.workflowId && context.interactionId
      ? {
          kind: 'chat',
          workflowId: context.workflowId,
          workflowName: context.workflowName || context.workflowId,
          interactionId: context.interactionId,
        }
      : { kind: 'none' };
  return notificationCenter.publish({
    id: `agent-notify-${context?.workflowId || 'unknown'}-${randomUUID()}`,
    type: 'agent.requested',
    title,
    body,
    occurredAt: new Date().toISOString(),
    workflowId: context?.workflowId,
    workflowName: context?.workflowName,
    interactionId: context?.interactionId,
    groupKey: context?.workflowId ? `agent:${context.workflowId}` : 'agent:unknown',
    target,
  }).shown;
});
/**
 * 현재 유효한 액세스 토큰 — **라이브 클라이언트(회전 반영) 우선**, 없으면 keychain.
 * WS 브릿지·워크스페이스 동기화가 keychain 만 읽으면, 세션 중 회전 시점과
 * keychain 기록 사이의 틈에서 폐기된 토큰을 집는다. 단일 소스로 그 틈을 없앤다.
 */
async function liveAccessToken(): Promise<string> {
  const live = client?.getAccessTokenAfterRotation();
  if (live) return live;
  return (await tokenStore.getAccess()) ?? '';
}
/**
 * 인증 실패(401/403)를 맞은 소비자의 자가치유 — refresh 토큰으로 액세스 토큰을
 * 회전(single-flight, core 가 보장)하고 새 토큰을 돌려준다. onTokensRotated 가
 * keychain 도 함께 갱신한다. null = 회전 불가(진짜 재로그인 대상).
 */
async function refreshAuthToken(): Promise<string | null> {
  const c = client;
  if (!c) return null;
  const fallback = (await tokenStore.getRefresh()) ?? undefined;
  return c.ensureFreshAuth(fallback);
}
/**
 * Teams 실시간 소켓 허브 — 로그인 동안 사용자 소켓 1개 + 열린 방 소켓 N개.
 *
 * 토큰은 항상 **라이브 값**을 집는다(liveAccessToken). keychain 만 읽으면 세션
 * 중 회전 시점과 기록 사이의 틈에서 폐기된 토큰을 잡아 403 에 갇힌다 — MCP
 * 브릿지·워크스페이스 동기화가 같은 이유로 같은 규칙을 쓴다.
 */
const teamsHub = new TeamsSocketHub();
let teamsHubConfigured = false;

function publishTeamsNotification(event: TeamsEvent): void {
  if (
    event.kind === 'rooms_changed' &&
    (event.reason === 'invited' || event.reason === 'removed')
  ) {
    const invited = event.reason === 'invited';
    notificationCenter.publish({
      id: `teams-${event.reason}-${event.roomId}`,
      type: invited ? 'teams.invited' : 'teams.removed',
      title: invited ? 'Teams 대화 초대' : 'Teams 대화 변경',
      body: invited ? '새 대화방에 초대되었습니다.' : '대화방에서 제외되었습니다.',
      occurredAt: new Date().toISOString(),
      teamsRoomId: event.roomId,
      groupKey: `teams:${event.roomId}`,
      target: invited ? { kind: 'teams', roomId: event.roomId } : { kind: 'none' },
    });
    return;
  }
  if (event.kind !== 'notify') return;
  const message = event.message;
  if (message.senderType === 'system') return;
  if (message.senderType === 'user' && message.senderId === currentUserId()) return;
  const roomName = notificationCenter.roomName(event.roomId) || 'Teams 대화';
  const body =
    shareBodyOf(message.content).trim() ||
    (message.attachments?.length ? `첨부 ${message.attachments.length}개` : '새 메시지');
  notificationCenter.publish({
    id: `teams-message-${event.roomId}-${message.id}`,
    type: message.senderType === 'agent' ? 'teams.agent_message' : 'teams.message',
    title: roomName,
    body: `${message.senderName}: ${body}`,
    occurredAt: message.createdAt,
    workflowId: message.senderType === 'agent' ? message.senderId : undefined,
    workflowName: message.senderType === 'agent' ? message.senderName : undefined,
    teamsRoomId: event.roomId,
    teamsMessageId: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    groupKey: `teams:${event.roomId}`,
    target: {
      kind: 'teams',
      roomId: event.roomId,
      roomName,
      messageId: message.id,
    },
  });
}

/** 로그인/로그아웃/서버변경 후 Teams 소켓을 현재 상태에 맞춘다. */
function syncTeams(): void {
  const cfg = loadConfig();
  if (!teamsHubConfigured) {
    teamsHubConfigured = true;
    teamsHub.configure({
      baseUrl: () => normalizeServerUrl(loadConfig().serverUrl),
      token: async () => (await liveAccessToken()) || '',
      refreshAuth: refreshAuthToken,
      allowPrivateCertificate: () => loadConfig().allowPrivateCertificate === true,
      emit: (event) => {
        publishTeamsNotification(event);
        safeSend(mainWindow, CHANNELS.teamsEvent, event);
      },
    });
  }
  if (currentUserId() && normalizeServerUrl(cfg.serverUrl)) {
    teamsHub.startUserSocket();
  } else {
    // 로그아웃/서버 미설정 — 방 소켓까지 전부 접는다. 다른 계정의 방을
    // 물고 있는 상태가 남으면 안 된다.
    teamsHub.stopAll();
  }
}

/** 에이전트 자기관리용 로컬 MCP delegate — McpAddServer/McpRemoveServer/McpListServers.
 *  로컬 MCP(cfg.mcp) 가 켜져 있을 때만 도구를 광고한다. 추가/제거는 설정 UI 와 **같은**
 *  applyMcpServers() 경로(비밀 키체인·redacted 저장·syncMcp 재조정)를 쓴다. 커넥터 로컬에서만
 *  동작하며, 등록된 서버 도구는 다음 턴부터(또는 list_changed 재광고로) 에이전트에 붙는다. */
function txt(text: string, isError = false): LocalToolResult {
  return { content: [{ type: 'text', text }], isError };
}
const mcpAdminDelegate: LocalToolDelegate = {
  advertise() {
    return loadConfig().mcp
      ? [mcpAddServerToolSchema(), mcpRemoveServerToolSchema(), mcpListServersToolSchema()]
      : [];
  },
  owns(tool: string) {
    return tool === MCP_ADD_TOOL || tool === MCP_REMOVE_TOOL || tool === MCP_LIST_TOOL;
  },
  async callTool(tool: string, rawArgs: unknown): Promise<LocalToolResult> {
    if (!loadConfig().mcp) return txt('로컬 MCP 가 꺼져 있습니다 (설정 > MCP).', true);
    const a = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;

    if (tool === MCP_LIST_TOOL) {
      const servers = loadConfig().mcpServers ?? [];
      const adverts = await getMcpManager()
        .advertise()
        .catch(
          () =>
            [] as { name: string; connected: boolean; error?: string; tools: { name: string }[] }[],
        );
      const byName = new Map(adverts.map((x) => [x.name, x]));
      const rows = servers.map((sv) => {
        const live = byName.get(sv.name);
        return {
          name: sv.name,
          transport: sv.transport,
          enabled: sv.enabled !== false,
          connected: !!live?.connected,
          error: live?.error,
          tools: (live?.tools ?? []).map((t) => t.name),
        };
      });
      return txt(JSON.stringify({ servers: rows }, null, 2));
    }

    if (tool === MCP_REMOVE_TOOL) {
      const name = String(a.name ?? '').trim();
      if (!name) return txt('name 이 필요합니다.', true);
      const prev = loadConfig().mcpServers ?? [];
      if (!prev.some((sv) => sv.name === name))
        return txt(`MCP 서버 '${name}' 이(가) 없습니다.`, true);
      await applyMcpServers(prev.filter((sv) => sv.name !== name));
      return txt(`MCP 서버 '${name}' 를 제거했습니다 (프로세스 종료·도구 분리).`);
    }

    // McpAddServer
    const name = String(a.name ?? '').trim();
    if (!name) return txt('name 이 필요합니다.', true);
    const hasUrl = typeof a.url === 'string' && String(a.url).trim() !== '';
    const transport = (
      ['stdio', 'http', 'sse'].includes(String(a.transport))
        ? String(a.transport)
        : hasUrl
          ? 'http'
          : 'stdio'
    ) as McpServerConfig['transport'];
    const server: McpServerConfig = { name, transport, enabled: true };
    if (typeof a.command === 'string' && a.command.trim())
      server.command = String(a.command).trim();
    if (Array.isArray(a.args)) server.args = a.args.map((x) => String(x));
    if (a.env && typeof a.env === 'object')
      server.env = Object.fromEntries(
        Object.entries(a.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    if (hasUrl) server.url = String(a.url).trim();
    if (a.headers && typeof a.headers === 'object')
      server.headers = Object.fromEntries(
        Object.entries(a.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    if (a.auth === 'oauth' || a.auth === 'none') server.auth = a.auth;
    if (transport === 'stdio' && !server.command)
      return txt('stdio 서버는 command 가 필요합니다.', true);
    if ((transport === 'http' || transport === 'sse') && !server.url)
      return txt('http/sse 서버는 url 이 필요합니다.', true);

    const prev = loadConfig().mcpServers ?? [];
    const replaced = prev.some((sv) => sv.name === name);
    await applyMcpServers([...prev.filter((sv) => sv.name !== name), server]);

    // 연결/도구 검색을 잠깐 기다렸다 결과를 요약한다(첫 실행은 의존성 내려받기로 느릴 수 있음).
    await new Promise((r) => setTimeout(r, 1500));
    const adverts = await getMcpManager()
      .advertise()
      .catch(() => []);
    const live = adverts.find((x) => x.name === name);
    const toolNames = (live?.tools ?? []).map((t) => t.name);
    const verb = replaced ? '갱신' : '추가';
    if (server.auth === 'oauth' && !live?.connected) {
      return txt(
        `MCP 서버 '${name}' 를 ${verb}했습니다. OAuth 인증이 필요합니다 — 사용자가 설정 > MCP 에서 "브라우저로 인가하기" 를 완료하면 도구가 연결됩니다.`,
      );
    }
    if (live?.error) {
      return txt(
        `MCP 서버 '${name}' 를 ${verb}했으나 연결 오류: ${live.error}. 명령/인자/토큰을 확인하세요 (여전히 등록은 유지됨, 재연결 자동 시도).`,
        true,
      );
    }
    return txt(
      `MCP 서버 '${name}' 를 ${verb}·연결했습니다. 노출 도구 ${toolNames.length}개: ${toolNames.join(', ') || '(아직 검색 중 — 다음 턴에 반영될 수 있음)'}. 이 도구들은 mcp__${name}__* 로 호출됩니다.`,
    );
  },
};

/** Reconcile MCP manager + bridge with config + login state. */
function syncMcp(): void {
  const cfg = loadConfig();
  setMcpRuntimeLogEnabled(cfg.mcpDebug === true);
  const mcp = getMcpManager();
  // 로컬 MCP 마스터 스위치: cfg.mcp 가 꺼져 있으면 서버 목록을 비워 넘긴다 →
  // configure 가 기존 서버를 전부 disconnect·제거한다. 이전에는 mcp:false 여도
  // 서버가 스폰되고 도구가 카탈로그에 실리던 버그가 있었다.
  mcp.configure(cfg.mcp ? cfg.mcpServers : [], {
    httpFetch: mcpHttpFetch,
    allowPrivateCertificate: cfg.allowPrivateCertificate === true,
  });
  // 서버가 도구 목록을 바꾸거나(list_changed) 죽으면 카탈로그를 에이전트에 다시 광고한다.
  mcp.setCatalogChangeListener(() => {
    void getMcpBridge().refreshCatalog();
  });
  // Browser pages and connector-hosted tools share the bridge catalog. Browser
  // state is account-scoped; without a live user configure() tears pages down.
  getBrowserRuntime().configure({
    enabled: cfg.browser?.enabled === true,
    serverUrl: normalizeServerUrl(cfg.serverUrl),
    userId: currentUserId() ?? undefined,
    newTabUrl: cfg.browser?.newTabUrl,
    popupPermissions: cfg.browser?.popupPermissions,
  });
  const browserTools = getBrowserToolProvider(getBrowserRuntime());
  browserTools.configure(
    cfg.browser?.enabled === true,
    cfg.localShell?.allowedRoots ?? [],
    (page) => {
      showMain();
      safeSend(mainWindow, CHANNELS.browserRevealEvent, page);
    },
  );
  getLocalToolProvider().configure(cfg.localShell, browserTools);
  // 로컬 MCP 자기관리 도구(McpAddServer 등) — cfg.mcp 스위치로 delegate 가 스스로 게이트한다.
  getLocalToolProvider().configureMcpAdmin(mcpAdminDelegate);
  const bridge = getMcpBridge();
  if (!mcpStatusWired) {
    mcpStatusWired = true;
    bridge.setStatusListener((s) => safeSend(mainWindow, CHANNELS.mcpStatusEvent, s));
  }
  if (!mcpRuntimeLogWired) {
    mcpRuntimeLogWired = true;
    onMcpRuntimeLog((entry) => safeSend(mainWindow, CHANNELS.mcpRuntimeLogEvent, entry));
  }
  const userId = currentUserId();
  // The bridge is the single conduit for BOTH external MCP servers and the
  // connector's built-in local tools. Start it when EITHER is on — the local
  // shell capability must reach the agent even if the user configured no MCP
  // servers (it is the out-of-the-box default).
  const builtinOn = getLocalToolProvider().advertise().length > 0;
  if ((cfg.mcp || builtinOn) && userId) {
    // start() is idempotent for the same target: it refreshes the catalog on a
    // live socket instead of tearing it down, so repeated syncMcp() (e.g. on
    // token refresh / restore) never flaps the connection status.
    bridge.start({
      serverUrl: normalizeServerUrl(cfg.serverUrl),
      userId,
      allowPrivateCertificate: cfg.allowPrivateCertificate === true,
      // 라이브 토큰 우선 — keychain 만 읽으면 세션 중 회전 시 폐기 토큰을 집는다.
      getToken: async () => (await liveAccessToken()) || null,
      refreshAuth: refreshAuthToken,
    });
  } else {
    bridge.stop();
  }
}
function setMcpEnabled(enabled: boolean): void {
  const next = saveConfig({ mcp: enabled });
  syncMcp();
  broadcastConfig(next);
}

// ── Workspace 동기화 (에이전트 workflow ↔ 로컬 폴더, Drive형) ─────
/** 이 설치본의 안정 디바이스 id — 최초 1회 생성 후 config 에 영속. */
/**
 * 이 PC 의 표시 이름.
 *
 * 로컬 로그인 이름은 클라우드 트리에서 아무것도 구분하지 않는다 — 클라우드는
 * 이미 XGEN 계정으로 갈린다. 그래서 호스트명 앞의 로그인 이름을 걷어낸다.
 *
 * **바꿀 수 있게 두지 않는다.** 이 이름은 서버가 이 기기를 **처음** 볼 때
 * 폴더 이름이 되고, 그 폴더는 이후 어떤 이름 변경에도 움직이지 않는다. 바꿀
 * 수 있게 하면 사용자는 주소를 옮기려 하고, 파일은 예전 자리에 남는다.
 */
function deviceNameOf(): string {
  return defaultDeviceName(hostname(), userInfo().username);
}

function ensureDeviceId(): string {
  const cfg = loadConfig();
  if (cfg.deviceId) return cfg.deviceId;
  const id = randomUUID();
  saveConfig({ deviceId: id });
  return id;
}

// ── IPC: config ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.configGet, () => loadConfig());
/** 서버 주소 확정 — 스킴이 없으면 https → http 순으로 실제로 두드려 정한다. */
ipcMain.handle(CHANNELS.configProbeServer, async (_e, input: string) => {
  const { resolveServerUrl } = await import('./server-probe');
  return resolveServerUrl(String(input ?? ''), async (url) => {
    // 상태코드는 무엇이든 좋다 — fetch 가 resolve 만 하면 그 스킴은 살아 있다.
    await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
  });
});
ipcMain.handle(CHANNELS.configSet, async (_e, patch: Partial<ConnectorConfig>) => {
  // Browser popup permissions are main-owned security state. Renderer settings
  // may update the other browser fields, but must neither grant permissions nor
  // erase existing rules when replacing the nested browser object.
  if (patch.browser !== undefined) {
    const previous = loadConfig().browser ?? {};
    patch = {
      ...patch,
      browser: {
        ...previous,
        ...patch.browser,
        addressSearch:
          patch.browser.addressSearch === undefined
            ? previous.addressSearch
            : { ...previous.addressSearch, ...patch.browser.addressSearch },
        popupPermissions: previous.popupPermissions,
      },
    };
  }
  // 서버 전환 = 계정 공간 전환: 구 서버의 세션/저장 자격 증명은 새 서버에서
  // 무의미하므로 여기서 전부 정리하고 재로그인을 요구한다. 원격 로그아웃은
  // best-effort 로만 시도한다 — 구 서버가 죽어서 주소를 바꾸는 경우가 흔해
  // 응답을 기다리면 설정 저장 자체가 막힌다. (최초 설정(prev 없음)은 제외.)
  const prevServer = normalizeServerUrl(loadConfig().serverUrl);
  const serverChanged =
    patch.serverUrl !== undefined &&
    !!prevServer &&
    normalizeServerUrl(patch.serverUrl) !== prevServer;
  if (serverChanged) {
    getMcpBridge().stop();
    // Teams 소켓도 함께 접는다. 빠뜨리면 구 서버 주소를 문 재연결 루프가 남아
    // 폐기된 토큰으로 최대 60초 백오프까지 영원히 재시도한다 (로그아웃 경로에는
    // 있는데 여기만 없어서 생기던 누수).
    teamsHub.stopAll();
    await getBrowserRuntime().closeAll();
    getBrowserRuntime().configure({ enabled: false });
    void client?.logout().catch(() => undefined); // 구 서버 세션 무효화 (rebind 전 호출)
    client = null; // in-memory user/token 을 남기지 않도록 새 인스턴스로
    // ⚠ **client 를 비운 뒤에** 걷는다. 앞에서 부르면 아직 살아 있는
    // `client.user` 때문에 리컨사일이 "로그인 중" 으로 판단해 구 서버의
    // 마운트를 그대로 남긴다 (로그아웃 경로와 같은 함정).
    fileSystem?.reconcile();
    await tokenStore.clear();
    await credentialStore.clear();
    patch = { ...patch, autoLogin: false }; // 저장된 자동 로그인은 구 서버 계정
  }
  const next = saveConfig(patch);
  if (patch.serverUrl !== undefined) getClient(); // rebind base URL
  if (patch.serverUrl !== undefined || patch.allowPrivateCertificate !== undefined) {
    // 검증 결과는 network service에 캐시되므로 proc을 다시 설치하고 기존
    // 연결을 닫아 다음 요청부터 새 정책을 사용한다.
    applyCertificatePolicy();
    await session.defaultSession.closeAllConnections();
  }
  if (patch.allowPrivateCertificate !== undefined) {
    applyMcpHttpCertificatePolicy();
    await mcpHttpSession().closeAllConnections();
    syncMcp();
    fileSystem?.reconcile();
  }
  if (patch.autoUpdate !== undefined) setAutoUpdate(!!patch.autoUpdate);
  if (patch.updateServer !== undefined) setUpdateServer(patch.updateServer);
  // 로컬 셸 접근 토글/설정: 프로바이더를 재구성하고 카탈로그를 다시 광고한다
  // (켜면 브릿지가 없던 경우 뜨고, 끄면 도구가 카탈로그에서 빠진다).
  if (patch.localShell !== undefined || patch.browser !== undefined) syncMcp();
  // 기본 작업 폴더/토글 변경 → 에이전트 workspace 로컬 동기화도 따라간다.
  if (patch.localShell !== undefined) fileSystem?.reconcile();
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  if (patch.linuxClickThrough !== undefined) {
    // 즉시 재적용: 클릭 통과가 켜진 오버레이는 마우스 이벤트를 못 받아
    // 렌더러 IPC 로는 다시 끌 수 없다 — 설정 토글이 유일한 복귀 경로.
    applyOverlayIgnoreMouse(overlayWindow, true);
  }
  broadcastConfig(next);
  if (serverChanged) safeSend(mainWindow, CHANNELS.authFailed); // → 로그인 화면
  return next;
});

// ── IPC: 공통 OS 알림 ───────────────────────────────────────────
ipcMain.handle(CHANNELS.notificationPreferences, () => currentNotificationProfile());
ipcMain.handle(CHANNELS.notificationUpdate, (_e, update: NotificationPreferenceUpdate) =>
  saveCurrentNotificationPreference(update),
);
ipcMain.handle(CHANNELS.notificationTest, () => notificationCenter.test());
ipcMain.handle(CHANNELS.notificationStatus, () => notificationCenter.status());
ipcMain.on(CHANNELS.notificationContext, (_e, context: NotificationRendererContext) =>
  notificationCenter.setContext(context),
);
ipcMain.handle(CHANNELS.notificationConsumeTarget, () => notificationCenter.consumePendingTarget());

// ── IPC: auth ────────────────────────────────────────────────────
// Persist the rotated tokens + wake dependent subsystems after any successful sign-in.
// @returns 토큰이 **영속** 저장됐는지 — false 면 재시작 시 재로그인이 필요하다
// (키체인/암호화 저장 전부 불가). 무음 실패 금지: 호출자가 UI 에 표면화한다.

async function afterAuthSuccess(refreshToken?: string): Promise<boolean> {
  const c = getClient();
  const persisted = await tokenStore.setAccess(c.getAccessTokenAfterRotation());
  if (refreshToken) await tokenStore.setRefresh(refreshToken);
  syncMcp();
  syncTeams();
  safeSend(overlayWindow, CHANNELS.avatarRefresh); // client is now authed → overlay can load the avatar
  // 파일 시스템 동기화는 로그인 상태에서만 대상이 생긴다 — 로그인이 끝난
  // 지금 에이전트 목록을 읽고 리컨사일한다.
  void fileSystem?.refreshAgents();
  checkForUpdatesAfterLogin();
  return persisted;
}

const SSO_CALLBACK = 'xgenDexSsoComplete';
let pendingSso: {
  resolve: (value: { user: NonNullable<XgenClient['user']>; tokenPersisted: boolean }) => void;
  reject: (reason: Error) => void;
} | null = null;

function settleSsoWindow(): void {
  const win = ssoWindow;
  ssoWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

ipcMain.handle(CHANNELS.authSsoLogin, async () => {
  const cfg = loadConfig();
  if (!cfg.ssoEnabled) throw new Error('SSO 로그인이 활성화되지 않았습니다.');
  const url = buildSsoUrl(
    normalizeServerUrl(cfg.serverUrl),
    cfg.ssoPath ?? '/sso/signin',
    SSO_CALLBACK,
  );
  const ssoDebug = cfg.ssoDebug === true;
  if (ssoWindow && !ssoWindow.isDestroyed()) {
    ssoWindow.show();
    ssoWindow.focus();
    throw new Error('SSO 로그인이 이미 진행 중입니다.');
  }

  return new Promise<{ user: NonNullable<XgenClient['user']>; tokenPersisted: boolean }>(
    (resolve, reject) => {
      const win = new BrowserWindow(
        createSsoWindowOptions(
          join(__dirname, '../preload/sso.js'),
          ssoDebug,
          mainWindow ?? undefined,
        ),
      );
      ssoWindow = win;
      pendingSso = { resolve, reject };
      if (ssoDebug) win.webContents.openDevTools({ mode: 'detach', activate: true });
      win.once('ready-to-show', () => win.show());
      win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
        try {
          const protocol = new URL(nextUrl).protocol;
          if (protocol === 'http:' || protocol === 'https:') void win.loadURL(nextUrl);
        } catch {
          // 잘못된 팝업 URL은 무시한다.
        }
        return { action: 'deny' };
      });
      win.on('closed', () => {
        ssoWindow = null;
        if (pendingSso) {
          const pending = pendingSso;
          pendingSso = null;
          pending.reject(new Error('SSO 로그인이 취소되었습니다.'));
        }
      });
      void win.loadURL(url).catch((error) => {
        if (!pendingSso) return;
        const pending = pendingSso;
        pendingSso = null;
        settleSsoWindow();
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    },
  );
});

ipcMain.on(CHANNELS.authSsoComplete, (event, payload: unknown) => {
  if (!pendingSso || !ssoWindow || event.sender !== ssoWindow.webContents) return;
  const senderFrame = event.senderFrame;
  if (!senderFrame) return;
  let callbackOrigin: string;
  let serverOrigin: string;
  try {
    callbackOrigin = new URL(senderFrame.url).origin;
    serverOrigin = new URL(normalizeServerUrl(loadConfig().serverUrl)).origin;
  } catch {
    return;
  }
  if (callbackOrigin !== serverOrigin) return;

  const pending = pendingSso;
  pendingSso = null;
  void (async () => {
    try {
      const c = getClient();
      const result = await c.adoptLogin(parseSsoLoginResponse(payload));
      const tokenPersisted = await afterAuthSuccess(result.refreshToken);
      if (!c.user) throw new Error('SSO 사용자 정보를 확인하지 못했습니다.');
      pending.resolve({ user: c.user, tokenPersisted });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      settleSsoWindow();
    }
  })();
});

ipcMain.handle(
  CHANNELS.authLogin,
  async (_e, email: string, password: string, remember?: boolean) => {
    const c = getClient();
    let res;
    try {
      res = await c.login(email, password);
    } catch (e) {
      // 예외를 그대로 던지면 렌더러에는 IPC 래핑 원문("Error invoking remote
      // method 'auth:login': ApiError: POST /api/auth/login → 401")이 보인다.
      // 구조화된 결과로 돌려 사람이 읽을 문장을 화면이 정하게 한다.
      const { loginErrorMessage } = await import('./server-probe');
      return { user: null, error: loginErrorMessage(e) };
    }
    const tokenPersisted = await afterAuthSuccess(res.refreshToken);
    // Remember (or forget) credentials for auto-login, per the login-form checkbox.
    let credsPersisted = true;
    if (remember) {
      credsPersisted = await credentialStore.save({ email, password });
      saveConfig({ autoLogin: credsPersisted }); // 저장 실패면 다음 실행 자동 로그인은 불가
    } else {
      await credentialStore.clear();
      saveConfig({ autoLogin: false });
    }
    return { user: c.user, tokenPersisted, credsPersisted };
  },
);

// Launch: sign in with the remembered credentials (only when 자동 로그인 is on).
ipcMain.handle(CHANNELS.authAutoLogin, async () => {
  if (!loadConfig().autoLogin) return { user: null };
  const creds = await credentialStore.get();
  if (!creds) return { user: null };
  try {
    const c = getClient();
    const res = await c.login(creds.email, creds.password);
    await afterAuthSuccess(res.refreshToken);
    return { user: c.user };
  } catch (e) {
    // 명시적 거부(서버가 응답으로 거절 = 비밀번호 변경 등)일 때만 저장
    // 자격을 폐기한다. 네트워크 일시 장애(오프라인 부팅·서버 재시작)는
    // TypeError('fetch failed')/AbortError 로 나타난다 — 이때 지우면
    // 자동 로그인이 장애 한 번에 영구 해제된다 (restoreDetailed 동일 원칙).
    const name = (e as Error)?.name ?? '';
    const transient = name === 'AbortError' || name === 'TypeError';
    if (!transient) {
      await credentialStore.clear();
      saveConfig({ autoLogin: false });
    }
    return { user: null, offline: transient };
  }
});

// Login form: prefill the remembered email + the auto-login checkbox state.
ipcMain.handle(CHANNELS.authLoginPrefill, async () => {
  const creds = await credentialStore.get();
  return { autoLogin: !!loadConfig().autoLogin, email: creds?.email ?? '' };
});

ipcMain.handle(CHANNELS.authRestore, async () => {
  const c = getClient();
  const access = await tokenStore.getAccess();
  const refresh = await tokenStore.getRefresh();
  if (!access) return { user: null };
  const verdict = await c
    .restoreDetailed(access, refresh ?? undefined)
    .catch(() => 'network' as const);
  if (verdict === 'valid') {
    const rotated = c.getAccessTokenAfterRotation();
    if (rotated && rotated !== access) await tokenStore.setAccess(rotated);
    const rotatedRefresh = c.getRefreshToken();
    if (rotatedRefresh && rotatedRefresh !== refresh) await tokenStore.setRefresh(rotatedRefresh);
    // 세션 복원도 **로그인 성공과 같은 뒷정리**가 필요하다. 예전엔 여기서
    // 같은 일을 손으로 되풀이했는데, 그러다 보니 afterAuthSuccess 에만 있는
    // 워크스페이스 리컨사일이 빠져 **재시작할 때마다 드라이브가 안 붙었다**.
    // 갈래가 둘이면 한쪽만 갱신되는 날이 온다 — 한 곳으로 모은다.
    syncMcp();
    syncTeams();
    safeSend(overlayWindow, CHANNELS.avatarRefresh); // session restored → overlay can load the avatar
    void fileSystem?.refreshAgents();
    return { user: c.user };
  }
  if (verdict === 'invalid') {
    // 서버가 명시적으로 거부했을 때만 토큰 폐기 — 일시적 네트워크 장애로
    // 로그인을 날리지 않는다 (geny-connector validateAndRefreshAuth 동형).
    await tokenStore.clear();
  }
  return { user: null, offline: verdict === 'network' };
});

ipcMain.handle(CHANNELS.authLogout, async () => {
  getMcpBridge().stop();
  teamsHub.stopAll();
  await getBrowserRuntime().closeAll();
  getBrowserRuntime().configure({ enabled: false });
  if (client) await client.logout();
  await tokenStore.clear();
  // 동기화 페어는 로그인 상태에서만 존재한다 — 로그아웃하면 걷어낸다.
  // ⚠ **반드시 logout 뒤에.** 앞에서 부르면 그 시점의 `client.user` 가 아직
  // 살아 있어 리컨사일이 "로그인 중" 으로 판단하고 페어를 그대로 둔다.
  fileSystem?.reconcile();
  // An explicit logout also disables auto-login (else next launch signs right back in).
  await credentialStore.clear();
  saveConfig({ autoLogin: false });
  return true;
});

ipcMain.handle(CHANNELS.authStatus, () => ({ user: client?.user ?? null }));
ipcMain.handle(CHANNELS.userAvatarConfig, () => getClient().preferences.getAvatarConfig());
ipcMain.handle(CHANNELS.userSaveAvatarConfig, (_e, cfg) =>
  getClient().preferences.saveAvatarConfig(cfg),
);
ipcMain.handle(CHANNELS.userSaveAvatarTransform, (_e, avatarId, tf) =>
  getClient().preferences.saveAvatarTransform(avatarId, tf),
);

// ── IPC: 아바타 설정 뷰 (등록/이름/선택/삭제 + 스토어) ─────────────
// config 를 바꾸는 op 는 저장 후 오버레이에 avatarRefresh 를 쏴서 다음 폴링을
// 기다리지 않고 즉시 반영한다.
function avatarConfigChanged<T>(result: T): T {
  safeSend(overlayWindow, CHANNELS.avatarRefresh);
  return result;
}
ipcMain.handle(CHANNELS.avatarUploadAsset, (_e, bytes: Uint8Array, filename: string) =>
  getClient().avatars.uploadAsset(bytes, filename),
);
ipcMain.handle(CHANNELS.avatarDeleteAsset, (_e, avatarId: string) =>
  getClient().avatars.deleteAsset(avatarId),
);
ipcMain.handle(CHANNELS.avatarSetEnabled, async (_e, enabled: boolean) =>
  avatarConfigChanged(await getClient().preferences.setAvatarEnabled(enabled)),
);
ipcMain.handle(CHANNELS.avatarSelect, async (_e, id: string) =>
  avatarConfigChanged(await getClient().preferences.selectAvatar(id)),
);
ipcMain.handle(CHANNELS.avatarRename, async (_e, id: string, name: string) =>
  avatarConfigChanged(await getClient().preferences.renameAvatar(id, name)),
);
ipcMain.handle(CHANNELS.avatarAdd, async (_e, descriptor, name?: string) =>
  avatarConfigChanged(await getClient().preferences.addAvatar(descriptor, name)),
);
ipcMain.handle(CHANNELS.avatarRemove, async (_e, id: string) =>
  avatarConfigChanged(await getClient().preferences.removeAvatar(id)),
);
ipcMain.handle(CHANNELS.avatarStoreList, () => getClient().avatars.storeList());
ipcMain.handle(CHANNELS.avatarStorePublish, (_e, descriptor, name: string, description: string) =>
  getClient().avatars.storePublish(descriptor, name, description),
);
ipcMain.handle(CHANNELS.avatarStoreDownload, (_e, storeId: string) =>
  getClient().avatars.storeDownload(storeId),
);
ipcMain.handle(CHANNELS.avatarStoreRate, (_e, storeId: string, stars: number) =>
  getClient().avatars.storeRate(storeId, stars),
);
ipcMain.handle(CHANNELS.avatarStoreUnpublish, (_e, storeId: string) =>
  getClient().avatars.storeUnpublish(storeId),
);

// ── IPC: agents ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.agentsList, (_e, query) => getClient().agents.list(query ?? {}));
ipcMain.handle(CHANNELS.agentsCreateOptions, () => getClient().agents.createOptions());
ipcMain.handle(CHANNELS.agentsCreate, (_e, input) => getClient().agents.create(input));

// ── IPC: voice (STT/TTS) ─────────────────────────────────────────
// The renderer captures audio via getUserMedia and hands bytes to main; main
// proxies to the backend with the Bearer token. Secrets never reach here.
ipcMain.handle(CHANNELS.voiceConfig, () => getClient().voice.getVoiceConfig());

// ── SSH (개인별 서버) ──────────────────────────────────────────────
// 얇은 통과 계층이다. 서버가 검증하고(이름 규칙·점프 그래프·자격증명 유무),
// 실패는 메시지째 렌더러로 올라가 그대로 보인다 — 여기서 다시 판단하면 두
// 화면(웹/커넥터)의 규칙이 갈라진다.
ipcMain.handle(CHANNELS.sshConfig, () => getClient().ssh.getConfig());
ipcMain.handle(CHANNELS.sshSetEnabled, (_e, enabled: boolean) =>
  getClient().ssh.setEnabled(!!enabled),
);
ipcMain.handle(CHANNELS.sshCreateServer, (_e, input: SshServerInput) =>
  getClient().ssh.createServer(input),
);
ipcMain.handle(CHANNELS.sshUpdateServer, (_e, name: string, input: SshServerInput) =>
  getClient().ssh.updateServer(name, input),
);
ipcMain.handle(CHANNELS.sshDeleteServer, (_e, name: string) =>
  getClient().ssh.deleteServer(name),
);
ipcMain.handle(CHANNELS.sshTestServer, (_e, name: string) =>
  getClient().ssh.testServer(name),
);
ipcMain.handle(
  CHANNELS.voiceTranscribe,
  (_e, bytes: Uint8Array, mime: string, language?: string) => {
    // Copy to a standalone ArrayBuffer (the IPC view may span a shared buffer).
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([buf], { type: mime || 'audio/webm' });
    return getClient().voice.transcribe(blob, language);
  },
);
ipcMain.handle(CHANNELS.voiceSpeak, async (_e, text: string, opts?: TtsSpeakOptions) => {
  const blob = await getClient().voice.speak(text, opts);
  const buf = Buffer.from(await blob.arrayBuffer());
  return { bytes: new Uint8Array(buf), mime: blob.type };
});

// ── IPC: history ─────────────────────────────────────────────────
ipcMain.handle(
  CHANNELS.historyTurns,
  (_e, workflowId: string, interactionId: string, name?: string) =>
    getClient().history.turns(workflowId, interactionId, name),
);
ipcMain.handle(CHANNELS.historyConversations, () => getClient().history.conversations());

// ── IPC: Agent Viewer (읽기 전용 관측 데이터) ───────────────────────
ipcMain.handle(CHANNELS.agentTraceList, (_e, wf: string) => getClient().agentData.traceList(wf));
ipcMain.handle(CHANNELS.agentTraceDetail, (_e, traceId: string) =>
  getClient().agentData.traceDetail(traceId),
);
ipcMain.handle(CHANNELS.agentMemoryList, (_e, wf: string) => getClient().agentData.memoryList(wf));
ipcMain.handle(CHANNELS.agentMemoryRead, (_e, wf: string, path: string) =>
  getClient().agentData.memoryRead(wf, path),
);
ipcMain.handle(CHANNELS.agentTasksList, (_e, wf: string) => getClient().agentData.tasksList(wf));
ipcMain.handle(CHANNELS.agentTaskRuns, (_e, wf: string, sessionId?: string) =>
  getClient().agentData.taskRuns(wf, sessionId),
);
ipcMain.handle(CHANNELS.agentTaskOutput, (_e, wf: string, runId: string) =>
  getClient().agentData.taskOutput(wf, runId),
);
ipcMain.handle(CHANNELS.agentBasicInfo, (_e, wf: string) => getClient().agentData.basicInfo(wf));
ipcMain.handle(CHANNELS.agentToolsList, (_e, wf: string) => getClient().agentData.toolsList(wf));
ipcMain.handle(CHANNELS.agentToolGet, (_e, wf: string, functionId: string) =>
  getClient().agentData.toolGet(wf, functionId),
);
ipcMain.handle(CHANNELS.agentWsTree, (_e, wf: string, path?: string) =>
  getClient().agentData.workspaceTree(wf, path),
);
ipcMain.handle(CHANNELS.agentWsFile, (_e, wf: string, path: string) =>
  getClient().agentData.workspaceFile(wf, path),
);
ipcMain.handle(
  CHANNELS.agentWsBinary,
  (_e, wf: string, path: string, purpose?: 'chat_attachment') =>
    getClient().agentData.workspaceBinary(wf, path, purpose),
);
ipcMain.handle(
  CHANNELS.agentWsUpload,
  (
    _e,
    wf: string,
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
    interactionId: string,
    attachmentId: string,
  ) =>
    getClient().agentData.workspaceUpload(
      wf,
      bytes,
      filename,
      mimeType,
      interactionId,
      attachmentId,
    ),
);

// ── IPC: Teams (사람 사이의 대화) ────────────────────────────────
// REST 는 전부 core 의 TeamsApi 에 위임한다 — 이 파일에는 매핑 로직이 없다.
// 실시간은 teamsHub 가 CHANNELS.teamsEvent 로 렌더러에 밀어 준다.
ipcMain.handle(CHANNELS.teamsRooms, () =>
  getClient().teams.listRooms(currentUserId() ?? undefined),
);
ipcMain.handle(CHANNELS.teamsCreateRoom, (_e, name: string, description?: string) =>
  // 커넥터가 만드는 방은 항상 '사람끼리만' 모드로 시작한다. 에이전트를 붙이는
  // 것은 후속 단계이고, 그때는 방 설정에서 모드를 올린다 (서버가 이미 지원).
  getClient().teams.createRoom({ name, description, routerMode: 'chat' }),
);
ipcMain.handle(CHANNELS.teamsOpenDm, (_e, userId: number, username?: string) =>
  getClient().teams.openDirectMessage(userId, username),
);
/**
 * teams 로컬 설정을 **필드 단위로** 갱신한다.
 *
 * `config:set` 은 `{...loadConfig(), ...patch}` 라 최상위만 얕게 병합한다.
 * 그래서 `{teams:{lastReadAt}}` 를 보내면 같은 `teams` 안의 `mutedRooms` 가
 * 통째로 사라진다 — 방을 음소거해 두고 메시지를 읽으면 음소거가 풀리고,
 * 그 반대도 마찬가지였다. 여기서 기존 teams 를 읽어 덮어쓸 필드만 얹는다.
 */
ipcMain.handle(
  CHANNELS.teamsSavePrefs,
  (_e, patch: { lastReadAt?: Record<string, string>; mutedRooms?: string[] }) => {
    const teams = { ...(loadConfig().teams ?? {}), ...patch };
    saveConfig({ teams });
    return true;
  },
);

ipcMain.handle(
  CHANNELS.teamsUpdateRoom,
  (_e, roomId: string, patch: { name?: string; description?: string | null }) =>
    getClient().teams.updateRoom(roomId, patch),
);
/**
 * 새 메시지 OS 알림.
 *
 * **판정은 렌더러가 한다.** "지금 그 방을 보고 있는가 / 음소거인가" 는 렌더러만
 * 아는 상태이고, main 이 그걸 다시 들고 있으면 두 곳이 어긋난다. main 은
 * 창 포커스 여부만 더 얹고(포커스 상태에서 보고 있지 않은 방은 알릴 가치가 있다)
 * 실제 표시와 클릭 처리를 맡는다.
 *
 * 클릭하면 창을 띄우고 렌더러에 방을 열라고 알린다 — 알림을 눌렀는데 아무 일도
 * 일어나지 않으면 알림이 아니라 소음이다.
 */
ipcMain.handle(
  CHANNELS.teamsNotify,
  (_e, payload: { roomId: string; roomName: string; sender: string; body: string }) => {
    // 구 renderer 와의 한 릴리스 호환 경로. 새 renderer 는 Teams WS 이벤트를
    // main 의 NotificationCenter 가 직접 처리하므로 이 IPC 를 호출하지 않는다.
    return notificationCenter.publish({
      id: `legacy-teams-${payload.roomId}-${payload.sender}-${payload.body.slice(0, 40)}`,
      type: 'teams.message',
      title: payload.roomName || 'Teams 대화',
      body: `${payload.sender}: ${payload.body}`,
      occurredAt: new Date().toISOString(),
      teamsRoomId: payload.roomId,
      senderName: payload.sender,
      groupKey: `teams:${payload.roomId}`,
      target: { kind: 'teams', roomId: payload.roomId, roomName: payload.roomName },
    }).shown;
  },
);

ipcMain.handle(CHANNELS.teamsLeaveRoom, async (_e, roomId: string) => {
  await getClient().teams.leaveRoom(roomId);
  // 나간 방의 소켓을 그대로 두면 서버가 거절할 때까지 재연결을 시도한다.
  teamsHub.closeRoom(roomId);
  return true;
});
ipcMain.handle(CHANNELS.teamsMembers, (_e, roomId: string) =>
  getClient().teams.listMembers(roomId),
);
ipcMain.handle(CHANNELS.teamsAddMember, async (_e, roomId: string, userId: number) => {
  await getClient().teams.addMember(roomId, userId);
  return true;
});
ipcMain.handle(CHANNELS.teamsSearchUsers, (_e, query: string) =>
  getClient().teams.searchUsers(query),
);
ipcMain.handle(CHANNELS.teamsMessages, (_e, roomId: string, before?: string) =>
  getClient().teams.listMessages(roomId, { before }),
);
ipcMain.handle(
  CHANNELS.teamsSend,
  (_e, roomId: string, content: string, replyToId?: string, attachments?: TeamsAttachment[]) =>
    getClient().teams.sendMessage(roomId, content, { replyToId, attachments }),
);
ipcMain.handle(CHANNELS.teamsEdit, (_e, roomId: string, messageId: string, content: string) =>
  getClient().teams.editMessage(roomId, messageId, content),
);
ipcMain.handle(CHANNELS.teamsReact, (_e, roomId: string, messageId: string, emoji: string) =>
  getClient().teams.toggleReaction(roomId, messageId, emoji),
);
ipcMain.handle(CHANNELS.teamsWatch, (_e, roomId: string) => {
  teamsHub.openRoom(roomId);
  return true;
});
ipcMain.handle(CHANNELS.teamsUnwatch, (_e, roomId: string) => {
  teamsHub.closeRoom(roomId);
  return true;
});
ipcMain.handle(CHANNELS.teamsTyping, (_e, roomId: string, typing: boolean) => {
  teamsHub.sendTyping(roomId, typing);
  return true;
});

ipcMain.handle(CHANNELS.clipboardWrite, (_e, text: unknown) => {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (!value) return false;
  clipboard.writeText(value);
  return true;
});

// ── IPC: Teams 첨부 ──────────────────────────────────────────────
// 파일 경로는 **메인에만** 존재한다. 렌더러는 "고르기 → 올리기" 를 시킬 수만
// 있고, 어떤 경로를 읽고 쓸지는 정하지 못한다.

/** 사용자가 고른 로컬 파일들을 방에 올린다. 취소하면 빈 배열. */
ipcMain.handle(CHANNELS.teamsUploadAttachment, async (_e, roomId: string) => {
  const paths = await pickFilesToAttach(mainWindow, [...TEAMS_ATTACHMENT_EXTENSIONS]);
  // **전부 먼저 검사한다.** 하나씩 올리다 중간에서 멈추면 앞의 파일은 이미 서버에
  // 올라갔는데 호출자는 오류만 받아, 올라간 파일을 알 수도 지울 수도 없게 된다
  // (서버에 첨부 삭제 API 가 없다).
  const files = [];
  for (const path of paths) {
    const file = await readFileForUpload(path);
    const reason = teamsAttachmentRejectReason(file.filename, file.bytes.byteLength);
    if (reason) throw new Error(reason);
    files.push(file);
  }
  const uploaded: TeamsAttachment[] = [];
  for (const file of files) {
    uploaded.push(await getClient().teams.uploadAttachment(roomId, file.bytes, file.filename));
  }
  return uploaded;
});

/**
 * 워크스페이스(가상 드라이브)의 파일을 그대로 방에 올린다 — 에이전트 산출물 공유.
 *
 * 렌더러는 **드라이브 상대 경로**(`/에이전트/…`)만 넘긴다. 절대 경로를 받아
 * "안에 있는지" 검사하는 방식은 심볼릭 링크·대소문자·UNC 로 뚫린다. 탐색기의
 * `workspaceOpenPath` 와 같은 규칙을 그대로 쓴다: 검증된 상대 경로를 마운트
 * 루트에 붙이는 것만 허용한다.
 */
ipcMain.handle(CHANNELS.teamsShareWorkspaceFile, async (_e, roomId: string, path: unknown) => {
  const root = fileSystem?.cloudDir();
  const rel = safeDrivePath(path);
  if (!root || !rel) throw new Error('클라우드 동기화 폴더 안의 파일만 공유할 수 있습니다.');
  const target = join(root, ...rel.split('/').filter(Boolean));
  const file = await readFileForUpload(target);
  const reason = teamsAttachmentRejectReason(file.filename, file.bytes.byteLength);
  if (reason) throw new Error(reason);
  return getClient().teams.uploadAttachment(roomId, file.bytes, file.filename);
});

ipcMain.handle(CHANNELS.teamsSaveAttachment, async (_e, roomId: string, att: TeamsAttachment) => {
  const bytes = await getClient().teams.downloadAttachment(roomId, att);
  return saveAttachmentAs(mainWindow, att.filename, bytes);
});

/**
 * 그림 미리보기용 원본 바이트.
 *
 * `<img src>` 에 서버 주소를 그대로 박을 수 없어서 이 통로가 필요하다: 렌더러가
 * 보내는 요청에는 Authorization 헤더가 실리지 않아 401 이 되고, 토큰을 쿼리에
 * 실으면 그 URL 이 캐시·로그에 남는다. 바이트를 건네주면 렌더러는 blob URL 만
 * 만들면 된다.
 */
ipcMain.handle(CHANNELS.teamsReadAttachment, async (_e, roomId: string, att: TeamsAttachment) =>
  getClient().teams.downloadAttachment(roomId, att),
);

ipcMain.handle(CHANNELS.teamsOpenAttachment, async (_e, roomId: string, att: TeamsAttachment) => {
  const bytes = await getClient().teams.downloadAttachment(roomId, att);
  return openAttachmentTemp(att.filename, att.storageKey, bytes);
});

// ── IPC: chat streaming ──────────────────────────────────────────
// The renderer starts a stream with a client-generated streamId; each ChatEvent
// is pushed back over CHANNELS.chatEvent; cancel via CHANNELS.chatCancel.
ipcMain.handle(CHANNELS.chatStart, async (e, streamId: string, req) => {
  const controller = new AbortController();
  aborters.set(streamId, controller);
  const sender = e.sender;
  (async () => {
    const serverReq: ChatRequest = { ...(req as ChatRequest) };
    let preview = '';
    let terminal = false;
    const publishTerminal = (kind: 'completed' | 'failed', detail?: string): void => {
      const event: NotificationEvent = {
        id: `chat-${kind}-${streamId}`,
        type: kind === 'completed' ? 'chat.completed' : 'chat.failed',
        title:
          kind === 'completed'
            ? `${serverReq.workflowName || '에이전트'} 답변 완료`
            : `${serverReq.workflowName || '에이전트'} 응답 실패`,
        body:
          kind === 'completed'
            ? preview.trim().slice(-180) || '답변이 완료되었습니다.'
            : detail || '응답 중 오류가 발생했습니다.',
        occurredAt: new Date().toISOString(),
        workflowId: serverReq.workflowId,
        workflowName: serverReq.workflowName,
        interactionId: serverReq.interactionId,
        groupKey: `chat:${serverReq.workflowId}:${serverReq.interactionId}`,
        target: {
          kind: 'chat',
          workflowId: serverReq.workflowId,
          workflowName: serverReq.workflowName,
          interactionId: serverReq.interactionId,
        },
      };
      notificationCenter.publish(event);
    };
    try {
      // 에이전트 턴은 **언제나 서버에서** 돈다 — 서버가 workflow 세션을 만들고
      // 그 세션의 sandbox 안에서 실행한다. 커넥터는 그 실행을 호출하는 접속기다.
      //
      // 예전에는 이 PC 에 Python 런타임을 심어 턴을 직접 돌렸다. 그러면 같은
      // 에이전트가 어디서 대화했느냐에 따라 다른 파일시스템·다른 도구 표면에서
      // 돌아, 모든 기능을 두 번 만들어야 했고 두 번째 구현은 늘 뒤처졌다.
      // 사용자 PC 는 이제 **도구**로만 참여한다(브라우저·Shell·로컬 MCP —
      // 서버 에이전트가 reverse-WS 카탈로그로 호출한다).
      for await (const ev of getClient().chat.stream(serverReq, controller.signal)) {
        if (sender.isDestroyed()) break;
        if (ev.kind === 'text') preview = (preview + ev.content).slice(-2_000);
        else if (ev.kind === 'summary' && !preview) preview = ev.text;
        sender.send(CHANNELS.chatEvent, streamId, ev satisfies ChatEvent);
        if (ev.kind === 'end') {
          terminal = true;
          publishTerminal('completed');
          break;
        }
        if (ev.kind === 'error') {
          terminal = true;
          publishTerminal('failed', ev.detail);
          break;
        }
      }
      // 일부 서버는 end 프레임 없이 정상 EOF 로 닫는다. 취소가 아니라면 같은 완료다.
      if (!terminal && !controller.signal.aborted && !sender.isDestroyed()) {
        sender.send(CHANNELS.chatEvent, streamId, { kind: 'end' });
        publishTerminal('completed');
      }
    } catch (err) {
      // 사용자가 [중지]한 Abort 는 실패 알림이 아니다.
      if (!controller.signal.aborted && !sender.isDestroyed()) {
        const detail = err instanceof Error ? err.message : String(err);
        sender.send(CHANNELS.chatEvent, streamId, { kind: 'error', detail });
        publishTerminal('failed', detail);
      }
    } finally {
      aborters.delete(streamId);
    }
  })();
  return true;
});
ipcMain.handle(CHANNELS.chatCancel, (_e, streamId: string) => {
  aborters.get(streamId)?.abort();
  aborters.delete(streamId);
  return true;
});

// '진행 중 대화' 삭제 → 서버 세션 RAM(executor + 라우팅)을 완전 정리한다. 이력은 보존.
// best-effort — 서버 미도달/미인증이어도 로컬 삭제 UX 는 막지 않는다.
ipcMain.handle(CHANNELS.chatEndSession, async (_e, workflowId: string, interactionId: string) => {
  if (!workflowId || !interactionId) return false;
  try {
    await getClient().agentData.endSession(workflowId, interactionId);
    return true;
  } catch (err) {
    void import('./diag-log').then(({ diag }) =>
      diag('chat', `end-session 서버 정리 실패(무시): ${(err as Error).message}`),
    );
    return false;
  }
});

// ── IPC: browser runtime ─────────────────────────────────────────
ipcMain.handle(CHANNELS.browserState, () => getBrowserRuntime().state());
ipcMain.handle(CHANNELS.browserCreate, (_e, request) => getBrowserRuntime().create(request));
ipcMain.handle(CHANNELS.browserEnsureShared, (_e, workflowId: string, workflowName?: string) =>
  getBrowserRuntime().ensureShared(workflowId, workflowName),
);
ipcMain.handle(CHANNELS.browserBindShared, (_e, pageId: string, webContentsId: number) =>
  getBrowserRuntime().bindSharedPage(pageId, webContentsId),
);
ipcMain.handle(CHANNELS.browserNavigate, (_e, request) => getBrowserRuntime().navigate(request));
ipcMain.handle(CHANNELS.browserActivate, (_e, pageId: string) =>
  getBrowserRuntime().activate(pageId),
);
ipcMain.handle(CHANNELS.browserSelectionBegin, (event, request) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('browser_denied: 허용되지 않은 브라우저 선택 요청입니다.');
  }
  return getBrowserRuntime().beginSelection(request, event.sender.id);
});
ipcMain.handle(CHANNELS.browserSelectionInspect, (event, request) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('browser_denied: 허용되지 않은 브라우저 검사 요청입니다.');
  }
  return getBrowserRuntime().inspectSelection(request, event.sender.id);
});
ipcMain.handle(CHANNELS.browserSelectionComplete, (event, request) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('browser_denied: 허용되지 않은 브라우저 캡처 요청입니다.');
  }
  return getBrowserRuntime().completeSelection(request, event.sender.id);
});
ipcMain.handle(CHANNELS.browserSelectionCancel, (event, token: string) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  return getBrowserRuntime().cancelSelection(token, event.sender.id);
});
ipcMain.handle(CHANNELS.browserPopupResolve, (event, request: BrowserPopupResolveRequest) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('browser_denied: 허용되지 않은 팝업 권한 요청입니다.');
  }
  return getBrowserRuntime().resolvePopup(request);
});
ipcMain.handle(
  CHANNELS.browserHistorySuggestions,
  (_event, request: BrowserHistorySuggestionsRequest = {}) => {
    const partition = getBrowserRuntime().partition();
    return partition
      ? getBrowserHistoryStore().suggestions(partition, request.query, request.limit)
      : [];
  },
);
ipcMain.handle(CHANNELS.browserHistoryList, (_event, request: BrowserHistoryListRequest = {}) => {
  const partition = getBrowserRuntime().partition();
  return partition ? getBrowserHistoryStore().list(partition, request) : { items: [], total: 0 };
});
ipcMain.handle(
  CHANNELS.browserHistoryRemove,
  (_event, request: BrowserHistoryRemoveRequest = {}) => {
    const partition = getBrowserRuntime().partition();
    return partition ? getBrowserHistoryStore().remove(partition, request) : false;
  },
);
ipcMain.handle(CHANNELS.browserHistoryClear, async () => {
  const partition = getBrowserRuntime().partition();
  if (!partition) return false;
  await getBrowserHistoryStore().clear(partition);
  return true;
});
ipcMain.handle(CHANNELS.browserClose, async (_e, pageId: string) => {
  await getBrowserRuntime().close(pageId);
  return true;
});
ipcMain.handle(CHANNELS.browserCloseWorkflow, async (_e, workflowId: string) => {
  await getBrowserRuntime().closeWorkflow(workflowId);
  return true;
});

// ── IPC: updater ─────────────────────────────────────────────────
ipcMain.handle(CHANNELS.updaterCheck, () => checkNow());
ipcMain.handle(CHANNELS.updaterGetEnabled, () => getAutoUpdate());
ipcMain.handle(CHANNELS.updaterSetEnabled, (_e, enabled: boolean) => {
  setAutoUpdate(enabled);
  saveConfig({ autoUpdate: enabled });
  return enabled;
});
ipcMain.handle(CHANNELS.openExternal, (_e, url: string) => shell.openExternal(url));
ipcMain.handle(CHANNELS.appVersion, () => app.getVersion());
ipcMain.handle(CHANNELS.systemMetrics, () =>
  systemMetricsSampler.sample(
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name,
      // Electron reports ProcessMetric memory fields in KiB.
      memoryBytes: metric.memory.workingSetSize * 1024,
    })),
  ),
);

// ── IPC: floating avatar overlay ─────────────────────────────────
ipcMain.handle(CHANNELS.overlayGetEnabled, () => !!loadConfig().avatarOverlay);
ipcMain.handle(CHANNELS.overlaySetEnabled, (_e, enabled: boolean) => {
  setOverlayEnabled(!!enabled);
  return !!enabled;
});
// Main window pushes the live avatar/chat state; relay it to the overlay.
ipcMain.on(CHANNELS.overlayPushState, (_e, state: unknown) => {
  lastOverlayState = state;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(CHANNELS.overlayState, state);
  }
});
// Overlay renderer → native window controls.
ipcMain.on(CHANNELS.overlaySetIgnoreMouse, (_e, ignore: boolean) => {
  // 남아 있는 호출자(구버전 페이지)를 위한 호환 경로. 잠금은 이제 main 이
  // 소유하므로 이 채널로 임시로 바꾼 값은 다음 잠금 변경에 덮인다.
  applyOverlayIgnoreMouse(overlayWindow, !!ignore);
});

// ── 화면 캡처 ──
ipcMain.handle(CHANNELS.captureListSources, async () => {
  const { listSources } = await import('./screen-capture');
  return listSources();
});

ipcMain.handle(CHANNELS.captureAccessStatus, async () => {
  const { screenAccessStatus } = await import('./screen-capture');
  return screenAccessStatus();
});

ipcMain.handle(CHANNELS.captureScreen, async () => {
  const cfg = loadConfig();
  // 설정이 꺼져 있으면 **찍지 않는다.** 렌더러가 실수로 불러도 화면이 나가지
  // 않아야 한다 — 이 게이트는 서버가 아니라 사용자의 기기에 있어야 의미가 있다.
  if (!cfg.screenCapture) return { ok: false, error: '화면 캡처가 꺼져 있습니다.' };
  const { captureScreen } = await import('./screen-capture');
  return captureScreen(cfg.screenCaptureSource || undefined);
});

ipcMain.handle(CHANNELS.overlayGetLocked, () => overlayLocked);

ipcMain.on(CHANNELS.overlaySetLocked, (_e, locked: boolean) => {
  setOverlayLocked(!!locked);
});

ipcMain.on(CHANNELS.overlayChipSize, (_e, w: number, h: number) => {
  // 컨트롤 창은 내용에 맞춰야 한다 — 버튼 수가 STT/TTS 가용성에 따라 다르다.
  // 창이 내용보다 작으면 버튼이 잘리고, 크면 투명 영역이 클릭을 먹는다.
  const nw = Math.max(48, Math.round(Number(w) || 0));
  const nh = Math.max(28, Math.round(Number(h) || 0));
  if (nw === chipSize.w && nh === chipSize.h) return;
  chipSize = { w: nw, h: nh };
  syncChipBounds();
  publishChipInset();
});
ipcMain.on(CHANNELS.overlayMoveBy, (_e, dx: number, dy: number) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // The naive setPosition(getPosition()+delta) GROWS the window on Windows
  // fractional-DPI monitors (150%): Electron's setPosition internally does
  // SetBounds(newOrigin, getBounds().size()), and getBounds() reports the
  // DIP-rounded size — each frame reads a slightly larger rounded size and
  // writes it back, so over a drag's hundreds of frames the window balloons.
  // (setBounds has the exact same read-back-and-grow flaw; the old "setPosition
  // is size-safe" comment was wrong.)
  //
  // Fix: keep an AUTHORITATIVE rect in JS. Capture the real bounds once at the
  // start of a drag, then apply deltas to the tracked position and re-assert a
  // CONSTANT captured size every frame — never reading getBounds() mid-drag. A
  // constant DIP size converts to the same physical size each call, so it can't
  // drift; it also stays put when crossing to a different-scale monitor
  // (physical size adapts), and the post-drag reconcile snaps to that monitor's
  // remembered size. The rect auto-expires shortly after the last delta, or on
  // the explicit commitBounds (pointer-up) below.
  if (!overlayMoveRect) {
    const b = overlayWindow.getBounds();
    overlayMoveRect = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  overlayMoveRect.x += dx;
  overlayMoveRect.y += dy;
  overlayWindow.setBounds({
    x: Math.round(overlayMoveRect.x),
    y: Math.round(overlayMoveRect.y),
    width: overlayMoveRect.w,
    height: overlayMoveRect.h,
  });
  if (overlayMoveIdle) clearTimeout(overlayMoveIdle);
  overlayMoveIdle = setTimeout(endOverlayMove, 300); // fallback drag-end
});
ipcMain.on(CHANNELS.overlayResizeBy, (_e, edge: string, dx: number, dy: number) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const MIN = 200;
  const b = overlayWindow.getBounds();
  let { x, y, width, height } = b;
  if (edge.includes('e')) width = Math.max(MIN, width + Math.round(dx));
  if (edge.includes('s')) height = Math.max(MIN, height + Math.round(dy));
  if (edge.includes('w')) {
    const nw = Math.max(MIN, width - Math.round(dx));
    x += width - nw;
    width = nw;
  }
  if (edge.includes('n')) {
    const nh = Math.max(MIN, height - Math.round(dy));
    y += height - nh;
    height = nh;
  }
  overlayWindow.setBounds({ x, y, width, height });
  // Persistence via 'resized' (Windows) + overlay:commitBounds on pointer-up.
});
// Drag/resize gesture ENDED (renderer pointerup) → persist the SETTLED bounds for
// the current monitor immediately, so an immediate restart can't lose it.
ipcMain.on(CHANNELS.overlayCommitBounds, () => {
  // Gesture ended (pointer-up): drop the authoritative move rect so the next
  // window event reads real bounds again, then persist immediately.
  if (overlayMoveIdle) {
    clearTimeout(overlayMoveIdle);
    overlayMoveIdle = null;
  }
  overlayMoveRect = null;
  saveOverlayGeometry(true);
});
ipcMain.on(CHANNELS.overlayFocusMain, () => showMain());
ipcMain.on(CHANNELS.overlayOpenSettings, () => openMainSettings());
ipcMain.on(CHANNELS.overlayHide, () => setOverlayEnabled(false));

// ── IPC: app / window management ─────────────────────────────────
/** 네이티브 폴더 선택 — 설정 화면(기본 작업 폴더·허용 폴더)이 쓴다. 경로를
 *  타이핑하게 두면 오타 하나로 도구 스코프가 조용히 빗나간다 — 고르게 한다. */
ipcMain.handle(CHANNELS.pickFolder, async () => {
  const win = mainWindow;
  const r = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle(CHANNELS.appOpenFolder, async (_e, p: unknown) => {
  const dir = typeof p === 'string' && p.trim() ? p : resolveDataRoot(loadConfig());
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 열기에서 드러남 */
  }
  const err = await shell.openPath(dir);
  return { ok: !err, error: err || undefined };
});
ipcMain.handle(CHANNELS.autostartGet, () => loadConfig().autoLaunch === true);
ipcMain.handle(CHANNELS.autostartSet, (_e, enabled: boolean) => {
  // 실효 결과를 저장·반환 — 리눅스 AppImage 임시 마운트 등 등록이 거부되면
  // 토글도 꺼진 상태로 남는다 (UI 가 거짓말하지 않게).
  const effective = applyAutoLaunch(!!enabled);
  saveConfig({ autoLaunch: effective });
  rebuildTrayMenu();
  return effective;
});
ipcMain.on(CHANNELS.resetPositions, () => resetPositions());
ipcMain.on(CHANNELS.resetSettings, () => {
  void resetStoredSettings().catch((err) => {
    dialog.showErrorBox('설정 초기화 실패', err instanceof Error ? err.message : String(err));
  });
});
ipcMain.on(CHANNELS.appRestart, () => {
  saveOverlayGeometry(true); // persist any pending move/resize before relaunching
  relaunchSelf();
});
ipcMain.on(CHANNELS.appQuit, () => {
  appQuitting = true;
  app.quit();
});

// ── IPC: hotkeys ─────────────────────────────────────────────────
ipcMain.handle(CHANNELS.quickChatSetHotkey, (_e, acc: string) => {
  const prev = loadConfig().quickChatHotkey;
  saveConfig({ quickChatHotkey: acc });
  globalShortcut.unregister(prev ?? DEFAULT_QUICKCHAT);
  registerQuickChatHotkey();
  const ok = globalShortcut.isRegistered(acc);
  if (!ok) {
    saveConfig({ quickChatHotkey: prev ?? DEFAULT_QUICKCHAT });
    registerQuickChatHotkey();
  }
  return ok;
});
// While a settings field records a new combo, suspend global shortcuts so the
// currently-registered key isn't swallowed system-wide during capture.
ipcMain.on(CHANNELS.hotkeyPause, () => globalShortcut.unregisterAll());
ipcMain.on(CHANNELS.hotkeyResume, () => registerQuickChatHotkey());

// ── IPC: local MCP ───────────────────────────────────────────────
ipcMain.handle(CHANNELS.mcpGetEnabled, () => !!loadConfig().mcp);
ipcMain.handle(CHANNELS.mcpSetEnabled, (_e, enabled: boolean) => {
  setMcpEnabled(!!enabled);
  return !!enabled;
});
ipcMain.handle(CHANNELS.mcpListServers, () => loadConfig().mcpServers ?? []);
/**
 * MCP 서버 목록을 반영한다(설정 UI 와 에이전트 자기관리 도구의 공통 경로).
 * G8a: 비밀 env/headers 값은 암호화 키체인으로 옮기고 connector.json 에는 redacted(값 '')만
 * 저장한다. 제거된 서버의 비밀/OAuth 상태는 정리한다. 저장 후 syncMcp() 로 매니저를 재조정하고
 * broadcast 한다. 반환은 저장된(redacted) 서버 목록.
 */
async function applyMcpServers(incoming: McpServerConfig[]): Promise<McpServerConfig[]> {
  const prev = loadConfig().mcpServers ?? [];
  const redacted: McpServerConfig[] = [];
  for (const s of incoming) {
    if (!s || !s.name) continue;
    const stored = await mcpSecretStore.get(s.name).catch(() => null);
    const { redacted: safe, secrets } = splitServerSecrets(s, stored);
    await mcpSecretStore.save(s.name, secrets).catch(() => {});
    redacted.push(safe);
  }
  // Clean up secrets + OAuth state for removed servers.
  const keep = new Set(redacted.map((s) => s.name));
  for (const p of prev) {
    if (p?.name && !keep.has(p.name)) {
      await mcpSecretStore.clear(p.name).catch(() => {});
      await mcpOAuthStore.clear(p.name).catch(() => {});
    }
  }
  const next = saveConfig({ mcpServers: redacted });
  syncMcp();
  broadcastConfig(next);
  return next.mcpServers ?? [];
}

ipcMain.handle(CHANNELS.mcpSaveServers, async (_e, servers) => {
  const incoming: McpServerConfig[] = Array.isArray(servers) ? servers : [];
  return applyMcpServers(incoming);
});
ipcMain.handle(CHANNELS.mcpTestServer, async (e, cfg) => {
  // OAuth 서버는 테스트가 임시이름(__test__)로 붙어 토큰이 없어 항상 실패하고, DCR 이
  // 돌면 임시이름으로 고아 키체인 항목을 남긴다. 브라우저 인가로 안내하고 단락한다.
  if (cfg?.auth === 'oauth') {
    const authed = cfg?.name ? await hasOAuthTokens(String(cfg.name)).catch(() => false) : false;
    return {
      ok: authed,
      message: authed
        ? '이미 인가된 OAuth 서버입니다. 저장하면 자동 연결됩니다.'
        : 'OAuth 서버는 테스트 대신 "브라우저로 인가하기" 를 사용하세요. 인가되면 자동 연결됩니다.',
    };
  }
  // 첫 실행은 인터프리터·의존성 내려받기로 몇 분이 걸릴 수 있다 — 그동안의
  // 서버 출력을 요청한 창으로 그대로 흘려보낸다.
  // G8a: 폼 값이 redacted('') 여도(저장된 서버를 테스트) 키체인 시크릿으로 채워 테스트.
  const stored = cfg?.name ? await mcpSecretStore.get(cfg.name).catch(() => null) : null;
  const resolved = cfg ? withResolvedSecrets(cfg, stored) : cfg;
  return getMcpManager().test(resolved, (lines) => {
    if (!e.sender.isDestroyed())
      e.sender.send(CHANNELS.mcpTestProgressEvent, { name: cfg?.name, lines });
  });
});
ipcMain.handle(CHANNELS.mcpAuthorize, async (_e, cfg) => {
  // G8b: interactive OAuth 2.1 (PKCE) — opens the browser + loopback listener.
  const stored = cfg?.name ? await mcpSecretStore.get(cfg.name).catch(() => null) : null;
  const resolved = cfg ? withResolvedSecrets(cfg, stored) : cfg;
  const res = await authorizeMcpServer(resolved, { fetch: mcpHttpFetch });
  if (res.ok) syncMcp(); // reconnect now that tokens exist
  return res;
});
ipcMain.handle(CHANNELS.mcpOauthStatus, async (_e, name) => ({
  authorized: await hasOAuthTokens(String(name || '')).catch(() => false),
}));
ipcMain.handle(CHANNELS.mcpClearOauth, async (_e, name) => {
  await clearOAuth(String(name || '')).catch(() => {});
  syncMcp();
  return { ok: true };
});
ipcMain.handle(CHANNELS.mcpRenameSecrets, async (_e, oldName, newName) => {
  // 서버 이름 변경 시 키체인의 시크릿/OAuth 를 old→new 로 이관한다. 안 하면 mcpSaveServers
  // 의 삭제정리(prev-but-not-new)가 옛 이름의 시크릿/토큰을 지워 데이터가 소실된다.
  const from = String(oldName || '');
  const to = String(newName || '');
  if (!from || !to || from === to) return { ok: true };
  try {
    const sec = await mcpSecretStore.get(from);
    if (sec) {
      await mcpSecretStore.save(to, sec);
    }
    const oauth = await mcpOAuthStore.load(from);
    if (oauth && (oauth.tokens || oauth.clientInformation || oauth.codeVerifier)) {
      await mcpOAuthStore.save(to, oauth);
    }
    // 옛 이름은 mcpSaveServers 의 삭제정리가 처리한다(중복 제거).
  } catch {
    /* best-effort — 저장은 계속 진행 */
  }
  return { ok: true };
});
ipcMain.handle(CHANNELS.mcpStatus, () => getMcpBridge().status());
ipcMain.handle(CHANNELS.mcpRuntimeLogs, () => mcpRuntimeLogs());
ipcMain.handle(CHANNELS.mcpClearRuntimeLogs, () => {
  clearMcpRuntimeLogs();
  return true;
});

/**
 * 파일 관리자로 경로 열기 — **shell.openPath 를 쓰면 안 된다.**
 *
 * 우리 마운트는 이 프로세스의 이벤트 루프가 서빙한다. `shell.openPath` 는
 * 경로를 **동기적으로 확인**하므로, 그 대상이 우리 마운트면 루프가 막히고
 * FUSE 콜백이 응답하지 못해 **서로를 기다리는 데드락**이 된다 (실기: "폴더
 * 열기"를 누르는 순간 앱이 응답 없음).
 *
 * 자식 프로세스로 분리하면 우리 루프는 계속 돌고 마운트도 계속 응답한다.
 */
function openInFileManager(target: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.log(`[workspace] 폴더 열기 실패: ${e.message}`));
    child.unref();
  } catch (e) {
    console.log(`[workspace] 폴더 열기 실패: ${(e as Error).message}`);
  }
}

// ── 계정별 워크스페이스 ────────────────────────────────────────────
//
// 워크스페이스는 **로그인한 계정에 속한다**. 예전에는 전역 설정 하나여서,
// 계정을 바꿔 로그인해도 이전 계정의 루트·부착 에이전트를 그대로 물었다.
// 두 계정이 같은 폴더를 클라우드로 가리키면 서로의 파일을 덮어썼다.

/** 지금 로그인한 계정의 키. 로그아웃 상태면 null. */
function currentAccountKey(): string | null {
  const uid = client?.user?.userId;
  if (!uid) return null;
  return accountKey(normalizeServerUrl(loadConfig().serverUrl), String(uid));
}

// ── 파일 시스템 — XGen 저장소를 이 PC 의 실제 폴더로 (계정별 토글) ────
//
// [XGen 클라우드 연결]    <dataRoot>/cloud            ↔ user:<id> 저장소
// [Agent Workspace 연결] <dataRoot>/agent_workspace/  ↔ 모든 에이전트 워크스페이스
// 기본은 둘 다 OFF — 서버에서는 어차피 항상 실행되고, 이 토글은 그것을
// 로컬 폴더로 보느냐만 정한다. 자세한 철학은 file-system.ts 참조.
let fileSystem: FileSystemController | null = null;

/** 동기화 엔진용 전송 — latest_seq 포함 타입. */
function syncRemoteFor(workflowId: string): SyncRemote {
  const auth = () => ({
    baseUrl: normalizeServerUrl(loadConfig().serverUrl),
    token: liveAccessToken,
    refreshAuth: refreshAuthToken,
    workflowId,
    deviceId: ensureDeviceId(),
    fetch: (input: Parameters<typeof net.fetch>[0], init?: Parameters<typeof net.fetch>[1]) =>
      net.fetch(input, init),
    allowPrivateCertificate: loadConfig().allowPrivateCertificate === true,
  });
  const staging = () => join(app.getPath('userData'), 'sync-staging');
  if (workflowId.startsWith('user:')) {
    // 사용자 클라우드 = **파일 저장소** — geny-workspace 가 아니라
    // /api/filestore/sync/* 표면과 말한다 (rmdir: 빈 원격 폴더 정리 포함).
    const transport = () => new FilestoreSyncTransport(auth(), staging());
    return {
      changes: (since) => transport().changes(since),
      download: (path, toAbs) => transport().download(path, toAbs),
      put: (path, fromAbs, baseSha) => transport().put(path, fromAbs, baseSha),
      del: (path, baseSha, opts) => transport().del(path, baseSha, opts),
      mkdir: (path) => transport().mkdir(path),
      rmdir: (path) => transport().rmdir(path),
    };
  }
  const transport = () => new HttpSyncTransport(auth(), staging());
  return {
    changes: (since) => transport().changes(since),
    download: (path, toAbs) => transport().download(path, toAbs),
    put: (path, fromAbs, baseSha) => transport().put(path, fromAbs, baseSha),
    del: (path, baseSha, opts) => transport().del(path, baseSha, opts),
    mkdir: (path) => transport().mkdir(path),
  };
}

function wireFileSystem(): void {
  fileSystem = new FileSystemController({
    dataRoot: () => resolveDataRoot(loadConfig()),
    loggedIn: () => !!client?.user,
    userId: () => (client?.user?.userId != null ? String(client.user.userId) : null),
    config: () => {
      const key = currentAccountKey();
      return key ? (loadConfig().fileSystems?.[key] ?? {}) : {};
    },
    persist: (next) => {
      const key = currentAccountKey();
      if (!key) return;
      const cfg = loadConfig();
      saveConfig({ fileSystems: { ...(cfg.fileSystems ?? {}), [key]: next } });
    },
    // "실행 세션" 에이전트 = 이 계정의 에이전트 전부 — 서버 목록이 원본이다.
    listAgents: async () => {
      const agents = await getClient().agents.listAll({ owner: 'personal' });
      return agents.map((a) => ({
        workflowId: a.workflowId,
        label: a.workflowName || a.workflowId,
      }));
    },
    remoteFor: syncRemoteFor,
    // 벌크 인덱스 probe — 보험 주기가 저장소마다 changes 를 돌지 않고 요청
    // 한 번으로 "변한 저장소"만 고른다 (구서버는 404 → 매니저가 전수 폴백).
    indexSeqs: (owners: string[]) =>
      fetchIndexSeqs(
        {
          baseUrl: normalizeServerUrl(loadConfig().serverUrl),
          token: liveAccessToken,
          refreshAuth: refreshAuthToken,
          workflowId: '',
          deviceId: ensureDeviceId(),
          fetch: (input, init) => net.fetch(input, init),
          allowPrivateCertificate: loadConfig().allowPrivateCertificate === true,
        },
        owners,
      ),
    presenceFor: (owner: string, onChanged: () => void) => {
      if (owner.startsWith('user:')) {
        // 파일 저장소에는 변경 WS 가 없다 — 인덱스 probe(5분)와 스윕이 담당.
        // geny WS 를 붙이면 **다른 저장소**의 알림으로 엉뚱한 사이클만 돈다.
        return { start: async () => undefined, stop: () => undefined };
      }
      return new WorkspaceWsClient(
        {
          baseUrl: normalizeServerUrl(loadConfig().serverUrl).replace(/\/$/, ''),
          token: liveAccessToken,
          refreshAuth: refreshAuthToken,
          workflowId: owner,
          deviceId: ensureDeviceId(),
          deviceName: deviceNameOf(),
          fetch: (input, init) => net.fetch(input, init),
          allowPrivateCertificate: loadConfig().allowPrivateCertificate === true,
        },
        deviceNameOf(),
        () => onChanged(),
        () => undefined,
      );
    },
    // ⚠ 'fs' 하위로 **새 네임스페이스** — 옛 로컬 동기화(기본 작업 폴더 시절)의
    // base 스냅숏을 새(빈) agent_workspace 루트에 재사용하면 3-way 가 "로컬
    // 전체 삭제"로 오판해 서버 파일을 지운다. 루트가 바뀌었으니 base 도
    // 처음부터다 (첫 사이클은 전부 다운로드 — 안전).
    stateDir: () =>
      join(
        app.getPath('userData'),
        'local-sync',
        (currentAccountKey() ?? 'anon').replace(/[^A-Za-z0-9._-]/g, '_'),
        'fs',
      ),
    deviceName: deviceNameOf(),
    onStatus: (s) => safeSend(mainWindow, CHANNELS.fsStatusEvent, s),
  });
  fileSystem.reconcile();

  // 워크스페이스 브리지 — 서버의 ConnectorLocalSandbox 가 이 PC 를 실행
  // 환경으로 쓰는 내부 도구(_Exec 등). 토글과 무관하게 동작한다 — 커넥터
  // 세션 실행의 전제는 로그인뿐이다. /cloud 가상 경로는 클라우드 동기화가
  // 켜져 있을 때만 열린다.
  getLocalToolProvider().configureWorkspaceBridge(
    new WorkspaceBridge({
      infoFor: (workflowId: string, workflowName?: string) => {
        const dir = fileSystem?.ensurePair(workflowId, workflowName || workflowId) ?? null;
        if (!dir) return null;
        const agent = fileSystem
          ?.status()
          .agents.list.find((a) => a.workflowId === workflowId);
        return { dir, label: agent?.label ?? workflowName ?? workflowId };
      },
      ensureSynced: async (workflowId: string, workflowName?: string) => {
        const r = (await fileSystem?.ensureSynced(workflowId, workflowName || workflowId)) ?? {
          dir: null,
          synced: false,
        };
        if (!r.dir) return { info: null, synced: false };
        const agent = fileSystem
          ?.status()
          .agents.list.find((a) => a.workflowId === workflowId);
        return {
          info: { dir: r.dir, label: agent?.label ?? workflowName ?? workflowId },
          synced: r.synced,
        };
      },
      flushSync: async (workflowId: string) => (await fileSystem?.flushSync(workflowId)) ?? false,
      cloudDir: () => fileSystem?.cloudDir() ?? null,
      poke: (workflowId: string) => fileSystem?.poke(workflowId),
    }),
  );
}

// ── 로컬 실행 v2: 사이드카 데몬 + 서버 버전 수렴 ──────────────────────
/** 사이드카 데몬(상주) — 첫 턴에 기동, 유휴 15분 뒤 자가 종료, 앱 종료 시 내림. */
/**
 * 통합 데이터 루트 정착(부팅 1회) — 인스톨러 선택(install-options.json)을 삼키고,
 * dataRoot 트리(workspace/·cloud/·local-runtime/)를 만들고, 미설정 경로 기본을
 * config 에 채운다. 명시 설정은 절대 덮지 않는다.
 */
function settleDataRootOnBoot(): void {
  try {
    const installPatch = consumeInstallOptions(app.getPath('userData'));
    if (installPatch) saveConfig(installPatch);
    const { root, patch } = settleDataRoot(loadConfig());
    if (Object.keys(patch).length) saveConfig(patch);
    // 실효 루트 마커 — 인스톨러(업데이트 시 런타임 복사 대상)·언인스톨러가 읽는다.
    writeDataRootMarker(app.getPath('userData'), root);
  } catch (e) {
    console.error('[data-root] 정착 실패(무시):', e);
  }
}
/**
 * 런타임 자가치유 사다리(설치 폴더 → 내장 번들 복사 → 네트워크 설치) — 서버와 무관하게
 * "항상 쓸 수 있는 런타임"을 보장하고, 상태/원인을 설정 화면에 그대로 드러낸다.
 * 진행은 메인 창으로 push(localRuntimeProgress).
 */
/** 부팅 배선 단계 실패(있으면) — 설정 화면에 그대로 드러낸다. */
/** 설치 폴더의 install.log — 인스톨러(NSIS)와 앱이 **같은 파일**에 이어 쓴다. */
function installLogPath(): string {
  return join(resolveDataRoot(loadConfig()), 'install.log');
}
function appendInstallLog(line: string): void {
  try {
    mkdirSync(resolveDataRoot(loadConfig()), { recursive: true });
    appendFileSync(installLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 로그 실패는 무시 */
  }
}

/** CLI 바이너리 자동 보장 — 도구별 single-flight(연타 턴이 중복 설치하지 않게). */
ipcMain.handle(CHANNELS.fsStatus, () => fileSystem?.status() ?? null);
ipcMain.handle(CHANNELS.fsSetCloud, async (_e, on: unknown) => {
  await fileSystem?.setCloudSync(on === true);
  return fileSystem?.status();
});
ipcMain.handle(CHANNELS.fsSetAgents, async (_e, on: unknown) => {
  await fileSystem?.setAgentSync(on === true);
  return fileSystem?.status();
});
ipcMain.handle(CHANNELS.fsSyncNow, async (_e, workflowId?: unknown) => {
  await fileSystem?.syncNow(typeof workflowId === 'string' ? workflowId : undefined);
  return fileSystem?.status();
});
ipcMain.handle(CHANNELS.fsRefreshAgents, async () => {
  await fileSystem?.refreshAgents();
  return fileSystem?.status();
});
/** 탐색기의 클라우드(파일 저장소) 서버 트리 — 동기화 OFF/미완료 상태의
 *  읽기 전용 관측. ⚠ geny(agentData.workspaceTree)가 아니라 **파일 저장소**
 *  스냅숏을 읽는다 — 클라우드 섹션이 구 xgen-cloud 를 비추면 안 된다. */
ipcMain.handle(CHANNELS.fsCloudServerTree, async () => {
  const uid = client?.user?.userId != null ? String(client.user.userId) : null;
  if (!uid) return [];
  const transport = new FilestoreSyncTransport(
    {
      baseUrl: normalizeServerUrl(loadConfig().serverUrl),
      token: liveAccessToken,
      refreshAuth: refreshAuthToken,
      workflowId: `user:${uid}`,
      deviceId: ensureDeviceId(),
      fetch: (input, init) => net.fetch(input, init),
      allowPrivateCertificate: loadConfig().allowPrivateCertificate === true,
    },
    join(app.getPath('userData'), 'sync-staging'),
  );
  try {
    const res = await transport.changes(0);
    return (res.changes ?? [])
      .filter((c) => !c.deleted)
      .map((c) => ({
        name: c.path.split('/').pop() ?? c.path,
        path: c.path,
        is_dir: !!c.is_dir,
        size: c.size ?? 0,
        modified_at: c.mtime_ns ? new Date(c.mtime_ns / 1e6).toISOString() : undefined,
      }));
  } catch (e) {
    void import('./diag-log').then(({ diag }) =>
      diag('file-system', `파일 저장소 서버 트리 조회 실패: ${(e as Error).message}`),
    );
    return [];
  }
});

/** 동기화 폴더 나열 — 탐색기가 로컬 실파일을 그대로 본다.
 *  workflowId 'user:<id>' 는 클라우드 폴더다. */
ipcMain.handle(CHANNELS.fsList, async (_e, workflowId: unknown, rel: unknown) => {
  const dir = typeof workflowId === 'string' ? fileSystem?.dirFor(workflowId) : null;
  if (!dir) return [];
  const relPath = typeof rel === 'string' ? rel : '';
  if (relPath && !isSafeRelPath(relPath)) return [];
  const abs = join(dir, ...relPath.split('/').filter(Boolean));
  try {
    const { readdir, stat } = await import('fs/promises');
    const entries = await readdir(abs, { withFileTypes: true });
    const out: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = [];
    for (const e of entries) {
      if (e.name === '.xgeny-session') continue;
      try {
        const st = await stat(join(abs, e.name));
        out.push({
          name: e.name,
          isDir: e.isDirectory(),
          size: e.isFile() ? st.size : 0,
          mtime: Math.floor(st.mtimeMs),
        });
      } catch {
        /* 나열 도중 사라진 항목 */
      }
    }
    return out;
  } catch {
    return [];
  }
});
ipcMain.handle(CHANNELS.fsOpenPath, (_e, workflowId: unknown, rel: unknown) => {
  const dir = typeof workflowId === 'string' ? fileSystem?.dirFor(workflowId) : null;
  if (!dir) return { ok: false };
  const relPath = typeof rel === 'string' ? rel : '';
  if (relPath && !isSafeRelPath(relPath)) return { ok: false };
  openInFileManager(join(dir, ...relPath.split('/').filter(Boolean)));
  return { ok: true };
});
/** 루트 폴더 열기 — 'cloud' | 'agents' | 'data'. 동기화 여부와 무관하게
 *  폴더 자체는 dataRoot 트리에 존재한다. */
ipcMain.handle(CHANNELS.fsOpenRoot, (_e, kind: unknown) => {
  const st = fileSystem?.status();
  if (!st) return { ok: false };
  const p = kind === 'cloud' ? st.cloud.dir : kind === 'agents' ? st.agents.root : st.dataRoot;
  openInFileManager(p);
  return { ok: true };
});

/** 탐색기/공유 경로 검증 — `/` 시작, `..` 세그먼트 금지. */
function safeDrivePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..')) return null;
  return '/' + parts.join('/');
}

ipcMain.handle(CHANNELS.diagCopy, async () => {
  // ⚠ 렌더러의 navigator.clipboard 는 Electron 에서 조용히 실패할 수 있다
  // (보안 컨텍스트/권한). main 의 clipboard 모듈은 항상 동작한다.
  const { diagText, diagHeader } = await import('./diag-log');
  const text = `${diagHeader({ app: app.getVersion() })}\n\n${diagText()}`;
  clipboard.writeText(text);
  return { ok: true, chars: text.length };
});
ipcMain.handle(CHANNELS.diagText, async () => {
  const { diagText } = await import('./diag-log');
  return diagText();
});
ipcMain.handle(CHANNELS.mcpRefresh, async () => {
  // 설정 화면을 열 때/테스트 성공 후 다시 붙여 본다 — 런타임을 나중에 설치한
  // 경우 예전 실패 문구가 계속 남아 있으면 안 된다.
  await getMcpBridge().refreshCatalog();
  return getMcpBridge().status();
});

// ── IPC: 시크릿 저장 상태 (키체인 불가 표면화) ────────────────────
ipcMain.handle(CHANNELS.secureStorageStatus, () => storageStatus());

// ── IPC: quick-chat ──────────────────────────────────────────────
ipcMain.handle(CHANNELS.quickChatGetEnabled, () => !!loadConfig().quickChat);
ipcMain.handle(CHANNELS.quickChatSetEnabled, (_e, enabled: boolean) => {
  setQuickChatEnabled(!!enabled);
  return !!enabled;
});
ipcMain.handle(
  CHANNELS.quickChatGetHotkey,
  () => loadConfig().quickChatHotkey ?? DEFAULT_QUICKCHAT,
);
ipcMain.handle(CHANNELS.quickChatSubmit, (_e, text: string) => {
  const r = deliverQuickChat(text);
  if (r.ok) dismissQuickChat();
  return r;
});
ipcMain.on(CHANNELS.quickChatClose, () => dismissQuickChat());

// ── app lifecycle ────────────────────────────────────────────────
/**
 * 메인 프로세스에서 예외/거부가 새어 나가면 Electron 은 **앱을 그대로 종료**한다.
 *
 * 사용자에게는 "앱이 그냥 꺼졌다"로만 보이고 원인이 어디에도 남지 않는다
 * (실기: 워크스페이스 폴더를 바꾸려는 순간 앱이 사라짐). 배경 작업 하나가
 * 실패했다고 앱 전체가 죽을 이유는 없다 — 로그에 남기고 살려 둔다.
 */
process.on('uncaughtException', (err) => {
  try {
    console.log(`[main] 처리되지 않은 예외: ${err?.stack || err}`);
    void import('./diag-log').then(({ diag }) =>
      diag('main', `처리되지 않은 예외: ${err?.stack || err}`),
    );
  } catch {
    /* 로깅 실패가 종료 사유가 되면 안 된다 */
  }
});
process.on('unhandledRejection', (reason) => {
  try {
    console.log(`[main] 처리되지 않은 거부: ${String(reason)}`);
    void import('./diag-log').then(({ diag }) =>
      diag('main', `처리되지 않은 거부: ${String(reason)}`),
    );
  } catch {
    /* 위와 같다 */
  }
});

// Single-instance: a second launch focuses the existing app instead of opening
// a duplicate (important — global hotkeys + tray must be owned by one instance).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    // 엔진에 이 호스트를 붙인다 — **가장 먼저**. 로컬 도구·MCP 매니저·서버
    // 브릿지가 전부 이 포트들 위에서 돌고, 붙기 전에 건드리면 엔진이 명확히
    // 던진다(조용히 메모리로 폴백해서 사용자의 MCP 인증을 매번 잃는 대신).
    bindDesktopHost();

    const cfg = loadConfig();
    if (cfg.theme) nativeTheme.themeSource = cfg.theme;
    applyCertificatePolicy();
    applyMcpHttpCertificatePolicy();

    // Voice input: the renderer calls navigator.mediaDevices.getUserMedia for the
    // push-to-talk mic. Electron denies media by default unless we approve it —
    // grant ONLY 'media', deny every other permission request.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

    // Avatar asset proxy: xgenavatar://a/<path> → <serverUrl>/<path>, fetched in
    // the main process (no CORS/CSP). The renderer points the Live2D/Spine loader
    // at xgenavatar:// URLs so model3.json + its relative moc3/textures/atlas
    // siblings all resolve through here.
    protocol.handle('xgenavatar', async (request) => {
      try {
        const u = new URL(request.url);
        const serverUrl = normalizeServerUrl(loadConfig().serverUrl).replace(/\/+$/, '');
        if (!serverUrl) return new Response('avatar proxy: no server URL', { status: 502 });
        // xgenavatar://a/<path> → <serverUrl>/<path>. Electron net.fetch: no CORS/CSP.
        return await net.fetch(`${serverUrl}${u.pathname}${u.search}`, { method: 'GET' });
      } catch (e) {
        return new Response(`avatar proxy error: ${e instanceof Error ? e.message : String(e)}`, {
          status: 502,
        });
      }
    });
    // The install callback flips appQuitting so quitAndInstall isn't blocked by
    // the close-to-tray guard.
    initUpdater({
      enabled: cfg.autoUpdate ?? true,
      updateServer: cfg.updateServer ?? 'github',
      isConfigured: () => !!normalizeServerUrl(loadConfig().serverUrl),
      xgenServerUrl: () => normalizeServerUrl(loadConfig().serverUrl),
      xgenToken: async () => (await liveAccessToken()) || null,
      onWillInstall: () => {
        appQuitting = true;
      },
      onUpdateAvailable: (version, onAccept) => {
        notificationCenter.publish(
          {
            id: `update-ready-${version}`,
            type: 'system.update_ready',
            title: 'XGen Dex 업데이트',
            body: `새 버전 v${version} — 클릭하면 지금 업데이트합니다.`,
            occurredAt: new Date().toISOString(),
            groupKey: 'system:update',
            target: { kind: 'none' },
          },
          { onClick: onAccept, bypassVisibility: true },
        );
      },
    });
    const trayOk = createTray();
    // `--hidden` (autostart) → start in the tray without showing the window.
    // 트레이 생성 실패(리눅스 appindicator 부재 등) 시 --hidden 을 취소한다 —
    // 트레이도 창도 없는 도달 불가 프로세스 방지 (geny-connector 동형).
    const startHidden = process.argv.includes('--hidden') && trayOk;
    createWindow();
    if (startHidden) mainWindow?.removeAllListeners('ready-to-show');
    // 부팅 배선 — 한 단계가 던져도 다음 단계(특히 로컬 실행 런타임 보장)가 멈추지 않게,
    // 각 단계를 격리하고 실패를 install.log 에 남긴다.
    const bootErrors: string[] = [];
    const bootStep = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
        bootErrors.push(`${name}: ${msg.split('\n')[0]}`);
        appendInstallLog(
          `[app] boot step ${name} FAILED: ${msg.split('\n').slice(0, 3).join(' | ')}`,
        );
        console.error(`[boot] ${name} failed`, e);
      }
    };
    bootStep('settleDataRoot', () => settleDataRootOnBoot()); // 통합 루트 정착 — 아래 배선들이 새 기본을 읽는다.
    bootStep('wireFileSystem', () => wireFileSystem());
    if (cfg.avatarOverlay) createOverlay();
    if (cfg.quickChat) {
      createQuickChat();
      registerQuickChatHotkey();
    }
    app.on('activate', () => showMain());

    // Monitor plug/unplug/rearrange or a DPI change → mark a settle window so
    // bounds saves hold off on transient rescale values, then rescue any window
    // that ended up off-screen on a now-disconnected monitor.
    let displayTimer: ReturnType<typeof setTimeout> | null = null;
    const onDisplayChange = () => {
      dpiSettleUntil = Date.now() + 1800;
      if (displayTimer) clearTimeout(displayTimer);
      displayTimer = setTimeout(ensureWindowsOnScreen, 900);
    };
    screen.on('display-removed', onDisplayChange);
    screen.on('display-added', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
  });

  // Tray app — never auto-quit when the window is hidden/closed. Quit only via
  // the tray "종료" (which sets appQuitting first).
  app.on('window-all-closed', () => {
    /* stay resident in the tray */
  });
  app.on('before-quit', () => {
    appQuitting = true;
    saveOverlayGeometry(true); // don't drop a pending move/resize on quit
    void browserHistoryStore?.flushAll().catch(() => undefined);
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    disposeUpdater();
    getMcpBridge().stop();
    void getBrowserRuntime().closeAll();
    void getMcpManager().closeAll();
    fileSystem?.stop();
  });
}
