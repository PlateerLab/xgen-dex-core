// SSO 팝업의 격리 보안과 선택적 DevTools 설정을 구성한다
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export function createSsoWindowOptions(
  preload: string,
  debug: boolean,
  parent?: BrowserWindow,
): BrowserWindowConstructorOptions {
  return {
    width: 560,
    height: 720,
    minWidth: 440,
    minHeight: 560,
    parent,
    modal: false,
    show: false,
    title: debug ? 'XGEN SSO 로그인 [디버그]' : 'XGEN SSO 로그인',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: debug,
    },
  };
}
