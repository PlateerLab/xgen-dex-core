/**
 * 로컬 동기화 엔진 — 에이전트 워크스페이스 저장소 ⟷ 사용자 PC 폴더 하나.
 *
 * 커넥터로 접속한 에이전트는 서버 sandbox 가 아니라 **이 폴더**를 워크스페이스로
 * 쓴다 (로컬 도구의 기본 디렉토리 아래 `<에이전트 폴더>`). sandbox 는 같은
 * 인덱스(MinIO 블롭 + DB)를 attach/publish 하므로, 이 엔진이 그 인덱스와 로컬
 * 폴더를 맞추는 것만으로 웹 세션(sandbox)과 커넥터 세션(로컬)이 같은 파일을
 * 본다.
 *
 * 판정은 전부 sync-plan(순수)에 있다. 여기는 IO 만 한다:
 *   1. 서버 델타(changes?since=cursor) → base 위에 얹어 전체 remote 상태
 *   2. 로컬 스캔 (size+mtime 이 base 와 같으면 재해시 생략)
 *   3. planSync(base, local, remote) 실행
 *   4. base·cursor 저장 (원자적 쓰기)
 *
 * 안전 규칙 (전부 실기 사고에서 나온 것):
 *   · 업로드는 base_sha, 삭제도 base_sha — 서버가 그 사이 변했으면 409 로
 *     거절되고, 다음 사이클이 3-way 로 다시 판정한다 (조용한 덮어쓰기 금지).
 *   · stale_cursor 응답이면 델타를 버리고 전체 스냅숏으로 다시 겨눈다 —
 *     프룬된 tombstone 을 델타로는 볼 수 없다.
 *   · 서버 sync_ignores 는 로컬 무시의 부분집합이 되도록 그대로 얹는다.
 *   · 내려받은 파일은 서버 mtime 으로 맞춘다 — 다음 스캔이 "방금 바뀐 파일"로
 *     오판해 재해시·재업로드하지 않게.
 */
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import {
  mkdir,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
  readFile,
} from 'fs/promises';
import { dirname, join } from 'path';
import { diag } from './diag-log';
import {
  conflictCopyName,
  isIgnoredPath,
  isSafeRelPath,
  overlayRemote,
  planSync,
  snapshotRemote,
  type BaseState,
  type FileSig,
  type LocalState,
  type SyncAction,
} from './sync-plan';
import type { ChangesResponse } from './sync-protocol';

