/**
 * XD 의 루트 폴더 — 에이전트의 작업 공간과 앱의 모든 상태가 이 아래에 있다.
 *
 *   <루트>/
 *     workspace/<에이전트>/   에이전트의 작업 공간(사용자가 보는 파일)
 *     .xd/                    앱의 상태 — 데이터베이스·비밀·엔진 상태·CLI·기록
 *       electron/             Electron 의 userData(캐시 등). 단일 실행 잠금도 여기라 "루트 하나에 앱 하나".
 *
 * 어디로 정하나(2026-10-02 사용자 결정 "설치 폴더, 안 되면 ~/XD"):
 *   1. 환경 변수 XD_DATA_ROOT — 시험·이식용 실행.
 *   2. 사용자가 설정에서 옮긴 곳 — 앱 바깥의 작은 표지 파일(`<appData>/XD/root.json`)에 적어 둔다.
 *      루트 안에 적으면 옮긴 뒤에는 찾을 수 없다.
 *   3. 개발 실행 — `~/XD-dev`(설치본의 루트를 건드리지 않게).
 *   4. Windows 설치본 — **설치 폴더** 자체(쓸 수 있을 때). 사용자가 설치 위치를 고른다.
 *   5. 그 밖 — `~/XD`. macOS 는 앱 묶음(.app) 안에 쓸 수 없고(서명이 깨진다), Linux 의 AppImage 는
 *      읽기 전용으로 붙고 deb 는 /opt 에 깔린다.
 */
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type RootSource = 'env' | 'moved' | 'dev' | 'install' | 'home';

export interface RootInputs {
  /** XD_DATA_ROOT. */
  env?: string;
  /** 설정에서 옮긴 곳(표지 파일). */
  moved?: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  /** 실행 파일이 있는 폴더 — Windows 설치본에서는 설치 폴더다. */
  exeDir: string;
  home: string;
  /** 그 폴더에 쓸 수 있는가(시험이 대신한다). */
  writable: (dir: string) => boolean;
}

export interface ChosenRoot {
  root: string;
  source: RootSource;
}

export function chooseDataRoot(i: RootInputs): ChosenRoot {
  const env = (i.env ?? '').trim();
  if (env) return { root: resolve(env), source: 'env' };
  const moved = (i.moved ?? '').trim();
  if (moved) return { root: resolve(moved), source: 'moved' };
  if (!i.packaged) return { root: join(i.home, 'XD-dev'), source: 'dev' };
  if (i.platform === 'win32' && i.exeDir && i.writable(i.exeDir)) return { root: resolve(i.exeDir), source: 'install' };
  return { root: join(i.home, 'XD'), source: 'home' };
}

export interface RootLayout {
  root: string;
  workspace: string;
  state: string;
  electron: string;
  logs: string;
}

export function rootLayout(root: string): RootLayout {
  const state = join(root, '.xd');
  return {
    root,
    workspace: join(root, 'workspace'),
    state,
    electron: join(state, 'electron'),
    logs: join(state, 'logs'),
  };
}

/** 폴더들을 만든다. 이미 있으면 그대로. */
export function ensureLayout(layout: RootLayout): void {
  for (const dir of [layout.root, layout.workspace, layout.state, layout.electron, layout.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 실제로 써 보고 지워 본다 — 권한 비트만 보면 Windows 의 상속 권한·읽기 전용 매체를 틀리게 읽는다. */
export function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.xd-write-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 설정에서 옮긴 루트의 표지 파일 — `<appData>/XD/root.json` = `{ "root": "…" }`. */
export function movedRootFile(appData: string): string {
  return join(appData, 'XD', 'root.json');
}

export function readMovedRoot(file: string): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(file, 'utf8')) as { root?: unknown }).root;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function writeMovedRoot(file: string, root: string | null): void {
  if (!root) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ root }, null, 2));
}
