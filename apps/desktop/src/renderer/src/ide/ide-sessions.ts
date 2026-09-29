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
const modeListeners = new Set<() => void>();
/** 저장소가 생기거나 없어질 때 — 앱 사이드바의 IDE 단추가 따라간다. */
const storeListeners = new Set<() => void>();
const emitStores = () => {
  for (const fn of storeListeners) fn();
};

// [채팅 | IDE] 선택은 앱을 다시 켜도 남는다(VS Code 가 배치를 기억하듯). 대화 탭의 key 는
// 대화 id 라 다시 켜도 같다. 앱 저장 공간만 쓰고, 닫힌 대화의 것은 지운다(아래 구독).
const MODES_KEY = 'xgen.ide.modes';
const MODES_MAX = 200;

function loadModes(): Set<string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(MODES_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(-MODES_MAX) : []);
  } catch {
    return new Set();
  }
}

function saveModes(): void {
  try {
    window.localStorage.setItem(MODES_KEY, JSON.stringify([...modes].slice(-MODES_MAX)));
  } catch {
    /* 기억 못 해도 동작엔 지장 없다 */
  }
}

const modes = loadModes();

/** 이 채팅 탭의 IDE 저장소(없으면 만든다). 에이전트가 바뀌면 새로 만든다. */
export function ideStoreFor(
  sessionKey: string,
  agent: { workflowId: string; workflowName: string },
): IdeStore {
  const hit = stores.get(sessionKey);
  if (hit && hit.workflowId === agent.workflowId) return hit.store;
  hit?.store.dispose();
  // 채팅 탭의 key 는 대화 id 다 — 그 대화에 연결한 폴더가 탐색기 아래 보인다.
  const store = new IdeStore(createDexIdeHost(agent, sessionKey));
  stores.set(sessionKey, { store, workflowId: agent.workflowId });
  // 그리는 도중(채팅 화면이 저장소를 만들 때)에 다른 부품을 다시 그리게 하지 않는다.
  queueMicrotask(emitStores);
  return store;
}

export function peekIdeStore(sessionKey: string): IdeStore | null {
  return stores.get(sessionKey)?.store ?? null;
}

/** 이 채팅 탭의 IDE 저장소를 구독한다 — 아직 없으면 null, 생기면 다시 그린다. */
export function useIdeStore(sessionKey: string | null): IdeStore | null {
  return useSyncExternalStore(
    (cb) => {
      storeListeners.add(cb);
      return () => storeListeners.delete(cb);
    },
    () => (sessionKey ? peekIdeStore(sessionKey) : null),
  );
}

/** 이 채팅 탭이 지금 IDE 로 보이는가 — 키가 없으면 false. */
export function useIsIdeMode(sessionKey: string | null): boolean {
  return useSyncExternalStore(
    (cb) => {
      modeListeners.add(cb);
      return () => modeListeners.delete(cb);
    },
    () => (sessionKey ? modes.has(sessionKey) : false),
  );
}

export function isIdeMode(sessionKey: string): boolean {
  return modes.has(sessionKey);
}

export function setIdeMode(sessionKey: string, on: boolean): void {
  if (on === modes.has(sessionKey)) return;
  if (on) modes.add(sessionKey);
  else modes.delete(sessionKey);
  saveModes();
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

// 채팅 탭이 닫히면(대화 종료·로그아웃) 그 IDE 도 정리한다. IDE 선택은 **이번에 살아 있는 것을
// 본 대화만** 지운다 — 앱을 켠 직후에는 대화가 아직 복원되지 않아 목록이 비어 있다.
const seen = new Set<string>();
sessionStore.subscribe(() => {
  const live = new Set(sessionStore.getSnapshot().sessions.map((s) => s.key));
  for (const key of live) seen.add(key);
  let dropped = false;
  for (const [key, entry] of stores) {
    if (live.has(key)) continue;
    entry.store.dispose();
    stores.delete(key);
    dropped = true;
  }
  if (dropped) emitStores();
  let changed = false;
  for (const key of [...modes]) {
    if (seen.has(key) && !live.has(key)) {
      modes.delete(key);
      seen.delete(key);
      changed = true;
    }
  }
  if (changed) saveModes();
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
