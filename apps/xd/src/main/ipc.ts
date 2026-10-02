/** XD 의 IPC 이름 — main 과 preload 가 같은 표를 본다. */
export const CHANNELS = {
  info: 'xd:info',
  openFolder: 'xd:openFolder',
} as const;

/** 화면이 아는 이 앱의 상태. */
export interface XdInfo {
  version: string;
  platform: NodeJS.Platform;
  root: string;
  rootSource: 'env' | 'moved' | 'dev' | 'install' | 'home';
  workspace: string;
}
