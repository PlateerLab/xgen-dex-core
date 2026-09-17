/**
 * Conversation history + past-conversation listing.
 *
 * - io-logs: the ordered turns of one conversation (workflowId + interactionId).
 * - interactions: the list of past conversations for a sidebar.
 */
import { HttpClient } from './client';
import type { Conversation, ConversationSnapshot, HistoryAttachment, HistoryFlowItem, HistoryTurn, ToolEvent } from './types';
import { stripBrowserContext } from './browser';

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

/** Resolve only the server-issued XGeny chat-workspace reference. The server
 * still performs the authoritative current-user path/access check. */
export function xgenyHistoryWorkspacePath(attachment: HistoryAttachment): string | null {
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

interface RawInteraction {
  id: number;
  interaction_id: string;
  workflow_id: string;
  workflow_name: string;
  interaction_count?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

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
      input: toDisplayText(r.input_data),
      output: toDisplayText(r.output_data),
      attachments: toHistoryAttachments(r.attachments),
      updatedAt: r.updated_at,
      process: toHistoryProcess(r.process),
    }));
    // 구버전 서버(필드 없음)에서는 false — "모른다" 를 "돌고 있다" 로 읽으면
    // 작성기가 영원히 잠긴다. 모르면 평소처럼 쓸 수 있어야 한다.
    return { turns, running: res.running === true };
  }

  /** Past conversations (interactions) for the sidebar. */
  async conversations(): Promise<Conversation[]> {
    const res = await this.http.get<{ execution_meta_list?: RawInteraction[] }>('/api/interaction/list');
    return (res.execution_meta_list ?? []).map((r) => ({
      id: r.id,
      interactionId: r.interaction_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      interactionCount: r.interaction_count ?? 0,
      metadata: r.metadata ?? {},
      createdAt: r.created_at ?? '',
      updatedAt: r.updated_at ?? '',
    }));
  }
}
