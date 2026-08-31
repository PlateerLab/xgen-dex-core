/**
 * User preferences — the per-user avatar config lives in xgen-core
 * `preferences.avatar` and is read via the profile endpoint. The connector shows
 * the user's DEFAULT avatar globally (not per-session), so this is the only
 * avatar source the overlay needs.
 */
import { HttpClient } from './client';

export type AvatarRuntime = 'live2d' | 'spine' | 'image';

export interface AvatarDescriptor {
  id: string;
  name: string;
  runtime: AvatarRuntime;
  source: string;
  modelUrl: string; // e.g. /api/storage/avatar/{user}/{id}/x.model3.json (relative)
  atlasUrl?: string;
  thumbnail?: string | null;
  scale?: number;
  position?: { x: number; y: number };
  idleMotionGroupName?: string;
  emotionMap?: Record<string, number>;
  emotionMotionMap?: Record<string, string>;
  tapMotions?: Record<string, Record<string, number>>;
  hiddenParts?: string[];
}

export interface AvatarConfig {
  enabled: boolean;
  defaultAvatarId: string | null;
  avatars: AvatarDescriptor[];
}

export const EMPTY_AVATAR_CONFIG: AvatarConfig = { enabled: false, defaultAvatarId: null, avatars: [] };

interface RawProfile {
  // preferences may arrive as a parsed object OR (defensively) a JSON string.
  user?: { preferences?: Record<string, unknown> | string | null } | null;
}

export class PreferencesApi {
  constructor(private http: HttpClient) {}

  /** GET /api/admin/user → preferences.avatar.
   *
   *  THROWS on failure (network / 401 / not-yet-authenticated) rather than
   *  returning an empty config: at startup the overlay's fetch can beat the
   *  main window's session restore, and masking that as `{enabled:false}` made
   *  the avatar look permanently absent. Propagating lets the caller retry until
   *  the client is authed. A genuinely empty config (feature off) still returns
   *  normally. */
  async getAvatarConfig(): Promise<AvatarConfig> {
    const res = await this.http.get<RawProfile>('/api/admin/user');
    if (!res || !res.user) {
      // Unauthenticated pass-through / no profile yet → not a real answer.
      throw new Error('avatar config: no authenticated profile');
    }
    let prefs: unknown = res.user.preferences ?? {};
    if (typeof prefs === 'string') {
      try {
        prefs = JSON.parse(prefs);
      } catch {
        prefs = {};
      }
    }
    const raw = ((prefs as Record<string, unknown> | null)?.avatar ?? {}) as Partial<AvatarConfig>;
    return {
      enabled: !!raw.enabled,
      defaultAvatarId: typeof raw.defaultAvatarId === 'string' ? raw.defaultAvatarId : null,
      avatars: Array.isArray(raw.avatars) ? (raw.avatars as AvatarDescriptor[]) : [],
    };
  }

  /** Persist the whole avatar config (PUT shallow-merges preferences top-level,
   *  so sending {avatar} replaces just that key). Used when the overlay adjusts
   *  the avatar's scale/position in-place. */
  async saveAvatarConfig(config: AvatarConfig): Promise<void> {
    await this.http.put('/api/admin/user', { preferences: { avatar: config } });
  }

  /** Read-modify-write: 서버의 CURRENT config 를 읽어 최소 패치만 적용한다.
   *  화면에 캐시된 스냅샷 전체를 저장하면 그 사이의 변경(선택 등)을 조용히
   *  되돌린다 — 모든 부분 수정은 반드시 이 경로를 쓴다. */
  async mutateAvatarConfig(mutate: (cur: AvatarConfig) => AvatarConfig): Promise<AvatarConfig> {
    const cfg = await this.getAvatarConfig();
    const next = mutate(cfg);
    await this.saveAvatarConfig(next);
    return next;
  }

  /** Persist ONE avatar's scale/position (read-modify-write). */
  async saveAvatarTransform(
    avatarId: string,
    tf: { scale: number; position: { x: number; y: number } },
  ): Promise<void> {
    await this.mutateAvatarConfig((cfg) => ({
      ...cfg,
      avatars: cfg.avatars.map((a) =>
        a.id === avatarId ? { ...a, scale: tf.scale, position: tf.position } : a,
      ),
    }));
  }

  setAvatarEnabled(enabled: boolean): Promise<AvatarConfig> {
    return this.mutateAvatarConfig((c) => ({ ...c, enabled }));
  }

  selectAvatar(id: string): Promise<AvatarConfig> {
    return this.mutateAvatarConfig((c) => ({ ...c, defaultAvatarId: id }));
  }

  renameAvatar(id: string, name: string): Promise<AvatarConfig> {
    return this.mutateAvatarConfig((c) => ({
      ...c,
      avatars: c.avatars.map((a) => (a.id === id ? { ...a, name } : a)),
    }));
  }

  /** Add an uploaded/downloaded descriptor (optionally renamed); first avatar
   *  becomes the selection. */
  addAvatar(descriptor: AvatarDescriptor, name?: string): Promise<AvatarConfig> {
    return this.mutateAvatarConfig((c) => ({
      ...c,
      avatars: [...c.avatars, { ...descriptor, name: (name ?? descriptor.name) || descriptor.name }],
      defaultAvatarId: c.defaultAvatarId ?? descriptor.id,
    }));
  }

  removeAvatar(id: string): Promise<AvatarConfig> {
    return this.mutateAvatarConfig((c) => {
      const remaining = c.avatars.filter((a) => a.id !== id);
      return {
        ...c,
        avatars: remaining,
        defaultAvatarId: c.defaultAvatarId === id ? (remaining[0]?.id ?? null) : c.defaultAvatarId,
      };
    });
  }
}
