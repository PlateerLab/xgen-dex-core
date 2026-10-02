/**
 * XD 의 IDE 호스트 — @dex/ide 가 바라는 것(IdeHost)을 이 PC 의 파일로 채운다. IDE 는 Dex 와 같은 부품 그대로다.
 *
 *   탐색기·편집기·찾기  = 에이전트의 작업 공간(main 의 ide-service — Dex 의 folder-fs 그대로)
 *   [연결된 폴더] 칸   = 그 에이전트의 연결 폴더(몇 번째로만 연다)
 *   미리보기           = Dex 의 뷰어(그림·PDF·마크다운·표). 문서(docx 등)는 그려 줄 서버가 없어 내려받기 안내로 간다.
 *
 * XD 에 아직 없는 것 — 소스 제어(git)·터미널 — 은 한 문장으로 그렇다고 답한다(활동 막대에는 단추를 두지 않는다).
 *
 * 바뀜 알림: 에이전트가 파일을 쓰는 것은 턴 안에서다 — 도구 결과·턴 끝이 오면, 그리고 창으로 돌아오면(다른 프로그램
 * 에서 고쳤을 수 있다) 다시 읽게 한다.
 */
import { IdeError, type IdeFolderSource, type IdeHost, type TerminalConnection } from '@dex/ide';
import { idePreviewModeFor } from '@dex/protocol/file-view';
import type { XdAgent } from '../../../main/store';
import { xd } from '../bridge';
import { loadMonaco } from '../dex';
import { folderId, folderOfId } from '../../../shared/folder-id';
import { onIdeActivity } from './activity';
import { createXdIdePreview } from './xd-ide-preview';

const EDITOR_MAX = 10 * 1024 * 1024;
const RAW_MAX = 50 * 1024 * 1024;

/** main 의 실패(code·detail) → IDE 가 아는 실패. */
function ideError(err: unknown): IdeError {
  const e = err as Error & { code?: string; detail?: Record<string, unknown> };
  return new IdeError(e?.code || 'error', e?.message || String(err), 0, e?.detail ?? {});
}

const NO_TERMINAL = 'XD 에서는 아직 터미널을 쓸 수 없습니다.';
const NO_GIT = 'XD 에서는 아직 소스 제어를 쓸 수 없습니다.';

export function createXdIdeHost(agentId: string, current: () => XdAgent | null): IdeHost {
  const call = async <T>(root: 'workspace' | string, op: string, args: Record<string, unknown> = {}): Promise<T> => {
    try {
      return await xd.ide.call<T>(agentId, root, op, args);
    } catch (err) {
      throw ideError(err);
    }
  };
  // 작업 공간 전체 목록은 무겁다 — 읽는 중에 또 부르면 지금 것이 끝난 뒤 **한 번 더** 읽어 그 대답을 같이 쓴다(지금 것은
  // 이미 낡았을 수 있다 — 턴 끝에 만든 파일이 빠지지 않게). 기다리는 다음 읽기는 하나뿐이다.
  let listing: Promise<unknown> | null = null;
  let queued: Promise<unknown> | null = null;
  const listTree = (): Promise<unknown> => {
    if (!listing) {
      listing = call('workspace', 'tree').finally(() => (listing = null));
      return listing;
    }
    if (!queued) {
      queued = listing
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return listTree();
        });
    }
    return queued;
  };

  // 연결 폴더의 rootId 는 그 경로의 열쇠다(folder-id.ts) — 다른 폴더의 연결을 끊어도 밀리지 않는다.
  const folders: IdeFolderSource = {
    async state() {
      const roots = await xd.ide.folders(agentId);
      return { roots: roots.map((r) => ({ id: r.id, name: r.name, detail: r.detail, missing: r.missing })) };
    },
    subscribe(onChange) {
      return onIdeActivity(agentId, () => {
        onChange();
        for (const f of current()?.folders ?? []) onChange(folderId(f));
      });
    },
    list: (rootId, dir) => call(rootId, 'list', { dir }),
    read: (rootId, path) => call(rootId, 'read', { path }),
    save: (rootId, path, bytes, baseSha) => call(rootId, 'save', { path, bytes, baseSha }),
    stat: (rootId, paths) => call(rootId, 'stat', { paths }),
    readRaw: (rootId, path) => call(rootId, 'raw', { path }),
    fs: (rootId, op) => call(rootId, 'fs', { op }),
    reveal: (rootId, path) => void call(rootId, 'reveal', { path }).catch(() => undefined),
    pathOf: (rootId, path) => {
      const base = folderOfId(rootId) ?? '';
      const slash = base.includes('\\') ? '\\' : '/';
      return path ? `${base.replace(/[\\/]+$/, '')}${slash}${path.split('/').join(slash)}` : base;
    },
    trashes: true,
  };

  const storagePrefix = `xd.ide.${agentId}.`;

  return {
    workflowId: agentId,
    get agentName() {
      return current()?.name ?? '';
    },
    session: async () => ({ readonly: false, terminals: [], limits: { editorMaxBytes: EDITOR_MAX, rawMaxBytes: RAW_MAX } }),
    listFiles: () => listTree() as Promise<never>,
    subscribeChanges: (onChange) => onIdeActivity(agentId, onChange),
    readFile: (path) => call('workspace', 'read', { path }),
    saveFile: (path, bytes, baseSha) => call('workspace', 'save', { path, bytes, baseSha }),
    stat: (paths) => call('workspace', 'stat', { paths }),
    readRaw: (path) => call('workspace', 'raw', { path }),
    fs: (op) => call('workspace', 'fs', { op }),
    search: (query) => call('workspace', 'search', { ...query }),
    replace: (query) => call('workspace', 'replace', { ...query }),
    git: async () => {
      throw new IdeError('unsupported', NO_GIT);
    },
    terminals: async () => [],
    closeTerminal: async () => undefined,
    openTerminal(_id, _options, handlers): TerminalConnection {
      // 4404 — IDE 는 다시 붙지 않고 이 문장을 보인다.
      queueMicrotask(() => handlers.onClose(4404, NO_TERMINAL));
      return { send: () => undefined, close: () => undefined };
    },
    loadMonaco,
    storage: {
      get(key) {
        try {
          return window.localStorage.getItem(storagePrefix + key);
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          window.localStorage.setItem(storagePrefix + key, value);
        } catch {
          /* 기억 못 해도 동작엔 지장 없다 */
        }
      },
    },
    openExternal: (url) => void xd.openExternal(url),
    copyText: (text) => xd.clipboard.write(text),
    // 늘 둔다 — 연결 폴더가 없으면 탐색기에 그 칸이 보이지 않고, 나중에 연결하면 그 자리에 나타난다(저장소를 새로
    // 만들지 않는다 — 편집 중인 버퍼·되돌리기 기록이 남게).
    folders,
    preview: createXdIdePreview(agentId, idePreviewModeFor),
  };
}
