/**
 * 탐색기(사이드바) 순수 모델 — React 없이 단위 테스트되는 부분.
 *
 * 탐색기는 두 종류의 저장소를 섹션으로 보여준다:
 *
 *     [XgenCloud]            ← 가상 드라이브 = 클라우드 루트 (경로 '/')
 *       파일 트리… (서버 스트리밍)
 *     [<에이전트 이름>]        ← 로컬 동기화 폴더 (<기본 작업 폴더>/<폴더명>)
 *       파일 트리… (로컬 실파일 — sandbox 워크스페이스와 동기화됨)
 *
 * 클라우드는 드라이브 백엔드(workspace.list)로, 에이전트는 로컬 fs(sync.list)로
 * 읽는다 — 에이전트 워크스페이스의 진실은 이제 사용자 PC 의 폴더다.
 */

export interface ExplorerSyncAgentLike {
  workflowId: string;
  label: string;
  folder: string;
  dir: string;
  syncing: boolean;
  lastError?: string;
}

export interface ExplorerSection {
  /** 접힘 상태의 키 — 안정적이어야 한다. */
  id: string;
  /** 섹션 헤더에 보이는 이름. */
  title: string;
  kind: 'cloud' | 'agent';
  /** cloud: 백엔드 경로('/'). agent: 로컬 상대 경로 기준(''). */
  path: string;
  /** agent 전용. */
  workflowId?: string;
  /** agent 전용 — 로컬 절대 경로 (툴팁·OS 열기). */
  dir?: string;
  syncing?: boolean;
  lastError?: string;
}

/** 드라이브 루트 — 곧 클라우드다. */
export const CLOUD_ROOT = '/';

/** 클라우드 + 동기화 중인 에이전트 → 섹션 목록. XgenCloud 가 항상 먼저다. */
export function sectionsFor(syncAgents: ExplorerSyncAgentLike[] | null): ExplorerSection[] {
  const out: ExplorerSection[] = [
    { id: 'cloud', title: 'XgenCloud', kind: 'cloud', path: CLOUD_ROOT },
  ];
  for (const a of syncAgents ?? []) {
    out.push({
      id: `agent:${a.workflowId}`,
      title: a.label || a.folder,
      kind: 'agent',
      path: '',
      workflowId: a.workflowId,
      dir: a.dir,
      syncing: a.syncing,
      lastError: a.lastError,
    });
  }
  return out;
}

/** 부모 경로 + 자식 이름 → 자식 경로. 드라이브('/')와 상대('') 기준 모두 안전. */
export function childPath(parent: string, name: string): string {
  if (parent === '/') return `/${name}`;
  if (parent === '') return name;
  return `${parent}/${name}`;
}

export interface ExplorerEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
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
