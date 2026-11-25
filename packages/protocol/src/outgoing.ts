import type { DeviceDraftStorage } from './device-draft';

export interface PendingSend<F> {
  id: string;
  text: string;
  files: F[];
  workflowId: string;
  interactionId: string;
}

export interface PendingStorage extends DeviceDraftStorage {
  keys(prefix: string): readonly string[] | Promise<readonly string[]>;
}

type Observer = () => void;

export class DeviceOutbox<F> {
  private rows: PendingSend<F>[] = [];
  private observers = new Set<Observer>();
  private serial: Promise<void> = Promise.resolve();
  private readonly prefix: string;

  constructor(
    private storage: PendingStorage,
    key: string,
  ) {
    this.prefix = key + '/pending/';
  }

  snapshot = () => this.rows;
  subscribe = (fn: Observer) => {
    this.observers.add(fn);
    void this.update().catch(() => {});
    return () => {
      this.observers.delete(fn);
    };
  };

  private update(change?: () => Promise<void>) {
    const task = this.serial.then(async () => {
      await change?.();
      const keys = await this.storage.keys(this.prefix);
      const rows: PendingSend<F>[] = [];
      for (const key of keys) {
        if (!key.startsWith(this.prefix)) continue;
        const raw = await this.storage.read(key);
        if (!raw) continue;
        let row: PendingSend<F>;
        try {
          row = JSON.parse(raw);
        } catch {
          continue;
        }
        if (
          row &&
          this.prefix + row.id === key &&
          typeof row.text === 'string' &&
          typeof row.workflowId === 'string' &&
          typeof row.interactionId === 'string' &&
          Array.isArray(row.files)
        )
          rows.push(row);
      }
      this.rows = rows.sort((a, b) => a.id.localeCompare(b.id));
      for (const fn of this.observers) fn();
    });
    this.serial = task.catch(() => {});
    return task;
  }

  stage(row: PendingSend<F>) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(row.id))
      return Promise.reject(new Error('Invalid request ID'));
    return this.update(async () => {
      await this.storage.write(this.prefix + row.id, JSON.stringify(row));
    });
  }

  remove(ids: string[]) {
    return this.update(async () => {
      for (const id of ids)
        if (/^[a-zA-Z0-9_-]{1,128}$/.test(id))
          await this.storage.write(this.prefix + id, null);
    });
  }
  /** Only check receipts. A network error or an unknown ID cannot dispatch a turn. */
  watch(check: (wf: string, room: string, ids: string[]) => Promise<string[]>) {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(poll, delay);
      // A background receipt check must not keep a terminal or extension host alive.
      (timer as unknown as {unref?: () => void}).unref?.();
    };
    const poll = async () => {
      try {
        await this.update();
        if (closed) return;
        const groups = new Map<string, PendingSend<F>[]>();
        for (const row of this.rows) {
          const key = JSON.stringify([row.workflowId, row.interactionId]);
          const group = groups.get(key) ?? [];
          groups.set(key, group);
          group.push(row);
        }
        for (const rows of groups.values()) {
          for (let offset = 0; !closed && offset < rows.length; offset += 64) {
            const ids = rows.slice(offset, offset + 64).map((row) => row.id);
            const accepted = (
              await check(rows[0].workflowId, rows[0].interactionId, ids)
            ).filter((id) => ids.includes(id));
            if (accepted.length && !closed) await this.remove(accepted);
          }
        }
      } catch {
        /* Keep the local copy until admission can be verified. */
      }
      if (!closed) schedule(15000);
    };
    schedule(500);
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }
}

// Components own their subscriptions. Separate processes/windows share independent
// per-request records, so concurrent sends cannot overwrite one another.
export function deviceOutbox<F>(
  storage: PendingStorage,
  key: string,
): DeviceOutbox<F> {
  return new DeviceOutbox<F>(storage, key);
}
