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
