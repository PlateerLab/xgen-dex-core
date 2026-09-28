/**
 * 채팅 탭마다의 IDE — 저장소와 [채팅 | IDE] 선택을 **화면 밖에** 둔다.
 *
 * 채팅 화면은 탭을 바꿀 때마다 다시 그려진다(`key={session.key}`). 편집기의 버퍼·되돌리기
 * 기록·터미널 연결이 그때마다 사라지면 안 되므로 여기서 들고 있고, 그 탭(세션)이 닫히면
 * 정리한다. 서버의 셸은 연결이 끊겨도 살아 있다가 다시 붙으면 이어진다.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { IdeStore, type ThemeKind } from '@dex/ide';
import { sessionStore } from '../session';
import { createDexIdeHost } from './dex-ide-host';

interface Entry {
  store: IdeStore;
  workflowId: string;
}

const stores = new Map<string, Entry>();
const modes = new Map<string, boolean>();
const modeListeners = new Set<() => void>();

/** 이 채팅 탭의 IDE 저장소(없으면 만든다). 에이전트가 바뀌면 새로 만든다. */
export function ideStoreFor(
  sessionKey: string,
  agent: { workflowId: string; workflowName: string },
): IdeStore {
  const hit = stores.get(sessionKey);
  if (hit && hit.workflowId === agent.workflowId) return hit.store;
  hit?.store.dispose();
  const store = new IdeStore(createDexIdeHost(agent));
  stores.set(sessionKey, { store, workflowId: agent.workflowId });
  return store;
}

export function peekIdeStore(sessionKey: string): IdeStore | null {
  return stores.get(sessionKey)?.store ?? null;
}

export function isIdeMode(sessionKey: string): boolean {
  return modes.get(sessionKey) ?? false;
}

export function setIdeMode(sessionKey: string, on: boolean): void {
  if (on) modes.set(sessionKey, true);
  else modes.delete(sessionKey);
  for (const fn of modeListeners) fn();
}

export function useIdeMode(sessionKey: string): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (cb) => {
      modeListeners.add(cb);
      return () => modeListeners.delete(cb);
    },
    () => isIdeMode(sessionKey),
  );
  return [on, (v: boolean) => setIdeMode(sessionKey, v)];
}

// 채팅 탭이 닫히면(대화 종료·로그아웃) 그 IDE 도 정리한다.
sessionStore.subscribe(() => {
  const live = new Set(sessionStore.getSnapshot().sessions.map((s) => s.key));
  for (const [key, entry] of stores) {
    if (live.has(key)) continue;
    entry.store.dispose();
    stores.delete(key);
    modes.delete(key);
  }
});

/** 앱의 테마 — `<html data-theme>` 가 있으면 그것, 없으면(시스템) 운영체제 설정. */
export function useResolvedTheme(): ThemeKind {
  const read = (): ThemeKind => {
    const explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark' || explicit === 'light') return explicit;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  const [theme, setTheme] = useState<ThemeKind>(read);
  useEffect(() => {
    const update = () => setTheme(read());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', update);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', update);
    };
  }, []);
  return theme;
}
