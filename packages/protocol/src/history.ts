/**
 * Conversation history + past-conversation listing.
 *
 * - io-logs: the ordered turns of one conversation (workflowId + interactionId).
 * - interactions: the list of past conversations for a sidebar.
 */
import { ApiError, HttpClient } from './client';
import type {
  Conversation,
  ConversationAgent,
  ConversationKind,
  ConversationPage,
  ConversationSearchHit,
  ConversationSearchPage,
  ConversationSnapshot,
  HistoryAttachment,
  HistoryFlowItem,
  HistoryTurn,
  ToolEvent,
} from './types';
import { stripBrowserContext } from './browser';
import {
  conversationMatchesKind,
  foldLegacyConversations,
  legacyConversation,
  parseConversation,
} from './conversation-list';
import { parseConversationSearchHit, searchConversationList, searchTerms } from './conversation-search';
import { groupConversationsByAgent, parseConversationAgent } from './conversation-agents';

interface RawIoLog {
  log_id: number;
  io_id: number;
  interaction_id: string;
  workflow_id: string;
  workflow_name: string;
  // ⚠ 서버는 `result` 를 그대로 싣는다 — 구조화 출력(Schema Provider) 턴은
  // dict, 멀티모달 입력은 [{type,text},{type,image_url}] 배열이라 **문자열이
  // 아니다.** 타입만 string 이라 믿고 그대로 렌더하면 React 가
  // "Objects are not valid as a React child" 로 죽어 화면이 통째로 검게 된다
  // (기존 채팅 불러오기 크래시의 근본 원인). ``toDisplayText`` 로 항상 문자열화.
  input_data: unknown;
  output_data: unknown;
  attachments?: unknown;
  updated_at: string;
  /** 서버가 실행 기록에서 되살린 작업 과정 — 도구를 쓴 턴에만. */
  process?: unknown;
}

/**
 * 서버 작업 과정 → 화면 순서. 사건 이름은 스트림(turn_events)과 같은 snake_case 라
 * 같은 규칙으로 옮긴다. 모양이 어긋난 칸은 버린다 — 한 칸 때문에 턴 전체를 잃지 않는다.
 */
export function toHistoryProcess(value: unknown): HistoryFlowItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HistoryFlowItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const at = typeof item.at === 'number' ? item.at : 0;
    if (item.kind === 'text' && typeof item.text === 'string') {
      out.push({ kind: 'text', text: item.text, at });
      continue;
    }
    if (item.kind === 'tool' && item.event && typeof item.event === 'object') {
      const e = item.event as Record<string, unknown>;
      const event: ToolEvent = {
        eventType: String(e.event_type ?? 'tool'),
        toolName: typeof e.tool_name === 'string' ? e.tool_name : undefined,
        toolInput: e.tool_input,
        result: typeof e.result === 'string' ? e.result : undefined,
        error: typeof e.error === 'string' ? e.error : undefined,
        toolUseId: typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined,
        durationMs: typeof e.duration_ms === 'number' ? e.duration_ms : undefined,
      };
      out.push({ kind: 'tool', event, at });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Keep the history boundary tolerant of both the current camelCase response
 * and older/raw DB-style keys. Invalid entries are ignored instead of making
 * the whole conversation impossible to reopen. */
export function toHistoryAttachments(value: unknown): HistoryAttachment[] {
  if (!Array.isArray(value)) return [];
  const result: HistoryAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const path = String(raw.minioPath ?? raw.filePath ?? raw.object_name ?? raw.path ?? '').trim();
    if (!path) continue;
    const name = String(raw.name ?? raw.original_name ?? path.split('/').pop() ?? 'attachment');
    const contentType = String(raw.contentType ?? raw.content_type ?? 'application/octet-stream')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const type = raw.type === 'picture' || contentType.startsWith('image/') ? 'picture' : 'file';
    const numericSize = Number(raw.size ?? raw.file_size ?? 0);
    result.push({
      id: typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : undefined,
      name,
      size: Number.isFinite(numericSize) && numericSize > 0 ? numericSize : 0,
      contentType,
      type,
      path,
      bucket: String(raw.bucket ?? ''),
    });
  }
  return result;
}

