/**
 * XD 의 preload — 화면이 이 앱에 닿는 유일한 길(`window.xd`).
 *
 * Dex 의 `window.xgen` 과 이름을 나눈다. 화면은 XD 전용이고, 같이 쓰는 Dex 부품이 찾는 것은
 * `window.xgen.clipboard` 한 칸뿐이다(아래).
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

const clipboard = {
  write: (text: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.clipboardWrite, text),
};

const api = {
  /** 이 앱의 판·루트 폴더. */
  info: (): Promise<XdInfo> => ipcRenderer.invoke(CHANNELS.info),
  /** 루트·작업 공간·에이전트 작업 공간 폴더를 파일 관리자로 연다. */
  openFolder: (which: 'root' | 'workspace' | 'agent', agentId?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.openFolder, which, agentId),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.pickFolder),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.openExternal, url),
  clipboard,
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
    kinds: call('accountKinds'),
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
    /** 이 CLI 로 에이전트를 돌릴 계정(없으면 만든다). */
    useAccount: call('cliAccountEnsure'),
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
// 같이 쓰는 Dex 화면 부품(마크다운·도구 기록의 [복사])은 `window.xgen.clipboard` 가 있으면 main 의 클립보드를 쓴다
// (Electron 의 navigator.clipboard 는 권한 문제로 조용히 실패한다). XD 는 그 한 칸만 같은 모양으로 연다 — 서버
// 기능은 하나도 열지 않는다.
contextBridge.exposeInMainWorld('xgen', { clipboard });
