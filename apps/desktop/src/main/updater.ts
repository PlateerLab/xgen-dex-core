/**
 * Auto-update via GitHub Releases or the configured XGEN download center.
 *
 * The releases repo is PUBLIC, so every feed URL (latest*.yml + installers) is
 * downloadable anonymously — being an org repo makes no difference. Verified:
 *   curl -sL .../releases/latest/download/latest.yml  → 200 + correct version.
 *
 * Platform behaviour:
 *   • Windows (NSIS) + Linux (AppImage): electron-updater self-updates
 *     (download → prompt → quitAndInstall).
 *   • macOS (unsigned): Squirrel.Mac can't apply an update to an unsigned /
 *     ad-hoc-signed app, so we do an ASSISTED update — auto-download the new
 *     .dmg to ~/Downloads and OPEN it, so the user just drags it to Applications.
 *
 * Robustness: all network calls use Electron's `net.fetch` (main-process HTTP,
 * system proxy/cert aware — NOT the ambiguous global fetch) with a timeout, so a
 * check ALWAYS resolves and the UI never gets stuck on "확인 중…".
 */
import { app, dialog, shell, BrowserWindow, net } from 'electron';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { basename, join } from 'node:path';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import { installerDownloadPath, installerListPath } from '@dex/protocol';
import {
  compareVersions,
  selectXgenUpdate,
  windowsNsisLauncherCommand,
  type UpdateServer,
  type XgenInstallerPackage,
} from './update-source';

// electron-updater is CommonJS: the `autoUpdater` instance lives on the DEFAULT
// export, NOT as a named export. `import { autoUpdater } from 'electron-updater'`
// (or `const { autoUpdater } = await import(...)`) resolves to `undefined` in the
// bundled main — which silently broke Windows/Linux self-update. Destructure the
// default export instead (Geny's proven pattern).
const { autoUpdater } = electronUpdater;

const REPO = 'PlateerLab/xgen-connector';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const SIX_HOURS = 6 * 60 * 60 * 1000;

let autoUpdate = true;
let updateServer: UpdateServer = 'github';
let isUpdateConfigured: () => boolean = () => false;
let getXgenServerUrl: () => string = () => '';
let getXgenToken: () => Promise<string | null> = async () => null;
let timer: NodeJS.Timeout | null = null;
let updaterRef: AppUpdater | null = null;
let lastNotifiedVersion: string | null = null;
let appWillInstall: () => void = () => {};
let showUpdateNotification: (version: string, onAccept: () => void) => void = () => {};
let busy = false; // guard against overlapping checks

function isPackagedMac(): boolean {
  return app.isPackaged && process.platform === 'darwin';
}
function canSelfUpdate(): boolean {
  return app.isPackaged && process.platform !== 'darwin';
}

function log(...args: unknown[]): void {
  console.log('[updater]', ...args);
}

/** Push a status line to the settings modal (inline feedback). */
function notify(message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:message', message);
  }
}

/** Main-process HTTP with a hard timeout, via Electron's net stack. */
async function netFetch(
  url: string,
  timeoutMs = 15000,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'xgen-dex',
        Accept: 'application/vnd.github+json',
        ...headers,
      },
    });
  } finally {
    clearTimeout(t);
  }
}

interface GhRelease {
  tag_name?: string;
  assets?: Array<{ name: string; browser_download_url: string; size: number }>;
}
async function latestRelease(): Promise<GhRelease> {
  const res = await netFetch(API_LATEST);
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return (await res.json()) as GhRelease;
}

