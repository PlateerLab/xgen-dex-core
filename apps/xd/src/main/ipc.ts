/** XD 의 IPC 이름 — main 과 preload 가 같은 표를 본다. */
export const CHANNELS = {
  info: 'xd:info',
  openFolder: 'xd:openFolder',
  /** 폴더 고르기 창 — 고른 경로(취소면 null). */
  pickFolder: 'xd:pickFolder',
  /** https 주소만 브라우저로 연다(로그인 주소·답의 링크). */
  openExternal: 'xd:openExternal',
  clipboardWrite: 'xd:clipboardWrite',
  /** main 의 API 한 칸 — `xd:api` 하나로 이름(메서드)과 인자를 넘긴다(xd-api.ts). */
  api: 'xd:api',
  /** main → 화면: 턴 사건(XdTurnEvent). */
  turnEvent: 'xd:turn-event',
  /** main → 화면: CLI 설치 진행·로그인 사건(CliEvent). */
  cliEvent: 'xd:cli-event',
  /** 작업 공간 IDE — 에이전트의 작업 공간·연결 폴더의 파일(ide-service.ts). */
  ide: 'xd:ide',
  /** 작업 공간 IDE 의 연결 폴더 목록. */
  ideFolders: 'xd:ide-folders',
} as const;

/** `xd:ide` 의 대답 — 실패는 IDE 가 다음 행동을 고르는 코드(not_found·changed·too_large…)와 함께. */
export type IdeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string; detail?: Record<string, unknown> };

/** 화면이 아는 이 앱의 상태. */
export interface XdInfo {
  version: string;
  platform: NodeJS.Platform;
  root: string;
  rootSource: 'env' | 'moved' | 'dev' | 'install' | 'home';
  workspace: string;
}

/** `xd:api` 의 대답 — 예외는 IPC 를 넘으며 모양을 잃으므로 값으로 싣는다. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };
