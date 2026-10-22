/**
 * Authentication against the XGEN gateway (native Rust routes under /api/auth).
 *
 * Flow: login → {access_token, refresh_token}. Every other call sends
 * `Authorization: Bearer <access_token>`. The current user + permissions are
 * resolved via validate-token (there is no /me endpoint). Access tokens are
 * refreshed with the refresh token.
 */
import { ApiError, HttpClient } from './client';
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

interface RawCliTokenResponse extends RawLoginResponse {
  state?: string;
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
      // Credential rejection belongs to this login, not an older active session.
      { auth: false },
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
    }, { auth: false });
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

  /** Native CLI PKCE exchange. State is mandatory and must be echoed exactly. */
  async exchangeCliCode(
    authorizationCode: string,
    codeVerifier: string,
    state: string,
  ): Promise<LoginResult> {
    if (!state) throw new Error('CLI 인증 state가 없습니다.');
    const res = await this.http.post<RawCliTokenResponse>(
      '/api/auth/cli/token',
      { authorization_code: authorizationCode, code_verifier: codeVerifier, state },
      { auth: false },
    );
    if (res.state !== state) throw new Error('CLI 인증 state가 일치하지 않습니다.');
    if (!res.success || !res.access_token) throw new Error(res.message || 'CLI 인증에 실패했습니다.');
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

  async logout(accessToken: string, refreshToken?: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // HttpClient's JSON timeout ends at headers. A stalled response body must
      // not hold logout (or disposal of an obsolete login) open indefinitely.
      await Promise.race([
        this.revoke(accessToken, refreshToken),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 8000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async revoke(accessToken: string, refreshToken?: string): Promise<void> {
    const options = { auth: false, timeoutMs: 8000 };
    if (accessToken) {
      try {
        await this.http.post('/api/auth/logout', { token: accessToken }, options);
        return;
      } catch (error) {
        // The gateway requires an unexpired access JWT, even when its family
        // still has a usable refresh token. Network/server failures stay best-effort.
        if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) return;
      }
    }
    if (!refreshToken) return;
    try {
      const res = await this.http.post<RawLoginResponse>(
        '/api/auth/refresh', { refresh_token: refreshToken }, options,
      );
      // Revoke the captured family; never adopt this temporary token locally.
      if (res.success && res.access_token) {
        await this.http.post('/api/auth/logout', { token: res.access_token }, options);
      }
    } catch {
      /* logout is best-effort, including expired refresh tokens and offline use */
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
