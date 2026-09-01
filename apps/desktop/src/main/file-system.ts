/**
 * 파일 시스템 — XGen 저장소들을 이 PC 의 **실제 폴더**로 비추는 단순한 창.
 *
 * 철학 (파일 저장소 = 정보 검색 노드 재편의 로컬 반쪽):
 *   · 에이전트는 자기 워크스페이스를 갖는다 — 서버에서 항상 실행되고 있고,
 *     이 앱의 토글은 그것을 **로컬 폴더로 볼 수 있느냐**만 정한다.
 *   · 클라우드는 클라우드일 뿐이다 — 에이전트를 클라우드에 "연결"한다는
 *     개념(cloud links / 가상 드라이브)은 폐기됐다.
 *
 * 두 개의 독립 토글 (기본 **모두 OFF**, 계정별 저장):
 *   [XGen 클라우드 연결]      → <dataRoot>/cloud            ↔ user:<id> 저장소
 *   [Agent Workspace 연결]   → <dataRoot>/agent_workspace/<에이전트>/ ↔ 각 워크스페이스
 *
 * 동기화 자체는 검증된 3-way 리컨실러(SyncPair/LocalSyncManager)를 그대로
 * 쓴다 — 이 모듈은 "무엇을 어디로" 만 정하는 오케스트레이션이다.
 *
 * Agent Workspace 대상 = **이 계정의 에이전트 전부** (서버 목록). 켜면 전부
 * 동기화되고, 꺼도 서버 브리지(ConnectorLocalSandbox)가 요구하는 온디맨드
 * 페어(ensurePair)는 계속 동작한다 — 커넥터 세션 실행은 토글과 무관하다.
 */
import { join } from 'path';
import { diag } from './diag-log';
import {
  LocalSyncManager,
  type LocalSyncDeps,
  type SyncProgress,
  type SyncQueueState,
  type SyncTarget,
} from './local-sync-manager';
import { SyncScheduler } from './sync-scheduler';
import { pickFolderName } from './local-sync-folder';

/** 계정 키 — `${serverUrl}|${userId}` (예전 workspace.ts 의 accountKey 승계). */
export function accountKey(serverUrl: string, userId: string | number): string {
  return `${serverUrl}|${userId}`;
}

/** 계정별 파일 시스템 설정 (영속). 기본은 둘 다 OFF. */
export interface FileSystemPersistConfig {
  cloudSync?: boolean;
  agentSync?: boolean;
}

export interface FileSystemAgent {
  workflowId: string;
  label: string;
}

export interface FileSystemTargetStatus {
  workflowId: string;
  label: string;
  folder: string;
  /** 로컬 절대 경로 — 페어가 살아 있을 때만. */
  dir: string | null;
  synced: boolean;
  /** 큐 상태 — 페어가 없으면 'idle'. syncing(boolean)은 하위호환 파생값. */
  state: SyncQueueState;
  /** 대기열 순번 (state === 'queued', 1-기반). */
  queuePosition?: number;
  /** 현재 사이클 진행률 (state === 'syncing'). */
  progress?: SyncProgress;
  syncing: boolean;
  lastSyncAt?: number;
  lastError?: string;
}

export interface FileSystemStatus {
  loggedIn: boolean;
  dataRoot: string;
  cloud: {
    enabled: boolean;
    dir: string;
    /** 서버 쪽 소유 키 ('user:<id>') — 탐색기가 서버 트리를 읽을 때 쓴다. */
    owner: string | null;
    synced: boolean;
    state: SyncQueueState;
    queuePosition?: number;
    progress?: SyncProgress;
    syncing: boolean;
    lastSyncAt?: number;
    lastError?: string;
  };
  agents: {
    enabled: boolean;
    root: string;
    /** 이 계정의 에이전트 전부 — 토글이 꺼져 있어도 목록은 항상 보인다. */
    list: FileSystemTargetStatus[];
  };
}

