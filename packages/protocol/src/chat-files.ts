/**
 * 답변에 딸린 파일 — 웹 채팅과 **같은 규칙**으로 고르고, 본문의 표식을 걷어 낸다.
 *
 * 답변의 파일은 두 갈래로 온다.
 *
 *   파일 저장소의 결과물   도구(문서 편집·표 내보내기·그림 생성)가 사용자의 파일 저장소 '결과물' 폴더에
 *                          올린 것. 스트림에서는 `download_artifact` 이벤트로, 이력에서는 서버가 답 끝에
 *                          붙인 표식 `📎 다운로드: [File: 이름]__[Path: …]__[StorageId: n]__[FileId: n]` 으로 온다.
 *   API 응답 임시 파일     API 도구가 받은 파일 — `[이름](/api/agentflow/files/artifacts/<id>/download#token=…)`.
 *
 * 에이전트가 자기 작업 공간에 만든 파일은 따로 고른다(turn-files).
 *
 * 규칙은 웹(@xgen/api-client download-artifacts)과 같다 — 같은 표식을 같은 방식으로 읽어야 한 대화가
 * 웹·데스크톱·모바일에서 같은 단추로 보인다. 예전에는 앱이 둘 다 버려서, 이력을 열면 표식 원문이 본문에
 * 그대로 보였고 받을 단추는 없었다.
 */
import type { HttpClient } from './client';

export interface ChatDownload {
  name: string;
  /** 파일 저장소의 결과물. */
  storageId?: number;
  fileId?: number;
  path?: string;
  /** API 응답 임시 파일. */
  artifactId?: string;
  downloadUrl?: string;
  contentType?: string;
  size?: number;
  expiresAt?: string;
}

/** `download_artifact` 이벤트의 모양 그대로(snake_case). 모양이 어긋난 값은 버린다. */
export interface ChatDownloadPayload {
  file_name?: unknown;
  path?: unknown;
  storage_id?: unknown;
  file_id?: unknown;
  artifact_id?: unknown;
  download_url?: unknown;
  content_type?: unknown;
  size?: unknown;
  expires_at?: unknown;
}

const DOWNLOAD_MARKER_RE =
  /(?:📎\s*다운로드:\s*)?\[File:\s*(.+?)\s*\]__\[Path:\s*([^\]]*)\s*\](?:__\[StorageId:\s*(\d+)\s*\]__\[FileId:\s*(\d+)\s*\])?/g;
