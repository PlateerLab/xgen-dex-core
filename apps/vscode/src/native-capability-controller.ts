import type { DexRpcClient } from '@dex/rpc/client';
import type { NativeCapabilityNotification, NativeCapabilitySnapshot, NativeRpcResult, RpcNotification } from '@dex/rpc';

interface CapabilityScope {
  profile: string;
  serverUrl: string;
  userId: string;
}

export interface NativeCapabilityConfirmation {
  requestId: string;
  agentSessionId: string;
  server: string;
  tool: string;
  args: unknown;
  expiresAt: number;
  argsSha256: string;
}

type ConfirmationPrompt = (request: NativeCapabilityConfirmation) => Promise<boolean | undefined>;

/** A request can only be approved when the modal can show its complete JSON arguments. */
export function nativeCapabilityArgumentDisplay(args: unknown, maximum = 6000): string | null {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(args, null, 2); } catch { return null; }
  return encoded !== undefined && encoded.length <= maximum ? encoded : null;
}

/** Keeps the local capability socket scoped to one verified account and never approves headlessly. */
export class NativeCapabilityController {
  private generation = 0;
  private scope: CapabilityScope | null = null;
  private snapshot: NativeCapabilitySnapshot | null = null;
  private prompting: string | null = null;
  private readonly consumed = new Set<string>();
  private readonly remove: Array<() => void>;

  constructor(private readonly rpc: Pick<DexRpcClient, 'start' | 'request' | 'onNotification' | 'onStateChange' | 'state'>,
    private readonly prompt: ConfirmationPrompt,
    private readonly render: (snapshot: NativeCapabilitySnapshot | null) => void = () => {}) {
    this.remove = [
      rpc.onNotification((notification) => this.notification(notification)),
      rpc.onStateChange((state) => {
        if (state === 'stopped' || state === 'stopping') this.reset(false);
      }),
    ];
  }

  current(): NativeCapabilitySnapshot | null { return this.snapshot; }

  async connect(profile: string, userId: string): Promise<NativeCapabilitySnapshot | null> {
    await this.requireHost();
    const generation = ++this.generation;
    this.scope = null; this.snapshot = null; this.prompting = null; this.consumed.clear(); this.render(null);
    const result = await this.rpc.request<NativeRpcResult>('native/connect-capabilities', { profile, user_id: userId });
    if (generation !== this.generation) return null;
    const scope = this.validateResult(result, profile, userId);
    if (!result.capability_connection) throw new Error('로컬 capability 연결 응답을 확인할 수 없습니다.');
    const snapshot = parseSnapshot(result.capability_connection);
    this.scope = scope; this.accept(snapshot, generation);
    return snapshot;
  }

  async status(profile: string, userId: string): Promise<NativeCapabilitySnapshot | null> {
    await this.requireHost();
    const generation = this.generation;
    const result = await this.rpc.request<NativeRpcResult>('native/capability-status', { profile, user_id: userId });
    if (generation !== this.generation) return null;
    const scope = this.validateResult(result, profile, userId);
    if (!result.capability_connection) throw new Error('로컬 capability 상태를 확인할 수 없습니다.');
    const snapshot = parseSnapshot(result.capability_connection);
    if (this.scope && !sameScope(this.scope, scope)) return null;
    this.scope = scope; this.accept(snapshot, generation);
    return snapshot;
  }

  async disconnect(profile: string, userId: string): Promise<void> {
    await this.requireHost();
    const generation = ++this.generation;
    this.scope = null; this.snapshot = null; this.prompting = null; this.consumed.clear(); this.render(null);
    if (this.rpc.state !== 'ready') return;
    const result = await this.rpc.request<NativeRpcResult>('native/disconnect-capabilities', { profile, user_id: userId });
    if (generation !== this.generation) return;
    this.validateResult(result, profile, userId);
  }

  reset(disconnect = true): void {
    const scope = this.scope;
    this.generation++; this.scope = null; this.snapshot = null; this.prompting = null; this.consumed.clear(); this.render(null);
    if (disconnect && scope && this.rpc.state === 'ready') {
      void this.rpc.request('native/disconnect-capabilities', { profile: scope.profile, user_id: scope.userId }).catch(() => {});
    }
  }

  dispose(): void { this.reset(); for (const remove of this.remove) remove(); }

  private notification(notification: RpcNotification): void {
    if (notification.method !== 'native/capabilities' || !this.scope) return;
    const value = notification.params as Partial<NativeCapabilityNotification> | undefined;
    if (!value || value.view !== 'capabilities' || value.platform_type !== 'vscode'
      || value.profile !== this.scope.profile || value.server_url !== this.scope.serverUrl
      || value.user_id !== this.scope.userId || !value.snapshot) return;
    try { this.accept(parseSnapshot(value.snapshot), this.generation); } catch { /* untrusted notice is ignored */ }
  }

