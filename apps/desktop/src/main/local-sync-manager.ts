/**
 * LocalSyncManager — 연결된 에이전트마다 SyncPair 하나(로컬 폴더 ⟷ 서버
 * 워크스페이스 저장소)의 수명을 소유한다.
 *
 * 켜지는 조건 (전부 만족):
 *   · 로그인됨
 *   · 로컬 도구 접근 켜짐 (localShell.enabled)
 *   · **기본 작업 폴더가 지정됨** — 비우면 홈이 기본이지만, 홈 전체에 에이전트
 *     폴더를 흩뿌리는 것은 사용자가 고른 일이 아니므로 동기화는 명시된 폴더가
 *     있을 때만 돈다.
 *
 * 대상 에이전트 = 서버 연결 목록(cloud links)의 사본 — 드라이브가 쓰던 것과
 * 같은 목록이다. 폴더는 `<기본 작업 폴더>/<링크 폴더명>`.
 *
 * 트리거: 서버 변경 알림(WS presence) · 로컬 파일 워처(chokidar, 디바운스) ·
 * 보험용 주기 타이머. 사이클 자체는 SyncPair 가 한 줄로 세운다.
 */
import { watch, type FSWatcher } from 'chokidar';
import { join } from 'path';
import { diag } from './diag-log';
import { SyncPair, type SyncRemote, type SyncReport } from './local-sync';
import { pickFolderName, safeName } from './local-sync-folder';

export interface SyncTarget {
  workflowId: string;
  label: string;
  folder: string;
}

export interface LocalSyncConfig {
  /** 로컬 도구 접근 + 기본 작업 폴더가 갖춰졌는가. */
  enabled: boolean;
  /** 기본 작업 폴더 (절대 경로). enabled 일 때만 의미 있다. */
  root: string;
  targets: SyncTarget[];
}

export interface LocalSyncDeps {
  config: () => LocalSyncConfig;
  loggedIn: () => boolean;
  remoteFor: (workflowId: string) => SyncRemote;
  /** 서버 변경 알림 (드라이브의 presence 와 같은 WS). */
  presenceFor?: (owner: string, onChanged: () => void) => { start(): Promise<void>; stop(): void };
  /** base 스냅숏 보관 폴더 (계정별 — 계정 전환을 따라가도록 호출 시점에 묻는다). */
  stateDir: () => string;
  deviceName: string;
  onStatus?: (s: LocalSyncStatus) => void;
  /** 보험 타이머 간격(ms). 기본 5분. 테스트에서 끈다(0). */
  intervalMs?: number;
}

export interface AgentSyncStatus {
  workflowId: string;
  label: string;
  folder: string;
  /** 로컬 절대 경로. */
  dir: string;
  syncing: boolean;
  lastSyncAt?: number;
  lastError?: string;
  last?: Pick<
    SyncReport,
    'downloaded' | 'uploaded' | 'deletedLocal' | 'deletedRemote' | 'conflicts'
  >;
}

export interface LocalSyncStatus {
  /** 동기화가 도는 상태인가. */
  enabled: boolean;
  /** 꺼져 있는 이유 (UI 안내용). */
  reason?: 'disabled' | 'no-root' | 'logged-out';
  root?: string;
  agents: AgentSyncStatus[];
}

interface Live {
  target: SyncTarget;
  dir: string;
  pair: SyncPair;
  watcher: FSWatcher | null;
  presence: { start(): Promise<void>; stop(): void } | null;
  timer: ReturnType<typeof setInterval> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  syncing: boolean;
  lastSyncAt?: number;
  lastError?: string;
  last?: AgentSyncStatus['last'];
}

