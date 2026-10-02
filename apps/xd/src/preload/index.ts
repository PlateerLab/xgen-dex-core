/**
 * XD 의 preload — 화면이 이 앱에 닿는 유일한 길(`window.xd`).
 *
 * Dex 의 `window.xgen` 과 이름을 나눈다: 공유하는 Dex 화면 코드는 XD 에서 기능 스위치로 서버 기능을
 * 끄고, XD 가 직접 채울 부분만 같은 모양으로 맞춘다(화면 공유 단계에서).
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type XdInfo } from '../main/ipc';

const api = {
  /** 이 앱의 판·루트 폴더. */
  info: (): Promise<XdInfo> => ipcRenderer.invoke(CHANNELS.info),
  /** 루트·작업 공간 폴더를 파일 관리자로 연다. */
  openFolder: (which: 'root' | 'workspace'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.openFolder, which),
};

export type XdBridge = typeof api;
contextBridge.exposeInMainWorld('xd', api);
