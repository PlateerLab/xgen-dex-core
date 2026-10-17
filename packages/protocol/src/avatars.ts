/**
 * Avatars — binary assets + the shared avatar store (xgen-documents).
 *
 * Web(마이페이지 아바타 설정)과 동일한 API 표면:
 *  - 에셋: POST /api/storage/avatar/upload (multipart, zip 모델/사진),
 *          DELETE /api/storage/avatar/{id}
 *  - 스토어: publish / list / download / rate / unpublish
 * per-user config (선택/이름/변형)는 PreferencesApi 가 담당한다.
 */
import { HttpClient, type UploadFileData, type UploadOptions } from './client';
import type { AvatarDescriptor, AvatarRuntime } from './preferences';

export interface StoreAvatar {
  storeId: string;
  name: string;
  description: string;
  runtime: AvatarRuntime;
  publisherUserId: number;
  publisherName: string;
  descriptor: AvatarDescriptor;
  createdAt: number;
  downloads: number;
  ratingAvg: number;
  ratingCount: number;
  myRating: number | null;
}

export class AvatarsApi {
  constructor(private http: HttpClient) {}

  /** Upload one avatar file (model zip or photo) → parsed descriptor. */
  async uploadAsset(
    file: UploadFileData,
    filename: string,
    opts: Pick<UploadOptions, 'signal' | 'onProgress'> = {},
  ): Promise<AvatarDescriptor> {
    // Chunked upload (model zips can be large) — bytes, a Blob or a file-backed source.
    const res = await this.http.upload<{ avatar: AvatarDescriptor }>(
      '/api/storage/avatar/upload',
      [{ name: 'file', file, filename }],
      { timeoutMs: 600_000, ...opts },
    );
    return res.avatar;
  }

  /** Delete an avatar's stored asset tree. */
  async deleteAsset(avatarId: string): Promise<void> {
    await this.http.json('DELETE', `/api/storage/avatar/${avatarId}`);
  }

  // ── store ──────────────────────────────────────────────────────

  async storeList(): Promise<StoreAvatar[]> {
    const res = await this.http.get<{ items: StoreAvatar[] }>('/api/storage/avatar/store/list');
    return res.items || [];
  }

  async storePublish(descriptor: AvatarDescriptor, name: string, description = ''): Promise<StoreAvatar> {
    const res = await this.http.post<{ item: StoreAvatar }>('/api/storage/avatar/store/publish', {
      descriptor,
      name,
      description,
    });
    return res.item;
  }

  /** Add a store avatar to my assets → descriptor with a fresh local id. */
  async storeDownload(storeId: string): Promise<AvatarDescriptor> {
    const res = await this.http.post<{ avatar: AvatarDescriptor }>(`/api/storage/avatar/store/${storeId}/download`, {});
    return res.avatar;
  }

  async storeRate(storeId: string, stars: number): Promise<StoreAvatar> {
    const res = await this.http.post<{ item: StoreAvatar }>(`/api/storage/avatar/store/${storeId}/rate`, { stars });
    return res.item;
  }

  async storeUnpublish(storeId: string): Promise<void> {
    await this.http.json('DELETE', `/api/storage/avatar/store/${storeId}`);
  }
}