const WATCH_DEBOUNCE_MS = 1200;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class LocalSyncManager {
  private live = new Map<string, Live>();
  private stopped = false;
  /**
   * 온디맨드 페어 — 서버가 커넥터 세션에서 **어느 에이전트든** 로컬로 실행하려
   * 할 때(ensurePair) 여기 쌓인다. config.targets(클라우드 연결 목록)와 달리
   * 연결(attach) 없이도 그 에이전트의 자기 워크스페이스를 로컬 폴더로 연다 —
   * 모든 Agent-XGeny 는 자기 워크스페이스를 항상 갖기 때문이다.
   */
  private extra = new Map<string, SyncTarget>();

  constructor(private deps: LocalSyncDeps) {}

  /**
   * 이 에이전트를 로컬로 실행할 폴더를 확보한다 (없으면 만든다). 서버의
   * ConnectorLocalSandbox 프로브가 부른다. 로컬 도구가 켜져 있고 기본 작업
   * 폴더가 지정돼 있을 때만 폴더를 준다 — 그 두 가지가 로컬 실행의 전제다.
   * 연결(attach) 여부와 무관하다.
   */
  ensurePair(workflowId: string, label: string): string | null {
    if (this.stopped) return null;
    const cfg = this.deps.config();
    if (!this.deps.loggedIn() || !cfg.enabled || !cfg.root) return null;
    const already =
      this.extra.has(workflowId) || cfg.targets.some((t) => t.workflowId === workflowId);
    if (!already) {
      const taken = new Set<string>([
        ...cfg.targets.map((t) => t.folder),
        ...[...this.extra.values()].map((t) => t.folder),
      ]);
      this.extra.set(workflowId, {
        workflowId,
        label: label || workflowId,
        folder: pickFolderName(workflowId, label || workflowId, taken),
      });
      this.reconcile();
    }
    // 연결 목록(targets)에 있지만 아직 live 가 안 선 창(로그인 직후 레이스) — 지금 세운다.
    if (!this.live.has(workflowId)) this.reconcile();
    return this.dirFor(workflowId);
  }

  /** 설정·로그인 상태에 맞춰 페어를 만들고 걷는다. 언제든 다시 불러도 된다. */
  reconcile(): void {
    if (this.stopped) return;
    const cfg = this.deps.config();
    const want = new Map<string, SyncTarget>();
    if (this.deps.loggedIn() && cfg.enabled && cfg.root) {
      for (const t of cfg.targets) want.set(t.workflowId, t);
      // 온디맨드 페어도 유지한다 (연결 목록에 없어도) — 다만 연결(config)이
      // 같은 에이전트를 정식 폴더로 가지면 그쪽이 이긴다.
      for (const [id, t] of this.extra) if (!want.has(id)) want.set(id, t);
    } else {
      // 로컬 실행 전제가 깨지면 온디맨드도 비운다 (다음 확보 때 다시 선다).
      this.extra.clear();
    }

    // 걷기 — 목록에서 빠졌거나 루트가 바뀐 페어.
    for (const [id, l] of [...this.live]) {
      const t = want.get(id);
      const dir = t ? join(cfg.root, t.folder) : null;
      if (!t || l.dir !== dir) this.teardown(id);
    }
    // 세우기.
    for (const [id, t] of want) {
      if (!this.live.has(id)) this.setup(cfg.root, t);
    }
    this.emit();
  }

  private setup(root: string, target: SyncTarget): void {
    const dir = join(root, target.folder);
    const pair = new SyncPair({
      remote: this.deps.remoteFor(target.workflowId),
      dir,
      // 폴더명까지 키에 넣는다 — 폴더가 바뀌면(라벨 변경 등) base 도 새로
      // 시작해야 한다. 옛 base 를 새(빈) 폴더에 재사용하면 3-way 가 "로컬
      // 전체 삭제"로 오판해 서버 파일을 지운다.
      statePath: join(
        this.deps.stateDir(),
        `${safeName(target.workflowId)}@${safeName(target.folder)}.json`,
      ),
      deviceName: this.deps.deviceName,
    });
    const live: Live = {
      target,
      dir,
      pair,
      watcher: null,
      presence: null,
      timer: null,
      debounce: null,
      syncing: false,
    };
    this.live.set(target.workflowId, live);

    // 로컬 워처 — 내가 방금 쓴 파일(다운로드)도 이벤트를 내지만, 사이클이
    // 한 줄로 서고 무변경 사이클은 무동작이므로 저렴한 재확인일 뿐이다.
    try {
      live.watcher = watch(dir, {
        ignoreInitial: true,
        ignored: /(^|[/\\])(\.git|node_modules|__pycache__|\.venv|\.xgeny-session)([/\\]|$)/,
        awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 150 },
      });
      live.watcher.on('all', () => this.schedule(target.workflowId, WATCH_DEBOUNCE_MS));
      live.watcher.on('error', (e) =>
        diag('local-sync', `워처 오류 ${target.label}: ${(e as Error).message}`),
      );
    } catch (e) {
      diag('local-sync', `워처 시작 실패 ${target.label}: ${(e as Error).message}`);
    }

    // 서버 변경 알림 — 에이전트 턴이 publish 하면 즉시 내려받는다.
    if (this.deps.presenceFor) {
      live.presence = this.deps.presenceFor(target.workflowId, () =>
        this.schedule(target.workflowId, 300),
      );
      void live.presence.start().catch((e) => {
        diag('local-sync', `변경 알림 연결 실패 ${target.label}: ${(e as Error).message}`);
      });
    }

    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (interval > 0) {
      live.timer = setInterval(() => this.schedule(target.workflowId, 0), interval);
      live.timer.unref?.();
    }

    diag('local-sync', `페어 시작: ${target.label} ↔ ${dir}`);
    this.schedule(target.workflowId, 0);
  }

  private teardown(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    if (l.debounce) clearTimeout(l.debounce);
    if (l.timer) clearInterval(l.timer);
    l.presence?.stop();
    void l.watcher?.close().catch(() => undefined);
    l.pair.dispose();
    diag('local-sync', `페어 종료: ${l.target.label}`);
  }

  private schedule(id: string, delayMs: number): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.debounce) clearTimeout(l.debounce);
    l.debounce = setTimeout(() => {
      l.debounce = null;
      void this.run(id);
    }, delayMs);
    l.debounce.unref?.();
  }

  private async run(id: string): Promise<void> {
    const l = this.live.get(id);
    if (!l) return;
    l.syncing = true;
    this.emit();
    try {
      const r = await l.pair.sync();
      l.lastSyncAt = Date.now();
      l.lastError = r.errors[0];
      l.last = {
        downloaded: r.downloaded,
        uploaded: r.uploaded,
        deletedLocal: r.deletedLocal,
        deletedRemote: r.deletedRemote,
        conflicts: r.conflicts,
      };
    } catch (e) {
      l.lastError = (e as Error).message;
      diag('local-sync', `동기화 실패 ${l.target.label}: ${l.lastError}`);
    } finally {
      l.syncing = false;
      this.emit();
    }
  }

  /** 곧 동기화 — 브리지 실행(_Exec/_WriteBytes)이 파일을 만졌을 때 부른다.
   *  워처보다 빠르게, 그러나 연타는 디바운스로 한 사이클에 합쳐진다. */
  poke(workflowId: string): void {
    this.schedule(workflowId, 800);
  }

  /** 지금 동기화 — id 없으면 전부. */
  async syncNow(workflowId?: string): Promise<void> {
    const ids = workflowId ? [workflowId] : [...this.live.keys()];
    await Promise.all(ids.map((id) => this.run(id)));
  }

  /**
   * 폴더를 확보하고 **인덱스에서 하이드레이트가 끝날 때까지** 기다린다 (bounded).
   * 커넥터 세션의 턴 시작(_WorkspaceInfo)이 부른다 — 웹에서 만든 파일이
   * 로컬 폴더에 내려온 뒤에야 에이전트가 실행돼야 "빈 워크스페이스" 오판이
   * 없다. 시간이 걸리면 synced=false 로 돌려주되 폴더는 준다 (실행은 진행,
   * 남은 동기화는 백그라운드).
   */
  async ensureSynced(
    workflowId: string,
    label: string,
    timeoutMs = 15000,
  ): Promise<{ dir: string | null; synced: boolean }> {
    const dir = this.ensurePair(workflowId, label);
    if (!dir) return { dir: null, synced: false };
    const synced = await Promise.race([
      this.syncNow(workflowId).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref?.()),
    ]);
    return { dir, synced };
  }

  /**
   * 로컬 변경을 인덱스로 **밀어 넣고 끝날 때까지** 기다린다 (bounded). 커넥터
   * 세션의 턴 종료가 부른다 — 이 PC 에서 만든 파일이 인덱스에 반영된 뒤에야
   * 웹(sandbox)이 그것을 하이드레이트할 수 있다 (커넥터→웹 일관성).
   */
  async flushSync(workflowId: string, timeoutMs = 15000): Promise<boolean> {
    if (!this.live.has(workflowId)) return false;
    return Promise.race([
      this.syncNow(workflowId).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref?.()),
    ]);
  }

  /** 이 에이전트가 지금 동기화 중인가 (상태 표시용). */
  isSyncing(workflowId: string): boolean {
    return this.live.get(workflowId)?.syncing ?? false;
  }

  status(): LocalSyncStatus {
    const cfg = this.deps.config();
    const reason = !this.deps.loggedIn()
      ? ('logged-out' as const)
      : !cfg.enabled
        ? ('disabled' as const)
        : !cfg.root
          ? ('no-root' as const)
          : undefined;
    return {
      enabled: !reason,
      reason,
      root: cfg.root || undefined,
      agents: [...this.live.values()].map((l) => ({
        workflowId: l.target.workflowId,
        label: l.target.label,
        folder: l.target.folder,
        dir: l.dir,
        syncing: l.syncing,
        lastSyncAt: l.lastSyncAt,
        lastError: l.lastError,
        last: l.last,
      })),
    };
  }

  dirFor(workflowId: string): string | null {
    return this.live.get(workflowId)?.dir ?? null;
  }

  private emit(): void {
    this.deps.onStatus?.(this.status());
  }

  stop(): void {
    this.stopped = true;
    for (const id of [...this.live.keys()]) this.teardown(id);
    this.emit();
  }
}
