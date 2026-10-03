/**
 * XD 의 업데이트 — Dex 와 같은 GitHub 릴리스, 채널 `xd`(xd.yml · xd-mac.yml · xd-linux.yml — Dex 의 latest*.yml 과
 * 겹치지 않는다).
 *
 * - Windows(NSIS)·Linux(AppImage·deb): electron-updater 가 받아 두고, 다 받으면 "다시 시작해 바꿀까요" 를 묻는다.
 *   Windows 는 제거 스크립트가 설치 폴더의 workspace·.xd 를 남기므로(build/installer.nsh) 바꿔도 데이터가 그대로다.
 * - macOS: 서명하지 않은 앱은 스스로 바꿀 수 없다(Squirrel.Mac 이 서명을 본다) — 새 판이 있으면 알리고, 그 판의 dmg 를
 *   브라우저로 받게 한다(이 맥의 아키텍처 것).
 *
 * 설치본에서만 돈다(개발 실행·시험은 `XD_DISABLE_UPDATES`). 시작 30초 뒤, 그다음은 6시간마다 본다.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { macDmgUrl } from './update-feed';

// electron-updater 는 CommonJS — 인스턴스는 기본 export 에 있다(이름으로 가져오면 번들에서 undefined, Dex 가 겪은 일).
const { autoUpdater } = electronUpdater;

const SIX_HOURS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'available'; version: string }
  | { state: 'error' };

let current: UpdateState = { state: 'disabled' };
let asked: string | null = null;
let beforeInstall: () => Promise<void> = async () => undefined;
const listeners = new Set<(s: UpdateState) => void>();

function set(next: UpdateState): void {
  current = next;
  for (const fn of listeners) fn(next);
}

export function updateState(): UpdateState {
  return current;
}

export function onUpdateState(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const window = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;

async function askRestart(version: string): Promise<void> {
  if (asked === version) return;
  asked = version;
  const win = window();
  const options = {
    type: 'info' as const,
    buttons: ['나중에', '다시 시작'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: 'XD 업데이트',
    message: `XD ${version} 을(를) 받았습니다.`,
    detail: '다시 시작하면 새 판으로 바뀌고, 에이전트와 대화는 그대로 남습니다.',
  };
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  if (response === 1) await installNow();
}

/**
 * 받아 둔 새 판으로 바꾼다 — 엔진을 먼저 멈추고(설치 프로그램이 엔진 파일을 바꾸려면 잠금이 풀려 있어야 한다) 바꾼다.
 * Windows 는 설치 프로그램이 다 바꾼 뒤 XD 를 다시 띄운다. Linux 는 스스로 다시 띄운다(아래 before-quit-for-update).
 */
async function installNow(): Promise<void> {
  try {
    await beforeInstall();
  } catch (err) {
    console.warn('[xd] before update install', err);
  }
  autoUpdater.quitAndInstall(false, process.platform === 'win32');
}

/** macOS — 새 판의 dmg 를 브라우저로 받는다(설정의 [내려받기], 알림 창에서 "나중에" 를 골랐어도). */
export async function downloadMacUpdate(): Promise<boolean> {
  if (current.state !== 'available') return false;
  await shell.openExternal(macDmgUrl(current.version, process.arch));
  return true;
}

async function askDownloadMac(version: string): Promise<void> {
  if (asked === version) return;
  asked = version;
  const win = window();
  const options = {
    type: 'info' as const,
    buttons: ['나중에', '내려받기'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: 'XD 업데이트',
    message: `XD ${version} 이(가) 나왔습니다.`,
    detail: '내려받은 dmg 를 열어 XD 를 응용 프로그램 폴더로 옮기면 바뀌고, 에이전트와 대화는 그대로 남습니다.',
  };
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  if (response === 1) await downloadMacUpdate();
}

/** 지금 한 번 본다 — 설정의 [업데이트 확인]. */
export async function checkForUpdates(): Promise<UpdateState> {
  if (current.state === 'disabled') return current;
  if (current.state === 'downloading' || current.state === 'ready') return current;
  set({ state: 'checking' });
  try {
    const result = await autoUpdater.checkForUpdates();
    // null = 이 설치 꼴은 스스로 바꾸지 못한다(예: 풀린 폴더) — "최신" 이라고 말하지 않는다.
    if (!result) set({ state: 'disabled' });
    else if (!result.isUpdateAvailable) set({ state: 'latest' });
  } catch (err) {
    console.warn('[xd] update check failed', err);
    set({ state: 'error' });
  }
  return current;
}

export function startUpdater(deps: { beforeInstall: () => Promise<void> }): void {
  if (!app.isPackaged || process.env.XD_DISABLE_UPDATES) return;
  // Windows 는 설치 프로그램으로 깐 XD 만 — 풀린 폴더를 옮겨 쓴 것이 스스로 바꾸면 설치 프로그램이 다른 자리(기본
  // 위치)에 깔아, 루트(= 설치 폴더)가 갈린다.
  if (process.platform === 'win32' && !existsSync(join(dirname(process.execPath), 'Uninstall XD.exe'))) return;
  beforeInstall = deps.beforeInstall;
  const mac = process.platform === 'darwin';
  autoUpdater.channel = 'xd';
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  // 서명 없는 맥은 받아도 바꿀 수 없다 — 알리기만 한다.
  autoUpdater.autoDownload = !mac;
  autoUpdater.autoInstallOnAppQuit = !mac;
  autoUpdater.logger = null;
  // 설치본이 아니면(isPackaged 가 아님, 리눅스에서 AppImage 가 아님 등) 끈다.
  if (!autoUpdater.isUpdaterActive()) return;
  if (process.platform === 'linux') {
    // electron-updater 의 재시작은 app.relaunch() 를 타는데 리눅스의 relauncher 가 NoNewPrivs 를 걸어 Ubuntu 24.04 에서
    // 새 프로세스의 SUID chrome-sandbox 가 SIGTRAP 으로 죽는다(Dex 가 겪은 일). 또 새 판이 옛 판보다 먼저 뜨면 단일
    // 실행 잠금에 걸려 바로 끝난다. 분리된 셸로 1.5초 뒤 깨끗하게 다시 띄운다(Dex 와 같은 방법).
    (app as unknown as NodeJS.EventEmitter).on('before-quit-for-update', () => {
      try {
        const target = process.env.APPIMAGE || app.getPath('exe');
        spawn('/bin/sh', ['-c', 'sleep 1.5; exec "$@"', 'relaunch', target], { detached: true, stdio: 'ignore' }).unref();
      } catch (err) {
        console.warn('[xd] relaunch after update', err);
      }
    });
  }
  autoUpdater.on('update-available', (info) => {
    if (mac) {
      set({ state: 'available', version: info.version });
      void askDownloadMac(info.version);
    } else set({ state: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('update-not-available', () => set({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) => {
    if (current.state === 'downloading') set({ ...current, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    set({ state: 'ready', version: info.version });
    void askRestart(info.version);
  });
  autoUpdater.on('error', (err) => {
    console.warn('[xd] updater', err);
    if (current.state !== 'ready') set({ state: 'error' });
  });
  set({ state: 'idle' });
  setTimeout(() => void checkForUpdates(), 30_000).unref?.();
  setInterval(() => void checkForUpdates(), SIX_HOURS).unref?.();
}