/** Resolve only the server-issued Geny chat-workspace reference. The server
 * still performs the authoritative current-user path/access check. */
export function genyHistoryWorkspacePath(attachment: HistoryAttachment): string | null {
  const marker = 'geny-workspace:';
  const rawPath = String(attachment.path ?? '')
    .replace(/\\/g, '/')
    .trim();
  if (!rawPath.startsWith(marker) && attachment.bucket !== 'geny-workspace') return null;
  let path = rawPath.startsWith(marker) ? rawPath.slice(marker.length) : rawPath;
  path = path.replace(/^\/+/, '');
  if (path.startsWith('workspace/')) path = path.slice('workspace/'.length);
  const parts = path.split('/');
  // 첨부가 놓이는 자리: uploads/users_<번호>/<대화>/<파일>. 그 앞에 올라간
  // 파일은 uploads/users/<번호>/<대화>/<첨부>/<파일> 에 그대로 있어 함께 받는다.
  const inAttachmentTree =
    /^uploads\/users_[^/]+\//.test(path) || path.startsWith('uploads/users/');
  if (!inAttachmentTree || parts.some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return path;
}

/** 서버가 준 turn 값(문자열/멀티모달 배열/구조화 dict)을 **표시용 문자열**로.
 *
 *  - 문자열: 그대로.
 *  - 멀티모달 content 배열: text 블록만 이어 붙이고, 이미지 등은 표식으로.
 *  - 그 외(dict/number/…): JSON 으로. (렌더가 절대 non-string 을 받지 않게.)
 */
export function toDisplayText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return stripBrowserContext(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((b) => {
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (typeof b === 'object') {
        const o = b as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        const t = typeof o.type === 'string' ? o.type : '';
        if (t.includes('image')) return '[이미지]';
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      }
      return String(b);
    });
    return stripBrowserContext(parts.filter(Boolean).join('\n'));
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 채팅 화면이 보내는 봉투의 키 전부 — JSON 문자열을 봉투로 읽는 기준(서버 turn_input 과 같다). */
const ENVELOPE_KEYS = new Set(['input_str', 'attachments']);

/**
 * 첨부를 함께 보낸 턴의 입력 봉투 `{input_str, attachments}` — 아니면 null.
 *
 * dict 는 본문 키(`input_str`·`input`)만 있으면 봉투다. JSON 문자열은 봉투의 키만 가진 것만 본다 —
 * 그 밖의 키가 있으면 사람이 붙여 넣은 JSON 일 수 있다.
 */
function inputEnvelope(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return 'input_str' in o || 'input' in o ? o : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s.startsWith('{') || !s.includes('"input_str"')) return null;
  try {
    const d = JSON.parse(s) as unknown;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const keys = Object.keys(d);
    return keys.includes('input_str') && keys.every((k) => ENVELOPE_KEYS.has(k)) ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 턴의 질문 → **사람이 보낸 본문**.
 *
 * 첨부를 함께 보낸 턴의 입력은 `{input_str, attachments}` 다. 옛 서버는 이 모양을 도는 턴의 기록과
 * 턴 시작·종료 프레임에 그대로 실었고, 받은 화면은 질문 말풍선에 JSON 을 통째로 그렸다(2026-10-01
 * 모바일 실측). 서버가 고쳐져도 이미 남은 기록이 있으므로 읽는 쪽도 같은 규칙으로 벗긴다.
 */
export function turnInputText(v: unknown): string {
  const envelope = inputEnvelope(v);
  if (envelope) return toDisplayText(envelope.input_str ?? envelope.input ?? '');
  return toDisplayText(v);
}

/** 질문에 붙은 파일 — 말풍선에 이름표로 그린다. 내용은 서버 워크스페이스에 있다. */
export interface TurnAttachment {
  name: string;
  kind: 'image' | 'file';
  mimeType?: string;
  size?: number;
  /** 서버 워크스페이스 안의 자리(uploads/…). 없으면 옛 웹 첨부다. */
  workspacePath?: string;
}

/**
 * 첨부 목록 → {@link TurnAttachment}. 턴 프레임의 `attachments` 도, 입력 봉투도 받는다 —
 * 둘은 같은 모양(snake_case)이다. 모양이 어긋난 칸은 버린다.
 */
export function turnAttachments(value: unknown): TurnAttachment[] {
  const list = Array.isArray(value) ? value : inputEnvelope(value)?.attachments;
  if (!Array.isArray(list)) return [];
  const out: TurnAttachment[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const path = String(item.workspace_path ?? item.workspacePath ?? '').trim();
    const name = String(item.name ?? '').trim() || path.split('/').pop() || '';
    if (!name) continue;
    const mimeType = String(item.mime_type ?? item.mimeType ?? item.content_type ?? '').trim();
    const kind =
      item.kind === 'image' || item.kind === 'file'
        ? item.kind
        : mimeType.startsWith('image/')
          ? 'image'
          : 'file';
    const size = Number(item.size ?? 0);
    out.push({
      name,
      kind,
      ...(mimeType ? { mimeType } : {}),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      ...(path ? { workspacePath: path } : {}),
    });
  }
  return out;
}

/**
 * 한 행의 첨부 — 서버가 이어 둔 것이 없으면 입력 봉투에서 되살린다.
 *
 * 옛 서버는 도는 턴의 첨부를 완결 때만 이었다. 그동안 대화를 연 화면에서도 질문의 첨부가 보이도록,
 * 서버가 이을 때와 같은 자리(`geny-workspace:` 참조)로 만든다.
 */
function rowAttachments(r: RawIoLog): HistoryAttachment[] {
  const linked = toHistoryAttachments(r.attachments);
  if (linked.length > 0) return linked;
  return turnAttachments(r.input_data)
    .filter((a) => a.workspacePath)
    .map((a) => ({
      name: a.name,
      size: a.size ?? 0,
      contentType: a.mimeType ?? (a.kind === 'image' ? 'image/png' : 'application/octet-stream'),
      type: a.kind === 'image' ? ('picture' as const) : ('file' as const),
      path: `geny-workspace:${(a.workspacePath ?? '').replace(/^workspace\//, '')}`,
      bucket: 'geny-workspace',
    }));
}

interface RawInteraction {
  id: number;
  interaction_id: string;
  workflow_id: string;
  workflow_name: string;
  interaction_count?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  agent_deleted?: boolean;
}

/** 한 번에 받는 대화 수(서버 상한 100). */
const CONVERSATION_PAGE_SIZE = 40;
/** `conversations()` 가 끝까지 따라가는 쪽 수 상한. 사이드바가 아닌 호출자(검색·복원)용. */
const CONVERSATIONS_ALL_MAX_PAGES = 10;

export class HistoryApi {
  constructor(private http: HttpClient) {}

  /** Ordered turns of one conversation. */
  async turns(workflowId: string, interactionId: string, workflowName?: string): Promise<HistoryTurn[]> {
    return (await this.snapshot(workflowId, interactionId, workflowName)).turns;
  }

  /**
   * 지난 턴들 + **지금 도는 턴이 있는가**, 한 번의 호출로.
   *
   * 서버는 실행을 연결이 아니라 대화에 매어 둔다 — 웹에서 시작한 턴이 앱을 켠
   * 순간에도 돌고 있을 수 있다. `running` 을 함께 읽지 않으면 여기서는 대화가
   * 끝난 것처럼 보이고, 그 위에 새 턴을 보내 같은 대화에서 둘이 겹친다.
   */
  async snapshot(
    workflowId: string,
    interactionId: string,
    workflowName?: string,
  ): Promise<ConversationSnapshot> {
    const params = new URLSearchParams({ workflow_id: workflowId, interaction_id: interactionId });
    if (workflowName) params.set('workflow_name', workflowName);
    const res = await this.http.get<{ in_out_logs?: RawIoLog[]; running?: boolean }>(
      `/api/chat/io-logs?${params}`,
    );
    const turns = (res.in_out_logs ?? []).map((r) => ({
      logId: r.log_id,
      ioId: r.io_id,
      interactionId: r.interaction_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      input: turnInputText(r.input_data),
      output: toDisplayText(r.output_data),
      attachments: rowAttachments(r),
      updatedAt: r.updated_at,
      process: toHistoryProcess(r.process),
    }));
    // 구버전 서버(필드 없음)에서는 false — "모른다" 를 "돌고 있다" 로 읽으면
    // 작성기가 영원히 잠긴다. 모르면 평소처럼 쓸 수 있어야 한다.
    return { turns, running: res.running === true };
  }

  /**
   * 대화 목록 한 쪽: 마지막으로 말한 순서, 커서로 이어 받는다(GET /api/interaction/conversations).
   *
   * 그 API 가 없는 옛 서버(404)에서는 옛 목록을 한 번에 읽어 같은 규칙으로 제목·꼬리표를 만들고
   * 비교 파생을 접어 한 쪽으로 돌려준다. 옛 서버는 마지막 활동 시각을 적지 않아 순서는 시작 순이다.
   */
  async conversationPage(
    opts: { limit?: number; cursor?: string | null; kind?: ConversationKind; workflowId?: string } = {},
  ): Promise<ConversationPage> {
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(100, opts.limit ?? CONVERSATION_PAGE_SIZE))),
    });
    if (opts.cursor) params.set('cursor', opts.cursor);
    const kind = opts.kind && opts.kind !== 'all' ? opts.kind : undefined;
    if (kind) params.set('kind', kind);
    const workflowId = opts.workflowId || undefined;
    if (workflowId) params.set('workflow_id', workflowId);
    try {
      const res = await this.http.get<{
        conversations?: unknown[];
        next_cursor?: string | null;
        agent_deleted_count?: number;
        total?: number;
        kind?: string;
        workflow_id?: string | null;
      }>(`/api/interaction/conversations?${params}`);
      let conversations = (res.conversations ?? []).map(parseConversation).filter((c): c is Conversation => c != null);
      // 상태·에이전트 필터를 모르는 옛 서버(답에 kind·workflow_id 가 없다)면 받은 쪽을 같은 판정으로 거른다.
      // 그때 총 수는 모른다.
      const kindIgnored = !!kind && res.kind !== kind;
      const agentIgnored = !!workflowId && res.workflow_id !== workflowId;
      const filtered = kindIgnored || agentIgnored;
      if (kindIgnored) conversations = conversations.filter((c) => conversationMatchesKind(c, kind));
      if (agentIgnored) conversations = conversations.filter((c) => c.workflowId === workflowId);
      return {
        conversations,
        nextCursor: res.next_cursor ?? null,
        ...(typeof res.agent_deleted_count === 'number' ? { agentDeletedCount: res.agent_deleted_count } : {}),
        ...(!filtered && typeof res.total === 'number' ? { total: res.total } : {}),
      };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404 || opts.cursor) throw e;
    }
    const legacy = await this.legacyConversations();
    const shown = legacy.filter(
      (c) => conversationMatchesKind(c, kind) && (!workflowId || c.workflowId === workflowId),
    );
    return {
      conversations: shown,
      nextCursor: null,
      agentDeletedCount: legacy.filter((c) => c.agentDeleted).length,
      total: shown.length,
    };
  }

  /**
   * 사이드바 [에이전트]: 대화가 있는 에이전트마다 한 줄, 마지막으로 말한 순서(GET /api/interaction/conversations/agents).
   * 그 API 가 없는 옛 서버(404)에서는 대화 목록을 받아 같은 규칙으로 묶는다(@dex/protocol conversation-agents).
   */
  async conversationAgents(opts: { limit?: number } = {}): Promise<ConversationAgent[]> {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(500, opts.limit ?? 200))) });
    try {
      const res = await this.http.get<{ agents?: unknown[] }>(`/api/interaction/conversations/agents?${params}`);
      return (res?.agents ?? [])
        .map(parseConversationAgent)
        .filter((a): a is ConversationAgent => a != null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    return groupConversationsByAgent(await this.conversations());
  }

  /** 대화 목록 전부(쪽을 따라간다, 상한 있음). 사이드바는 {@link conversationPage} 로 나눠 받는다. */
  async conversations(): Promise<Conversation[]> {
    const out: Conversation[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < CONVERSATIONS_ALL_MAX_PAGES; i += 1) {
      const page: ConversationPage = await this.conversationPage({ limit: 100, cursor });
      for (const c of page.conversations) {
        const key = `${c.workflowId}\u0000${c.interactionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * 채팅 검색: 제목·에이전트 이름·대화 내용으로 내 대화를 찾는다(GET /api/interaction/conversations/search).
   * 규칙은 서버 한 곳에 있다(conversation-search.ts 머리말). 순서는 마지막으로 말한 순서.
   *
   * 그 API 가 없는 옛 서버(404)에서는 대화 목록을 받아 제목·에이전트 이름만으로 찾는다
   * (`contentSearched: false`, 화면은 내용까지 찾지 못했다고 알린다).
   */
  async searchConversations(
    query: string,
    opts: { limit?: number; kind?: ConversationKind } = {},
  ): Promise<ConversationSearchPage> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 30));
    const q = query.trim();
    if (!searchTerms(q).length) return { query: q, terms: [], hits: [], hasMore: false, contentSearched: true };
    const kind = opts.kind && opts.kind !== 'all' ? opts.kind : undefined;
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (kind) params.set('kind', kind);
    try {
      const res = await this.http.get<{
        query?: string;
        terms?: unknown[];
        results?: unknown[];
        has_more?: boolean;
        kind?: string;
      }>(`/api/interaction/conversations/search?${params}`);
      let hits = (res?.results ?? [])
        .map(parseConversationSearchHit)
        .filter((h): h is ConversationSearchHit => h != null);
      // 상태 필터를 모르는 서버면 같은 판정으로 거른다.
      if (kind && res?.kind !== kind) hits = hits.filter((h) => conversationMatchesKind(h.conversation, kind));
      return {
        query: typeof res?.query === 'string' ? res.query : q,
        terms: (res?.terms ?? []).filter((t): t is string => typeof t === 'string'),
        hits,
        hasMore: res?.has_more === true,
        contentSearched: true,
      };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    const all = (await this.conversations()).filter((c) => conversationMatchesKind(c, kind));
    return searchConversationList(all, q, limit);
  }

  /** 옛 서버의 목록(/api/interaction/list) → 같은 모양. */
  private async legacyConversations(): Promise<Conversation[]> {
    const res = await this.http.get<{ execution_meta_list?: RawInteraction[] }>('/api/interaction/list');
    return foldLegacyConversations((res.execution_meta_list ?? []).map(legacyConversation));
  }

  /**
   * 이름 바꾸기(내 대화만). 빈 이름이면 붙인 이름을 지워 첫 메시지 제목으로 돌아간다.
   * 목록 순서는 그대로다. 바뀐 제목은 대화 목록 소켓으로 다른 화면에도 간다.
   */
  async renameConversation(
    workflowId: string,
    interactionId: string,
    title: string,
  ): Promise<{ title: string; customTitle: boolean }> {
    const res = await this.http.post<{ title?: string; custom_title?: boolean }>(
      '/api/interaction/conversations/rename',
      { workflow_id: workflowId, interaction_id: interactionId, title },
    );
    return { title: typeof res?.title === 'string' ? res.title : '', customTitle: res?.custom_title === true };
  }

  /** 대화 지우기. 비교 채팅이면 딸린 파생 스레드까지 서버가 함께 지운다. */
  async deleteConversation(workflowId: string, interactionId: string, workflowName?: string): Promise<void> {
    const params = new URLSearchParams({ workflow_id: workflowId, interaction_id: interactionId, with_compare: 'true' });
    if (workflowName) params.set('workflow_name', workflowName);
    await this.http.del(`/api/chat/io-logs?${params}`);
  }

  /** 에이전트가 사라진 내 대화를 한 번에 지운다. 지운 수를 돌려준다. */
  async purgeDeletedAgentConversations(): Promise<number> {
    const res = await this.http.del<{ deleted_interactions?: number }>('/api/chat/io-logs/orphans');
    return typeof res?.deleted_interactions === 'number' ? res.deleted_interactions : 0;
  }
}
