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
 *
 * ## 큐 (에이전트 100+ 대비)
 *
 * 트리거는 페어를 직접 돌리지 않고 **매니저 전역 FIFO 큐**에 넣는다 — 동시에
 * 도는 사이클은 concurrency(기본 1)개뿐이다. 전에는 reconcile/syncNow 가 전
 * 페어를 한꺼번에 돌려(Promise.all) 네트워크·디스크가 서로를 밀어내며 전체가
 * 느려졌다. 큐에서는:
 *   · 같은 페어의 연타는 하나로 접힌다 (대기 중 재요청 무시, 실행 중이면
 *     끝난 뒤 한 번 더).
 *   · 턴 크리티컬 경로(ensureSynced/flushSync — 커넥터 세션 시작·종료)는
 *     맨 앞에 끼어든다 (front).
 *   · 각 페어의 상태(idle/queued/syncing + 대기 순번 + 사이클 진행률)가
 *     status() 로 나가 UI 가 개별 프로그레스를 보여준다.
 */
import { watch, type FSWatcher } from 'chokidar';
import { join } from 'path';
import { diag } from './diag-log';
import { SyncPair, type SyncProgress, type SyncRemote, type SyncReport } from './local-sync';
import { pickFolderName, safeName } from './local-sync-folder';

export type { SyncProgress } from './local-sync';

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
  /** 동시에 도는 사이클 수. 기본 1 — 큐가 하나하나 처리한다. */
  concurrency?: number;
  /**
   * 벌크 인덱스 probe — 여러 저장소의 원본 seq 를 요청 한 번으로. 있으면
   * 보험 주기가 "seq 가 커서와 다른 페어"만 큐에 세운다 (100+ 페어 전수
   * 폴링 → 게이트웨이 504 폭주 방지). 실패/미지원(구서버)이면 전수 폴백.
   */
  indexSeqs?: (owners: string[]) => Promise<Record<string, number>>;
  /**
   * 느린 전체 사이클 스윕 간격(ms). probe 는 원본 인덱스만 보므로(파드
   * 로컬 미발행 산출물 안 보임) 이 주기마다는 probe 결과와 무관하게 정식
   * 사이클을 돈다. 기본 1시간. 0 = 스윕 없음(테스트).
   */
  fullSweepMs?: number;
}

/** 큐 안에서의 페어 상태. syncing(boolean)은 하위호환용 파생값이다. */
export type SyncQueueState = 'idle' | 'queued' | 'syncing';

export interface AgentSyncStatus {
  workflowId: string;
  label: string;
  folder: string;
  /** 로컬 절대 경로. */
  dir: string;
  state: SyncQueueState;
  /** state === 'queued' 일 때 1-기반 대기 순번. */
  queuePosition?: number;
  /** state === 'syncing' 일 때 현재 사이클 진행률. */
  progress?: SyncProgress;
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
  debounce: ReturnType<typeof setTimeout> | null;
  state: SyncQueueState;
  /** 실행 중에 새 요청이 오면 표시만 해 두고, 끝난 뒤 큐에 다시 선다. */
  rerun: boolean;
  /** 연속 실패 횟수 — 보험 주기의 지수 백오프 재료 (성공 시 0). */
  failures: number;
  /** 이 시각 전에는 보험 주기가 이 페어를 다시 세우지 않는다 (명시 요청은 무시). */
  nextRetryAt: number;
  /** 이 페어의 다음 완료를 기다리는 쪽 (syncNow/ensureSynced/flushSync). */
  waiters: Array<(ok: boolean) => void>;
  progress?: SyncProgress;
  lastSyncAt?: number;
  lastError?: string;
  last?: AgentSyncStatus['last'];
}

const WATCH_DEBOUNCE_MS = 1200;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 1;
/** probe 와 무관하게 정식 사이클을 강제하는 스윕 주기 — 기본 1시간. */
const DEFAULT_FULL_SWEEP_MS = 60 * 60 * 1000;
/** 실패 백오프: 1분 × 2^(n-1), 상한 30분. */
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
/** 진행률 status 방송 간격 — apply 가 수백 파일이어도 IPC 를 도배하지 않게. */
const PROGRESS_EMIT_MS = 200;

