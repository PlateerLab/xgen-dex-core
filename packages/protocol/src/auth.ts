/**
 * Authentication against the XGEN gateway (native Rust routes under /api/auth).
 *
 * Flow: login → {access_token, refresh_token}. Every other call sends
 * `Authorization: Bearer <access_token>`. The current user + permissions are
 * resolved via validate-token (there is no /me endpoint). Access tokens are
 * refreshed with the refresh token.
 */
import { HttpClient } from './client';
import { sha256Hex } from './hash';
import type { CurrentUser, LoginResult } from './types';

interface RawLoginResponse {
  success: boolean;
  message?: string;
  access_token: string | null;
  refresh_token: string | null;
  token_type?: string;
  user_id?: string;
  username?: string;
}

interface RawValidateResponse {
  valid: boolean;
  user_id?: string;
  username?: string;
  is_superuser?: boolean;
  roles?: string[];
  permissions?: string[];
  new_access_token?: string | null;
}

export class AuthApi {
  constructor(private http: HttpClient) {}

  /**
   * Log in with email + plaintext password. The password is SHA-256-hex hashed
   * before sending (the gateway compares the hash verbatim). Returns tokens +
   * identity. Throws ApiError on bad credentials / locked / inactive account.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const passwordHash = await sha256Hex(password);
    const res = await this.http.post<RawLoginResponse>(
      '/api/auth/login',
      { email, password: passwordHash, token: null },
      // login itself must not trigger the onAuthFailure hook
    );
    if (!res.success || !res.access_token) {
      throw new Error(res.message || '로그인에 실패했습니다.');
    }
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? undefined,
      tokenType: res.token_type ?? 'bearer',
      userId: res.user_id ?? '',
      username: res.username ?? email,
    };
  }

  /** SSO login with a pre-obtained token. */
  async loginWithToken(ssoToken: string): Promise<LoginResult> {
    const res = await this.http.post<RawLoginResponse>('/api/auth/login', {
      token: ssoToken,
    });
    if (!res.success || !res.access_token) {
      throw new Error(res.message || 'SSO 로그인에 실패했습니다.');
    }
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? undefined,
      tokenType: res.token_type ?? 'bearer',
      userId: res.user_id ?? '',
      username: res.username ?? '',
    };
  }

  /**
   * Validate the access token and return the current user + permissions. If the
   * access token is expired and a refresh token is supplied, the gateway may
   * return a rotated access token in `newAccessToken`.
   */
  async validate(
    accessToken: string,
    refreshToken?: string,
  ): Promise<{ user: CurrentUser | null; newAccessToken?: string }> {
    const res = await this.http.post<RawValidateResponse>(
      '/api/auth/validate-token',
      { token: accessToken, refresh_token: refreshToken },
      { auth: false },
    );
    if (!res.valid) return { user: null, newAccessToken: res.new_access_token ?? undefined };
    return {
      user: {
        userId: res.user_id ?? '',
        username: res.username ?? '',
        isSuperuser: !!res.is_superuser,
        roles: res.roles ?? [],
        permissions: res.permissions ?? [],
      },
      newAccessToken: res.new_access_token ?? undefined,
    };
  }

  /** Exchange a refresh token for a fresh access token. */
  async refresh(refreshToken: string): Promise<string | null> {
    const res = await this.http.post<RawLoginResponse>(
      '/api/auth/refresh',
      { refresh_token: refreshToken },
      { auth: false },
    );
    return res.success ? res.access_token : null;
  }

  async logout(accessToken: string): Promise<void> {
    try {
      await this.http.post('/api/auth/logout', { token: accessToken }, { timeoutMs: 8000 });
    } catch {
      /* logout is best-effort */
    }
  }

  /** Server session policy (timeouts) — useful for a refresh scheduler. */
  async sessionConfig(): Promise<{
    session_timeout_min?: number;
    inactivity_timeout_min?: number;
    refresh_token_ttl_days?: number;
    server_now_epoch_ms?: number;
  }> {
    return this.http.get('/api/auth/session-config', { timeoutMs: 8000 });
  }
}
