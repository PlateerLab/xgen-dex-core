import { ipcMain, type WebContents } from 'electron';
import { DesktopNativeSessions, isNativeSessionSender, type DesktopNativeContext } from './native-session';
import { desktopNativeFetch } from './native-session-network';
import { CHANNELS } from './ipc';

export function bindDesktopNativeSessions(main: () => WebContents | null, current: () => DesktopNativeContext, trustedRendererUrl: string): DesktopNativeSessions {
  const host = new DesktopNativeSessions({ current, fetch: desktopNativeFetch, notify: (notice) => {
    const contents = main(); if (contents && !contents.isDestroyed()) contents.send(CHANNELS.nativeSessionUpdate, notice);
  } });
  ipcMain.handle(CHANNELS.nativeSessionRequest, (event, method: unknown, params: unknown) => {
    if (!isNativeSessionSender(event.sender, event.senderFrame, main(), trustedRendererUrl)) return {
      ok: false, code: 'auth_required', message: '앱의 기본 화면에서만 기기·세션을 관리할 수 있습니다.',
    };
    return host.request(method, params);
  });
  return host;
}
