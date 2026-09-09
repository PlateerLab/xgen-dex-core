import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/** Workspace owns this cache for the lifetime of an open viewer tab. No server data is retained. */
export function createAgentViewerState() {
  return { values: new Map<string, unknown>(), scroll: new Map<string, number>() };
}

export type AgentViewerState = ReturnType<typeof createAgentViewerState>;
export const AgentViewerStateContext = createContext<AgentViewerState | null>(null);

function useNavigation() {
  const navigation = useContext(AgentViewerStateContext);
  if (!navigation) throw new Error('Agent viewer state provider is missing');
  return navigation;
}

export function useViewerState<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const navigation = useNavigation();
  const [value, setValue] = useState<T>(() =>
    navigation.values.has(key) ? (navigation.values.get(key) as T) : initial,
  );
  const current = useRef(value);
  const update = useCallback(
    (next: React.SetStateAction<T>) => {
      const resolved =
        typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next;
      current.current = resolved;
      navigation.values.set(key, resolved);
      setValue(resolved);
    },
    [key, navigation],
  );
  return [value, update];
}

/** Restore only once the content exists; loading placeholders must not overwrite the saved offset. */
export function useViewerScroll(key: string, ready: boolean) {
  const navigation = useNavigation();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!ready || !element) return;
    element.scrollTop = navigation.scroll.get(key) ?? 0;
    // A tab can unmount before Chromium delivers its pending scroll event.
    return () => {
      navigation.scroll.set(key, element.scrollTop);
    };
  }, [navigation, key, ready]);
  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (ready) navigation.scroll.set(key, event.currentTarget.scrollTop);
    },
    [navigation, key, ready],
  );
  return { ref, onScroll };
}
