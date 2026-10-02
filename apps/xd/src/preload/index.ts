/**
 * XD 의 preload — 화면이 이 앱에 닿는 유일한 길(`window.xd`).
 *
 * Dex 의 `window.xgen` 과 이름을 나눈다: 공유하는 Dex 화면 코드는 XD 에서 기능 스위치로 서버 기능을
 * 끄고, XD 가 직접 채울 부분만 같은 모양으로 맞춘다(화면 공유 단계에서).
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type ApiResult, type XdInfo } from '../main/ipc';
import type { XdApi } from '../main/xd-api';
import type { XdTurnEvent } from '../main/turn-runner';
import type { CliEvent } from '../main/cli/service';

type Method = keyof XdApi;
type Fn<M extends Method> = XdApi[M] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;

/** main API 한 칸을 부른다 — 실패는 예외로 되돌린다(`code` 를 싣는다). */
function call<M extends Method>(method: M): Fn<M> {
  return (async (...args: unknown[]) => {
    const res = (await ipcRenderer.invoke(CHANNELS.api, method, args)) as ApiResult<unknown>;
    if (res.ok) return res.value;
    const err = new Error(res.error) as Error & { code?: string };
    if (res.code) err.code = res.code;
    throw err;
  }) as Fn<M>;
}

const api = {
  /** 이 앱의 판·루트 폴더. */
  info: (): Promise<XdInfo> => ipcRenderer.invoke(CHANNELS.info),
  /** 루트·작업 공간 폴더를 파일 관리자로 연다. */
  openFolder: (which: 'root' | 'workspace'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.openFolder, which),
  agents: {
    list: call('agentsList'),
    get: call('agentsGet'),
    create: call('agentsCreate'),
    update: call('agentsUpdate'),
    remove: call('agentsDelete'),
  },
  conversations: {
    list: call('conversationsList'),
    rename: call('conversationsRename'),
    remove: call('conversationsDelete'),
    turns: call('turnsList'),
  },
  turn: {
    send: call('turnSend'),
    cancel: call('turnCancel'),
    stop: call('turnStop'),
  },
  accounts: {
    list: call('accountsList'),
    create: call('accountsCreate'),
    update: call('accountsUpdate'),
    setSecret: call('accountsSetSecret'),
    remove: call('accountsDelete'),
    secretsStatus: call('secretsStatus'),
  },
  models: {
    list: call('modelsList'),
    probe: call('modelsProbe'),
  },
  cli: {
    state: call('cliState'),
    detect: call('cliDetect'),
    install: call('cliInstall'),
    login: call('cliLogin'),
    loginCode: call('cliLoginCode'),
    loginCancel: call('cliLoginCancel'),
    logout: call('cliLogout'),
  },
  engine: {
    status: call('engineStatus'),
  },
  /** CLI 설치 진행·로그인 사건 — 돌려받은 함수를 부르면 그만 듣는다. */
  onCliEvent(cb: (event: CliEvent) => void): () => void {
    const listener = (_e: unknown, event: CliEvent) => cb(event);
    ipcRenderer.on(CHANNELS.cliEvent, listener);
    return () => ipcRenderer.removeListener(CHANNELS.cliEvent, listener);
  },
  /** 턴 사건 — 돌려받은 함수를 부르면 그만 듣는다. */
  onTurnEvent(cb: (event: XdTurnEvent) => void): () => void {
    const listener = (_e: unknown, event: XdTurnEvent) => cb(event);
    ipcRenderer.on(CHANNELS.turnEvent, listener);
    return () => ipcRenderer.removeListener(CHANNELS.turnEvent, listener);
  },
};

export type XdBridge = typeof api;
contextBridge.exposeInMainWorld('xd', api);
