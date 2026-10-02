/**
 * XD 의 preload — 화면이 이 앱에 닿는 유일한 길(`window.xd`).
 *
 * Dex 의 `window.xgen` 과 이름을 나눈다. 화면은 XD 전용이고, 같이 쓰는 Dex 부품이 찾는 것은
 * `window.xgen.clipboard` 한 칸뿐이다(아래).
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type ApiResult, type IdeResult, type XdInfo } from '../main/ipc';
import type { IdeFolderRootView } from '../main/ide-service';
import type { XdApi } from '../main/xd-api';
import type { XdTurnEvent } from '../main/turn-runner';
import type { CliEvent } from '../main/cli/service';
import type { UpdateState } from '../main/updater';

type Method = keyof XdApi;
type Raw<M extends Method> = XdApi[M] extends (...a: infer A) => infer R ? (...a: A) => Promise<ApiResult<Awaited<R>>> : never;

/**
 * main API 한 칸 — 대답은 **값으로**(`{ok, value}` 또는 `{ok: false, error, code}`). 여기서 예외로 던지면
 * contextBridge 를 넘으며 메시지만 남고 `code` 를 잃는다(실측) — 예외로 바꾸는 것은 화면 쪽(`renderer/src/bridge.ts`)이다.
 */
function call<M extends Method>(method: M): Raw<M> {
  return ((...args: unknown[]) => ipcRenderer.invoke(CHANNELS.api, method, args)) as Raw<M>;
}

const clipboard = {
  write: (text: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.clipboardWrite, text),
};

const api = {
  /** 이 앱의 판·루트 폴더. */
  info: (): Promise<XdInfo> => ipcRenderer.invoke(CHANNELS.info),
  /** 루트·작업 공간·에이전트 작업 공간·그 에이전트의 몇 번째 연결 폴더를 파일 관리자로 연다. */
  openFolder: (which: 'root' | 'workspace' | 'agent' | 'linked', agentId?: string, index?: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.openFolder, which, agentId, index),
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
  folders: {
    check: call('foldersCheck'),
  },
  mcp: {
    /** MCP 서버 [연결 확인] — 붙어 보고 도구 목록만. */
    test: call('mcpTest'),
  },
  /** 작업 공간 IDE — 이 에이전트의 작업 공간(`'workspace'`)이나 연결 폴더(그 경로)의 파일. 대답은 값으로. */
  ide: {
    call: <T = unknown>(agentId: string, root: 'workspace' | string, op: string, args: Record<string, unknown> = {}): Promise<IdeResult<T>> =>
      ipcRenderer.invoke(CHANNELS.ide, agentId, root, op, args),
    folders: (agentId: string): Promise<IdeFolderRootView[]> => ipcRenderer.invoke(CHANNELS.ideFolders, agentId),
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
  update: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateState),
    check: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateCheck),
    on(cb: (state: UpdateState) => void): () => void {
      const listener = (_e: unknown, state: UpdateState) => cb(state);
      ipcRenderer.on(CHANNELS.updateEvent, listener);
      return () => ipcRenderer.removeListener(CHANNELS.updateEvent, listener);
    },
  },
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
