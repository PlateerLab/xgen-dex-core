/**
 * 대화 목록 (2026-10-09): ChatGPT·Claude 처럼 **대화 단위, 마지막으로 말한 순서**.
 *
 * 한 줄 = 에이전트 이름(작게) + 대화 제목 + 꼬리표. 제목은 사용자가 붙인 이름, 없으면 첫 메시지
 * 한 줄이다. 일반 채팅이 아니면 꼬리표(배포 · Teams · 스케줄 · 비교 · API · 테스트 · 캔버스)가
 * 붙고, 에이전트가 사라진 대화는 [지워짐] 으로만 보인다.
 *
 * 제목·꼬리표·순서는 서버가 한 곳에서 정한다(xgen-workflow conversation_list.py,
 * GET /api/interaction/conversations). 데스크톱·CLI·VSCode·모바일이 이 모듈 하나로 읽고, 웹도 같은
 * 규칙을 쓴다. 그 API 가 없는 옛 서버(404)에서는 옛 목록(/api/interaction/list)을 읽어 **같은 규칙으로**
 * 제목과 꼬리표를 여기서 만든다. 그래서 어느 서버에 붙어도 목록 모양이 같다.
 *
 * 아래 순수 함수들은 목록을 고치는 규칙이다(새 쪽 합치기, 방금 말한 대화 올리기, 지운 대화 빼기).
 * 처음 읽기와 대화 목록 소켓의 소식이 같은 규칙을 탄다.
 */
import type { Conversation, ConversationCompareThread, ConversationTag } from './types';
import { turnInputText } from './history';

/** 제목 길이: 한 줄로 보이는 만큼만(서버와 같다). */
export const CONVERSATION_TITLE_MAX = 80;
/** 비교 채팅의 파생 스레드 표식: `<부모>__cmp_<에이전트>`. */
export const COMPARE_MARKER = '__cmp_';

const TAGS: ReadonlySet<string> = new Set(['deploy', 'teams', 'schedule', 'compare', 'api', 'test', 'canvas']);

/** 꼬리표의 화면 이름(한국어). 앱마다 따로 적지 않는다. */
export const CONVERSATION_TAG_LABELS: Record<ConversationTag, string> = {
  deploy: '배포',
  teams: 'Teams',
  schedule: '스케줄',
  compare: '비교',
  api: 'API',
  test: '테스트',
  canvas: '캔버스',
};
/** 에이전트가 사라진 대화의 표시. */
export const DELETED_AGENT_LABEL = '지워짐';
/** 제목이 없는 대화(첫 메시지도 없다). */
export const UNTITLED_CONVERSATION = '새 대화';

const PREFIX_TAGS: ReadonlyArray<readonly [string, ConversationTag]> = [
  ['guest_', 'deploy'],
  ['deploy_', 'deploy'],
  ['teams-', 'teams'],
  ['workflow_schedule_', 'schedule'],
  ['schedule_', 'schedule'],
  ['openai_', 'api'],
  ['tester_', 'test'],
  ['canvas_', 'canvas'],
  ['builder_', 'canvas'],
];

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 비교 파생 스레드면 부모 interaction_id, 아니면 null. */
export function compareParent(interactionId: string): string | null {
  const idx = interactionId.indexOf(COMPARE_MARKER);
  return idx > 0 ? interactionId.slice(0, idx) : null;
}

/** interaction_id 모양으로 정하는 꼬리표(서버 conversation_tag 와 같은 규칙). */
export function conversationTagOf(interactionId: string, hasCompare = false): ConversationTag | null {
  if (hasCompare || compareParent(interactionId) != null) return 'compare';
  if (/^[a-f0-9]{40}$/i.test(interactionId)) return 'deploy';
  for (const [prefix, tag] of PREFIX_TAGS) if (interactionId.startsWith(prefix)) return tag;
  return null;
}

function oneLine(text: string, limit: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** 옛 목록의 metadata 로 제목을 만든다(붙인 이름, 없으면 첫 메시지 한 줄). 서버 규칙과 같다. */
export function conversationTitleFromMetadata(metadata: Record<string, unknown> | null | undefined): {
  title: string;
  customTitle: boolean;
} {
  const meta = metadata ?? {};
  for (const key of ['title', 'conversation_title']) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim()) return { title: oneLine(v, 200), customTitle: true };
  }
  const first = meta.first_message;
  let body = '';
  if (typeof first === 'string' && first.trim().startsWith('{')) {
    try {
      const decoded = JSON.parse(first) as unknown;
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        const o = decoded as Record<string, unknown>;
        body = 'input_str' in o || 'input' in o ? turnInputText(o) : '';
        if (!body.trim()) {
          const files = (o.attachments ?? o.selected_files) as unknown;
          if (Array.isArray(files)) {
            const named = files.find((f) => f && typeof f === 'object' && str((f as Record<string, unknown>).name).trim());
            if (named) body = str((named as Record<string, unknown>).name);
          }
        }
      } else {
        body = turnInputText(first);
      }
    } catch {
      body = first;
    }
  } else if (first != null) {
    body = turnInputText(first);
  }
  return { title: oneLine(body, CONVERSATION_TITLE_MAX), customTitle: false };
}