// ── electron-updater (Windows / Linux) ───────────────────────────
function getUpdater(): AppUpdater | null {
  if (!canSelfUpdate()) return null;
  if (updaterRef) return updaterRef;
  autoUpdater.autoDownload = false;
  // 종료-시 자동 설치는 **silent 고정**이라 인스톨러(설치/데이터 폴더 페이지)가
  // 절대 안 뜬다 — 설치는 항상 아래 명시 경로(quitAndInstall isSilent=false)로만.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (m: unknown) => log('eu', m),
    warn: (m: unknown) => log('eu:warn', m),
    error: (m: unknown) => log('eu:error', m),
    debug: () => {},
  } as never;
  autoUpdater.on('download-progress', (p) => notify(`업데이트 내려받는 중… ${Math.round(p.percent)}%`));
  // Linux deb: electron-updater 의 재시작은 app.relaunch() 를 타는데, 리눅스의
  // `--type=relauncher` 헬퍼가 NoNewPrivs 를 설정한다 — 비가역이라 재시작된
  // 프로세스의 SUID chrome-sandbox 가 무력화돼 Ubuntu 24.04 에서 SIGTRAP 으로
  // 죽는다 (geny-connector 이식). 설치 직전 훅에서 분리 셸로 1.5초 뒤 재실행을
  // 예약해 NNP 없는 깨끗한 프로세스로 살아나게 한다.
  if (process.platform === 'linux') {
    // 'before-quit-for-update' 는 electron-updater 가 quitAndInstall 직전에
    // 쏘는 이벤트 — Electron 타입 정의에 없어 EventEmitter 로 캐스팅.
    (app as unknown as NodeJS.EventEmitter).on('before-quit-for-update', () => {
      try {
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const target = process.env.APPIMAGE || app.getPath('exe');
        spawn('/bin/sh', ['-c', 'sleep 1.5; exec "$@"', 'relaunch', target], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } catch (e) {
        log('linux relaunch schedule', e);
      }
    });
  }
  autoUpdater.on('update-downloaded', async (info) => {
    notify(`업데이트 준비됨 (v${info.version})`);
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비됨',
      message: `XGen Dex ${info.version} 가 다운로드됐습니다.`,
      detail: '지금 재시작하면 새 버전이 설치됩니다.',
    });
    if (res.response === 0) {
      appWillInstall(); // flips appQuitting so close-to-tray can't block the quit
      // 인스톨러 UI(설치 경로/데이터 폴더 페이지)가 보이게 isSilent=false.
      // (과거 silent 였던 이유는 oneClick 설치자의 즉시 파일락 체크가 앱 종료와
      // 레이스했기 때문 — 지금은 assisted 라 사용자가 페이지를 넘기는 사이 앱
      // 종료가 끝난다. 아래 safety-net 이 잔류 프로세스도 정리한다.)
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (e) {
        log('quitAndInstall', e);
      }
      // Safety net: a tray app can linger on quit (MCP stdio child pipes, the
      // overlay/quick-chat sockets). If the process is somehow still alive a few
      // seconds later, force-exit so the installer can replace the locked files.
      setTimeout(() => {
        try {
          app.exit(0);
        } catch {
          /* already gone */
        }
      }, 3500);
    }
  });
  autoUpdater.on('error', (err) => log('error', err?.message ?? err));
  updaterRef = autoUpdater;
  return autoUpdater;
}

