/**
 * 에이전트마다의 IDE 저장소와 [대화 | 작업 공간] 선택 — **화면 밖에** 둔다. 채팅 화면은 에이전트를 바꿀 때마다 다시
 * 그려지는데(key), 편집기의 버퍼·되돌리기 기록이 그때마다 사라지면 안 된다. 에이전트가 지워지면 정리한다.
 *
 * Dex 는 대화(탭)마다 하나지만 XD 는 에이전트마다 하나다 — 작업 공간과 연결 폴더가 에이전트의 것이기 때문이다.
 */
import { useSyncExternalStore } from 'react';
import { IdeStore } from '@dex/ide';
import type { XdAgent } from '../../../main/store';
import { createXdIdeHost } from './xd-ide-host';

interface Entry {
  store: IdeStore;
  /** 연결 폴더가 바뀌면 그 칸만 다시 읽는다(저장소는 그대로 — 편집 중인 버퍼·되돌리기 기록이 남게). */
  foldersKey: string;
}

const stores = new Map<string, Entry>();
const agents = new Map<string, XdAgent>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};

const MODES_KEY = 'xd.ide.modes';

function loadModes(): Set<string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(MODES_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}
const modes = loadModes();
function saveModes(): void {
  try {
    window.localStorage.setItem(MODES_KEY, JSON.stringify([...modes]));
  } catch {
    /* 기억 못 해도 동작엔 지장 없다 */
  }
}

/** 이 에이전트의 IDE 저장소(없으면 만든다). 호스트는 늘 최신 에이전트를 본다. */
export function ideStoreFor(agent: XdAgent): IdeStore {
  agents.set(agent.id, agent);
  const foldersKey = agent.folders.join('\n');
  const hit = stores.get(agent.id);
  if (hit) {
    if (hit.foldersKey !== foldersKey) {
      hit.foldersKey = foldersKey;
      // 그리는 도중이다 — 다음 차례에.
      queueMicrotask(() => void hit.store.refreshFolders());
    }
    return hit.store;
  }
  const store = new IdeStore(createXdIdeHost(agent.id, () => agents.get(agent.id) ?? null));
  stores.set(agent.id, { store, foldersKey });
  queueMicrotask(emit);
  return store;
}

/** 지워진 에이전트의 저장소와 그 화면 상태(작업 공간 켜짐·열어 둔 탭·저장 안 한 버퍼의 사본)를 정리한다. */
export function forgetIdeStores(liveAgentIds: Iterable<string>): void {
  const keep = new Set(liveAgentIds);
  for (const [id, entry] of stores) {
    if (keep.has(id)) continue;
    entry.store.dispose();
    stores.delete(id);
    agents.delete(id);
  }
  let changed = false;
  for (const id of [...modes]) {
    if (!keep.has(id)) changed = modes.delete(id) || changed;
  }
  if (changed) saveModes();
  try {
    // 호스트의 저장 공간 키는 `xd.ide.<에이전트 id>.…` 이다(xd-ide-host.ts).
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i) ?? '';
      const m = /^xd\.ide\.([^.]+)\./.exec(key);
      if (m && !keep.has(m[1])) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    /* 저장 공간을 못 써도 동작엔 지장 없다 */
  }
  emit();
}

export function isIdeMode(agentId: string | null): boolean {
  return !!agentId && modes.has(agentId);
}

export function setIdeMode(agentId: string, on: boolean): void {
  if (on) modes.add(agentId);
  else modes.delete(agentId);
  saveModes();
  emit();
}

/** [대화 | 작업 공간] 선택을 구독한다. */
export function useIdeMode(agentId: string | null): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => isIdeMode(agentId),
  );
}

/** 이 에이전트의 IDE 저장소를 구독한다 — 아직 없으면 null. */
export function useIdeStore(agentId: string | null): IdeStore | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (agentId ? stores.get(agentId)?.store ?? null : null),
  );
}