/** 서버 한 줄(GET /api/interaction/conversations) → 화면 모양. 대화를 가리킬 수 없는 줄은 null. */
export function parseConversation(raw: unknown): Conversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const interactionId = str(r.interaction_id);
  const workflowId = str(r.workflow_id);
  if (!interactionId || !workflowId) return null;
  const tag = str(r.tag);
  const compare: ConversationCompareThread[] = Array.isArray(r.compare)
    ? (r.compare as unknown[])
        .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>) : null))
        .filter((c): c is Record<string, unknown> => c != null && !!str(c.interaction_id))
        .map((c) => ({
          interactionId: str(c.interaction_id),
          workflowId: str(c.workflow_id),
          workflowName: str(c.workflow_name),
        }))
    : [];
  const id = typeof r.id === 'number' ? r.id : Number(r.id) || 0;
  return {
    id,
    interactionId,
    workflowId,
    workflowName: str(r.workflow_name),
    interactionCount: typeof r.interaction_count === 'number' ? r.interaction_count : 0,
    metadata: {},
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    title: str(r.title),
    customTitle: r.custom_title === true,
    tag: TAGS.has(tag) ? (tag as ConversationTag) : null,
    agentDeleted: r.agent_deleted === true,
    agentOwnerId: typeof r.agent_owner_id === 'number' ? r.agent_owner_id : null,
    compare,
  };
}

/** 옛 서버의 목록 한 줄(/api/interaction/list) → 같은 모양. 비교 묶기는 {@link foldLegacyConversations}. */
export function legacyConversation(raw: {
  id: number;
  interaction_id: string;
  workflow_id: string;
  workflow_name: string;
  interaction_count?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  agent_deleted?: boolean;
}): Conversation {
  const { title, customTitle } = conversationTitleFromMetadata(raw.metadata);
  return {
    id: raw.id,
    interactionId: raw.interaction_id,
    workflowId: raw.workflow_id,
    workflowName: raw.workflow_name,
    interactionCount: raw.interaction_count ?? 0,
    metadata: raw.metadata ?? {},
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? '',
    title,
    customTitle,
    tag: conversationTagOf(raw.interaction_id),
    agentDeleted: raw.agent_deleted === true,
    agentOwnerId: null,
    compare: [],
  };
}

/** 옛 목록에서 비교 파생 스레드를 부모 줄로 접는다(부모가 없는 파생은 제 줄로 남는다). */
export function foldLegacyConversations(list: Conversation[]): Conversation[] {
  const parents = new Set(list.filter((c) => compareParent(c.interactionId) == null).map((c) => c.interactionId));
  const byParent = new Map<string, ConversationCompareThread[]>();
  const out: Conversation[] = [];
  for (const c of list) {
    const parent = compareParent(c.interactionId);
    if (parent != null && parents.has(parent)) {
      const bucket = byParent.get(parent) ?? [];
      bucket.push({ interactionId: c.interactionId, workflowId: c.workflowId, workflowName: c.workflowName });
      byParent.set(parent, bucket);
      continue;
    }
    out.push(c);
  }
  return out.map((c) => {
    const compare = byParent.get(c.interactionId);
    return compare ? { ...c, compare, tag: 'compare' as const } : c;
  });
}

/** 줄에 보일 제목. 비어 있으면 "새 대화". */
export function conversationDisplayTitle(c: Pick<Conversation, 'title'>): string {
  return c.title?.trim() || UNTITLED_CONVERSATION;
}

/** 줄 위쪽 작은 글: 에이전트 이름, 에이전트가 사라졌으면 [지워짐]. */
export function conversationAgentLabel(c: Pick<Conversation, 'agentDeleted' | 'workflowName'>): string {
  return c.agentDeleted ? DELETED_AGENT_LABEL : c.workflowName || 'Agent';
}

// ── 목록 규칙 (순수 함수) ─────────────────────────────────────────────

export const conversationKey = (c: { workflowId: string; interactionId: string }): string =>
  `${c.workflowId}\u0000${c.interactionId}`;

const stamp = (v: string | null | undefined): number => {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/** 마지막으로 말한 순서, 같은 시각이면 나중에 생긴 대화가 위(서버와 같은 순서). */
export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || (b.id ?? 0) - (a.id ?? 0));
}

