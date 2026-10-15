/**
 * 대화의 폴더 — 서버 사본과 그 모양.
 *
 * 폴더는 대화의 속성이고 물리적으로는 기기(데스크톱·모바일 앱, 웹 브라우저)에 있다. 한 대화에
 * 여러 기기의 폴더가 함께 붙을 수 있다(에이전트는 사용자 PC 접속에서 폴더 이름으로 고른다).
 * 기기의 장부가 원본이고, 서버는 사본을 들고 **어느 화면에서든** 그것을 보이고 쓰게 한다.
 *
 *   GET  /api/agentflow/conversations/{id}/folders   이 대화의 폴더와 그 기기들(켜짐/꺼짐)
 *   PUT  /api/agentflow/conversations/{id}/folders   기기가 자기 폴더를 올린다(연결·해제).
 *   POST /api/agentflow/conversations/folders/reconcile   기기가 켜질 때 장부 전체를 맞춘다.
 *
 * 대화당 기기 하나만 받는 서버(옛 서버, 표를 아직 바꾸지 않은 서버)는 다른 기기에 폴더가 있으면
 * PUT 을 409 other_device 로 거절한다 — takeOver 로 옮긴다([이 기기로 옮기기]).
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

/** 폴더가 있는 기기 하나와 그 폴더 이름들. */
export interface ConversationFolderDeviceFolders extends ConversationFolderDevice {
  folders: { id: string; name: string }[];
}

export interface ConversationFoldersState {
  interactionId: string;
  /**
   * 폴더가 있는 기기 — 옛 모양. 폴더 기기가 정확히 하나일 때만 온다(둘 이상이면 null:
   * 옛 앱이 "옮겨 갔다" 로 읽고 자기 폴더를 잊지 않게 서버가 비운다).
   */
  device: ConversationFolderDevice | null;
  /** `device` 의 폴더 이름(경로 없음). */
  folders: { id: string; name: string }[];
  /** 폴더가 있는 기기 전부. 이 칸을 모르는 옛 서버면 null(대화당 기기 하나). */
  devices?: ConversationFolderDeviceFolders[] | null;
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
  /** 대화당 기기 하나만 받는 서버에서, 이 대화의 폴더는 다른 기기에 있다 — 옮기려면 takeOver. */
  | { ok: false; code: 'other_device'; state: ConversationFoldersState }
  /** 옛 서버 — 사본이 없다(예전처럼 요청에 실린 폴더만 쓴다). */
  | { ok: false; code: 'unsupported' };

function parseDevice(raw: unknown): ConversationFolderDevice | null {
  const device = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!device || !String(device.device_id ?? '')) return null;
  return {
    deviceId: String(device.device_id),
    name: String(device.name ?? device.device_id ?? ''),
    platform: String(device.platform ?? ''),
    online: device.online === true,
  };
}

function parseFolderNames(raw: unknown): { id: string; name: string }[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({ id: String(f.id ?? ''), name: String(f.name ?? '') }));
}

/** 서버 모양(snake) → 화면 모양. 대화 버스의 `folders` 프레임도 같은 모양이다. */
export function parseConversationFolders(raw: unknown, interactionId = ''): ConversationFoldersState {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const devices = Array.isArray(value.devices)
    ? value.devices.flatMap((d) => {
        const device = parseDevice(d);
        const folders = parseFolderNames((d as Record<string, unknown>).folders);
        return device && folders.length ? [{ ...device, folders }] : [];
      })
    : null;
  return {
    interactionId: String(value.interaction_id ?? interactionId ?? ''),
    device: parseDevice(value.device),
    folders: parseFolderNames(value.folders),
    devices,
    updatedAt: String(value.updated_at ?? ''),
  };
}

/** 이 기기에서 본 소유 — 폴더가 없음 / 이 기기 / 다른 기기(옛 모양, 대화당 기기 하나). */
export function folderOwnership(
  state: ConversationFoldersState | null | undefined,
  myDeviceId: string,
): 'none' | 'mine' | 'other' {
  if (!state?.device || !state.folders.length) return 'none';
  return state.device.deviceId === myDeviceId ? 'mine' : 'other';
}

/** 이 대화에서 다른 기기에 있는 폴더들 — 새 서버는 `devices`, 옛 서버는 `device` 하나로 본다. */
export function otherDeviceFolders(
  state: ConversationFoldersState | null | undefined,
  myDeviceId: string,
): ConversationFolderDeviceFolders[] {
  if (!state) return [];
  if (Array.isArray(state.devices)) return state.devices.filter((d) => d.deviceId !== myDeviceId);
  if (folderOwnership(state, myDeviceId) !== 'other' || !state.device) return [];
  return [{ ...state.device, folders: state.folders }];
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
