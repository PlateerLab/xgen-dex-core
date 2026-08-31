/**
 * 데스크톱이 엔진에게 주는 것 — 포트 구현 세 개.
 *
 * 엔진은 "설정을 어디 두는지 · 비밀을 어떻게 보관하는지 · 사용자에게 어떻게 묻는지"
 * 만 모른다. 그 셋을 여기서 Electron 의 방식으로 채운다. 엔진 코드에는 electron 이
 * 한 글자도 없고, 그래서 같은 엔진이 터미널에서도 돈다.
 */
import { app, BrowserWindow, clipboard, dialog, Notification, shell } from 'electron';
import { bindHost, type HostPorts, type InteractionPort } from '@dex/engine';
import { DANGEROUS_COMMAND_PROMPT } from '@dex/engine/local-tools';
import { loadConfig, saveConfig, type ConnectorConfig } from './config';
import { resolveDataRoot } from './data-root';
import { secretGet, secretSet } from './keychain';

/**
 * 위험한 명령 확인 — 세 갈래 다이얼로그.
 *
 * 버튼 순서를 바꾸지 말 것: 기본값(Enter)과 취소(Esc)가 모두 **거부**여야 한다.
 * 확인 창이 뜬 줄 모르고 Enter 를 친 사용자가 `rm -rf` 를 승인하면 안 된다.
 */
async function confirmDangerous(command: string): Promise<'once' | 'session' | 'deny'> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const options = {
    type: 'warning' as const,
    buttons: ['거부', '이번만 허용', '이 세션 동안 허용'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: DANGEROUS_COMMAND_PROMPT.title,
    message: DANGEROUS_COMMAND_PROMPT.message,
    detail: DANGEROUS_COMMAND_PROMPT.detail(command),
  };
  const result = await (win
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options));
  return result.response === 2 ? 'session' : result.response === 1 ? 'once' : 'deny';
}

const desktopInteraction: InteractionPort = {
  confirmDangerous,
  clipboard: {
    async read() {
      return clipboard.readText();
    },
    async write(text) {
      clipboard.writeText(text);
    },
  },
  async notify(title, body) {
    if (!Notification.isSupported()) return false;
    new Notification({ title, body }).show();
    return true;
  },
  async openExternal(url) {
    await shell.openExternal(url);
  },
  async openPath(absolutePath) {
    return shell.openPath(absolutePath);
  },
};

/** 앱 시작 시 **한 번** 호출한다. 이 전에 엔진을 건드리면 엔진이 명확히 던진다. */
export function bindDesktopHost(): void {
  const ports: HostPorts<ConnectorConfig> = {
    secrets: { get: secretGet, set: secretSet },
    config: { load: loadConfig, save: saveConfig },
    paths: { dataRoot: () => resolveDataRoot(loadConfig()) },
    interaction: desktopInteraction,
  };
  bindHost(ports);
  void app; // 이 모듈이 main 프로세스 전용임을 타입으로 못 박는다
}
