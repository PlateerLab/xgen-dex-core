/**
 * Per-user SSH servers — the same store the web mypage [SSH 연동 설정] writes to.
 *
 * There is no syncing code here, and that is the point: both surfaces call
 * `/api/agentflow/user-ssh`, so there is only ever one copy. Edit on either side
 * and the other sees it on its next read. A local mirror would have to be
 * reconciled, and every reconciliation strategy eventually resurrects a server
 * the user deleted somewhere else.
 *
 * Credentials never come back from the server — only `has_password` /
 * `has_private_key`. Writes are partial: a key you do not send keeps its stored
 * value, an empty string clears it. That is what lets the UI edit a description
 * without knowing (or destroying) the password.
 */
import { HttpClient } from './client';

const BASE = '/api/agentflow/user-ssh';

export interface SshServer {
  name: string;
  host: string;
  port: number;
  username: string;
  description: string;
  strict_host_key: boolean;
  /** Other server names to hop through, nearest first. */
  jump_via: string[];
  enabled: boolean;
  sort_order: number;
  has_password: boolean;
  has_private_key: boolean;
  has_passphrase: boolean;
  /** 'password' | 'key' | 'password+key' | 'none' — computed server-side. */
  auth: string;
}

export interface SshServerInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  description?: string;
  strict_host_key?: boolean;
  jump_via?: string[];
  enabled?: boolean;
  sort_order?: number;
  /** Plaintext. Omit to keep, `''` to clear. Never echoed back. */
  password?: string;
  private_key?: string;
  passphrase?: string;
}

export interface SshConfig {
  enabled: boolean;
  servers: SshServer[];
  limits: { max_servers: number; max_jump_depth: number };
}

export interface SshTestResult {
  success: boolean;
  latency_ms?: number;
  error?: string;
  /** The dial order actually taken — the only clue to *which* hop broke. */
  hops?: string[];
}

export const EMPTY_SSH_CONFIG: SshConfig = {
  enabled: false,
  servers: [],
  limits: { max_servers: 50, max_jump_depth: 8 },
};

export class SshApi {
  constructor(private http: HttpClient) {}

  getConfig(): Promise<SshConfig> {
    return this.http.get<SshConfig>(`${BASE}/config`);
  }

  /** Master switch only — the server list survives being turned off. */
  setEnabled(enabled: boolean): Promise<SshConfig> {
    return this.http.put<SshConfig>(`${BASE}/config`, { enabled });
  }

  createServer(input: SshServerInput): Promise<SshServer> {
    return this.http.post<SshServer>(`${BASE}/servers`, input);
  }

  /** Partial update. Renaming also rewrites this server out of others' jump paths. */
  updateServer(name: string, input: SshServerInput): Promise<SshServer> {
    return this.http.put<SshServer>(`${BASE}/servers/${encodeURIComponent(name)}`, input);
  }

  /** Refused (400) while another server still lists it as a jump host. */
  deleteServer(name: string): Promise<SshConfig> {
    return this.http.del<SshConfig>(`${BASE}/servers/${encodeURIComponent(name)}`);
  }

  /**
   * Dial it for real, through the jump path.
   *
   * Works regardless of the master switch — you must be able to check a server
   * *before* turning the feature on, otherwise the only order available is
   * "switch it on and hope".
   *
   * The connection is opened by the XGEN server, not this machine: the agent
   * runs there, so that is the only reachability that matters.
   */
  testServer(name: string): Promise<SshTestResult> {
    return this.http.post<SshTestResult>(
      `${BASE}/servers/${encodeURIComponent(name)}/test`,
      {},
      // A three-hop chain can legitimately take a while; the default JSON
      // timeout would report a failure the server never saw.
      { timeoutMs: 70_000 },
    );
  }
}
