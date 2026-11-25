// Device storage only. This module has no network transport.
export interface DeviceDraftStorage {
  read(key: string): string | null | Promise<string | null>;
  write(key: string, value: string | null): void | Promise<void>;
}

export function draftKey(...parts: (string | number)[]): string {
  return 'xgen:draft:v1:' + JSON.stringify(parts);
}

type DraftValue = string | unknown[];
type Field<T extends DraftValue> = ReturnType<typeof createField<T>>;
// An in-flight acknowledgement and a reopened editor must see the same value.
const scopes = new WeakMap<DeviceDraftStorage, Map<string, { deref(): Field<DraftValue> | undefined }>>();

export function draftField<T extends DraftValue>(storage: DeviceDraftStorage, key: string, empty: T): Field<T> {
  let entries = scopes.get(storage);
  if (!entries) scopes.set(storage, entries = new Map());
  const existing = entries.get(key)?.deref();
  if (existing) return existing as Field<T>;
  const field = createField(storage, key, empty);
  const shared = field as Field<DraftValue>;
  for (const [name, ref] of entries) if (!ref.deref()) entries.delete(name);
  if (typeof WeakRef === 'function') entries.set(key, new WeakRef(shared));
  else {
    // Older mobile engines lack weak references. Bound their resident cache.
    if (entries.size >= 64) entries.delete(entries.keys().next().value!);
    entries.set(key, { deref: () => shared });
  }
  return field;
}

function createField<T extends DraftValue>(storage: DeviceDraftStorage, key: string, empty: T) {
  let value = empty;
  let loaded = false;
  let edited = false;
  let writing: Promise<void> | undefined;
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
        const raw = value.length ? JSON.stringify(value) : null;
        const write = writing ? writing.then(() => storage.write(key, raw)) : storage.write(key, raw);
        if (write) {
          const done = write.catch(() => console.warn('Could not save the local chat draft'));
          writing = done;
          void done.then(() => { if (writing === done) writing = undefined; });
        }
      } catch { console.warn('Could not save the local chat draft'); }
      for (const notify of listeners) notify();
    },
  };
}

/** Only events produced by an admitted execution can consume a device draft. */
export function confirmsChatDispatch(kind: string): boolean {
  return kind === 'turn_accepted' || kind === 'execution_io' || kind === 'text' || kind === 'tool' || kind === 'generated_content';
}
