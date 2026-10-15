/**
 * 소스 제어 — 서버(샌드박스의 git) 응답의 모양과, 화면이 쓰는 파생 값.
 *
 * 경로 규칙: git 응답의 경로는 **저장소 기준**이다. 탐색기·편집기는 workspace 기준이므로
 * `repoPath + '/' + path` 로 옮겨 쓴다(루트 저장소면 그대로).
 */
import { join } from './paths';

export type GitFileStatus =
  | 'modified'
  | 'type_changed'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked';

export interface GitChange {
  path: string;
  status: GitFileStatus;
  orig?: string;
  xy?: string;
}

export interface GitRemote {
  name: string;
  url?: string;
  push_url?: string;
  host: string;
  path: string;
  protocol: string;
  web_url: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'gitea' | 'git';
}

export interface GitStatus {
  repo: string;
  branch: {
    head: string;
    oid: string;
    upstream: string;
    ahead: number;
    behind: number;
    detached?: boolean;
  };
  state: '' | 'merging' | 'rebasing' | 'cherry_picking';
  staged: GitChange[];
  changes: GitChange[];
  untracked: GitChange[];
  conflicts: GitChange[];
  stash_count: number;
  remotes: GitRemote[];
  identity: { name: string; email: string };
  last_commit: { hash: string; subject: string; author: string; time: number } | null;
}

export interface GitCredential {
  protocol: string;
  host: string;
  username: string;
  provider: GitRemote['provider'];
}

export interface GitAccount {
  identity: { name: string; email: string };
  credentials: { stored: GitCredential[]; helpers: string[] };
}

export interface GitBranch {
  name: string;
  oid: string;
  upstream: string;
  current: boolean;
  time: number;
  subject: string;
}

export interface GitBranches {
  local: GitBranch[];
  remote: GitBranch[];
  tags: GitBranch[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  time: number;
  parents: string[];
  refs: string;
  subject: string;
}

export const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  type_changed: 'T',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  unmerged: '!',
  untracked: 'U',
};

export const STATUS_LABEL: Record<GitFileStatus, string> = {
  modified: '수정됨',
  type_changed: '종류 바뀜',
  added: '추가됨',
  deleted: '삭제됨',
  renamed: '이름 바뀜',
  copied: '복사됨',
  unmerged: '충돌',
  untracked: '추적 안 됨',
};

export const PROVIDER_LABEL: Record<GitRemote['provider'], string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
  gitea: 'Gitea',
  git: 'Git',
};

/** workspace 기준 경로로. */
export function toWorkspacePath(repo: string, path: string): string {
  return repo ? join(repo, path) : path;
}

/** 탐색기에 칠할 것 — 파일마다 가장 무거운 상태 하나, 폴더는 "안에 바뀐 것이 있다". */
export interface Decoration {
  status: GitFileStatus;
  letter: string;
  tooltip: string;
}

const WEIGHT: Record<GitFileStatus, number> = {
  unmerged: 6,
  deleted: 5,
  modified: 4,
  type_changed: 4,
  renamed: 3,
  copied: 3,
  added: 2,
  untracked: 1,
};

export function decorations(statuses: GitStatus[]): {
  files: Map<string, Decoration>;
  dirs: Map<string, GitFileStatus>;
} {
  const files = new Map<string, Decoration>();
  const dirs = new Map<string, GitFileStatus>();
  const put = (repo: string, c: GitChange) => {
    const path = toWorkspacePath(repo, c.path.replace(/\/$/, ''));
    const prev = files.get(path);
    if (!prev || WEIGHT[c.status] > WEIGHT[prev.status]) {
      files.set(path, { status: c.status, letter: STATUS_LETTER[c.status], tooltip: STATUS_LABEL[c.status] });
    }
    let d = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    while (d) {
      const cur = dirs.get(d);
      if (!cur || WEIGHT[c.status] > WEIGHT[cur]) dirs.set(d, c.status);
      d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    }
  };
  for (const s of statuses) {
    for (const c of s.conflicts) put(s.repo, c);
    for (const c of s.changes) put(s.repo, c);
    for (const c of s.staged) put(s.repo, c);
    for (const c of s.untracked) put(s.repo, c);
  }
  return { files, dirs };
}

export function changeCount(s: GitStatus | null | undefined): number {
  if (!s) return 0;
  const set = new Set<string>();
  for (const c of [...s.conflicts, ...s.staged, ...s.changes, ...s.untracked]) set.add(c.path);
  return set.size;
}

/** 실패 코드 → 화면 문구(한 문장, 해결 방법 포함). */
export function gitErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case 'auth':
      return '원격 저장소에 로그인할 수 없습니다. 소스 제어의 계정에서 토큰을 등록하세요.';
    case 'identity':
      return '커밋할 이름과 메일이 없습니다. 소스 제어의 계정에서 설정하세요.';
    case 'conflict':
      return '충돌이 생겼습니다. 충돌한 파일을 고친 뒤 스테이지하고 커밋하세요.';
    case 'no_upstream':
      return '이 브랜치는 원격과 연결되어 있지 않습니다. 먼저 푸시하세요.';
    case 'no_remote':
      return '원격 저장소가 없습니다. 원격을 추가하세요.';
    case 'network':
      return '원격 저장소에 연결할 수 없습니다. 주소와 네트워크를 확인하세요.';
    case 'not_repo':
      return 'git 저장소가 아닙니다.';
    case 'timeout':
      return '시간이 너무 오래 걸려 멈췄습니다.';
    case 'no_git':
      return '샌드박스에 git 이 없습니다.';
    default:
      return fallback || 'git 작업을 마치지 못했습니다.';
  }
}

export function relativeTime(epochSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.round(now / 1000 - epochSeconds));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}달 전`;
  return `${Math.floor(s / (86400 * 365))}년 전`;
}