/**
 * 받은 쪽을 지금 목록에 합친다.
 * - `append`: 다음 쪽. 뒤에 잇는다(이미 있는 대화는 건너뛴다).
 * - `head`: 첫 쪽을 다시 읽었다. 그 쪽의 대화는 새 값으로 바꾸고, 받아 둔 뒤쪽은 지키고 다시 정렬한다.
 */
export function mergeConversationPage(
  current: Conversation[],
  page: Conversation[],
  mode: 'append' | 'head',
): Conversation[] {
  if (mode === 'append') {
    const seen = new Set(current.map(conversationKey));
    return [...current, ...page.filter((c) => !seen.has(conversationKey(c)))];
  }
  const fresh = new Set(page.map(conversationKey));
  return sortConversations([...page, ...current.filter((c) => !fresh.has(conversationKey(c)))]);
}

/**
 * "이 대화에서 방금 말했다": 목록 맨 위로. 모르는 대화면 `known: false`
 * (화면이 첫 쪽을 다시 읽는다. 숨겨야 하는 대화인지는 서버만 안다).
 */
export function touchConversation(
  current: Conversation[],
  item: Conversation,
): { list: Conversation[]; known: boolean } {
  const key = conversationKey(item);
  const idx = current.findIndex((c) => conversationKey(c) === key);
  if (idx < 0) return { list: current, known: false };
  const prev = current[idx];
  const next: Conversation = {
    ...prev,
    ...item,
    // 소식은 대화 한 줄만 안다. 비교 파생과 그 꼬리표, 모르는 주인은 목록이 들고 있던 것을 지킨다.
    compare: item.compare.length > 0 ? item.compare : prev.compare,
    tag: item.tag ?? (prev.compare.length > 0 ? prev.tag : item.tag),
    id: item.id || prev.id,
    agentOwnerId: item.agentOwnerId ?? prev.agentOwnerId,
  };
  return { list: [next, ...current.slice(0, idx), ...current.slice(idx + 1)], known: true };
}

export function removeConversation(current: Conversation[], workflowId: string, interactionId: string): Conversation[] {
  return current.filter((c) => !(c.workflowId === workflowId && c.interactionId === interactionId));
}

export function renameConversationInList(
  current: Conversation[],
  workflowId: string,
  interactionId: string,
  title: string,
  customTitle: boolean,
): Conversation[] {
  return current.map((c) =>
    c.workflowId === workflowId && c.interactionId === interactionId ? { ...c, title, customTitle } : c,
  );
}

/**
 * 대화 목록 소켓의 소식 하나가 목록에 무엇을 하는가. 화면은 이 결과대로만 고친다.
 *
 * - `touched`: 방금 말한 대화. `conversation` 이 있으면 맨 위로, 모르면 첫 쪽을 다시 읽는다.
 * - `renamed`: 이름이 바뀌었다(제목만 고친다).
 * - `removed`: 지워졌다.
 * - `running`: 지금 돈다/멈췄다(목록 내용은 그대로, 표시만).
 * - `reload`: 무엇이 바뀌었는지 모른다 → 첫 쪽을 다시 읽는다.
 * - `ignore`: 목록과 상관없다(앱·폴더·기기·모델 소식).
 */
export type ConversationListChange =
  | { type: 'touched'; conversation: Conversation | null; created: boolean }
  | { type: 'renamed'; workflowId: string; interactionId: string; title: string; customTitle: boolean }
  | { type: 'removed'; workflowId: string; interactionId: string }
  | { type: 'running'; workflowId: string; interactionId: string; running: boolean }
  | { type: 'reload' }
  | { type: 'ignore' };

const LIST_UNRELATED = new Set(['apps', 'folders', 'devices', 'model']);

/** 소켓 프레임(type + data) → 목록이 할 일. */
export function conversationListChange(kind: string, data: Record<string, unknown> | undefined): ConversationListChange {
  const d = data ?? {};
  const workflowId = str(d.workflow_id);
  const interactionId = str(d.interaction_id);
  if (kind === 'conversation_running') {
    return { type: 'running', workflowId, interactionId, running: d.running === true };
  }
  if (kind === 'conversation_touched') {
    return { type: 'touched', conversation: parseConversation(d.conversation), created: d.created === true };
  }
  if (kind === 'conversation_updated') {
    if (typeof d.title === 'string') {
      return { type: 'renamed', workflowId, interactionId, title: d.title, customTitle: d.custom_title === true };
    }
    return { type: 'reload' };
  }
  if (kind === 'conversation_deleted') return { type: 'removed', workflowId, interactionId };
  if (LIST_UNRELATED.has(kind)) return { type: 'ignore' };
  return { type: 'reload' };
}