  private accept(snapshot: NativeCapabilitySnapshot, generation: number): void {
    if (generation !== this.generation) return;
    this.snapshot = snapshot; this.render(snapshot);
    const confirmation = snapshot.confirmation;
    if (snapshot.state !== 'confirmation_required' || !confirmation || this.prompting === confirmation.requestId
      || this.consumed.has(confirmation.requestId)) return;
    this.prompting = confirmation.requestId;
    void this.decide(confirmation, generation);
  }

  private async decide(confirmation: NativeCapabilityConfirmation, generation: number): Promise<void> {
    let confirmed = false;
    let timer: number | NodeJS.Timeout | undefined;
    try {
      const remaining = confirmation.expiresAt * 1000 - Date.now();
      if (remaining > 0) {
        const deadline = new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, Math.min(remaining, 2_147_483_647));
          (timer as unknown as { unref?: () => void }).unref?.();
        });
        const decision = await Promise.race<boolean | undefined>([
          this.prompt(confirmation),
          deadline,
        ]);
        confirmed = decision === true && Date.now() < confirmation.expiresAt * 1000;
      }
    } catch { confirmed = false; }
    finally { if (timer) clearTimeout(timer); }
    if (generation !== this.generation || !this.scope || this.prompting !== confirmation.requestId
      || this.snapshot?.confirmation?.requestId !== confirmation.requestId || this.consumed.has(confirmation.requestId)) return;
    this.prompting = null; this.consumed.add(confirmation.requestId);
    try {
      const result = await this.rpc.request<NativeRpcResult>('native/confirm-capability', {
        request_id: confirmation.requestId, confirmed,
      });
      if (generation !== this.generation || !this.scope) return;
      this.validateResult(result, this.scope.profile, this.scope.userId);
      if (result.capability_connection) this.accept(parseSnapshot(result.capability_connection), generation);
    } catch {
      // A denied, expired or already consumed request is terminal for this exact prompt.
    }
  }

  private validateResult(result: NativeRpcResult, profile: string, userId: string): CapabilityScope {
    let serverUrl = '';
    try { serverUrl = new URL(result.server_url).origin; } catch { /* rejected below */ }
    if (result.platform_type !== 'vscode' || result.profile !== profile || result.user_id !== userId
      || serverUrl !== result.server_url) throw new Error('로컬 capability 응답 범위를 확인할 수 없습니다.');
    return { profile, serverUrl, userId };
  }

  private async requireHost(): Promise<void> {
    const initialized = await this.rpc.start();
    if (initialized.capabilities.nativePlatformSession?.platform !== 'vscode'
      || initialized.capabilities.nativePlatformSession.canonicalCapabilities !== true) {
      throw new Error('Canonical capability 연결을 지원하는 CLI가 필요합니다.');
    }
  }
}

function sameScope(left: CapabilityScope, right: CapabilityScope): boolean {
  return left.profile === right.profile && left.serverUrl === right.serverUrl && left.userId === right.userId;
}

function parseSnapshot(value: unknown): NativeCapabilitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const raw = value as Record<string, unknown>;
  if (!['ready', 'confirmation_required', 'executing', 'closed', 'failed'].includes(String(raw.state))
    || !('confirmation' in raw)) throw new TypeError();
  if (raw.confirmation === null) {
    if (raw.state === 'confirmation_required') throw new TypeError();
    return { state: raw.state as NativeCapabilitySnapshot['state'], confirmation: null };
  }
  if (!raw.confirmation || typeof raw.confirmation !== 'object' || Array.isArray(raw.confirmation)) throw new TypeError();
  const confirmation = raw.confirmation as Record<string, unknown>;
  if (typeof confirmation.requestId !== 'string' || typeof confirmation.agentSessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(confirmation.agentSessionId)
    || typeof confirmation.server !== 'string'
    || typeof confirmation.tool !== 'string' || typeof confirmation.expiresAt !== 'number'
    || !Number.isFinite(confirmation.expiresAt) || typeof confirmation.argsSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(confirmation.argsSha256)) throw new TypeError();
  const encoded = JSON.stringify(confirmation.args);
  if (encoded === undefined || encoded.length > 32 * 1024) throw new TypeError();
  return { state: raw.state as NativeCapabilitySnapshot['state'], confirmation: {
    requestId: confirmation.requestId, agentSessionId: confirmation.agentSessionId,
    server: confirmation.server, tool: confirmation.tool,
    args: JSON.parse(encoded), expiresAt: confirmation.expiresAt, argsSha256: confirmation.argsSha256,
  } };
}
