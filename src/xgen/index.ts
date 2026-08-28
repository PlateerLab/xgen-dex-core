import { AgentsApi } from './agents';
import { AuthApi } from './auth';
import { ChatApi } from './chat';
import { HttpClient, type FetchLike } from './client';
import { HistoryApi } from './history';
import type { CurrentUser, LoginResult } from './types';

export interface XgenClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  accessToken?: string;
  refreshToken?: string;
  onAuthFailure?: () => void;
  onTokensRotated?: (accessToken: string, refreshToken?: string) => void;
}

export class XgenClient {
  readonly http: HttpClient;
  readonly auth: AuthApi;
  readonly agents: AgentsApi;
  readonly chat: ChatApi;
  readonly history: HistoryApi;

  private refreshToken?: string;
  private readonly onTokensRotated?: (accessToken: string, refreshToken?: string) => void;
  private refreshing: Promise<string | null> | null = null;
  user: CurrentUser | null = null;

  constructor(options: XgenClientOptions) {
    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      onAuthFailure: options.onAuthFailure,
    });
    if (options.accessToken) this.http.setToken(options.accessToken);
    this.refreshToken = options.refreshToken;
    this.onTokensRotated = options.onTokensRotated;
    this.auth = new AuthApi(this.http);
    this.agents = new AgentsApi(this.http);
    this.chat = new ChatApi(this.http);
    this.history = new HistoryApi(this.http);
  }

  setTokens(accessToken: string | null, refreshToken?: string): void {
    this.http.setToken(accessToken);
    if (refreshToken !== undefined) this.refreshToken = refreshToken;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const result = await this.auth.login(email, password);
    this.http.setToken(result.accessToken);
    this.refreshToken = result.refreshToken;
    this.onTokensRotated?.(result.accessToken, result.refreshToken);
    this.user = {
      userId: result.userId,
      username: result.username,
      isSuperuser: false,
      roles: [],
      permissions: [],
    };
    try {
      const validated = await this.auth.validate(result.accessToken, result.refreshToken);
      if (validated.user) this.user = validated.user;
    } catch {
      // The minimal login identity is still sufficient when validation is temporarily unavailable.
    }
    return result;
  }

  async restoreDetailed(
    accessToken: string,
    refreshToken?: string,
  ): Promise<'valid' | 'invalid' | 'network'> {
    this.http.setToken(accessToken);
    this.refreshToken = refreshToken;
    let networkFailure = false;
    try {
      const validated = await this.auth.validate(accessToken, refreshToken);
      if (validated.newAccessToken) {
        this.http.setToken(validated.newAccessToken);
        this.onTokensRotated?.(validated.newAccessToken, refreshToken);
      }
      if (validated.user) {
        this.user = validated.user;
        return 'valid';
      }
    } catch {
      networkFailure = true;
    }
    if (refreshToken) {
      try {
        const fresh = await this.auth.refresh(refreshToken);
        if (fresh) {
          this.http.setToken(fresh);
          this.onTokensRotated?.(fresh, refreshToken);
          const validated = await this.auth.validate(fresh, refreshToken);
          if (validated.user) {
            this.user = validated.user;
            return 'valid';
          }
        }
        networkFailure = false;
      } catch {
        networkFailure = true;
      }
    }
    return networkFailure ? 'network' : 'invalid';
  }

  getAccessTokenAfterRotation(): string {
    return this.http.getToken();
  }

  async ensureFreshAuth(fallbackRefreshToken?: string): Promise<string | null> {
    if (this.refreshing) return this.refreshing;
    const refreshToken = this.refreshToken ?? fallbackRefreshToken;
    if (!refreshToken) return null;
    this.refreshing = (async () => {
      try {
        const accessToken = await this.auth.refresh(refreshToken);
        if (!accessToken) return null;
        this.http.setToken(accessToken);
        this.refreshToken = refreshToken;
        this.onTokensRotated?.(accessToken, refreshToken);
        return accessToken;
      } catch {
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async logout(): Promise<void> {
    const accessToken = this.http.getToken();
    if (accessToken) await this.auth.logout(accessToken);
    this.http.setToken(null);
    this.refreshToken = undefined;
    this.user = null;
  }
}
