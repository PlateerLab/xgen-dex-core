/**
 * `window.xd` — XD 의 preload 가 연다. 화면은 이 파일의 `xd` 만 쓴다.
 *
 * preload 는 main 의 대답을 **값으로** 넘긴다(`{ok, value}` 또는 `{ok: false, error, code}`). 예외는 contextBridge 를
 * 넘으며 메시지만 남고 `code`·`detail` 을 잃기 때문이다(실측 — 그래서 `busy`·연결 폴더 사유·IDE 의 `changed` 가 화면에
 * 닿지 않았다). 여기서 실패를 `code` 를 실은 예외로 되돌린다.
 */
import type { XdBridge } from '../../preload/index';
import type { ApiResult } from '../../main/ipc';

declare global {
  interface Window {
    xd: XdBridge;
  }
}

/** main 의 실패 — 화면이 까닭을 고르는 `code`(와 IDE 의 `detail`). */
export class XdCallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'XdCallError';
  }
}

type Unwrapped<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => Promise<ApiResult<infer V>> ? (...a: A) => Promise<V> : T[K];
};

function unwrap<T extends object>(group: T): Unwrapped<T> {
  return Object.fromEntries(
    Object.entries(group).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        const res = (await (fn as (...a: unknown[]) => Promise<ApiResult<unknown>>)(...args)) as ApiResult<unknown>;
        if (res.ok) return res.value;
        throw new XdCallError(res.error, res.code);
      },
    ]),
  ) as Unwrapped<T>;
}

function make(raw: XdBridge) {
  return {
    info: raw.info,
    openFolder: raw.openFolder,
    pickFolder: raw.pickFolder,
    openExternal: raw.openExternal,
    clipboard: raw.clipboard,
    agents: unwrap(raw.agents),
    folders: unwrap(raw.folders),
    mcp: unwrap(raw.mcp),
    conversations: unwrap(raw.conversations),
    turn: unwrap(raw.turn),
    accounts: unwrap(raw.accounts),
    models: unwrap(raw.models),
    cli: unwrap(raw.cli),
    engine: unwrap(raw.engine),
    ide: {
      async call<T = unknown>(agentId: string, root: 'workspace' | string, op: string, args: Record<string, unknown> = {}): Promise<T> {
        const res = await raw.ide.call<T>(agentId, root, op, args);
        if (res.ok) return res.value;
        throw new XdCallError(res.message, res.code, res.detail ?? {});
      },
      folders: raw.ide.folders,
    },
    onCliEvent: raw.onCliEvent,
    onTurnEvent: raw.onTurnEvent,
  };
}

export type Xd = ReturnType<typeof make>;

export const xd: Xd = (typeof window !== 'undefined' && window.xd ? make(window.xd) : undefined) as Xd;
