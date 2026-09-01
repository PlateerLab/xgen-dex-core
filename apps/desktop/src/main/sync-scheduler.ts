/**
 * SyncScheduler — 여러 LocalSyncManager 가 **하나의 대기열**을 공유하게 하는
 * 전역 실행 게이트.
 *
 * 왜 매니저 밖으로 뺐나: [XGen 클라우드]와 [Agent Workspace]는 매니저가
 * 다르다. 큐가 매니저마다 있으면 둘이 **병렬로** 서버를 두드린다 — 사용자
 * 관점의 "하나씩"이 깨진다. 이 스케줄러 하나를 양쪽에 주입하면 계정 전체에서
 * 동시에 도는 사이클이 concurrency(기본 1)개가 된다.
 *
 * 계약:
 *   · enqueue(key, run) — key 는 전역 유일(workflow_id / 'user:<id>').
 *     이미 대기 중이면 무시(front 요청이면 승격만), **실행 중이면 rerun 으로
 *     적립**되어 끝난 뒤 맨 앞에서 한 번 더 돈다 (신호 유실 없음).
 *   · run 의 예외는 여기서 삼킨다 — 실패 처리는 매니저(runCycle)의 몫이다.
 *   · positionOf 는 대기열 전체(두 매니저 합산)에서의 1-기반 순번.
 */

interface Entry {
  key: string;
  run: () => Promise<void>;
}

export class SyncScheduler {
  private queue: Entry[] = [];
  private active = new Set<string>();
  /** 실행 중에 다시 들어온 요청 — 끝난 뒤 맨 앞으로 (연타는 마지막 것 하나로 접힘). */
  private rerun = new Map<string, () => Promise<void>>();
  private listeners = new Set<() => void>();

  constructor(private concurrency = 1) {}

  /** 대기열 변화 알림 — 매니저가 status 방송을 다시 하도록. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* 리스너 오류가 스케줄을 막으면 안 된다 */
      }
    }
  }

  enqueue(key: string, run: () => Promise<void>, opts?: { front?: boolean }): void {
    if (this.active.has(key)) {
      this.rerun.set(key, run);
      return;
    }
    if (this.queue.some((e) => e.key === key)) {
      if (opts?.front) this.promote(key);
      return;
    }
    const entry: Entry = { key, run };
    if (opts?.front) this.queue.unshift(entry);
    else this.queue.push(entry);
    this.notify();
    this.drain();
  }

  /** 대기 중인 항목을 맨 앞으로 (턴 크리티컬 경로용). */
  promote(key: string): void {
    const i = this.queue.findIndex((e) => e.key === key);
    if (i > 0) {
      const [e] = this.queue.splice(i, 1);
      this.queue.unshift(e);
      this.notify();
    }
  }

  /** 페어 철거 시 — 대기·적립분을 걷는다 (실행 중이면 그 사이클은 끝까지 돈다). */
  remove(key: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.key !== key);
    this.rerun.delete(key);
    if (this.queue.length !== before) this.notify();
  }

  /** 1-기반 대기 순번 (실행 중/없음 = undefined). */
  positionOf(key: string): number | undefined {
    const i = this.queue.findIndex((e) => e.key === key);
    return i >= 0 ? i + 1 : undefined;
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private drain(): void {
    while (this.active.size < Math.max(1, this.concurrency) && this.queue.length > 0) {
      const entry = this.queue.shift() as Entry;
      this.active.add(entry.key);
      this.notify();
      void entry
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(entry.key);
          const again = this.rerun.get(entry.key);
          if (again) {
            this.rerun.delete(entry.key);
            this.queue.unshift({ key: entry.key, run: again });
          }
          this.notify();
          this.drain();
        });
    }
  }
}
