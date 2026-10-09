/**
 * 에이전트 목록 한 벌: 시작 화면의 에이전트 고르기와 사이드바 대화 목록이 함께 쓴다 (2026-10-09).
 *
 * 대화 목록은 에이전트 이름만 알고 그 에이전트가 Agent Geny 인지는 모른다. 그런데 대화를 열 때 그 값이
 * 있어야 첨부가 제대로 간다(Geny 는 그림뿐 아니라 문서·표도 받는다, session-store send). 그래서 한 번
 * 읽어 두고 대화를 열 때 찾아 쓴다. 못 찾으면 이름만으로 연다(예전 이어보기와 같다).
 */
import { useSyncExternalStore } from 'react';
import type { Agent } from '@dex/protocol';
import { xgen } from './bridge';

const PAGE_SIZE = 100;
/** 고르기 목록에 싣는 상한(5쪽). 그보다 많은 사람은 검색으로 좁힌다. */
const MAX_PAGES = 5;

export interface AgentDirectorySnapshot {
  agents: readonly Agent[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

class AgentDirectory {
  private snap: AgentDirectorySnapshot = { agents: [], loaded: false, loading: false, error: null };
  private inflight: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AgentDirectorySnapshot => this.snap;

  private set(next: Partial<AgentDirectorySnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const listener of this.listeners) listener();
  }

  /** 읽는다. 이미 읽었으면 `force` 일 때만 다시 읽는다. 같은 때 여러 번 불러도 한 번만 간다. */
  load(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.snap.loaded && !force) return Promise.resolve();
    this.set({ loading: true, error: null });
    this.inflight = (async () => {
      try {
        const first = await xgen.agents.list({ page: 1, pageSize: PAGE_SIZE });
        const all = [...first.items];
        const last = Math.min(first.pagination.totalPages, MAX_PAGES);
        for (let page = 2; page <= last; page += 1) {
          const next = await xgen.agents.list({ page, pageSize: PAGE_SIZE });
          all.push(...next.items);
        }
        this.set({ agents: all, loaded: true, loading: false });
      } catch (e) {
        this.set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  find(workflowId: string): Agent | undefined {
    return this.snap.agents.find((a) => a.workflowId === workflowId);
  }

  /** 방금 만든 에이전트를 맨 앞에 더한다(다시 읽지 않아도 고르기 목록에 보인다). */
  add(agent: Agent): void {
    if (this.find(agent.workflowId)) return;
    this.set({ agents: [agent, ...this.snap.agents] });
  }
}

export const agentDirectory = new AgentDirectory();

export function useAgentDirectory(): AgentDirectorySnapshot {
  return useSyncExternalStore(agentDirectory.subscribe, agentDirectory.getSnapshot);
}

/** 대화 목록 한 줄로 여는 에이전트. 목록에 있으면 그것, 없으면 이름만 아는 자리표시. */
export function agentForConversation(c: { workflowId: string; workflowName: string; createdAt?: string; updatedAt?: string }): Agent {
  return (
    agentDirectory.find(c.workflowId) ?? {
      id: 0,
      workflowId: c.workflowId,
      workflowName: c.workflowName,
      nodeCount: 0,
      isShared: false,
      isDeployed: false,
      isCompleted: true,
      description: '',
      username: '',
      fullName: '',
      createdAt: c.createdAt ?? '',
      updatedAt: c.updatedAt ?? '',
    }
  );
}
