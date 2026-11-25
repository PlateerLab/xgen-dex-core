import { useMemo, useSyncExternalStore } from 'react';
import { draftField, type PendingStorage } from '@dex/protocol';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const draftStorage: PendingStorage = {
  keys: async prefix => (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(prefix)),
  read: key => AsyncStorage.getItem(key),
  write: (key, value) => value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value),
};

export function useDraft<T extends string | unknown[]>(key: string, empty: T) {
  const field = useMemo(() => draftField(draftStorage, key, empty), [key]);
  return [useSyncExternalStore(field.subscribe, field.get), field.set, field.flush] as const;
}
