import { HttpClient } from './client';
import type { Conversation, HistoryAttachment, HistoryTurn } from './types';

const BROWSER_CONTEXT_START = '<xgen_browser_context>';
const BROWSER_CONTEXT_END = '</xgen_browser_context>';

interface RawIoLog {
  log_id: number;
  io_id: number;
  interaction_id: string;
  workflow_id: string;
  workflow_name: string;
  input_data: unknown;
  output_data: unknown;
  attachments?: unknown;
  updated_at: string;
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

function stripBrowserContext(text: string): string {
  if (!text.startsWith(BROWSER_CONTEXT_START)) return text;
  const end = text.indexOf(BROWSER_CONTEXT_END);
  if (end < 0) return text;
  return text.slice(end + BROWSER_CONTEXT_END.length).replace(/^\r?\n/, '');
}

function displayText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return stripBrowserContext(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((block) => {
      if (block == null) return '';
      if (typeof block === 'string') return block;
      if (typeof block === 'object') {
        const data = block as Record<string, unknown>;
        if (typeof data.text === 'string') return data.text;
        if (typeof data.type === 'string' && data.type.includes('image')) return '[이미지]';
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      }
      return String(block);
    });
    return stripBrowserContext(parts.filter(Boolean).join('\n'));
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function historyAttachments(value: unknown): HistoryAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: HistoryAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const path = String(raw.minioPath ?? raw.filePath ?? raw.object_name ?? raw.path ?? '').trim();
    if (!path) continue;
    const contentType = String(raw.contentType ?? raw.content_type ?? 'application/octet-stream')
      .split(';', 1)[0]
      .trim()
      .toLocaleLowerCase();
    const size = Number(raw.size ?? raw.file_size ?? 0);
    attachments.push({
      id: typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : undefined,
      name: String(raw.name ?? raw.original_name ?? path.split('/').pop() ?? 'attachment'),
      size: Number.isFinite(size) && size > 0 ? size : 0,
      contentType,
      type: raw.type === 'picture' || contentType.startsWith('image/') ? 'picture' : 'file',
      path,
      bucket: String(raw.bucket ?? ''),
    });
  }
  return attachments;
}

export class HistoryApi {
  constructor(private readonly http: HttpClient) {}

  async turns(workflowId: string, interactionId: string, workflowName?: string): Promise<HistoryTurn[]> {
    const params = new URLSearchParams({ workflow_id: workflowId, interaction_id: interactionId });
    if (workflowName) params.set('workflow_name', workflowName);
    const response = await this.http.get<{ in_out_logs?: RawIoLog[] }>(`/api/chat/io-logs?${params}`);
    return (response.in_out_logs ?? []).map((raw) => ({
      logId: raw.log_id,
      ioId: raw.io_id,
      interactionId: raw.interaction_id,
      workflowId: raw.workflow_id,
      workflowName: raw.workflow_name,
      input: displayText(raw.input_data),
      output: displayText(raw.output_data),
      attachments: historyAttachments(raw.attachments),
      updatedAt: raw.updated_at,
    }));
  }

  async conversations(): Promise<Conversation[]> {
    const response = await this.http.get<{ execution_meta_list?: RawInteraction[] }>('/api/interaction/list');
    return (response.execution_meta_list ?? []).map((raw) => ({
      id: raw.id,
      interactionId: raw.interaction_id,
      workflowId: raw.workflow_id,
      workflowName: raw.workflow_name,
      interactionCount: raw.interaction_count ?? 0,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at ?? '',
      updatedAt: raw.updated_at ?? '',
    }));
  }
}