/** 엔진이 서버에 요구하는 표면 — HttpSyncTransport 가 그대로 구현한다. */
export interface SyncRemote {
  changes(since: number): Promise<ChangesResponse>;
  download(path: string, toAbs: string): Promise<void>;
  put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }>;
  del(path: string, baseSha?: string, opts?: { force?: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/**
 * 사이클 진행률 — UI 의 개별 프로그레스 표시용.
 *   check: 서버 델타 조회 중 (total 미정 = 0)
 *   scan:  로컬 폴더 스캔 중 (total 미정 = 0)
 *   apply: 파일 전송/적용 중 — done/total 이 실제 개수
 */
export interface SyncProgress {
  phase: 'check' | 'scan' | 'apply';
  done: number;
  total: number;
}

export interface SyncPairDeps {
  /** 이 페어의 서버 쪽 (에이전트 workflow_id 하나). */
  remote: SyncRemote;
  /** 로컬 폴더 (절대 경로). 없으면 만든다. */
  dir: string;
  /** base 스냅숏 저장 파일 (절대 경로). */
  statePath: string;
  /** 충돌 사본 이름에 쓸 이 PC 이름. */
  deviceName: string;
  /** 사이클 진행률 (best-effort — 실패해도 동기화는 계속). */
  onProgress?: (p: SyncProgress) => void;
  now?: () => number;
}

export interface SyncReport {
  downloaded: number;
  uploaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  /** 이번 사이클에 못 끝낸 항목 (409 경합·개별 IO 실패) — 다음 사이클이 잡는다. */
  deferred: number;
  errors: string[];
}

interface PersistedState {
  cursor: number;
  base: Record<string, FileSig>;
}

const EMPTY_REPORT = (): SyncReport => ({
  downloaded: 0,
  uploaded: 0,
  deletedLocal: 0,
  deletedRemote: 0,
  conflicts: 0,
  deferred: 0,
  errors: [],
});

function sha256File(absPath: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(absPath)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

export class SyncPair {
  private running: Promise<SyncReport> | null = null;
  private rerun = false;
  private disposed = false;

  constructor(private deps: SyncPairDeps) {}

  /**
   * 한 사이클. 이미 도는 중이면 **끝난 뒤 한 번 더** 돌도록 표시만 한다 —
   * 알림(WS·파일 워처)이 몰려도 사이클은 항상 한 줄이다.
   */
  sync(): Promise<SyncReport> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.cycle().finally(() => {
      this.running = null;
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        // 예약 재실행의 실패는 여기서 삼킨다 — 다음 트리거(워처·WS·타이머)가
        // 어차피 다시 돈다. 던지면 아무도 안 받는 거절이 된다.
        void this.sync().catch(() => undefined);
      }
    });
    return this.running;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  dispose(): void {
    this.disposed = true;
  }

  // ── 상태 파일 ────────────────────────────────────────────────────
  private async loadState(): Promise<PersistedState> {
    try {
      const raw = JSON.parse(await readFile(this.deps.statePath, 'utf8')) as PersistedState;
      if (typeof raw?.cursor === 'number' && raw.base && typeof raw.base === 'object') return raw;
    } catch {
      /* 첫 실행 또는 깨진 상태 — 스냅숏부터 다시 */
    }
    return { cursor: 0, base: {} };
  }

  private async saveState(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.deps.statePath), { recursive: true });
    const tmp = `${this.deps.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, this.deps.statePath);
  }

  // ── 로컬 스캔 ────────────────────────────────────────────────────
  private async scanLocal(base: BaseState, ignores: string[]): Promise<LocalState> {
    const out: LocalState = new Map();
    const walk = async (rel: string): Promise<void> => {
      const abs = rel ? join(this.deps.dir, rel) : this.deps.dir;
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (isIgnoredPath(childRel, ignores)) continue;
        if (e.isSymbolicLink()) continue; // sandbox 스캔과 동일 — 링크는 동기화하지 않는다
        if (e.isDirectory()) {
          await walk(childRel);
          continue;
        }
        if (!e.isFile()) continue;
        try {
          const st = await stat(join(this.deps.dir, childRel));
          const known = base.get(childRel);
          const sha =
            known && known.size === st.size && known.mtimeMs === Math.floor(st.mtimeMs)
              ? known.sha // 크기·시각이 그대로면 내용도 그대로라고 본다 (재해시 생략)
              : await sha256File(join(this.deps.dir, childRel));
          out.set(childRel, { sha, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        } catch {
          /* 스캔 도중 사라진 파일 — 다음 사이클이 본다 */
        }
      }
    };
    await walk('');
    return out;
  }

  private progress(phase: SyncProgress['phase'], done: number, total: number): void {
    try {
      this.deps.onProgress?.({ phase, done, total });
    } catch {
      /* 진행률 리스너 오류가 동기화를 막으면 안 된다 */
    }
  }

  // ── 사이클 ───────────────────────────────────────────────────────
  private async cycle(): Promise<SyncReport> {
    const report = EMPTY_REPORT();
    await mkdir(this.deps.dir, { recursive: true });
    const state = await this.loadState();
    const base: BaseState = new Map(Object.entries(state.base));

    // 1. 서버 상태.
    this.progress('check', 0, 0);
    let res = await this.deps.remote.changes(state.cursor);
    let remote;
    if (state.cursor === 0) {
      remote = snapshotRemote(res.changes);
    } else if (res.stale_cursor) {
      // 커서가 프룬을 넘겼다 — 델타에 삭제가 빠져 있다. 전체로 다시.
      res = await this.deps.remote.changes(0);
      remote = snapshotRemote(res.changes);
    } else {
      remote = overlayRemote(base, res.changes);
    }
    const ignores = res.sync_ignores ?? [];
    const maxBytes = res.max_file_bytes;

    // 무시 대상이 base 에 남아 있으면 걷어낸다 — 서버가 무시를 넓힌 경우
    // "서버에서 사라졌다"로 읽혀 로컬 원본을 지우는 사고를 막는다.
    for (const p of [...base.keys()]) {
      if (isIgnoredPath(p, ignores)) {
        base.delete(p);
        remote.delete(p);
      }
    }

    // 2. 로컬 상태.
    this.progress('scan', 0, 0);
    const local = await this.scanLocal(base, ignores);

    // 3. 실행.
    const actions = planSync(base, local, remote);
    this.progress('apply', 0, actions.length);
    let applied = 0;
    for (const a of actions) {
      if (!isSafeRelPath(a.path)) {
        report.errors.push(`경로 거부: ${a.path}`);
        this.progress('apply', ++applied, actions.length);
        continue;
      }
      try {
        await this.apply(a, base, remote, local, report, maxBytes);
      } catch (e) {
        report.deferred++;
        const msg = (e as Error).message;
        // 409 경합은 정상 흐름이다 — 다음 사이클이 3-way 로 다시 판정한다.
        if ((e as { status?: number }).status !== 409) report.errors.push(`${a.path}: ${msg}`);
      }
      this.progress('apply', ++applied, actions.length);
    }

    // 4. 커서·base 저장. (커서는 이번에 **본** 서버 상태까지만 전진한다)
    const nextState: PersistedState = { cursor: res.latest_seq ?? state.cursor, base: {} };
    for (const [p, s] of base) nextState.base[p] = s;
    await this.saveState(nextState);

    if (
      report.downloaded ||
      report.uploaded ||
      report.deletedLocal ||
      report.deletedRemote ||
      report.conflicts
    ) {
      diag(
        'local-sync',
        `동기화: ↓${report.downloaded} ↑${report.uploaded} 삭제(로컬 ${report.deletedLocal}/서버 ${report.deletedRemote}) 충돌 ${report.conflicts} 보류 ${report.deferred}`,
      );
    }
    return report;
  }

  private abs(rel: string): string {
    return join(this.deps.dir, ...rel.split('/'));
  }

  private async apply(
    a: SyncAction,
    base: BaseState,
    remote: Map<string, { sha: string; size: number; mtimeMs: number }>,
    local: LocalState,
    report: SyncReport,
    maxBytes?: number,
  ): Promise<void> {
    switch (a.kind) {
      case 'download': {
        const abs = this.abs(a.path);
        await mkdir(dirname(abs), { recursive: true });
        await this.deps.remote.download(a.path, abs);
        const r = remote.get(a.path);
        // 서버 mtime 으로 맞춘다 — 다음 스캔이 재해시하지 않게. (실패는 무해)
        if (r?.mtimeMs)
          await utimes(abs, new Date(r.mtimeMs), new Date(r.mtimeMs)).catch(() => undefined);
        const st = await stat(abs);
        base.set(a.path, { sha: r?.sha ?? a.sha, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        report.downloaded++;
        return;
      }
      case 'delete-local': {
        await unlink(this.abs(a.path)).catch(async (e) => {
          if ((e as { code?: string }).code !== 'ENOENT') throw e;
        });
        base.delete(a.path);
        report.deletedLocal++;
        await this.pruneEmptyDirs(a.path);
        return;
      }
      case 'upload': {
        const l = local.get(a.path);
        if (!l) return; // 실행 직전 사라짐 — 다음 사이클
        if (maxBytes && l.size > maxBytes) {
          report.errors.push(`${a.path}: 서버 제한(${maxBytes}B)보다 크다 — 건너뜀`);
          return;
        }
        const { sha256 } = await this.deps.remote.put(a.path, this.abs(a.path), a.baseSha);
        base.set(a.path, { sha: sha256, size: l.size, mtimeMs: l.mtimeMs });
        report.uploaded++;
        return;
      }
      case 'delete-remote': {
        await this.deps.remote.del(a.path, a.baseSha);
        base.delete(a.path);
        report.deletedRemote++;
        return;
      }
      case 'conflict': {
        // 서버 채택 + 로컬 보존: 로컬을 충돌 사본으로 옮겨 올리고, 원 경로는
        // 서버 것으로 되받는다. 어느 쪽 내용도 사라지지 않는다.
        const copyRel = conflictCopyName(
          a.path,
          this.deps.deviceName,
          new Date(this.deps.now?.() ?? Date.now()),
        );
        const absPath = this.abs(a.path);
        const absCopy = this.abs(copyRel);
        await mkdir(dirname(absCopy), { recursive: true });
        await rename(absPath, absCopy);
        try {
          const { sha256 } = await this.deps.remote.put(copyRel, absCopy, '');
          const st = await stat(absCopy);
          base.set(copyRel, { sha: sha256, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        } catch (e) {
          // 사본 업로드 실패해도 로컬 사본은 남는다 — 데이터는 안전.
          report.errors.push(`${copyRel}: 충돌 사본 업로드 실패: ${(e as Error).message}`);
        }
        await mkdir(dirname(absPath), { recursive: true });
        await this.deps.remote.download(a.path, absPath);
        const r = remote.get(a.path);
        if (r?.mtimeMs)
          await utimes(absPath, new Date(r.mtimeMs), new Date(r.mtimeMs)).catch(() => undefined);
        const st2 = await stat(absPath);
        base.set(a.path, { sha: a.remoteSha, size: st2.size, mtimeMs: Math.floor(st2.mtimeMs) });
        report.conflicts++;
        return;
      }
      case 'adopt': {
        base.set(a.path, { sha: a.sha, size: a.size, mtimeMs: a.mtimeMs });
        return;
      }
      case 'forget': {
        base.delete(a.path);
        return;
      }
    }
  }

  /** 파일을 지운 뒤 빈 부모 폴더를 걷어낸다 (동기화 폴더 자신은 남긴다). */
  private async pruneEmptyDirs(rel: string): Promise<void> {
    let dir = dirname(rel);
    while (dir && dir !== '.' && dir !== '/') {
      const abs = this.abs(dir);
      try {
        if ((await readdir(abs)).length > 0) return;
        await rmdir(abs); // 빈 폴더만 지운다 — 경합으로 내용이 생겼으면 실패하고 만다
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }
}