/** Wrap a promise with a timeout so a hung check can't leave the UI stuck. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

// ── macOS assisted update (download the dmg + open it) ────────────
async function macAssistedUpdate(version: string, manual: boolean): Promise<void> {
  try {
    notify(`새 버전 v${version} 내려받는 중…`);
    const rel = await latestRelease();
    const asset = (rel.assets ?? []).find((a) => /\.dmg$/i.test(a.name));
    if (!asset) throw new Error('no dmg asset');
    const res = await netFetch(asset.browser_download_url, 180000);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = join(app.getPath('downloads'), asset.name);
    writeFileSync(dest, buf);
    notify('다운로드 완료 — 설치 창을 엽니다');
    await shell.openPath(dest);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${version} 다운로드 완료`,
        detail: `열린 디스크 이미지에서 'XGen-Dex' 를 Applications 폴더로 드래그해 설치하세요.\n파일 위치: ${dest}`,
      });
    }
  } catch (e) {
    log('mac assisted update failed', e);
    notify('릴리스 페이지를 엽니다');
    await shell.openExternal(RELEASES_URL);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${version} 이(가) 있습니다.`,
        detail: '자동 다운로드에 실패해 릴리스 페이지를 열었습니다. 새 dmg 를 받아 설치해 주세요.',
      });
    }
  }
}

async function macCheck(manual: boolean): Promise<void> {
  let latest: string;
  try {
    latest = String((await latestRelease()).tag_name ?? '').replace(/^v/, '');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log('mac check failed', detail);
    notify('업데이트 확인 실패');
    if (manual) await dialog.showMessageBox({ type: 'error', message: '업데이트 확인에 실패했습니다.', detail });
    return;
  }
  if (!latest || compareVersions(latest, app.getVersion()) <= 0) {
    notify(`최신 버전입니다 (v${app.getVersion()})`);
    if (manual) await dialog.showMessageBox({ type: 'info', message: '최신 버전입니다.', detail: `현재 v${app.getVersion()}` });
    return;
  }
  // Update available.
  if (manual) {
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      message: `새 버전 v${latest} 이(가) 있습니다.`,
      detail: `현재 v${app.getVersion()}. 새 버전을 내려받아 설치 창을 열어드립니다.`,
    });
    if (res.response === 0) await macAssistedUpdate(latest, true);
    else notify(`새 버전 v${latest} 이(가) 있습니다.`);
  } else if (lastNotifiedVersion !== latest) {
    lastNotifiedVersion = latest;
    notifyUpdateAvailable(latest, () => void macAssistedUpdate(latest, false));
  }
}

// ── XGEN download-center assisted update ────────────────────────
interface XgenInstallerListResponse {
  success?: boolean;
  data?: XgenInstallerPackage[];
}

async function xgenRequest(path: string, token: string, timeoutMs = 15000): Promise<Response> {
  const base = getXgenServerUrl().trim().replace(/\/+$/, '');
  if (!base) throw new Error('XGEN 서버 URL이 설정되지 않았습니다.');
  return netFetch(`${base}${path}`, timeoutMs, {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  });
}

async function downloadXgenPackage(pkg: XgenInstallerPackage, token: string): Promise<string> {
  const expectedHash = (pkg.file_hash ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('설치 파일의 SHA-256 정보가 없습니다.');
  }
  const id = encodeURIComponent(String(pkg.id));
  const res = await xgenRequest(installerDownloadPath(pkg.id), token, 180000);
  if (!res.ok) throw new Error(`XGEN 다운로드 센터 ${res.status}`);
  if (!res.body) throw new Error('설치 파일 응답이 비어 있습니다.');

  const safeName = basename(pkg.original_name || `xgen-dex-${pkg.version || 'update'}`);
  const updateDir = join(app.getPath('temp'), 'xgen-dex-updates', id);
  mkdirSync(updateDir, { recursive: true });
  const destination = join(updateDir, safeName);
  const output = createWriteStream(destination);
  const hash = createHash('sha256');
  const total = Number(res.headers.get('content-length') || pkg.file_size || 0);
  let downloaded = 0;
  let lastPercent = -1;
  try {
    for await (const value of res.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value);
      hash.update(chunk);
      downloaded += chunk.length;
      if (total > 0) {
        const percent = Math.min(100, Math.floor((downloaded / total) * 100));
        if (percent >= lastPercent + 5) {
          lastPercent = percent;
          notify(`업데이트 내려받는 중… ${percent}%`);
        }
      }
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await finished(output);
    if (hash.digest('hex') !== expectedHash) {
      throw new Error('설치 파일의 SHA-256 검증에 실패했습니다.');
    }
    return destination;
  } catch (error) {
    output.destroy();
    try {
      rmSync(destination, { force: true });
    } catch {
      // 부분 다운로드 정리는 best-effort다.
    }
    throw error;
  }
}

async function installXgenPackage(pkg: XgenInstallerPackage): Promise<void> {
  let destination = '';
  try {
    const token = await getXgenToken();
    if (!token) throw new Error('로그인 토큰이 없습니다. 다시 로그인해 주세요.');
    notify(`새 버전 v${pkg.version} 내려받는 중…`);
    destination = await downloadXgenPackage(pkg, token);
    notify(`업데이트 준비됨 (v${pkg.version})`);
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: [process.platform === 'win32' ? '지금 재시작' : '설치 시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비됨',
      message: `XGen Dex ${pkg.version} 설치 파일을 확인했습니다.`,
      detail:
        process.platform === 'win32'
          ? 'XGen Dex 종료 후 설치 진행 창을 표시하고 새 버전으로 다시 시작합니다.'
          : '설치 프로그램을 연 뒤 화면의 안내에 따라 업데이트를 완료해 주세요.',
    });
    if (result.response === 0) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          // NSIS를 바로 열면 현재 XGen Dex의 파일 잠금 검사와 경합한다.
          // 숨겨진 cmd launcher가 안전 종료 제한(3.5초)보다 늦게 실행해,
          // 앱이 완전히 사라진 뒤 대화형 NSIS 프로그레스 창을 표시한다.
          const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
          const launcher = spawn(command, ['/d', '/s', '/c', windowsNsisLauncherCommand()], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, XGEN_UPDATE_INSTALLER: destination },
          });
          launcher.once('spawn', () => {
            launcher.unref();
            resolve();
          });
          launcher.once('error', reject);
        });
        notify('XGen Dex 종료 후 설치 진행 창을 표시합니다.');
        appWillInstall();
        app.quit();
        // MCP·동기화 자식 프로세스가 종료를 늦춰 설치 파일 잠금이 남는 경우를
        // 막는다. electron-updater의 GitHub 경로와 같은 안전 종료 방식이다.
        setTimeout(() => {
          try {
            app.exit(0);
          } catch {
            /* 이미 종료됨 */
          }
        }, 3500);
        return;
      }
      const error = await shell.openPath(destination);
      if (error) throw new Error(error);
      notify('설치 프로그램을 열었습니다.');
    }
  } catch (error) {
    if (destination) {
      try {
        rmSync(destination, { force: true });
      } catch {
        // 임시 파일 정리는 best-effort다.
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    log('xgen download failed', detail);
    notify('업데이트 다운로드 실패');
    await dialog.showMessageBox({ type: 'error', message: '업데이트 다운로드에 실패했습니다.', detail });
  }
}

async function xgenCheck(manual: boolean): Promise<void> {
  if (manual) notify('업데이트 확인 중…');
  const token = await getXgenToken();
  if (!token) {
    if (manual) {
      notify('로그인 후 XGEN 업데이트를 확인할 수 있습니다.');
      await dialog.showMessageBox({
        type: 'info',
        message: 'XGEN 업데이트는 로그인 후 확인할 수 있습니다.',
      });
    }
    return;
  }

  const res = await xgenRequest(installerListPath('connector'), token);
  if (!res.ok) throw new Error(`XGEN 다운로드 센터 ${res.status}`);
  const body = (await res.json()) as XgenInstallerListResponse;
  const pkg = selectXgenUpdate(Array.isArray(body.data) ? body.data : [], process.platform, app.getVersion());
  if (!pkg) {
    notify(`최신 버전입니다 (v${app.getVersion()})`);
    if (manual) {
      await dialog.showMessageBox({ type: 'info', message: '최신 버전입니다.', detail: `현재 v${app.getVersion()}` });
    }
    return;
  }

  const version = pkg.version ?? '';
  if (manual) {
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      message: `새 버전 v${version} 이(가) 있습니다.`,
      detail: pkg.release_notes || `현재 v${app.getVersion()}. 설치 파일을 내려받습니다.`,
    });
    if (result.response === 0) await installXgenPackage(pkg);
    else notify(`새 버전 v${version} 이(가) 있습니다.`);
  } else if (autoUpdate) {
    await installXgenPackage(pkg);
  } else if (lastNotifiedVersion !== version) {
    lastNotifiedVersion = version;
    notifyUpdateAvailable(version, () => void installXgenPackage(pkg));
  }
}