export interface FileSystemDeps {
  /** 통합 데이터 루트 (~/xgen-dex). */
  dataRoot: () => string;
  loggedIn: () => boolean;
  /** 현재 로그인 사용자 id — 클라우드 소유 키의 재료. */
  userId: () => string | null;
  /** 계정별 설정 읽기/쓰기. */
  config: () => FileSystemPersistConfig;
  persist: (next: FileSystemPersistConfig) => void;
  /** 이 계정의 에이전트 전부 (서버). */
  listAgents: () => Promise<FileSystemAgent[]>;
  remoteFor: LocalSyncDeps['remoteFor'];
  presenceFor?: LocalSyncDeps['presenceFor'];
  stateDir: () => string;
  deviceName: string;
  onStatus?: (s: FileSystemStatus) => void;
  /** 벌크 인덱스 probe — LocalSyncDeps.indexSeqs 그대로 (양쪽 매니저 공용). */
  indexSeqs?: LocalSyncDeps['indexSeqs'];
  /** 테스트용 — 보험 타이머 간격. */
  intervalMs?: number;
  /** 테스트용 — 느린 전체 사이클 스윕 간격. */
  fullSweepMs?: number;
}

export const CLOUD_FOLDER = 'cloud';
export const AGENT_WORKSPACE_FOLDER = 'agent_workspace';

/** 클라우드 동기화 대상 — 토글 ON + 로그인일 때 하나. */
export function cloudTargets(userId: string | null, enabled: boolean): SyncTarget[] {
  if (!enabled || !userId) return [];
  return [{ workflowId: `user:${userId}`, label: 'XGen 클라우드', folder: CLOUD_FOLDER }];
}

/** 에이전트 동기화 대상 — 토글 ON 이면 전부, 폴더명은 라벨 기반 중복 제거. */
export function agentTargets(agents: FileSystemAgent[], enabled: boolean): SyncTarget[] {
  if (!enabled) return [];
  const taken = new Set<string>();
  const out: SyncTarget[] = [];
  for (const a of agents) {
    const folder = pickFolderName(a.workflowId, a.label || a.workflowId, taken);
    taken.add(folder);
    out.push({ workflowId: a.workflowId, label: a.label || a.workflowId, folder });
  }
  return out;
}

export class FileSystemController {
  private cloud: LocalSyncManager;
  private agents: LocalSyncManager;
  private agentCache: FileSystemAgent[] = [];
  private refreshing: Promise<void> | null = null;
  /** 클라우드와 Agent Workspace 가 **하나의 대기열**을 공유한다 — 계정
   *  전체에서 동시에 도는 사이클은 1개다 (두 토글이 병렬로 서버를 두드리는
   *  일이 없다). */
  private scheduler = new SyncScheduler(1);

  constructor(private deps: FileSystemDeps) {
    const common = {
      scheduler: this.scheduler,
      loggedIn: deps.loggedIn,
      remoteFor: deps.remoteFor,
      presenceFor: deps.presenceFor,
      stateDir: deps.stateDir,
      deviceName: deps.deviceName,
      indexSeqs: deps.indexSeqs,
      intervalMs: deps.intervalMs,
      fullSweepMs: deps.fullSweepMs,
    };
    this.cloud = new LocalSyncManager({
      ...common,
      config: () => ({
        // 게이트는 대상 목록이 진다 — enabled 는 항상 true 라야 토글 OFF 때도
        // 페어 걷기(reconcile)가 정상 동작한다.
        enabled: true,
        root: deps.dataRoot(),
        targets: cloudTargets(deps.userId(), this.cfg().cloudSync === true),
      }),
      onStatus: () => this.emit(),
    });
    this.agents = new LocalSyncManager({
      ...common,
      config: () => ({
        enabled: true,
        root: join(deps.dataRoot(), AGENT_WORKSPACE_FOLDER),
        targets: agentTargets(this.agentCache, this.cfg().agentSync === true),
      }),
      onStatus: () => this.emit(),
    });
  }

  private cfg(): FileSystemPersistConfig {
    return this.deps.config() ?? {};
  }

  /** 로그인/토글/명시 새로고침 때 서버 에이전트 목록을 다시 읽는다. */
  async refreshAgents(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        if (!this.deps.loggedIn()) {
          this.agentCache = [];
          return;
        }
        this.agentCache = await this.deps.listAgents();
      } catch (e) {
        diag('file-system', `에이전트 목록 조회 실패: ${(e as Error).message}`);
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
    this.reconcile();
  }

  reconcile(): void {
    this.cloud.reconcile();
    this.agents.reconcile();
    this.emit();
  }

  async setCloudSync(on: boolean): Promise<void> {
    this.deps.persist({ ...this.cfg(), cloudSync: !!on });
    this.reconcile();
    if (on) await this.cloud.syncNow().catch(() => undefined);
  }

