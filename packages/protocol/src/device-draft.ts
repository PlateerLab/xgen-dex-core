// Device storage only. This module has no network transport.
export interface DeviceDraftStorage {
  read(key: string): string | null | Promise<string | null>;
  write(key: string, value: string | null): void | Promise<void>;
}

export function draftKey(...parts: (string | number)[]): string {
  return 'xgen:draft:v1:' + JSON.stringify(parts);
}

export function draftField<T extends string | unknown[]>(storage: DeviceDraftStorage, key: string, empty: T) {
  let value = empty;
  let loaded = false;
  let edited = false;
  const listeners = new Set<() => void>();
  function restore(raw: string | null) {
    if (!raw || edited) return;
    try {
      const saved: unknown = JSON.parse(raw);
      if ((typeof empty === 'string' && typeof saved === 'string') ||
          (Array.isArray(empty) && Array.isArray(saved))) {
        value = saved as T;
        for (const notify of listeners) notify();
      }
    } catch { /* ignore damaged local storage */ }
  }
  return {
    get: () => value,
    subscribe(notify: () => void) {
      listeners.add(notify);
      if (!loaded) {
        loaded = true;
        try {
          const raw = storage.read(key);
          if (typeof raw === 'string' || raw === null) restore(raw);
          else void raw.then(restore).catch(() => {});
        } catch { /* unavailable storage: keep editing in this view */ }
      }
      return () => { listeners.delete(notify); };
    },
    set(next: T | ((previous: T) => T)) {
      value = typeof next === 'function' ? next(value) : next;
      edited = true;
      try {
        const write = storage.write(key, value.length ? JSON.stringify(value) : null);
        if (write) void write.catch(() => console.warn('Could not save the local chat draft'));
      } catch { console.warn('Could not save the local chat draft'); }
      for (const notify of listeners) notify();
    },
  };
}
