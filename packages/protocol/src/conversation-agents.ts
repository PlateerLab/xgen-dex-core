/**
 * 사이드바 [최근 채팅] · [에이전트] (2026-10-10). 웹·Dex 전 표면이 같은 규칙을 쓴다.
 *
 *   [+ 새 채팅]                       [검색] [⋯]
 *   최근 채팅          ← 마지막으로 말한 대화 5개, [더 보기] 로 5개씩 늘린다
 *   에이전트           ← 대화가 있는 에이전트(대화 수, 마지막 대화의 제목·시각), 마지막으로 말한 순서
 *     [다른 에이전트 N개]  ← 쓸 수 있지만 아직 대화가 없는 에이전트(펼치면 보인다)
 *
 * 에이전트 줄을 누르면 그 에이전트의 대화로 들어간다(예전 Dex 의 에이전트 → 대화). [+] 는 그 에이전트가 골라진
 * 시작 화면이다. 묶음은 서버가 센다(conversations/agents). 아래 함수는 실시간 소식으로 묶음을 고치는 규칙과,
 * 그 API 가 없는 옛 서버에서 대화 목록으로 묶음을 만드는 규칙이다.
 */
import type { Agent, Conversation, ConversationAgent } from './types';

/** [최근 채팅] 을 처음 보여 주는 수이자 [더 보기] 가 늘리는 수. */
export const RECENT_CONVERSATION_STEP = 5;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const stamp = (v: string | null | undefined): number => {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/** 서버 한 줄 → 묶음 한 줄. 에이전트를 가리킬 수 없는 줄은 버린다. */
export function parseConversationAgent(raw: unknown): ConversationAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const workflowId = str(r.workflow_id);
  if (!workflowId) return null;
  const count = Number(r.conversation_count);
  return {
    workflowId,
    workflowName: str(r.workflow_name),
    conversationCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    lastActivity: r.last_activity == null ? null : str(r.last_activity),
    lastTitle: str(r.last_title),
    lastInteractionId: r.last_interaction_id == null ? null : str(r.last_interaction_id),
    agentDeleted: r.agent_deleted === true,
    agentOwnerId: typeof r.agent_owner_id === 'number' ? r.agent_owner_id : null,
  };
}

/** 마지막으로 말한 순서(같으면 이름 순). */
export function sortConversationAgents(list: readonly ConversationAgent[]): ConversationAgent[] {
  return [...list].sort(
    (a, b) => stamp(b.lastActivity) - stamp(a.lastActivity) || a.workflowName.localeCompare(b.workflowName),
  );
}

/**
 * 대화 목록 → 에이전트 묶음. 묶음 API 가 없는 옛 서버와 서버가 없는 XD 가 쓴다.
 * 목록은 마지막으로 말한 순서라 처음 만난 대화가 그 에이전트의 마지막 대화다.
 */
export function groupConversationsByAgent(list: readonly Conversation[]): ConversationAgent[] {
  const byAgent = new Map<string, ConversationAgent>();
  const ordered = [...list].sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || (b.id ?? 0) - (a.id ?? 0));
  for (const c of ordered) {
    const found = byAgent.get(c.workflowId);
    if (found) {
      found.conversationCount += 1;
      continue;
    }
    byAgent.set(c.workflowId, {
      workflowId: c.workflowId,
      workflowName: c.workflowName,
      conversationCount: 1,
      lastActivity: c.updatedAt || c.createdAt || null,
      lastTitle: c.title,
      lastInteractionId: c.interactionId,
      agentDeleted: c.agentDeleted,
      agentOwnerId: c.agentOwnerId,
    });
  }
  return sortConversationAgents([...byAgent.values()]);
}

/**
 * "이 대화에서 방금 말했다"를 묶음에 싣는다. 그 에이전트 줄의 마지막 대화·시각을 바꾸고 맨 위로 올린다.
 * 새 대화면 수를 하나 늘린다. 묶음에 없는 에이전트의 새 대화면 줄을 새로 만든다. 묶음에 없는 에이전트의
 * 옛 대화면 `known: false`(화면이 묶음을 다시 읽는다. 숨길 대화인지는 서버만 안다).
 */
export function touchConversationAgent(
  agents: readonly ConversationAgent[],
  conversation: Conversation,
  created: boolean,
): { agents: ConversationAgent[]; known: boolean } {
  const idx = agents.findIndex((a) => a.workflowId === conversation.workflowId);
  const last = {
    lastActivity: conversation.updatedAt || conversation.createdAt || new Date().toISOString(),
    lastTitle: conversation.title,
    lastInteractionId: conversation.interactionId,
  };
  if (idx < 0) {
    if (!created) return { agents: [...agents], known: false };
    const row: ConversationAgent = {
      workflowId: conversation.workflowId,
      workflowName: conversation.workflowName,
      conversationCount: 1,
      agentDeleted: conversation.agentDeleted,
      agentOwnerId: conversation.agentOwnerId,
      ...last,
    };
    return { agents: [row, ...agents], known: true };
  }
  const prev = agents[idx];
  const row: ConversationAgent = {
    ...prev,
    ...last,
    workflowName: conversation.workflowName || prev.workflowName,
    conversationCount: prev.conversationCount + (created ? 1 : 0),
  };
  return { agents: [row, ...agents.slice(0, idx), ...agents.slice(idx + 1)], known: true };
}

/** 대화 이름이 바뀌었다: 그 대화가 어느 에이전트의 마지막 대화면 그 줄의 제목도 바꾼다. */
export function renameInConversationAgents(
  agents: readonly ConversationAgent[],
  workflowId: string,
  interactionId: string,
  title: string,
): ConversationAgent[] {
  return agents.map((a) =>
    a.workflowId === workflowId && a.lastInteractionId === interactionId ? { ...a, lastTitle: title } : a,
  );
}

/**
 * 대화가 지워졌다: 그 에이전트의 수를 하나 줄이고, 0 이면 줄을 뺀다. 지운 것이 그 에이전트의 마지막
 * 대화였으면 `stale: true`(새 마지막 대화는 서버만 안다. 화면이 묶음을 다시 읽는다).
 */
export function dropFromConversationAgents(
  agents: readonly ConversationAgent[],
  workflowId: string,
  interactionId: string,
): { agents: ConversationAgent[]; stale: boolean } {
  const idx = agents.findIndex((a) => a.workflowId === workflowId);
  if (idx < 0) return { agents: [...agents], stale: false };
  const prev = agents[idx];
  const stale = prev.lastInteractionId === interactionId;
  if (prev.conversationCount <= 1) return { agents: agents.filter((_, i) => i !== idx), stale: false };
  const next = [...agents];
  next[idx] = { ...prev, conversationCount: prev.conversationCount - 1 };
  return { agents: next, stale };
}

/**
 * 쓸 수 있지만 아직 대화가 없는 에이전트([다른 에이전트]). 받은 순서를 지킨다.
 * 에이전트 모양은 표면마다 다르다(서버 Agent, XD 의 제 에이전트). workflowId 만 본다.
 */
export function agentsWithoutConversations<T extends Pick<Agent, 'workflowId'>>(
  withChats: readonly Pick<ConversationAgent, 'workflowId'>[],
  available: readonly T[],
): T[] {
  const has = new Set(withChats.map((a) => a.workflowId));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const a of available) {
    if (has.has(a.workflowId) || seen.has(a.workflowId)) continue;
    seen.add(a.workflowId);
    out.push(a);
  }
  return out;
}
