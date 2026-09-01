/**
 * 탐색기(사이드바) 순수 모델 — React 없이 단위 테스트되는 부분.
 *
 * 탐색기는 XGen 저장소들을 섹션으로 보여준다:
 *
 *     [XgenCloud]            ← 사용자의 클라우드 저장소
 *     [<에이전트 이름>]        ← 각 에이전트의 자기 워크스페이스 (**전부** — 연결
 *                              여부와 무관하게 보인다)
 *
 * 읽기 경로는 동기화 여부가 정한다:
 *   · 동기화 ON  → 로컬 실파일 (fileSystem.list — <dataRoot>/cloud,
 *                  <dataRoot>/agent_workspace/<이름>)
 *   · 동기화 OFF → 서버 평면 트리 (agentData.workspaceTree — 읽기 전용 관측)
 */
import type { FileSystemStatusLike } from '../../../preload/index';

export interface ExplorerSection {
  /** 접힘 상태의 키 — 안정적이어야 한다. */
  id: string;
  /** 섹션 헤더에 보이는 이름. */
  title: string;
  kind: 'cloud' | 'agent';
  /** 서버 소유 키 — cloud 는 'user:<id>', agent 는 workflowId. */
  workflowId: string;
  /** 로컬로 동기화되어 있는가 (읽기 경로 + OS 열기 가능 여부). */
  synced: boolean;
  /** 로컬 절대 경로 (동기화 시). */
  dir?: string | null;
  syncing?: boolean;
  lastError?: string;
}

/** 클라우드 + 모든 에이전트 → 섹션 목록. XgenCloud 가 항상 먼저다. */
export function sectionsFor(status: FileSystemStatusLike | null): ExplorerSection[] {
  if (!status) return [];
  const out: ExplorerSection[] = [];
  if (status.cloud.owner) {
    out.push({
      id: 'cloud',
      title: '파일 저장소',
      kind: 'cloud',
      workflowId: status.cloud.owner,
      synced: status.cloud.enabled && status.cloud.synced,
      dir: status.cloud.enabled ? status.cloud.dir : null,
      syncing: status.cloud.syncing,
      lastError: status.cloud.lastError,
    });
  }
  for (const a of status.agents.list) {
    out.push({
      id: `agent:${a.workflowId}`,
      title: a.label,
      kind: 'agent',
      workflowId: a.workflowId,
      synced: a.synced,
      dir: a.dir,
      syncing: a.syncing,
      lastError: a.lastError,
    });
  }
  return out;
}

export interface ExplorerEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** 서버 평면 트리 노드 (agentData.workspaceTree 의 WsNode 미러). */
export interface RemoteNodeLike {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number | null;
  modified_at?: string;
}

/**
 * 서버 평면 목록 → 한 디렉터리의 직계 자식.
 * 평면 목록에 중간 폴더 항목이 없어도(파일만 나열) 경로에서 폴더를 유도한다.
 */
export function entriesAt(nodes: RemoteNodeLike[], rel: string): ExplorerEntry[] {
  const prefix = rel ? `${rel.replace(/\/+$/, '')}/` : '';
  const dirs = new Map<string, ExplorerEntry>();
  const files: ExplorerEntry[] = [];
  for (const n of nodes) {
    const p = String(n.path ?? '').replace(/^\/+/, '');
    if (prefix && !p.startsWith(prefix)) continue;
    const restPath = p.slice(prefix.length);
    if (!restPath) continue;
    const seg = restPath.split('/')[0];
    const isLeaf = !restPath.includes('/');
    if (isLeaf && !n.is_dir) {
      files.push({
        name: n.name || seg,
        isDir: false,
        size: Number(n.size ?? 0) || 0,
        mtime: n.modified_at ? Date.parse(n.modified_at) || 0 : 0,
      });
    } else if (!dirs.has(seg)) {
      dirs.set(seg, { name: seg, isDir: true, size: 0, mtime: 0 });
    }
  }
  return [...dirs.values(), ...files];
}

/** 부모 경로 + 자식 이름 → 자식 경로 (상대 '' 기준). */
export function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/** 탐색기 정렬 — 폴더 먼저, 그 다음 이름(한국어 로케일). */
export function sortEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'ko');
  });
}

/** 파일 크기 표시 — 목록 행 우측 미터. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}

/** 마지막 동기화 시각 표시. */
export function syncedAgo(lastSyncAt: number | undefined, now: number): string {
  if (!lastSyncAt) return '';
  const s = Math.floor((now - lastSyncAt) / 1000);
  if (s < 5) return '방금 동기화';
  if (s < 60) return `${s}초 전 동기화`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전 동기화`;
  return `${Math.floor(m / 60)}시간 전 동기화`;
}
