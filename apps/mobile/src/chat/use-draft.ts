import { useMemo, useSyncExternalStore } from 'react';
import { draftField, type DeviceDraftStorage } from '@dex/protocol';
import AsyncStorage from '@react-native-async-storage/async-storage';

const draftStorage: DeviceDraftStorage = {
  read: key => AsyncStorage.getItem(key),
  write: (key, value) => value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value),
};

export function useDraft<T extends string | unknown[]>(key: string, empty: T) {
  const field = useMemo(() => draftField(draftStorage, key, empty), [key]);
  return [useSyncExternalStore(field.subscribe, field.get), field.set] as const;
}
