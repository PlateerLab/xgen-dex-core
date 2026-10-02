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
  if (response === 1) autoUpdater.quitAndInstall();
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
  if (response === 1) await shell.openExternal(macDmgUrl(version, process.arch));
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

export function startUpdater(): void {
  if (!app.isPackaged || process.env.XD_DISABLE_UPDATES) return;
  const mac = process.platform === 'darwin';
  autoUpdater.channel = 'xd';
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  // 서명 없는 맥은 받아도 바꿀 수 없다 — 알리기만 한다.
  autoUpdater.autoDownload = !mac;
  autoUpdater.autoInstallOnAppQuit = !mac;
  autoUpdater.logger = null;
  // 스스로 바꿀 수 없는 설치 꼴(AppImage·deb·NSIS·dmg 가 아닌 풀린 폴더 등)이면 끈다.
  if (!autoUpdater.isUpdaterActive()) return;
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
