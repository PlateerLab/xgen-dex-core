/**
 * 로컬 동기화 **판정기** — 순수 함수만 있다 (IO 없음, 전부 단위 테스트).
 *
 * 커넥터로 접속한 에이전트는 서버 sandbox 대신 **사용자 PC 의 폴더**를
 * 워크스페이스로 쓴다. 그 폴더와 서버의 에이전트 워크스페이스 저장소(=sandbox
 * 가 attach/publish 하는 바로 그 인덱스)를 여기서 맞춘다.
 *
 * ── 왜 3-way 인가 ────────────────────────────────────────────────────
 *
 * 2026-08-06 의 "무한 부활" 사고: 레거시 엔진은 자기 인덱스만 보고 로컬에
 * 있는 파일을 서버로 다시 올렸다 — 사용자가 서버에서 지운 파일이 계속
 * 되살아났다. 원인은 **기준(base)이 없어서** "로컬에 있다"와 "로컬에서 새로
 * 생겼다/서버에서 지워졌다"를 구분하지 못한 것이다.
 *
 * 그래서 모든 판정은 세 값의 비교다:
 *
 *     base   — 지난 동기화가 끝났을 때 양쪽이 합의한 상태 (로컬 DB)
 *     local  — 지금 디스크를 스캔한 결과
 *     remote — 서버 인덱스 (changes 델타 또는 전체 스냅숏)
 *
 * 한쪽만 변했으면 그쪽을 따르고, 양쪽이 다르게 변했으면 **데이터를 잃지 않는
 * 쪽**(서버 채택 + 로컬을 충돌 사본으로 보존)을 고른다.
 */

/** 파일 하나의 지문. sha 가 같으면 같은 내용이다. */
export interface FileSig {
  sha: string;
  size: number;
  /** epoch ms — 재해시를 피하는 힌트일 뿐, 판정 근거가 아니다. */
  mtimeMs: number;
}

/** base 스냅숏: 경로 → 지문. 디렉터리는 담지 않는다 (파일이 곧 구조다). */
export type BaseState = Map<string, FileSig>;

/** 로컬 스캔 결과. */
export type LocalState = Map<string, FileSig>;

/** 서버 상태: 경로 → sha (삭제는 아예 없음이 아니라 tombstone 로 온다). */
export interface RemoteFile {
  sha: string;
  size: number;
  mtimeMs: number;
}
export type RemoteState = Map<string, RemoteFile>;

export type SyncAction =
  | { kind: 'download'; path: string; sha: string }
  | { kind: 'delete-local'; path: string }
  | { kind: 'upload'; path: string; baseSha: string }
  | { kind: 'delete-remote'; path: string; baseSha: string }
  | {
      /** 양쪽이 다르게 변했다 — 서버를 채택하고 로컬을 충돌 사본으로 남긴다. */
      kind: 'conflict';
      path: string;
      remoteSha: string;
    }
  | {
      /** 내용이 이미 같다 — 전송 없이 base 만 맞춘다. */
      kind: 'adopt';
      path: string;
      sha: string;
      size: number;
      mtimeMs: number;
    }
  | { kind: 'forget'; path: string };

/**
 * 3-way 판정. remote 는 **전체 상태**여야 한다 (델타는 호출 전에 base 위에
 * 얹어 전체로 만든다 — 엔진의 몫).
 */
export function planSync(base: BaseState, local: LocalState, remote: RemoteState): SyncAction[] {
  const out: SyncAction[] = [];
  const paths = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const l = local.get(path);
    const r = remote.get(path);

    const localChanged = !!l && (!b || l.sha !== b.sha);
    const localDeleted = !l && !!b;
    const remoteChanged = !!r && (!b || r.sha !== b.sha);
    const remoteDeleted = !r && !!b;

    if (l && r && l.sha === r.sha) {
      // 내용 합의 — base 가 뒤처졌으면 맞춘다.
      if (!b || b.sha !== l.sha)
        out.push({ kind: 'adopt', path, sha: l.sha, size: l.size, mtimeMs: l.mtimeMs });
      continue;
    }

    if (localChanged && remoteChanged) {
      out.push({ kind: 'conflict', path, remoteSha: r!.sha });
      continue;
    }
    if (localChanged && remoteDeleted) {
      // 서버가 지운 뒤 로컬이 또 고쳤다 — 로컬을 새 파일로 올린다 (잃지 않는다).
      out.push({ kind: 'upload', path, baseSha: '' });
      continue;
    }
    if (localDeleted && remoteChanged) {
      // 로컬이 지운 뒤 서버가 또 고쳤다 — 서버 것을 되받는다 (잃지 않는다).
      out.push({ kind: 'download', path, sha: r!.sha });
      continue;
    }

    if (remoteChanged) {
      out.push({ kind: 'download', path, sha: r!.sha });
      continue;
    }
    if (remoteDeleted) {
      if (l) out.push({ kind: 'delete-local', path });
      else out.push({ kind: 'forget', path });
      continue;
    }
    if (localChanged) {
      out.push({ kind: 'upload', path, baseSha: b?.sha ?? '' });
      continue;
    }
    if (localDeleted) {
      if (r) out.push({ kind: 'delete-remote', path, baseSha: b!.sha });
      else out.push({ kind: 'forget', path });
      continue;
    }
    // 삼자 모두 같은 sha — 할 일 없음. (b·l·r 모두 없음은 도달 불가)
  }
  return out;
}

