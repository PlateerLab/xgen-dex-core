/**
 * 대화의 폴더 — 서버 사본과 그 모양.
 *
 * 폴더는 대화의 속성이고 물리적으로는 기기 하나(데스크톱·모바일 앱, 웹 브라우저)에 있다.
 * 기기의 장부가 원본이고, 서버는 사본을 들고 **어느 화면에서든** 그것을 보이고 쓰게 한다.
 *
 *   GET  /api/agentflow/conversations/{id}/folders   이 대화의 폴더와 폴더 기기(켜짐/꺼짐)
 *   PUT  /api/agentflow/conversations/{id}/folders   기기가 폴더를 올린다(연결·해제).
 *                                                    다른 기기에 있으면 409 other_device —
 *                                                    takeOver 로 옮긴다([이 기기로 옮기기]).
 *   POST /api/agentflow/conversations/folders/reconcile   기기가 켜질 때 장부 전체를 맞춘다.
 *
 * 화면에는 폴더 이름과 기기만 온다(다른 PC 의 경로는 그 PC 에서만 보인다).
 * 옛 서버(API 없음, 404)면 `get` 은 null, `put`/`reconcile` 은 `unsupported` 로 끝난다.
 */
import { ApiError, type HttpClient } from './client';

export interface ConversationFolderDevice {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
}

export interface ConversationFoldersState {
  interactionId: string;
  /** 폴더가 있는 기기. 폴더가 없으면 null. */
  device: ConversationFolderDevice | null;
  /** 폴더 이름(경로 없음). */
  folders: { id: string; name: string }[];
  updatedAt: string;
}

/** 서버에 올리는 폴더 — 경로는 그 기기의 것(데스크톱은 절대 경로, 모바일·웹은 가상 경로). */
export interface ConversationFolderUpload {
  id: string;
  name: string;
  path: string;
}

export interface ConversationFolderDeviceInfo {
  deviceId: string;
  deviceName: string;
  devicePlatform: string;
}

export type ConversationFoldersPutResult =
  | { ok: true; state: ConversationFoldersState }
  /** 이 대화의 폴더는 다른 기기에 있다 — 옮기려면 takeOver. */
  | { ok: false; code: 'other_device'; state: ConversationFoldersState }
  /** 옛 서버 — 사본이 없다(예전처럼 요청에 실린 폴더만 쓴다). */
  | { ok: false; code: 'unsupported' };

/** 서버 모양(snake) → 화면 모양. 대화 버스의 `folders` 프레임도 같은 모양이다. */
export function parseConversationFolders(raw: unknown, interactionId = ''): ConversationFoldersState {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const device = value.device && typeof value.device === 'object' ? (value.device as Record<string, unknown>) : null;
  const folders = Array.isArray(value.folders) ? value.folders : [];
  return {
    interactionId: String(value.interaction_id ?? interactionId ?? ''),
    device: device && String(device.device_id ?? '')
      ? {
          deviceId: String(device.device_id),
          name: String(device.name ?? device.device_id ?? ''),
          platform: String(device.platform ?? ''),
          online: device.online === true,
        }
      : null,
    folders: folders
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({ id: String(f.id ?? ''), name: String(f.name ?? '') })),
    updatedAt: String(value.updated_at ?? ''),
  };
}

/** 이 기기에서 본 소유 — 폴더가 없음 / 이 기기 / 다른 기기. */
export function folderOwnership(
  state: ConversationFoldersState | null | undefined,
  myDeviceId: string,
): 'none' | 'mine' | 'other' {
  if (!state?.device || !state.folders.length) return 'none';
  return state.device.deviceId === myDeviceId ? 'mine' : 'other';
}

/** 다른 기기의 이름을 사람이 읽을 말로 — "사무실 PC(켜짐)". */
export function folderDeviceLabel(device: ConversationFolderDevice): string {
  return `${device.name || '다른 기기'}(${device.online ? '켜짐' : '꺼짐'})`;
}

function path(interactionId: string): string {
  return `/api/agentflow/conversations/${encodeURIComponent(interactionId)}/folders`;
}

type HttpLike = Pick<HttpClient, 'get' | 'put' | 'post'>;

export class ConversationFoldersApi {
  constructor(private http: HttpLike) {}

  /** 이 대화의 폴더. 옛 서버면 null. */
  async get(interactionId: string): Promise<ConversationFoldersState | null> {
    try {
      return parseConversationFolders(await this.http.get<unknown>(path(interactionId)), interactionId);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  }

  async put(
    interactionId: string,
    device: ConversationFolderDeviceInfo,
    folders: ConversationFolderUpload[],
    opts: { workflowId?: string; takeOver?: boolean } = {},
  ): Promise<ConversationFoldersPutResult> {
    try {
      const raw = await this.http.put<unknown>(path(interactionId), {
        device_id: device.deviceId,
        device_name: device.deviceName,
        device_platform: device.devicePlatform,
        folders: folders.map((f) => ({ id: f.id, name: f.name, path: f.path })),
        workflow_id: opts.workflowId ?? '',
        take_over: opts.takeOver === true,
      });
      return { ok: true, state: parseConversationFolders(raw, interactionId) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const detail = (e.body as { detail?: unknown } | undefined)?.detail;
        return { ok: false, code: 'other_device', state: parseConversationFolders(detail, interactionId) };
      }
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return { ok: false, code: 'unsupported' };
      throw e;
    }
  }

  /** 기기가 켜질 때 — 장부 전체를 맞추고, 옮겨 간 대화(drop)를 돌려받는다. 옛 서버면 null. */
  async reconcile(
    device: ConversationFolderDeviceInfo,
    conversations: { interactionId: string; workflowId?: string; folders: ConversationFolderUpload[] }[],
  ): Promise<{ drop: string[] } | null> {
    try {
      const raw = await this.http.post<{ drop?: unknown }>('/api/agentflow/conversations/folders/reconcile', {
        device_id: device.deviceId,
        device_name: device.deviceName,
        device_platform: device.devicePlatform,
        conversations: conversations.map((c) => ({
          interaction_id: c.interactionId,
          workflow_id: c.workflowId ?? '',
          folders: c.folders.map((f) => ({ id: f.id, name: f.name, path: f.path })),
        })),
      });
      return { drop: Array.isArray(raw?.drop) ? raw.drop.map(String) : [] };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  }
}
