/** 이 PC 의 밝은·어두운 화면 설정 — Dex 스타일이 따르는 것과 같은 기준(prefers-color-scheme). IDE 편집기 색에 쓴다. */
import { useSyncExternalStore } from 'react';

const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function useTheme(): 'dark' | 'light' {
  return useSyncExternalStore(
    (cb) => {
      const q = query();
      q?.addEventListener('change', cb);
      return () => q?.removeEventListener('change', cb);
    },
    () => (query()?.matches ? 'dark' : 'light'),
  );
}
