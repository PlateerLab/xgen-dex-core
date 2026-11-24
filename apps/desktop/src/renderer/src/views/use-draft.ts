import { useMemo, useSyncExternalStore } from 'react';
import { draftField, type DeviceDraftStorage } from '@dex/protocol';

const draftStorage: DeviceDraftStorage = {
  read: key => localStorage.getItem(key),
  write: (key, value) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value),
};

export function useDraft<T extends string | unknown[]>(key: string, empty: T, storage = draftStorage) {
  const field = useMemo(() => draftField(storage, key, empty), [key, storage]);
  return [useSyncExternalStore(field.subscribe, field.get), field.set] as const;
}
