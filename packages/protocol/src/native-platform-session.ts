/** Native ceremonies use their own transport; never inherit browser cookies or legacy refresh. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const BYTES32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PLATFORMS = ['desktop', 'mobile', 'cli', 'vscode'] as const;
export type NativePlatform = typeof PLATFORMS[number];
export type NativeDeviceProofPurpose = 'register' | 'approval_request' | 'login' | 'native_refresh';
export interface NativePublicKey { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export interface NativeDeviceIdentity {
  installId: string;
  publicKey: NativePublicKey;
  /** The host owns the private key. Never return private key bytes to this package. */
  signChallenge(purpose: NativeDeviceProofPurpose, challenge: string, signal?: AbortSignal): Promise<string>;
}
export interface NativeAccountCredential { authScope: string; accessToken: string | null }
export interface NativeAccountSource {
  /** A validated account session. Change scope on logout/relogin/account switch, including the same account. */
  current(): NativeAccountCredential | null;
}
export interface NativeDeviceStatus {
  device_id: string;
  state: 'pending' | 'trusted' | 'suspended' | 'revoked';
}
export interface NativeTrustedDevice {
  device_id: string;
  platform: NativePlatform | 'web';
  device_name: string | null;
  registered_at: string;
  last_seen_at: string | null;
  is_default_approver: boolean;
}
export interface NativeTrustOverview {
  enrollment_state: 'first_device_available' | 'first_device_pending' | 'existing_trust' | 'recovery_required' | 'migration_required';
  trusted_devices: NativeTrustedDevice[];
  more_trusted_devices: boolean;
  admin_code_required: boolean;
}
export interface NativeApprovalRequest {
  request_id: string;
  target_device_id: string;
  target_platform: NativePlatform;
  target_device_name: string | null;
  approver_device_id: string;
  approver_platform: 'web';
  state: 'pending';
  requested_at: string;
  expires_at: string;
  confirmation_code: string;
}
interface NativeAccess {
  token_type: 'DPoP' | null;
  access_token: string | null;
  access_expires_at: string | null;
}
export type NativeLoginResult =
  (NativeAccess & { session_id: string; state: 'active'; refresh_token: string })
  | { session_id: string; state: 'pending_takeover'; refresh_token: null;
    token_type: null; access_token: null; access_expires_at: null };
export interface NativeRefreshResult extends NativeAccess {
  session_id: string;
  refreshed: true;
  access_ready: boolean;
  refresh_token: string;
}
export class NativePlatformProtocolError extends Error {}
export class NativeAccountChanged extends Error {
  constructor() { super('Native account credentials unavailable or changed'); }
}
export class NativePlatformHttpError extends Error {
  constructor(readonly status: number) { super(`Native Platform Session request failed: ${status}`); }
}
export class NativePlatformTransportError extends Error {
  constructor() { super('Native Platform Session transport unavailable'); }
}
export class NativeDeviceKeyUnavailable extends Error {
  constructor() { super('Native device key signing unavailable'); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new NativePlatformProtocolError('Invalid Native Platform Session response'); }
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function time(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}
function name(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && [...value].length > 0
    && [...value].length <= 80 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value));
}
function id(value: string): string {
  if (!uuid(value)) throw new TypeError('Invalid native device identifier');
  return value;
}
function status(value: unknown): NativeDeviceStatus {
  const raw = object(value);
  if (!uuid(raw.device_id) || !['pending', 'trusted', 'suspended', 'revoked'].includes(raw.state as string)) invalid();
  return { device_id: raw.device_id, state: raw.state as NativeDeviceStatus['state'] };
}
function challenge(value: unknown, field = 'challenge'): { raw: Record<string, unknown>; value: string } {
  const raw = object(value);
  if (typeof raw[field] !== 'string' || !BYTES32.test(raw[field])
    || !Number.isInteger(raw.expires_in_seconds) || (raw.expires_in_seconds as number) < 1
    || (raw.expires_in_seconds as number) > 300) invalid();
  return { raw, value: raw[field] as string };
}
function access(raw: Record<string, unknown>): NativeAccess {
  if (raw.token_type === null && raw.access_token === null && raw.access_expires_at === null) {
    return { token_type: null, access_token: null, access_expires_at: null };
  }
  if (raw.token_type !== 'DPoP' || typeof raw.access_token !== 'string'
    || raw.access_token.length > 8192 || !JWT.test(raw.access_token) || !time(raw.access_expires_at)) invalid();
  return { token_type: 'DPoP', access_token: raw.access_token, access_expires_at: raw.access_expires_at };
}