const API_ARTIFACT_LINK_RE =
  /\[([^\]]+)\]\((\/api\/agentflow\/files\/artifacts\/([0-9a-fA-F-]{36})\/download(?:[?#]token=[A-Za-z0-9_-]+)?)\)/g;
const API_ARTIFACT_CAPABILITY_RE =
  /^(\/api\/agentflow\/files\/artifacts\/[0-9a-fA-F-]{36}\/download)([?#])token=([A-Za-z0-9_-]+)$/;

/** 임시 파일 주소의 토큰은 주소가 아니라 머리(X-XGEN-Artifact-Token)로 보낸다 — 웹과 같다. */
export function resolveArtifactCapability(
  downloadUrl: string,
): { requestUrl: string; headers: Record<string, string> } | null {
  const match = API_ARTIFACT_CAPABILITY_RE.exec(downloadUrl);
  if (!match) return null;
  return { requestUrl: match[1], headers: { 'X-XGEN-Artifact-Token': match[3] } };
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function nameOf(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '파일';
}

/** 받은 항목 하나를 더한다. 이미 있으면(같은 저장소 파일·같은 임시 파일) 그대로 돌려준다. */
export function mergeChatDownload(existing: readonly ChatDownload[], payload: ChatDownloadPayload): ChatDownload[] {
  const list = existing as ChatDownload[];
  const artifactId = typeof payload.artifact_id === 'string' ? payload.artifact_id.trim() : '';
  const downloadUrl = typeof payload.download_url === 'string' ? payload.download_url.trim() : '';
  const expected = `/api/agentflow/files/artifacts/${artifactId}/download`;
  const suffix = downloadUrl.slice(expected.length);
  if (
    /^[0-9a-fA-F-]{36}$/.test(artifactId) &&
    (downloadUrl === expected || (downloadUrl.startsWith(expected) && /^[?#]token=[A-Za-z0-9_-]+$/.test(suffix)))
  ) {
    if (list.some((item) => item.artifactId === artifactId)) return list;
    return [
      ...list,
      {
        name: nameOf(payload.file_name),
        artifactId,
        downloadUrl,
        contentType: typeof payload.content_type === 'string' ? payload.content_type : undefined,
        size: typeof payload.size === 'number' ? payload.size : undefined,
        expiresAt: typeof payload.expires_at === 'string' ? payload.expires_at : undefined,
      },
    ];
  }
  const storageId = positiveInt(payload.storage_id);
  const fileId = positiveInt(payload.file_id);
  if (storageId === null || fileId === null) return list;
  if (list.some((item) => item.storageId === storageId && item.fileId === fileId)) return list;
  return [
    ...list,
    {
      name: nameOf(payload.file_name),
      path: typeof payload.path === 'string' ? payload.path : undefined,
      storageId,
      fileId,
    },
  ];
}

/** 본문(이력의 답)에 남은 표식에서 파일을 되살린다. */
export function extractChatDownloads(text: unknown): ChatDownload[] {
  if (typeof text !== 'string' || !text) return [];
  let out: ChatDownload[] = [];
  for (const m of text.matchAll(DOWNLOAD_MARKER_RE)) {
    if (!m[3] || !m[4]) continue;
    out = mergeChatDownload(out, { file_name: m[1], path: m[2], storage_id: m[3], file_id: m[4] });
  }
  for (const m of text.matchAll(API_ARTIFACT_LINK_RE)) {
    out = mergeChatDownload(out, { file_name: m[1], download_url: m[2], artifact_id: m[3] });
  }
  return out;
}

/** 단추로 그릴 파일의 표식을 본문에서 지운다. 모르는 표식은 그대로 둔다(지우면 그 파일을 받을 길이 없다). */
export function stripChatDownloadMarkers(text: string, downloads: readonly ChatDownload[] | undefined): string {
  if (!text || !downloads?.length) return text;
  const keys = new Set(downloads.filter((d) => d.fileId && d.storageId).map((d) => `${d.fileId}:${d.storageId}`));
  const out = text
    .replace(DOWNLOAD_MARKER_RE, (marker, rawName: string, rawPath: string, sid?: string, fid?: string) => {
      const key = sid && fid ? `${Number(fid)}:${Number(sid)}` : null;
      const name = rawName.trim();
      const path = rawPath.trim();
      const known = downloads.some((d) => d.name.trim() === name && (!d.path || d.path.trim() === path));
      return (key && keys.has(key)) || known ? '' : marker;
    })
    .replace(API_ARTIFACT_LINK_RE, (marker, _name: string, _url: string, id: string) =>
      downloads.some((d) => d.artifactId === id) ? '' : marker,
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  // 표식이 빠진 자리의 끝 빈 줄은 걷는다 — 남기면 답 말풍선 아래에 빈 줄이 하나 선다.
  return out === text ? text : out.replace(/\s+$/, '');
}

/**
 * 답 한 개의 파일과 보일 본문. 스트림으로 받은 것(`live`)이 먼저, 본문 표식에서 되살린 것이 그 뒤에 붙는다
 * (같은 파일은 한 번). 본문에서는 그 표식을 걷는다.
 */
export function chatAnswerFiles(
  text: string,
  live?: readonly ChatDownload[],
): { text: string; downloads: ChatDownload[] } {
  let downloads: ChatDownload[] = live ? [...live] : [];
  for (const d of extractChatDownloads(text)) {
    downloads = mergeChatDownload(downloads, {
      file_name: d.name,
      path: d.path,
      storage_id: d.storageId,
      file_id: d.fileId,
      artifact_id: d.artifactId,
      download_url: d.downloadUrl,
    });
  }
  return { text: stripChatDownloadMarkers(text, downloads), downloads };
}

const fold = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * 작업 공간에 같은 이름의 파일이 이미 보이면 그 다운로드는 뺀다. 그림 생성 도구는 같은 그림을 작업 공간과
 * 파일 저장소 두 곳에 같은 이름으로 둔다 — 둘 다 그리면 같은 그림이 두 장 보인다.
 */
export function withoutShownFiles(downloads: readonly ChatDownload[], shownNames: Iterable<string>): ChatDownload[] {
  const names = new Set([...shownNames].map(fold));
  if (names.size === 0) return [...downloads];
  return downloads.filter((d) => !names.has(fold(d.name)));
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/** 답 아래에 그림으로 바로 보일 파일인가(확장자). 웹의 이미지 카드와 같은 목록이다. */
export function isChatImageName(name: string | null | undefined): boolean {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  return dot >= 0 && IMAGE_EXT.has(value.slice(dot + 1).toLowerCase());
}

/** 한 파일을 받는 요청 — 경로와 붙일 머리. 모바일은 이것으로 파일을 디스크에 바로 받는다. */
export interface ChatDownloadRequest {
  path: string;
  headers: Record<string, string>;
}

/** 받을 길이 없으면(모양이 어긋남) null. */
export function chatDownloadRequest(item: ChatDownload, opts: { preview?: boolean } = {}): ChatDownloadRequest | null {
  if (item.artifactId && item.downloadUrl) {
    const cap = resolveArtifactCapability(item.downloadUrl);
    if (cap) return { path: cap.requestUrl, headers: cap.headers };
    return item.downloadUrl.startsWith('/api/agentflow/files/artifacts/') ? { path: item.downloadUrl, headers: {} } : null;
  }
  if (item.fileId && item.storageId) {
    return { path: `/api/storage/file/${opts.preview ? 'preview' : 'download'}/${item.fileId}`, headers: {} };
  }
  return null;
}

export class ChatFilesApi {
  constructor(private readonly http: HttpClient) {}

  /** 답의 파일 바이트. `preview` 는 그림을 화면에 그릴 때(파일 저장소의 미리보기 길) 쓴다. */
  download(item: ChatDownload, opts: { preview?: boolean } = {}): Promise<{ bytes: Uint8Array; contentType: string }> {
    const req = chatDownloadRequest(item, opts);
    if (!req) return Promise.reject(new Error('받을 수 없는 파일입니다.'));
    return this.http.getBinary(req.path, { headers: req.headers, timeoutMs: 300_000 });
  }

  /** 서버가 내어 준 임시 파일(작업 공간 → 기기 폴더 복사의 받을 거리)의 바이트. */
  artifactBytes(url: string, token?: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (!url.startsWith('/api/agentflow/files/artifacts/')) return Promise.reject(new Error('임시 파일 주소가 아닙니다.'));
    return this.http.getBinary(url, {
      headers: token ? { 'X-XGEN-Artifact-Token': token } : {},
      timeoutMs: 600_000,
    });
  }
}
