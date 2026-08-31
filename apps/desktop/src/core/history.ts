/**
 * Conversation history + past-conversation listing.
 *
 * - io-logs: the ordered turns of one conversation (workflowId + interactionId).
 * - interactions: the list of past conversations for a sidebar.
 */
import { HttpClient } from './client';
import type { Conversation, HistoryAttachment, HistoryTurn } from './types';
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
  if (
    !path.startsWith('uploads/users/') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
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
    const params = new URLSearchParams({ workflow_id: workflowId, interaction_id: interactionId });
    if (workflowName) params.set('workflow_name', workflowName);
    const res = await this.http.get<{ in_out_logs?: RawIoLog[] }>(`/api/chat/io-logs?${params}`);
    return (res.in_out_logs ?? []).map((r) => ({
      logId: r.log_id,
      ioId: r.io_id,
      interactionId: r.interaction_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      input: toDisplayText(r.input_data),
      output: toDisplayText(r.output_data),
      attachments: toHistoryAttachments(r.attachments),
      updatedAt: r.updated_at,
    }));
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
