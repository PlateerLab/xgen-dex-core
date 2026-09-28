/**
 * 데스크톱의 IDE 호스트 — `IdeHost` 를 main 프로세스 통로(`xgen.ide`)로 구현한다.
 *
 * 렌더러는 CSP 로 네트워크에 직접 나가지 못한다. 서버 호출은 main 이 대신하고(`ide:call`),
 * 실패는 봉투로 돌아와 여기서 `IdeError` 로 되살린다 — 저장 충돌(409)의 지금 sha 같은 상세가
 * 그대로 편집기까지 온다. 터미널 소켓도 main 이 열고, 프레임은 한 채널로 밀려와 소켓 id 로
 * 나눠 준다.
 */
import {
  IdeError,
  type IdeFileEntry,
  type IdeFsOp,
  type IdeHost,
  type IdeReplaceResult,
  type IdeSearchQuery,
  type IdeSearchResult,
  type IdeStat,
  type IdeTerminalInfo,
  type TerminalHandlers,
  type TerminalServerFrame,
} from '@dex/ide';
import type {
  IdeFileResponse,
  IdeSaveResponse,
  IdeSessionResponse,
  IdeStorageEntry,
} from '@dex/protocol';
import { xgen, copyText } from '../bridge';
import { loadMonaco } from './monaco';

async function call<T>(method: string, workflowId: string, ...args: unknown[]): Promise<T> {
  const out = await xgen.ide.call(method, workflowId, ...args);
  if (out.ok) return out.value as T;
  throw new IdeError(out.code, out.message, out.status, out.detail);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ── 터미널 소켓 — 한 채널로 오는 이벤트를 소켓 id 로 나눈다 ──────────
const sockets = new Map<string, TerminalHandlers>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  xgen.ide.onTerminalEvent((event) => {
    const h = sockets.get(event.socket);
    if (!h) return;
    if (event.type === 'frame') h.onFrame(event.frame as unknown as TerminalServerFrame);
    else {
      sockets.delete(event.socket);
      h.onClose(event.code, event.reason);
    }
  });
}

let socketSeq = 0;

// ── 스토리지 변경 알림 — main 이 소켓을 열고, 바뀌면 구독 key 로 알려 준다 ───────
const watchers = new Map<string, () => void>();
let watching = false;
let watchSeq = 0;

function subscribeWorkspace(workflowId: string, onChange: () => void): () => void {
  if (!watching) {
    watching = true;
    xgen.ide.onChanged((key) => watchers.get(key)?.());
  }
  watchSeq += 1;
  const key = `${workflowId}:${watchSeq}`;
  watchers.set(key, onChange);
  xgen.ide.watch(key, workflowId);
  return () => {
    watchers.delete(key);
    xgen.ide.unwatch(key);
  };
}

export function createDexIdeHost(agent: { workflowId: string; workflowName: string }): IdeHost {
  const wf = agent.workflowId;
  return {
    workflowId: wf,
    agentName: agent.workflowName,

    async session() {
      const s = await call<IdeSessionResponse>('session', wf);
      return {
        readonly: !!s.readonly,
        terminals: (s.terminals ?? []) as IdeTerminalInfo[],
        user: s.user,
        limits: {
          editorMaxBytes: s.limits?.editor_max_bytes,
          rawMaxBytes: s.limits?.raw_max_bytes,
        },
      };
    },

    // 터미널·다른 기기·웹이 바꾼 것을 곧바로 따라간다(없으면 IDE 가 30초마다 목록을 다시 읽는다).
    subscribeChanges: (onChange) => subscribeWorkspace(wf, onChange),

    async listFiles(): Promise<IdeFileEntry[]> {
      const out = await call<{ files: IdeStorageEntry[] }>('files', wf);
      return (out.files ?? []).map((f) => ({
        path: f.path,
        isDir: f.is_dir,
        size: f.size,
        modifiedAt: f.modified_at,
        originName: f.origin_name,
      }));
    },

    async readFile(path) {
      const out = await call<IdeFileResponse>('read', wf, path);
      return { bytes: b64ToBytes(out.content_b64), sha: out.sha, size: out.size };
    },

    async saveFile(path, bytes, baseSha) {
      const out = await call<IdeSaveResponse>('save', wf, {
        path,
        content_b64: bytesToB64(bytes),
        base_sha: baseSha,
      });
      return { sha: out.sha, conflicts: out.published?.conflicts };
    },

    async stat(paths) {
      const out = await call<{ entries: Record<string, IdeStat> }>('stat', wf, paths);
      return out.entries ?? {};
    },

    async readRaw(path) {
      return call<Uint8Array>('raw', wf, path);
    },

    async fs(op: IdeFsOp) {
      await call('fs', wf, op);
    },

    search(q: IdeSearchQuery) {
      return call<IdeSearchResult>('search', wf, q);
    },

    replace(q) {
      return call<IdeReplaceResult>('replace', wf, q);
    },

    git<T>(args: Record<string, unknown>) {
      return call<T>('git', wf, args);
    },

    async terminals() {
      const out = await call<{ terminals: IdeTerminalInfo[] }>('terminals', wf);
      return out.terminals ?? [];
    },

    async closeTerminal(id) {
      await call('closeTerminal', wf, id);
    },

    openTerminal(id, options, handlers) {
      listen();
      socketSeq += 1;
      const socket = `${wf}:${id}:${socketSeq}`;
      sockets.set(socket, handlers);
      void xgen.ide.terminalOpen(socket, wf, id, options).catch(() => {
        if (sockets.delete(socket)) handlers.onClose(1011, '터미널을 열지 못했습니다');
      });
      return {
        send: (frame) => xgen.ide.terminalSend(socket, frame),
        close: () => {
          sockets.delete(socket);
          xgen.ide.terminalClose(socket);
        },
      };
    },

    loadMonaco,

    storage: {
      get: (key) => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      set: (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          /* 저장 공간이 없어도 IDE 는 돈다 */
        }
      },
    },

    openExternal: (url) => void xgen.openExternal(url),

    async download(path) {
      await xgen.ide.download(wf, path);
    },

    copyText,
  };
}