export interface NativePlatformSessionOptions {
  origin: string;
  platform: NativePlatform;
  identity: NativeDeviceIdentity;
  account: NativeAccountSource;
  fetch?: typeof fetch;
}

/** One immutable origin/platform/install/key. No disk, credential cache, automatic retry or trust decisions. */
export class NativePlatformSessionClient {
  private readonly origin: string;
  private readonly platform: NativePlatform;
  private readonly installId: string;
  private readonly publicKey: NativePublicKey;
  private readonly sign: NativeDeviceIdentity['signChallenge'];
  private readonly account: NativeAccountSource;
  private readonly fetchImpl: typeof fetch;
  private busy = false;

  constructor(options: NativePlatformSessionOptions) {
    const url = new URL(options.origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new TypeError('Native Platform Session requires an HTTPS origin');
    }
    if (!PLATFORMS.includes(options.platform) || !/^[\x21-\x7e]{16,128}$/.test(options.identity.installId)) {
      throw new TypeError('Invalid native platform or install identifier');
    }
    const key = options.identity.publicKey;
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string'
      || !BYTES32.test(key.x) || !BYTES32.test(key.y)
      || Object.keys(key).some((field) => !['kty', 'crv', 'x', 'y'].includes(field))) {
      throw new TypeError('Expected only a public P-256 JWK');
    }
    this.origin = url.origin;
    this.platform = options.platform;
    this.installId = options.identity.installId;
    this.publicKey = Object.freeze({ ...key });
    this.sign = options.identity.signChallenge.bind(options.identity);
    this.account = options.account;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private credential(requireToken = true): NativeAccountCredential {
    const current = this.account.current();
    if (!current || typeof current.authScope !== 'string' || !current.authScope
      || (current.accessToken !== null && (typeof current.accessToken !== 'string' || !TOKEN.test(current.accessToken)))
      || (requireToken && current.accessToken === null)) throw new NativeAccountChanged();
    return { ...current };
  }
  private unchanged(expected: NativeAccountCredential, requireToken = true): void {
    const current = this.credential(requireToken);
    if (current.authScope !== expected.authScope || (requireToken && current.accessToken !== expected.accessToken)) throw new NativeAccountChanged();
  }
  private async request(path: string, body: object | undefined, credential: NativeAccountCredential | null, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (credential) this.unchanged(credential);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (credential) headers.Authorization = `Bearer ${credential.accessToken}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new NativePlatformTransportError();
    }
    signal?.throwIfAborted();
    if (credential) this.unchanged(credential);
    if (!response.ok) throw new NativePlatformHttpError(response.status);
    let value: unknown;
    try { value = await response.json(); } catch { signal?.throwIfAborted(); invalid(); }
    signal?.throwIfAborted();
    if (credential) this.unchanged(credential);
    return value;
  }
  private async proof(purpose: NativeDeviceProofPurpose, value: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let proof: string;
    try { proof = await this.sign(purpose, value, signal); }
    catch { signal?.throwIfAborted(); throw new NativeDeviceKeyUnavailable(); }
    signal?.throwIfAborted();
    if (typeof proof !== 'string' || proof.length > 8192 || !JWT.test(proof)) throw new NativeDeviceKeyUnavailable();
    return proof;
  }
  /** Avoid overlapping mutating ceremonies on this installation, especially refresh rotation. */
  private async ceremony<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new NativePlatformProtocolError('Native device ceremony already in progress');
    this.busy = true;
    try { return await run(); } finally { this.busy = false; }
  }

  async registrationStatus(signal?: AbortSignal): Promise<NativeDeviceStatus | null> {
    const value = await this.request(`/api/auth/platform-devices/native/${this.platform}/registration/status/${encodeURIComponent(this.installId)}`,
      undefined, this.credential(), signal);
    return value === null ? null : status(value);
  }
  async register(deviceName?: string, signal?: AbortSignal): Promise<NativeDeviceStatus> {
    const trimmed = deviceName?.trim();
    if (trimmed !== undefined && !name(trimmed)) throw new TypeError('Invalid native device name');
    return this.ceremony(async () => {
      const credential = this.credential();
      const path = `/api/auth/platform-devices/native/${this.platform}/registration`;
      const begun = challenge(await this.request(`${path}/challenge`, {
        install_id: this.installId, public_key_jwk: this.publicKey,
      }, credential, signal));
      const proof = await this.proof('register', begun.value, signal);
      const result = status(await this.request(`${path}/complete`, {
        challenge: begun.value, proof_jwt: proof, ...(trimmed === undefined ? {} : { device_name: trimmed }),
      }, credential, signal));
      if (result.state !== 'pending') invalid();
      return result;
    });
  }
  async trustOverview(signal?: AbortSignal): Promise<NativeTrustOverview> {
    const raw = object(await this.request('/api/auth/platform-devices/trust-overview', undefined, this.credential(), signal));
    if (!['first_device_available', 'first_device_pending', 'existing_trust', 'recovery_required', 'migration_required'].includes(raw.enrollment_state as string)
      || !Array.isArray(raw.trusted_devices) || raw.trusted_devices.length > 100
      || typeof raw.more_trusted_devices !== 'boolean' || typeof raw.admin_code_required !== 'boolean') invalid();
    const seen = new Set<string>();
    const devices = raw.trusted_devices.map((value): NativeTrustedDevice => {
      const device = object(value);
      if (!uuid(device.device_id) || seen.has(device.device_id)
        || ![...PLATFORMS, 'web'].includes(device.platform as NativePlatform)
        || !name(device.device_name) || !time(device.registered_at)
        || (device.last_seen_at !== null && !time(device.last_seen_at)) || typeof device.is_default_approver !== 'boolean') invalid();
      seen.add(device.device_id);
      return { device_id: device.device_id, platform: device.platform as NativeTrustedDevice['platform'],
        device_name: device.device_name, registered_at: device.registered_at,
        last_seen_at: device.last_seen_at as string | null, is_default_approver: device.is_default_approver };
    });
    return { enrollment_state: raw.enrollment_state as NativeTrustOverview['enrollment_state'], trusted_devices: devices,
      more_trusted_devices: raw.more_trusted_devices, admin_code_required: raw.admin_code_required };
  }
  async requestApproval(deviceId: string, approverDeviceId: string, signal?: AbortSignal): Promise<NativeApprovalRequest> {
    id(deviceId); id(approverDeviceId);
    if (deviceId === approverDeviceId) throw new TypeError('A native device requires a different browser approver');
    return this.ceremony(async () => {
      const credential = this.credential();
      const path = `/api/me/devices/native/${this.platform}/${deviceId}/approval-requests`;
      const begun = challenge(await this.request(`${path}/begin`, { approver_device_id: approverDeviceId }, credential, signal), 'device_challenge');
      if (!uuid(begun.raw.flow_id)) invalid();
      const proof = await this.proof('approval_request', begun.value, signal);
      const raw = object(await this.request(path, {
        flow_id: begun.raw.flow_id, device_challenge: begun.value, device_proof_jwt: proof,
      }, credential, signal));
      if (!uuid(raw.request_id) || raw.target_device_id !== deviceId || raw.target_platform !== this.platform
        || raw.approver_device_id !== approverDeviceId || raw.approver_platform !== 'web' || raw.state !== 'pending'
        || !name(raw.target_device_name) || !time(raw.requested_at) || !time(raw.expires_at)
        || Date.parse(raw.expires_at) <= Date.parse(raw.requested_at)
        || typeof raw.confirmation_code !== 'string' || !/^\d{6}$/.test(raw.confirmation_code)) invalid();
      return { request_id: raw.request_id, target_device_id: deviceId, target_platform: this.platform,
        target_device_name: raw.target_device_name, approver_device_id: approverDeviceId, approver_platform: 'web',
        state: 'pending', requested_at: raw.requested_at, expires_at: raw.expires_at, confirmation_code: raw.confirmation_code };
    });
  }
  async login(deviceId: string, password: string, signal?: AbortSignal): Promise<NativeLoginResult> {
    id(deviceId);
    if (typeof password !== 'string' || !password || new TextEncoder().encode(password).length > 1024) throw new TypeError('Invalid native login password');
    return this.ceremony(async () => {
      const credential = this.credential();
      const path = '/api/auth/platform-sessions/native/login-key';
      const begun = challenge(await this.request(`${path}/begin`, { device_id: deviceId }, credential, signal));
      if (!uuid(begun.raw.flow_id) || begun.raw.device_id !== deviceId) invalid();
      const proof = await this.proof('login', begun.value, signal);
      const raw = object(await this.request(`${path}/complete`, {
        flow_id: begun.raw.flow_id, device_id: deviceId, challenge: begun.value, proof_jwt: proof, password,
      }, credential, signal));
      if (!uuid(raw.session_id)) invalid();
      const credentials = access(raw);
      if (raw.state === 'pending_takeover') {
        if (credentials.access_token !== null || raw.refresh_token !== null) invalid();
        return { session_id: raw.session_id, state: 'pending_takeover', token_type: null,
          access_token: null, access_expires_at: null, refresh_token: null };
      }
      if (raw.state !== 'active' || typeof raw.refresh_token !== 'string' || !BYTES32.test(raw.refresh_token)) invalid();
      return { session_id: raw.session_id, state: 'active', ...credentials, refresh_token: raw.refresh_token };
    });
  }
  /** Caller must persist the returned rotated credential before using it again. Never retry a completion. */
  async refresh(deviceId: string, sessionId: string, refreshToken: string, signal?: AbortSignal): Promise<NativeRefreshResult> {
    id(deviceId); id(sessionId);
    if (typeof refreshToken !== 'string' || !BYTES32.test(refreshToken)) throw new TypeError('Invalid native refresh credential');
    return this.ceremony(async () => {
      // Scope is checked locally, but NO account Bearer is sent on either refresh request.
      const credential = this.credential(false);
      const path = '/api/auth/platform-sessions/native/refresh';
      const begun = challenge(await this.request(`${path}/begin`, { device_id: deviceId, refresh_token: refreshToken }, null, signal));
      this.unchanged(credential, false);
      if (!uuid(begun.raw.flow_id) || begun.raw.device_id !== deviceId) invalid();
      const proof = await this.proof('native_refresh', begun.value, signal);
      this.unchanged(credential, false);
      const raw = object(await this.request(`${path}/complete`, {
        flow_id: begun.raw.flow_id, device_id: deviceId, refresh_token: refreshToken, challenge: begun.value, proof_jwt: proof,
      }, null, signal));
      this.unchanged(credential, false);
      const credentials = access(raw);
      if (raw.session_id !== sessionId || raw.refreshed !== true || typeof raw.access_ready !== 'boolean'
        || raw.access_ready !== (credentials.access_token !== null) || typeof raw.refresh_token !== 'string'
        || !BYTES32.test(raw.refresh_token) || raw.refresh_token === refreshToken) invalid();
      return { session_id: sessionId, refreshed: true, access_ready: raw.access_ready,
        ...credentials, refresh_token: raw.refresh_token };
    });
  }
}