export class LocalSyncManager {
  private live = new Map<string, Live>();
  private stopped = false;
  /** 전역 FIFO 큐 — 대기 중인 페어 id. 실행 중(active)인 id 는 없다. */
  private queue: string[] = [];
  private activeCount = 0;
  private lastProgressEmit = 0;
  /** 매니저 전역 보험 타이머 — 페어별 타이머는 없다 (전원이 같은 시각에
   *  발사되는 thundering herd 가 5분 정각 504 폭주의 절반이었다). */
  private insuranceTimer: ReturnType<typeof setInterval> | null = null;
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
      onProgress: (p) => this.onProgress(target.workflowId, p),
    });
    const live: Live = {
      target,
      dir,
      pair,
      watcher: null,
      presence: null,
      debounce: null,
      state: 'idle',
      rerun: false,
      failures: 0,
      nextRetryAt: 0,
      waiters: [],
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

    this.ensureInsuranceTimer();

    diag('local-sync', `페어 시작: ${target.label} ↔ ${dir}`);
    this.schedule(target.workflowId, 0);
  }

  private ensureInsuranceTimer(): void {
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0 || this.insuranceTimer) return;
    this.insuranceTimer = setInterval(() => void this.insuranceTick(), interval);
    this.insuranceTimer.unref?.();
  }

  private teardown(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
    // 기다리는 쪽을 매달아 두지 않는다 — 페어가 사라졌으면 실패로 정리.
    for (const w of l.waiters.splice(0)) w(false);
    if (l.debounce) clearTimeout(l.debounce);
    l.presence?.stop();
    if (this.live.size === 0 && this.insuranceTimer) {
      clearInterval(this.insuranceTimer);
      this.insuranceTimer = null;
    }
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
      void this.enqueue(id);
    }, delayMs);
    l.debounce.unref?.();
  }

  /**
   * 큐에 세운다. 반환 Promise 는 **이 요청 이후에 시작된 사이클이 끝날 때**
   * 풀린다 (실행 중이었으면 끝난 뒤 한 번 더 돈 사이클까지 — 그 사이 변경이
   * 반영된 시점이라야 flushSync 의 의미가 맞다). front 는 대기열 맨 앞 —
   * 커넥터 세션의 턴 시작/종료 같은 크리티컬 경로 전용이다.
   */
  private enqueue(id: string, opts?: { front?: boolean }): Promise<boolean> {
    const l = this.live.get(id);
    if (!l || this.stopped) return Promise.resolve(false);
    const done = new Promise<boolean>((resolve) => l.waiters.push(resolve));
    if (l.state === 'syncing') {
      // 이미 도는 중 — 끝난 뒤 한 번 더 (연타는 이 표시 하나로 접힌다).
      l.rerun = true;
    } else if (l.state === 'queued') {
      // 이미 줄에 서 있다 — front 요청이면 앞으로 끌어올린다.
      if (opts?.front && this.queue[0] !== id) {
        this.queue = this.queue.filter((q) => q !== id);
        this.queue.unshift(id);
        this.emit();
      }
    } else {
      l.state = 'queued';
      if (opts?.front) this.queue.unshift(id);
      else this.queue.push(id);
      this.emit();
      this.drain();
    }
    return done;
  }

  /** 큐를 concurrency 만큼만 비운다 — 나머지는 순번을 기다린다. */
  private drain(): void {
    const limit = Math.max(1, this.deps.concurrency ?? DEFAULT_CONCURRENCY);
    while (this.activeCount < limit && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const l = this.live.get(id);
      if (!l || l.state !== 'queued') continue;
      this.activeCount++;
      l.state = 'syncing';
      l.progress = undefined;
      this.emit();
      void this.runCycle(l).finally(() => {
        this.activeCount--;
        if (l.rerun && this.live.has(id) && !this.stopped) {
          // 실행 중 들어온 변경 — 대기자(waiters)는 그대로 들고 다시 줄을 선다.
          l.rerun = false;
          l.state = 'queued';
          this.queue.unshift(id);
        } else {
          l.state = 'idle';
          l.progress = undefined;
          const ok = !l.lastError;
          for (const w of l.waiters.splice(0)) w(ok);
        }
        this.emit();
        this.drain();
      });
    }
  }

  private async runCycle(l: Live): Promise<void> {
    try {
      const r = await l.pair.sync();
      l.lastSyncAt = Date.now();
      l.lastError = r.errors[0];
      l.failures = 0;
      l.nextRetryAt = 0;
      l.last = {
        downloaded: r.downloaded,
        uploaded: r.uploaded,
        deletedLocal: r.deletedLocal,
        deletedRemote: r.deletedRemote,
        conflicts: r.conflicts,
      };
    } catch (e) {
      l.lastError = (e as Error).message;
      // 지수 백오프 — 죽은 서버를 보험 주기마다 다시 두드리지 않는다.
      // (명시 요청 — 사용자 클릭·watcher·presence — 은 이 시각을 무시한다.)
      l.failures += 1;
      l.nextRetryAt =
        Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (l.failures - 1), BACKOFF_MAX_MS);
      diag('local-sync', `동기화 실패 ${l.target.label}: ${l.lastError}`);
    }
  }

  private onProgress(id: string, p: SyncProgress): void {
    const l = this.live.get(id);
    if (!l) return;
    l.progress = p;
    // 파일 수백 개짜리 apply 가 IPC 를 도배하지 않게 방송은 간격을 둔다.
    // 단 마지막(완료) 표시는 항상 내보내 done/total 이 어긋난 채 남지 않게.
    const now = Date.now();
    const isFinal = p.phase === 'apply' && p.total > 0 && p.done >= p.total;
    if (isFinal || now - this.lastProgressEmit >= PROGRESS_EMIT_MS) {
      this.lastProgressEmit = now;
      this.emit();
    }
  }

  /**
   * 보험 주기 — 놓친 알림(WS 드롭 등)의 안전망. **파일 인덱스 기반**이다:
   *
   *   1. 벌크 probe 한 번으로 전 페어의 원본 seq 를 읽고,
   *   2. seq 가 내 커서와 **다른** 페어만 큐에 세운다 (같으면 서버 쪽 변경
   *      없음 — 로컬 변경은 watcher 가 따로 잡는다),
   *   3. 단 fullSweepMs 가 지난 페어는 probe 결과와 무관하게 정식 사이클을
   *      돈다 — probe 는 파드 로컬 미발행 산출물을 못 보기 때문이다.
   *
   * probe 미지원(구서버)·실패면 전수 큐잉으로 폴백한다 — 그래도 큐라서
   * 동시 요청은 concurrency 개뿐이다. 연속 실패 중인 페어는 지수 백오프
   * (1분×2^n, 상한 30분) 동안 건너뛴다.
   */
  async insuranceTick(): Promise<void> {
    if (this.stopped || this.live.size === 0) return;
    const now = Date.now();
    const sweepMs = this.deps.fullSweepMs ?? DEFAULT_FULL_SWEEP_MS;
    const eligible = [...this.live.values()].filter((l) => now >= l.nextRetryAt);
    if (eligible.length === 0) return;

    let seqs: Record<string, number> | null = null;
    if (this.deps.indexSeqs) {
      try {
        seqs = await this.deps.indexSeqs(eligible.map((l) => l.target.workflowId));
      } catch (e) {
        // 구서버(404)·일시 장애 — 전수 폴백. 로그는 한 줄이면 충분하다.
        diag('local-sync', `인덱스 probe 실패 (전수 폴백): ${(e as Error).message}`);
      }
    }
    for (const l of eligible) {
      const id = l.target.workflowId;
      if (seqs) {
        const cursor = l.pair.cursor;
        const seq = seqs[id];
        const sweepDue =
          sweepMs > 0 && (!l.lastSyncAt || now - l.lastSyncAt >= sweepMs);
        // cursor === null: 이 프로세스에서 아직 안 돌았다 — 오프라인 로컬
        // 변경 스캔이 필요하므로 건너뛰지 않는다. seq === undefined: 서버가
        // 이 owner 를 답하지 않았다(권한/미지원) — 모르는 것은 돌린다.
        if (cursor !== null && seq !== undefined && seq === cursor && !sweepDue) continue;
      }
      void this.enqueue(id);
    }
  }

  /** 곧 동기화 — 브리지 실행(_Exec/_WriteBytes)이 파일을 만졌을 때 부른다.
   *  워처보다 빠르게, 그러나 연타는 디바운스로 한 사이클에 합쳐진다. */
  poke(workflowId: string): void {
    this.schedule(workflowId, 800);
  }

  /**
   * 지금 동기화 — id 없으면 전부 **큐에 세운다** (동시 실행이 아니라 순차).
   * 특정 id 지정은 크리티컬 경로(사용자 클릭·턴 시작/종료)이므로 맨 앞에
   * 끼어든다.
   */
  async syncNow(workflowId?: string): Promise<void> {
    if (workflowId) {
      const ok = await this.enqueue(workflowId, { front: true });
      if (!ok) {
        const err = this.live.get(workflowId)?.lastError;
        if (err) throw new Error(err);
      }
      return;
    }
    await Promise.all([...this.live.keys()].map((id) => this.enqueue(id)));
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
    return this.live.get(workflowId)?.state === 'syncing';
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
      agents: [...this.live.values()].map((l) => {
        const pos = l.state === 'queued' ? this.queue.indexOf(l.target.workflowId) : -1;
        return {
          workflowId: l.target.workflowId,
          label: l.target.label,
          folder: l.target.folder,
          dir: l.dir,
          state: l.state,
          queuePosition: pos >= 0 ? pos + 1 : undefined,
          progress: l.state === 'syncing' ? l.progress : undefined,
          syncing: l.state === 'syncing',
          lastSyncAt: l.lastSyncAt,
          lastError: l.lastError,
          last: l.last,
        };
      }),
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
    if (this.insuranceTimer) {
      clearInterval(this.insuranceTimer);
      this.insuranceTimer = null;
    }
    for (const id of [...this.live.keys()]) this.teardown(id);
    this.emit();
  }
}
