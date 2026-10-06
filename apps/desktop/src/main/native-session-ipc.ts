import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { DesktopNativeSessions, isNativeSessionSender, type DesktopNativeContext } from './native-session';
import { createDesktopNativeSocket, desktopNativeFetch } from './native-session-network';
import { CHANNELS } from './ipc';
import { readSelectedNativeAttachments } from './native-attachment-files';

export function bindDesktopNativeSessions(main: () => WebContents | null, current: () => DesktopNativeContext, trustedRendererUrl: string): DesktopNativeSessions {
  const host = new DesktopNativeSessions({ current, fetch: desktopNativeFetch, socket: createDesktopNativeSocket,
    attachmentPicker: async (signal, limits) => {
      signal.throwIfAborted();
      const contents = main();
      const owner = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
      if (!owner) throw new DOMException('파일 선택 창을 열 수 없습니다.', 'AbortError');
      const selected = await dialog.showOpenDialog(owner, {
        title: 'Canonical 턴에 첨부할 파일 선택', properties: ['openFile', 'multiSelections'],
      });
      signal.throwIfAborted();
      if (main() !== contents || contents!.isDestroyed()) throw new DOMException('파일 선택이 취소되었습니다.', 'AbortError');
      return selected.canceled ? [] : readSelectedNativeAttachments(selected.filePaths, signal, limits);
    }, notify: (notice) => {
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