// ── Windows / Linux check ────────────────────────────────────────
async function winLinuxCheck(manual: boolean): Promise<void> {
  const u = getUpdater();
  if (!u) return;
  if (manual) notify('업데이트 확인 중…');
  let latest: string | undefined;
  try {
    const result = await withTimeout(u.checkForUpdates(), 20000, 'checkForUpdates');
    latest = result?.updateInfo?.version;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log('check failed', detail);
    notify('업데이트 확인 실패');
    if (manual) await dialog.showMessageBox({ type: 'error', message: '업데이트 확인에 실패했습니다.', detail });
    return;
  }
  if (!latest || latest === app.getVersion()) {
    notify(`최신 버전입니다 (v${app.getVersion()})`);
    if (manual) await dialog.showMessageBox({ type: 'info', message: '최신 버전입니다.', detail: `현재 v${app.getVersion()}` });
    return;
  }
  if (manual || autoUpdate) {
    notify(`새 버전 v${latest} 내려받는 중…`);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${latest} 을(를) 내려받는 중입니다.`,
        detail: '완료되면 재시작 여부를 물어봅니다.',
      });
    }
    await u.downloadUpdate().catch((e) => log('download', e));
  } else {
    if (lastNotifiedVersion !== latest) {
      lastNotifiedVersion = latest;
      notifyUpdateAvailable(latest, () => void u.downloadUpdate().catch(() => undefined));
    }
  }
}

async function runCheck(manual: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (!app.isPackaged) {
      if (manual) {
        notify('개발 모드에서는 업데이트를 확인할 수 없습니다.');
        await dialog.showMessageBox({ message: '개발 모드에서는 업데이트를 확인하지 않습니다.' });
      }
      return;
    }
    if (!isUpdateConfigured()) {
      if (manual) {
        notify('서버 연결 설정 후 업데이트를 확인할 수 있습니다.');
        await dialog.showMessageBox({ message: '먼저 서버 연결 설정을 완료해 주세요.' });
      }
      return;
    }
    if (updateServer === 'xgen') return await xgenCheck(manual);
    if (isPackagedMac()) return await macCheck(manual);
    if (canSelfUpdate()) return await winLinuxCheck(manual);
  } catch (e) {
    // Safety net — a manual check must NEVER end without feedback.
    const detail = e instanceof Error ? e.message : String(e);
    log('runCheck error', detail);
    notify('업데이트 확인 실패');
    if (manual) await dialog.showMessageBox({ type: 'error', message: '업데이트 확인 중 오류가 발생했습니다.', detail });
  } finally {
    busy = false;
  }
}

function notifyUpdateAvailable(version: string, onAccept: () => void): void {
  notify(`새 버전 v${version} 이(가) 있습니다.`);
  showUpdateNotification(version, onAccept);
}

export interface UpdaterOptions {
  enabled: boolean;
  updateServer?: UpdateServer;
  isConfigured: () => boolean;
  xgenServerUrl: () => string;
  xgenToken: () => Promise<string | null>;
  onWillInstall?: () => void;
  onUpdateAvailable?: (version: string, onAccept: () => void) => void;
}

export function initUpdater(options: UpdaterOptions): void {
  autoUpdate = options.enabled;
  updateServer = options.updateServer ?? 'github';
  isUpdateConfigured = options.isConfigured;
  getXgenServerUrl = options.xgenServerUrl;
  getXgenToken = options.xgenToken;
  if (options.onWillInstall) appWillInstall = options.onWillInstall;
  if (options.onUpdateAvailable) showUpdateNotification = options.onUpdateAvailable;
  if (!app.isPackaged) return; // dev builds never check
  setTimeout(() => void runCheck(false), 8000);
  timer = setInterval(() => void runCheck(false), SIX_HOURS);
}

export function setAutoUpdate(enabled: boolean): void {
  autoUpdate = enabled;
  if (enabled) void runCheck(false);
}

export function setUpdateServer(source: UpdateServer): void {
  updateServer = source;
  lastNotifiedVersion = null;
  if (app.isPackaged) void runCheck(false);
}

/** XGEN 소스의 시작 시점 검사를 로그인 토큰 저장 뒤 다시 시도한다. */
export function checkForUpdatesAfterLogin(): void {
  if (app.isPackaged && updateServer === 'xgen') void runCheck(false);
}

export function getAutoUpdate(): boolean {
  return autoUpdate;
}

/** Manual "업데이트 확인" — always resolves with explicit feedback. */
export async function checkNow(): Promise<{ opened?: boolean }> {
  await runCheck(true);
  return {};
}

export function disposeUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
