/**
 * MCP 카탈로그 — 데스크톱 메인의 배선.
 *
 * 순서와 기록은 엔진(`runCatalogInstall`)이 하고, 여기서는 그 deps 를 이 앱의 것으로 채운다:
 * 네이티브 확인 창(포커스된 설정 화면에서만), 키체인, connector.json, MCP 매니저, 런타임
 * 설치 폴더(userData/runtimes), 서버 호출(@dex/protocol), 사용 기록 큐.
 *
 * 보안 성질(기존 MCP 저장 · 테스트와 같다):
 *  - 설치는 포커스된 설정 창의 직접 조작 + 네이티브 확인 창 승인이 있어야 한다.
 *  - 런타임 내려받기는 무엇을 · 어디서 · 얼마나 받는지 보여 주고 따로 동의를 받는다.
 *  - 승인 창에는 **확정된** 실행 파일 · 인자 · 환경 키 · setup 명령이 그대로 나온다.
 *  - 카탈로그 정의는 렌더러가 보낸 것이 아니라 메인이 서버에서 받은 것만 쓴다.
 */
import { app, dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { XgenClient } from '@dex/protocol';
import type {
  CatalogDevice,
  CatalogEventIn,
  CatalogItem,
  CatalogValues,
} from '@dex/protocol/mcp-catalog';
import { augmentedPath, buildChildEnv } from '@dex/engine/exec-resolve';
import { canonicalizeMcpServerConfig, getMcpManager } from '@dex/engine/mcp-manager';
import {
  catalogSaveEvents,
  catalogServerName,
  catalogVarsKey,
  runCatalogInstall,
  type CatalogInstallProgress,
  type CatalogInstallResult,
} from '@dex/engine/mcp-catalog-install';
import { CatalogEventReporter, fileEventStorage } from '@dex/engine/mcp-catalog-events';
import { McpRuntimeManager, type RuntimePlan } from '@dex/engine/mcp-runtime-manager';
import { runProcess } from '@dex/engine/proc-run';
import type { McpServerConfig } from './config';
// applyMcpServers 와 같은 키체인(데스크톱 safeStorage 사다리)을 쓴다.
import { mcpSecretStore } from './keychain';

export interface CatalogHostDeps {
  ipcMain: IpcMain;
  channels: {
    list: string;
    runtime: string;
    install: string;
    cancel: string;
    progress: string;
    stored: string;
    pickPath: string;
    viewed: string;
  };
  client: () => XgenClient;
  /** 로그인한 계정 키(서버 + 사용자). 없으면 로그인 전. */
  accountKey: () => string | null;
  deviceId: () => string;
  mainWindow: () => BrowserWindow | null;
  listServers: () => McpServerConfig[];
  applyServers: (servers: McpServerConfig[]) => Promise<McpServerConfig[]>;
  requireFocused: (event: IpcMainInvokeEvent) => void;
  /** 승인 창. 취소하면 던진다(기존 설정 저장과 같은 함수). */
  confirm: (event: IpcMainInvokeEvent, title: string, detail: string) => Promise<void>;
  approvalSummary: (servers: McpServerConfig[], digest: string) => string;
  digest: (value: unknown) => string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  diag?: (message: string) => void;
}

// ── 런타임 관리자 ─────────────────────────────────────────────────────

let runtimeManager: McpRuntimeManager | null = null;

export function getRuntimeManager(fetcher?: CatalogHostDeps['fetch']): McpRuntimeManager {
  if (!runtimeManager) {
    runtimeManager = new McpRuntimeManager({
      baseDir: join(app.getPath('userData'), 'runtimes'),
      fetch: fetcher ?? ((url, init) => fetch(url, init)),
    });
  }
  return runtimeManager;
}

/** 앱 시작 때 — 앱이 설치해 둔 Node · uv · Python 을 PATH 맨 앞에 건다(서버 기동 전에). */
export function activateManagedRuntimes(fetcher: CatalogHostDeps['fetch']): string[] {
  const mgr = getRuntimeManager(fetcher);
  void mgr.cleanupTemp();
  return mgr.activate();
}

// ── 사용 기록 ────────────────────────────────────────────────────────

const reporters = new Map<string, CatalogEventReporter>();
let hostDeps: CatalogHostDeps | null = null;

function fileSafe(key: string): string {
  return Buffer.from(key).toString('base64url').slice(0, 120);
}

function device(): CatalogDevice {
  return {
    device_id: hostDeps?.deviceId() ?? '',
    device_name: `${hostname()} · 데스크톱`,
    platform: process.platform,
    arch: process.arch,
    dexon_version: app.getVersion(),
  };
}

/** 계정마다 큐를 따로 둔다 — 로그아웃 뒤 다른 계정으로 남의 기록이 올라가지 않게. */
function reporterFor(account: string): CatalogEventReporter {
  let rep = reporters.get(account);
  if (!rep) {
    rep = new CatalogEventReporter({
      storage: fileEventStorage(
        join(app.getPath('userData'), 'mcp-catalog-events', `${fileSafe(account)}.json`),
      ),
      send: (events) => hostDeps!.client().mcpCatalog.sendEvents(device(), events),
      canSend: () => !!hostDeps && hostDeps.accountKey() === account,
    });
    rep.start();
    reporters.set(account, rep);
  }
  return rep;
}

export function recordCatalogEvent(event: CatalogEventIn): void {
  const account = hostDeps?.accountKey();
  if (!account) return; // 로그인 전의 조작은 누구의 것인지 알 수 없다
  reporterFor(account).enqueue(event);
}

/** 로그인 · 계정 전환 뒤 — 그 계정에 쌓인 기록을 바로 보내 본다. */
export function kickCatalogEvents(): void {
  const account = hostDeps?.accountKey();
  if (account) reporterFor(account).kick();
}

/** 설정 저장(켜기 · 끄기 · 삭제 · 직접 편집) 전후를 비교해 카탈로그 서버의 변화를 남긴다. */
export function recordCatalogSave(prev: McpServerConfig[], next: McpServerConfig[]): void {
  for (const e of catalogSaveEvents(prev, next)) recordCatalogEvent(e);
}

/** 제거된 서버의 카탈로그 비밀 변수도 지운다(applyMcpServers 의 정리와 같이). */
export async function clearCatalogVars(serverName: string): Promise<void> {
  await mcpSecretStore.clear(catalogVarsKey(serverName)).catch(() => {});
}

export async function renameCatalogVars(from: string, to: string): Promise<void> {
  const vars = await mcpSecretStore.get(catalogVarsKey(from)).catch(() => null);
  if (vars) await mcpSecretStore.save(catalogVarsKey(to), vars);
}

// ── 게시된 카탈로그(캐시 + ETag) ──────────────────────────────────────

interface CatalogCache {
  account: string;
  etag: string | null;
  items: CatalogItem[];
  fetchedAt: number;
}

let cache: CatalogCache | null = null;

function cachePath(): string {
  return join(app.getPath('userData'), 'mcp-catalog-cache.json');
}

function loadCache(account: string): CatalogCache | null {
  if (cache?.account === account) return cache;
  try {
    if (!existsSync(cachePath())) return null;
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8')) as CatalogCache;
    if (raw?.account === account && Array.isArray(raw.items)) cache = raw;
  } catch {
    /* 캐시는 없어도 된다 */
  }
  return cache?.account === account ? cache : null;
}

function saveCache(next: CatalogCache): void {
  cache = next;
  try {
    const tmp = `${cachePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, cachePath());
  } catch {
    /* 메모리 캐시는 남는다 */
  }
}

export interface CatalogListResult {
  items: CatalogItem[];
  fetchedAt: number | null;
  /** 서버에 닿지 못해 마지막으로 받은 목록을 보여 준다. */
  stale: boolean;
  error?: string;
}

async function listCatalog(force = false): Promise<CatalogListResult> {
  const deps = hostDeps!;
  const account = deps.accountKey();
  if (!account)
    return {
      items: [],
      fetchedAt: null,
      stale: false,
      error: '로그인한 뒤 카탈로그를 볼 수 있습니다.',
    };
  const cached = loadCache(account);
  try {
    const res = await deps.client().mcpCatalog.published(force ? null : (cached?.etag ?? null));
    if (res.notModified && cached) {
      saveCache({ ...cached, fetchedAt: Date.now() });
      return { items: cached.items, fetchedAt: Date.now(), stale: false };
    }
    if (res.notModified) return listCatalog(true);
    saveCache({ account, etag: res.etag, items: res.items, fetchedAt: Date.now() });
    return { items: res.items, fetchedAt: Date.now(), stale: false };
  } catch (e) {
    const status = (e as { status?: number }).status;
    const error =
      status === 404
        ? '이 XGEN 서버는 아직 MCP 카탈로그를 지원하지 않습니다.'
        : status === 401 || status === 403
          ? '카탈로그를 볼 권한이 없습니다. 다시 로그인해 보세요.'
          : `카탈로그를 불러오지 못했습니다: ${(e as Error).message}`;
    return {
      items: cached?.items ?? [],
      fetchedAt: cached?.fetchedAt ?? null,
      stale: !!cached,
      error,
    };
  }
}

function findItem(catalogId: string): CatalogItem | null {
  const account = hostDeps?.accountKey();
  if (!account) return null;
  return loadCache(account)?.items.find((i) => i.catalog_id === catalogId) ?? null;
}

// ── 확인 창 문구 ──────────────────────────────────────────────────────

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function runtimeConsentDetail(plan: RuntimePlan, baseDir: string): string {
  const rows = plan.downloads.map(
    (d) => `· ${d.label} ${d.version} — ${d.approximate ? '약 ' : ''}${mb(d.size)}\n  ${d.url}`,
  );
  return [
    `${plan.summary}`,
    '',
    '다음 런타임을 내려받아 이 앱 폴더에만 설치합니다(관리자 권한 · 시스템 변경 없음):',
    ...rows,
    '',
    `설치 위치: ${baseDir}`,
    'Node · uv 는 고정된 SHA-256 으로 검증하고, 맞지 않으면 설치하지 않습니다.',
    'Python 은 uv 가 공식 빌드(python-build-standalone)를 내려받아 검증합니다.',
  ].join('\n');
}

// ── IPC ─────────────────────────────────────────────────────────────

const jobs = new Map<string, AbortController>();

interface InstallRequest {
  jobId: string;
  catalogId: string;
  values: CatalogValues;
  mode?: 'install' | 'update';
  /** 업데이트할 서버 이름. */
  serverName?: string;
}

export function registerMcpCatalogIpc(deps: CatalogHostDeps): void {
  hostDeps = deps;
  const { ipcMain, channels } = deps;

  ipcMain.handle(channels.list, (_e, force?: boolean) => listCatalog(!!force));

  ipcMain.handle(channels.viewed, (_e, catalogId: string) => {
    const item = findItem(String(catalogId ?? ''));
    if (item) {
      recordCatalogEvent({
        ts: new Date().toISOString(),
        catalog_id: item.catalog_id,
        revision: item.revision,
        event: 'catalog_viewed',
        ok: true,
      });
    }
    return true;
  });

  ipcMain.handle(channels.runtime, async (_e, catalogId: string) => {
    const item = findItem(String(catalogId ?? ''));
    if (!item) throw new Error('카탈로그 항목을 찾지 못했습니다. 목록을 새로 고쳐 주세요.');
    const launch = item.spec.transport === 'stdio' ? item.spec.launch : null;
    const command =
      launch?.platforms?.[process.platform as 'win32' | 'darwin' | 'linux']?.command ||
      launch?.command;
    return getRuntimeManager(deps.fetch).plan(
      item.spec.runtime?.kind ?? 'none',
      item.spec.runtime?.min_version ?? undefined,
      command,
    );
  });

  ipcMain.handle(channels.stored, async (_e, serverName: string) => {
    const server = deps.listServers().find((s) => s.name === String(serverName ?? ''));
    if (!server?.catalog) return { values: {}, secretsSet: [] };
    const secrets = await mcpSecretStore.get(catalogVarsKey(server.name)).catch(() => null);
    return {
      values: server.catalog.values ?? {},
      // 값은 화면으로 보내지 않는다 — "저장됨" 표시용 이름만.
      secretsSet: Object.entries(secrets?.env ?? {})
        .filter(([, v]) => !!v)
        .map(([k]) => k),
    };
  });

  ipcMain.handle(
    channels.pickPath,
    async (event, opts?: { directory?: boolean; title?: string }) => {
      deps.requireFocused(event);
      const win = deps.mainWindow();
      const options = {
        title: String(opts?.title ?? '경로 선택'),
        defaultPath: homedir(),
        properties: (opts?.directory === false
          ? ['openFile']
          : ['openDirectory', 'createDirectory']) as Array<
          'openFile' | 'openDirectory' | 'createDirectory'
        >,
      };
      const r = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
  );

  ipcMain.handle(channels.cancel, (_e, jobId: string) => {
    jobs.get(String(jobId ?? ''))?.abort();
    return true;
  });

  ipcMain.handle(
    channels.install,
    async (event, raw: InstallRequest): Promise<CatalogInstallResult> => {
      deps.requireFocused(event);
      const jobId = String(raw?.jobId ?? '');
      if (!jobId || jobs.has(jobId)) throw new Error('설치 작업 id 가 올바르지 않습니다.');
      const item = findItem(String(raw?.catalogId ?? ''));
      if (!item) throw new Error('카탈로그 항목을 찾지 못했습니다. 목록을 새로 고쳐 주세요.');
      const mode = raw?.mode === 'update' ? 'update' : 'install';
      const existing = deps.listServers();
      let serverName: string;
      let storedSecrets: Record<string, string> | undefined;
      if (mode === 'update') {
        const target = existing.find((s) => s.name === String(raw?.serverName ?? ''));
        if (!target || target.catalog?.catalog_id !== item.catalog_id)
          throw new Error('업데이트할 카탈로그 서버를 찾지 못했습니다.');
        serverName = target.name;
        storedSecrets =
          (await mcpSecretStore.get(catalogVarsKey(serverName)).catch(() => null))?.env ??
          undefined;
      } else {
        serverName = catalogServerName(
          item.catalog_id,
          existing.map((s) => s.name),
        );
      }
      const ctrl = new AbortController();
      jobs.set(jobId, ctrl);
      const send = (p: CatalogInstallProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send(channels.progress, { jobId, ...p });
      };
      const runtimes = getRuntimeManager(deps.fetch);
      /** 승인 창 — 취소는 false, 그 밖의 실패(포커스 잃음 등)는 그대로 던진다. */
      const ask = async (title: string, detail: string): Promise<boolean> => {
        try {
          await deps.confirm(event, title, detail);
          return true;
        } catch (e) {
          if (/취소/.test(String((e as Error)?.message))) return false;
          throw e;
        }
      };
      try {
        const result = await runCatalogInstall(
          {
            item,
            values: raw?.values ?? {},
            serverName,
            mode,
            platform: process.platform,
            dexonVersion: app.getVersion(),
            storedSecrets,
          },
          {
            planRuntime: (kind, min, command) => runtimes.plan(kind, min, command),
            confirmRuntime: (plan) =>
              ask('MCP 런타임 설치', runtimeConsentDetail(plan, runtimes.baseDir)),
            ensureRuntime: (plan, onProgress, signal) => runtimes.ensure(plan, onProgress, signal),
            canonicalize: (config) => canonicalizeMcpServerConfig(config),
            confirmInstall: ({ config, setup }) => {
              const digest = deps.digest(config);
              const setupRows = setup.length
                ? [
                    '',
                    '설치 직후 한 번 실행할 명령:',
                    ...setup.map((s, i) => `  ${i + 1}. ${s.command} ${JSON.stringify(s.args)}`),
                  ]
                : [];
              return ask(
                mode === 'update' ? 'MCP 카탈로그 업데이트' : 'MCP 카탈로그 설치',
                [
                  `카탈로그: ${item.name} (${item.catalog_id} · 판 ${item.revision})`,
                  '',
                  deps.approvalSummary([config], digest),
                  ...setupRows,
                  '',
                  '연결을 시험해 도구 목록을 확인한 뒤 저장합니다.',
                ].join('\n'),
              );
            },
            runSetup: async (step, env, signal, onOutput) =>
              runProcess(step.command, step.args, {
                env: buildChildEnv(await augmentedPath(), env),
                timeoutMs: step.timeoutMs,
                signal,
                onOutput,
              }),
            test: (config, onLines) => getMcpManager().test(config, onLines),
            save: async (config, secretValues, saveMode) => {
              const current = deps.listServers();
              const at = current.findIndex((s) => s.name === config.name);
              if (saveMode === 'install' && at >= 0)
                throw new Error(
                  `같은 이름(${config.name})의 서버가 방금 생겼습니다. 다시 시도해 주세요.`,
                );
              const next = [...current];
              if (at >= 0) next[at] = { ...config, enabled: current[at].enabled !== false };
              else next.push(config);
              await deps.applyServers(next);
              const saved = await mcpSecretStore.save(catalogVarsKey(config.name), {
                env: secretValues,
              });
              if (!saved) deps.diag?.(`catalog vars not persisted for ${config.name}`);
            },
            emit: (e) => recordCatalogEvent(e),
            progress: send,
          },
          ctrl.signal,
        );
        deps.diag?.(`catalog ${mode} ${item.catalog_id} → ${result.ok ? 'ok' : result.code}`);
        return result;
      } finally {
        jobs.delete(jobId);
      }
    },
  );
}