/**
 * 서버 델타를 base 위에 얹어 **전체 remote 상태**를 만든다.
 *
 * changes(since) 는 그 커서 이후의 변경만 준다 — 안 온 경로는 "그대로"라는
 * 뜻이므로 base 의 지문이 곧 서버의 지문이다. (커서가 프룬보다 뒤처진
 * stale_cursor 는 이 가정이 깨지므로 엔진이 전체 스냅숏으로 다시 부른다.)
 */
export function overlayRemote(
  base: BaseState,
  delta: Array<{
    path: string;
    is_dir: boolean;
    size: number;
    mtime_ns: number;
    sha256: string;
    deleted: boolean;
  }>,
): RemoteState {
  const remote: RemoteState = new Map();
  for (const [path, sig] of base)
    remote.set(path, { sha: sig.sha, size: sig.size, mtimeMs: sig.mtimeMs });
  for (const c of delta) {
    if (c.is_dir) continue; // 디렉터리는 파일 경로에서 유도한다
    if (c.deleted) remote.delete(c.path);
    else
      remote.set(c.path, {
        sha: c.sha256,
        size: c.size,
        mtimeMs: Math.floor((c.mtime_ns ?? 0) / 1e6),
      });
  }
  return remote;
}

/** 전체 스냅숏(since=0) → remote 상태. tombstone 이 섞여 있어도 안전하다. */
export function snapshotRemote(
  delta: Array<{
    path: string;
    is_dir: boolean;
    size: number;
    mtime_ns: number;
    sha256: string;
    deleted: boolean;
  }>,
): RemoteState {
  return overlayRemote(new Map(), delta);
}

/**
 * 동기화에서 제외할 경로인가.
 *
 * 서버 인덱스가 무시하는 패턴(sync_ignores)의 **상위집합**이어야 한다 —
 * 서버만 무시하는 패턴이 로컬에 있으면 "서버에 없으니 지워야 한다"로 읽혀
 * 로컬 원본이 지워진다 (workspace_sync.py 의 데이터 손실 경로). 그래서
 * sandbox 의 SKIP_DIRS 를 기본으로 깔고, 서버가 준 패턴을 더한다.
 */
const DEFAULT_SKIP_SEGMENTS = new Set([
  '.git',
  '__pycache__',
  '.venv',
  'node_modules',
  '.xgeny-session',
  '.DS_Store',
  'Thumbs.db',
]);

export function isIgnoredPath(path: string, serverIgnores: string[] = []): boolean {
  const segs = path.split('/').filter(Boolean);
  if (segs.some((s) => DEFAULT_SKIP_SEGMENTS.has(s))) return true;
  for (const pat of serverIgnores) {
    if (matchIgnore(path, segs, pat)) return true;
  }
  return false;
}

/**
 * gitignore 풍 패턴의 **보수적** 부분집합: `이름`, `이름/`, `*.ext`, `dir/**`.
 * 못 알아보는 패턴은 무시가 아니라 **동기화 대상**으로 남긴다 — 과잉 무시가
 * 과소 무시보다 낫다고 착각하기 쉽지만, 여기서는 반대다: 로컬만 무시하면
 * 손실은 없고 (서버 상위집합 원칙), 서버만 무시하면 손실이 난다.
 */
function matchIgnore(path: string, segs: string[], pattern: string): boolean {
  const pat = pattern.trim().replace(/\/+$/, '');
  if (!pat || pat.startsWith('#')) return false;
  if (pat.endsWith('/**')) {
    const head = pat.slice(0, -3);
    return path === head || path.startsWith(`${head}/`);
  }
  if (pat.startsWith('*.')) {
    const ext = pat.slice(1);
    return path.endsWith(ext);
  }
  if (!pat.includes('/') && !pat.includes('*')) return segs.includes(pat);
  return path === pat || path.startsWith(`${pat}/`);
}

/** 충돌 사본 이름 — `보고서.md` → `보고서 (충돌 HRJANG-PC 0821-1432).md`. */
export function conflictCopyName(path: string, deviceName: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const device = deviceName.replace(/[/\\:*?"<>|]/g, '-').trim() || 'PC';
  return `${dir}${stem} (충돌 ${device} ${stamp})${ext}`;
}

/** 상대 경로 검증 — 동기화 폴더 밖을 절대 가리킬 수 없어야 한다. */
export function isSafeRelPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  const segs = path.split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}
