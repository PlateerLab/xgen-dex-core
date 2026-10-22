/** Authentication ownership and ordered persistence, independent of React/native storage. */
export interface MobileSession {
  serverUrl: string;
  accessToken: string;
  refreshToken?: string;
  userId: string;
  username: string;
}

export interface SavedCredentials {
  serverUrl: string;
  email: string;
  password: string;
}

interface AuthClient {
  session: MobileSession;
  api: {
    restore(accessToken: string, refreshToken?: string): Promise<boolean>;
    logout(): Promise<void>;
  };
}

interface AuthPorts<C extends AuthClient> {
  readSession(): Promise<MobileSession | null>;
  readCredentials(): Promise<SavedCredentials | null>;
  writeSession(session: MobileSession | null): Promise<void>;
  writeCredentials(credentials: SavedCredentials | null): Promise<void>;
  writeLastChat(value: string | null): Promise<void>;
  login(server: string, email: string, password: string): Promise<MobileSession>;
  build(session: MobileSession, failed: () => void, rotated: (access: string, refresh?: string) => void): C;
  changed(client: C | null): void;
  log(message: string): void;
}

export class MobileAuthLifecycle<C extends AuthClient> {
  private generation = 0;
  private owned: C | null = null;
  private storage: Promise<void> = Promise.resolve();

  constructor(private readonly ports: AuthPorts<C>) {}

  owns(client: C): boolean {
    return this.owned === client;
  }

  saveLastChat(value: string | null): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (this.current(generation) && this.owned) await this.ports.writeLastChat(value);
    });
  }

  private current(generation: number): boolean {
    return generation === this.generation;
  }

  /** Failed writes cannot break ordering or prevent the next cleanup. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.storage.then(operation);
    this.storage = result.catch((error: unknown) => this.ports.log(`인증 저장 실패: ${String(error)}`));
    return result;
  }

  private save(generation: number, session: MobileSession | null): Promise<void> {
    const snapshot = session ? { ...session } : null;
    return this.enqueue(async () => {
      if (this.current(generation)) await this.ports.writeSession(snapshot);
    });
  }

  private revoke(client: C | null): Promise<void> {
    return client ? client.api.logout().catch(() => undefined) : Promise.resolve();
  }

  private begin(): number {
    const previous = this.owned;
    this.owned = null;
    const generation = ++this.generation;
    this.ports.changed(null);
    void this.revoke(previous);
    return generation;
  }

  private build(generation: number, session: MobileSession): C {
    const client = this.ports.build(session, () => {
      // A late 401 from an old account must not sign the next account out.
      if (this.current(generation) && this.owned === client) void this.logout();
    }, (access, refresh) => {
      if (!this.current(generation) || this.owned !== client) return;
      session.accessToken = access;
      if (refresh !== undefined) session.refreshToken = refresh;
      void this.save(generation, session).catch(() => undefined);
    });
    this.owned = client;
    return client;
  }

  private async authenticate(generation: number, credentials: SavedCredentials, remember: boolean): Promise<void> {
    const session = await this.ports.login(credentials.serverUrl, credentials.email, credentials.password);
    if (!this.current(generation)) {
      // The request may have issued a fresh server session after logout/account change.
      await this.revoke(this.ports.build(session, () => {}, () => {}));
      return;
    }
    const client = this.build(generation, session);
    try {
      await this.save(generation, session);
      await this.enqueue(async () => {
        if (this.current(generation)) {
          await this.ports.writeCredentials(remember ? { ...credentials, serverUrl: session.serverUrl } : null);
        }
      });
      if (this.current(generation)) this.ports.changed(client);
    } catch (error) {
      if (this.current(generation)) await this.logout();
      throw error;
    }
  }

  async login(server: string, email: string, password: string, remember: boolean): Promise<void> {
    const generation = this.begin();
    // Queue deletion ahead of a new account's writes, including an older pending write.
    await this.enqueue(async () => {
      if (this.current(generation)) {
        await Promise.allSettled([
          this.ports.writeSession(null), this.ports.writeCredentials(null), this.ports.writeLastChat(null),
        ]);
      }
    });
    if (this.current(generation)) {
      await this.authenticate(generation, { serverUrl: server, email, password }, remember);
    }
  }

  async bootstrap(): Promise<void> {
    const generation = this.begin();
    try {
      await this.storage;
      if (!this.current(generation)) return;
      const session = await this.ports.readSession();
      if (!this.current(generation)) return;
      if (session) {
        const client = this.build(generation, session);
        const alive = await client.api.restore(session.accessToken, session.refreshToken).catch(() => false);
        if (!this.current(generation)) return;
        if (alive) {
          this.ports.changed(client);
          return;
        }
        this.owned = null;
        void this.revoke(client);
        await this.save(generation, null);
      }
      if (!this.current(generation)) return;
      const credentials = await this.ports.readCredentials();
      if (credentials && this.current(generation)) await this.authenticate(generation, credentials, true);
    } catch (error) {
      this.ports.log(`자동 로그인 실패: ${String(error)}`);
    }
  }

  async logout(): Promise<void> {
    const previous = this.owned;
    this.owned = null;
    ++this.generation;
    this.ports.changed(null);
    // Retirement happens synchronously; storage and server failures are independent.
    const revocation = this.revoke(previous);
    const cleanup = this.enqueue(async () => {
      await Promise.allSettled([
        this.ports.writeSession(null),
        this.ports.writeCredentials(null),
        this.ports.writeLastChat(null),
      ]);
    });
    await Promise.allSettled([revocation, cleanup]);
  }
}
