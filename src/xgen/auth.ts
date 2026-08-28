import { createHash } from 'node:crypto';
import { HttpClient } from './client';
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
  constructor(private readonly http: HttpClient) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const passwordHash = createHash('sha256').update(password).digest('hex');
    const response = await this.http.post<RawLoginResponse>('/api/auth/login', {
      email,
      password: passwordHash,
      token: null,
    });
    if (!response.success || !response.access_token) {
      throw new Error(response.message || '로그인에 실패했습니다.');
    }
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? undefined,
      tokenType: response.token_type ?? 'bearer',
      userId: response.user_id ?? '',
      username: response.username ?? email,
    };
  }

  async validate(
    accessToken: string,
    refreshToken?: string,
  ): Promise<{ user: CurrentUser | null; newAccessToken?: string }> {
    const response = await this.http.post<RawValidateResponse>(
      '/api/auth/validate-token',
      { token: accessToken, refresh_token: refreshToken },
      { auth: false },
    );
    if (!response.valid) {
      return { user: null, newAccessToken: response.new_access_token ?? undefined };
    }
    return {
      user: {
        userId: response.user_id ?? '',
        username: response.username ?? '',
        isSuperuser: !!response.is_superuser,
        roles: response.roles ?? [],
        permissions: response.permissions ?? [],
      },
      newAccessToken: response.new_access_token ?? undefined,
    };
  }

  async refresh(refreshToken: string): Promise<string | null> {
    const response = await this.http.post<RawLoginResponse>(
      '/api/auth/refresh',
      { refresh_token: refreshToken },
      { auth: false },
    );
    return response.success ? response.access_token : null;
  }

  async logout(accessToken: string): Promise<void> {
    try {
      await this.http.post('/api/auth/logout', { token: accessToken }, { timeoutMs: 8_000 });
    } catch {
      // Logout is best-effort; the local credential is still removed.
    }
  }
}