  async setAgentSync(on: boolean): Promise<void> {
    this.deps.persist({ ...this.cfg(), agentSync: !!on });
    if (on) await this.refreshAgents();
    this.reconcile();
    if (on) await this.agents.syncNow().catch(() => undefined);
  }

  async syncNow(workflowId?: string): Promise<void> {
    if (!workflowId) {
      await Promise.all([this.cloud.syncNow(), this.agents.syncNow()]);
      return;
    }
    if (workflowId.startsWith('user:')) await this.cloud.syncNow(workflowId);
    else await this.agents.syncNow(workflowId);
  }

  /** 브리지(ConnectorLocalSandbox)용 — 토글과 무관한 온디맨드 페어. */
  ensurePair(workflowId: string, label: string): string | null {
    return this.agents.ensurePair(workflowId, label);
  }

  ensureSynced(workflowId: string, label: string) {
    return this.agents.ensureSynced(workflowId, label);
  }

  flushSync(workflowId: string): Promise<boolean> {
    return this.agents.flushSync(workflowId);
  }

  poke(workflowId: string): void {
    this.agents.poke(workflowId);
  }

  /** 클라우드 로컬 폴더 — 토글 ON + 페어 살아 있을 때만. 브리지 /cloud 용. */
  cloudDir(): string | null {
    const uid = this.deps.userId();
    if (!uid || this.cfg().cloudSync !== true) return null;
    return this.cloud.dirFor(`user:${uid}`);
  }

  /** 탐색기/열기 — 대상의 로컬 폴더 (cloud 는 workflowId 'user:…'). */
  dirFor(workflowId: string): string | null {
    return workflowId.startsWith('user:')
      ? this.cloud.dirFor(workflowId)
      : this.agents.dirFor(workflowId);
  }

  status(): FileSystemStatus {
    const cfg = this.cfg();
    const root = this.deps.dataRoot();
    const uid = this.deps.userId();
    const owner = uid ? `user:${uid}` : null;
    const cloudAgents = this.cloud.status().agents;
    const cloudLive = owner ? cloudAgents.find((a) => a.workflowId === owner) : undefined;
    const agentStatus = this.agents.status().agents;
    const byId = new Map(agentStatus.map((a) => [a.workflowId, a]));
    const list: FileSystemTargetStatus[] = this.agentCache.map((a) => {
      const live = byId.get(a.workflowId);
      return {
        workflowId: a.workflowId,
        label: a.label,
        folder: live?.folder ?? '',
        dir: live?.dir ?? null,
        synced: !!live,
        state: live?.state ?? 'idle',
        queuePosition: live?.queuePosition,
        progress: live?.progress,
        syncing: live?.syncing ?? false,
        lastSyncAt: live?.lastSyncAt,
        lastError: live?.lastError,
      };
    });
    // 온디맨드 페어(브리지)가 목록 밖 에이전트를 세웠으면 그것도 보인다.
    for (const live of agentStatus) {
      if (!this.agentCache.some((a) => a.workflowId === live.workflowId)) {
        list.push({
          workflowId: live.workflowId,
          label: live.label,
          folder: live.folder,
          dir: live.dir,
          synced: true,
          state: live.state,
          queuePosition: live.queuePosition,
          progress: live.progress,
          syncing: live.syncing,
          lastSyncAt: live.lastSyncAt,
          lastError: live.lastError,
        });
      }
    }
    return {
      loggedIn: this.deps.loggedIn(),
      dataRoot: root,
      cloud: {
        enabled: cfg.cloudSync === true,
        dir: join(root, CLOUD_FOLDER),
        owner,
        synced: !!cloudLive,
        state: cloudLive?.state ?? 'idle',
        queuePosition: cloudLive?.queuePosition,
        progress: cloudLive?.progress,
        syncing: cloudLive?.syncing ?? false,
        lastSyncAt: cloudLive?.lastSyncAt,
        lastError: cloudLive?.lastError,
      },
      agents: {
        enabled: cfg.agentSync === true,
        root: join(root, AGENT_WORKSPACE_FOLDER),
        list,
      },
    };
  }

  private emit(): void {
    this.deps.onStatus?.(this.status());
  }

  stop(): void {
    this.cloud.stop();
    this.agents.stop();
  }
}
