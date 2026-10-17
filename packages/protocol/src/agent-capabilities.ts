/** Canonical Agent Session capability discovery, selection and approval adoption. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TOOL_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const CONNECTION = /^conn_[A-Za-z0-9_-]{32}$/;
const EPOCH = /^epoch_[A-Za-z0-9_-]{32}$/;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SELECTION_BYTES = 16 * 1024;
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'armed', 'consumed', 'expired', 'unavailable'] as const;

export type CapabilityApprovalStatus = typeof APPROVAL_STATUSES[number];

export interface AgentCapabilitiesProofSource {
  accessToken(): Promise<string | null>;
  signProof(method: 'GET' | 'PUT' | 'POST', htu: string, accessToken: string): Promise<string>;
}

export interface AgentCapability {
  capability_id: string;
  server: string;
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  risk: 'high';
  approval_mode: 'per_call';
  device_id: string;
  connection_id: string;
  epoch: string;
  descriptor_hash: string;
}

export interface CapabilityCatalog {
  capabilities: readonly AgentCapability[];
  version: string | null;
  selected_capability_ids: readonly string[];
  expires_at: number | null;
}

export interface SelectCapabilitiesInput {
  capability_ids: readonly string[];
  expected_version: string | null;
}

export interface CapabilitySelection {
  version: string;
  selected_capability_ids: readonly string[];
  expires_at: number;
}

export interface CapabilityApproval {
  approval_id: number;
  intent_version: string;
  status: CapabilityApprovalStatus;
  capability_id: string;
  tool_name: string;
  target_device_id: string;
  args_sha256: string;
  source_turn_id: string;
  expires_at: number;
}

export interface CapabilityApprovalList {
  approvals: readonly CapabilityApproval[];
}

/** UI-facing name for the bounded approval list. */
export type CapabilityApprovalPage = CapabilityApprovalList;

export interface AdoptedCapabilityApproval {
  approval_id: number;
  intent_version: string;
  status: 'armed';
  expires_at: number;
}

export class AgentCapabilitiesProtocolError extends Error {
  constructor() {
    super('Invalid canonical capability response');
    this.name = 'AgentCapabilitiesProtocolError';
  }
}

export class AgentCapabilitiesHttpError extends Error {
  constructor(readonly status: number) {
    super(`Canonical capability request rejected: ${status}`);
    this.name = 'AgentCapabilitiesHttpError';
  }
}

/** A write may have reached the server. Read current state before issuing another logical write. */
export class AgentCapabilitiesOutcomeUnknown extends Error {
  constructor() {
    super('Canonical capability write outcome is unknown');
    this.name = 'AgentCapabilitiesOutcomeUnknown';
  }
}

export class AgentCapabilitiesTransportError extends Error {
  constructor() {
    super('Canonical capability transport unavailable');
    this.name = 'AgentCapabilitiesTransportError';
  }
}

function invalid(): never { throw new AgentCapabilitiesProtocolError(); }
function invalidInput(): never { throw new TypeError('Invalid canonical capability request'); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || !keys.every((key) => typeof key === 'string' && expected.includes(key))) invalid();
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) invalid();
  }
}

function capabilityId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512
    && value.startsWith('cap://device/') && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function unixTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function safeJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (depth >= 32 || !value || typeof value !== 'object') invalid();
  if (Array.isArray(value)) {
    if (value.length > 2048) invalid();
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) invalid();
      result.push(safeJson(value[index], depth + 1));
    }
    return Object.freeze(result);
  }
  const raw = record(value);
  const keys = Reflect.ownKeys(raw);
  if (keys.length > 2048 || keys.some((key) => typeof key !== 'string')) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor)) invalid();
    Object.defineProperty(result, key, { value: safeJson(descriptor.value, depth + 1),
      enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(result);
}

function parseCapability(value: unknown): AgentCapability {
  const raw = record(value);
  fields(raw, ['capability_id', 'server', 'name', 'description', 'inputSchema', 'risk', 'approval_mode',
    'device_id', 'connection_id', 'epoch', 'descriptor_hash']);
  if (!capabilityId(raw.capability_id) || typeof raw.server !== 'string' || !TOOL_ID.test(raw.server)
    || typeof raw.name !== 'string' || !TOOL_ID.test(raw.name) || typeof raw.description !== 'string'
    || [...raw.description].length > 1200 || raw.risk !== 'high' || raw.approval_mode !== 'per_call'
    || typeof raw.device_id !== 'string' || !UUID.test(raw.device_id)
    || typeof raw.connection_id !== 'string' || !CONNECTION.test(raw.connection_id)
    || typeof raw.epoch !== 'string' || !EPOCH.test(raw.epoch)
    || typeof raw.descriptor_hash !== 'string' || !HEX64.test(raw.descriptor_hash)) invalid();
  const schema = safeJson(raw.inputSchema);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)
    || (schema as Record<string, unknown>).type !== 'object') invalid();
  const expectedId = `cap://device/${encodeURIComponent(raw.device_id)}/mcp/${encodeURIComponent(raw.server)}/${encodeURIComponent(raw.name)}`;
  if (raw.capability_id !== expectedId) invalid();
  return Object.freeze({ capability_id: raw.capability_id, server: raw.server, name: raw.name,
    description: raw.description, inputSchema: schema as Readonly<Record<string, unknown>>, risk: 'high',
    approval_mode: 'per_call', device_id: raw.device_id, connection_id: raw.connection_id,
    epoch: raw.epoch, descriptor_hash: raw.descriptor_hash });
}

export function parseCapabilityCatalog(value: unknown): CapabilityCatalog {
  const raw = record(value);
  fields(raw, ['capabilities', 'version', 'selected_capability_ids', 'expires_at']);
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 4096
    || !Array.isArray(raw.selected_capability_ids) || raw.selected_capability_ids.length > 64
    || (raw.version !== null && (typeof raw.version !== 'string' || !UUID.test(raw.version)))
    || (raw.expires_at !== null && !unixTime(raw.expires_at))
    || ((raw.version === null) !== (raw.expires_at === null))) invalid();
  const capabilities = raw.capabilities.map(parseCapability);
  const capabilityIds = new Set<string>();
  for (const item of capabilities) {
    if (capabilityIds.has(item.capability_id)) invalid();
    capabilityIds.add(item.capability_id);
  }
  const selected: string[] = [];
  const selectedIds = new Set<string>();
  for (const value of raw.selected_capability_ids) {
    if (!capabilityId(value) || selectedIds.has(value)) invalid();
    selectedIds.add(value); selected.push(value);
  }
  return Object.freeze({ capabilities: Object.freeze(capabilities), version: raw.version as string | null,
    selected_capability_ids: Object.freeze(selected), expires_at: raw.expires_at as number | null });
}

export function validateSelectCapabilities(value: unknown): SelectCapabilitiesInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidInput();
  const raw = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || !keys.every((key) => key === 'capability_ids' || key === 'expected_version')) invalidInput();
  const idsDescriptor = Object.getOwnPropertyDescriptor(raw, 'capability_ids');
  const versionDescriptor = Object.getOwnPropertyDescriptor(raw, 'expected_version');
  if (!idsDescriptor || !('value' in idsDescriptor) || !versionDescriptor || !('value' in versionDescriptor)
    || !Array.isArray(idsDescriptor.value) || idsDescriptor.value.length > 64
    || (versionDescriptor.value !== null && (typeof versionDescriptor.value !== 'string' || !UUID.test(versionDescriptor.value)))) invalidInput();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < idsDescriptor.value.length; index++) {
    if (!(index in idsDescriptor.value)) invalidInput();
    const id = idsDescriptor.value[index];
    if (!capabilityId(id) || seen.has(id)) invalidInput();
    seen.add(id); ids.push(id);
  }
  return Object.freeze({ capability_ids: Object.freeze(ids), expected_version: versionDescriptor.value as string | null });
}

function parseSelection(value: unknown, requested: readonly string[]): CapabilitySelection {
  const raw = record(value);
  fields(raw, ['version', 'expires_at', 'selected_capability_ids']);
  if (typeof raw.version !== 'string' || !UUID.test(raw.version) || !unixTime(raw.expires_at)
    || !Array.isArray(raw.selected_capability_ids) || raw.selected_capability_ids.length !== requested.length) invalid();
  for (let index = 0; index < requested.length; index++) {
    if (raw.selected_capability_ids[index] !== requested[index]) invalid();
  }
  return Object.freeze({ version: raw.version, expires_at: raw.expires_at,
    selected_capability_ids: Object.freeze([...requested]) });
}

export function parseCapabilityApprovals(value: unknown): CapabilityApprovalList {
  const raw = record(value); fields(raw, ['approvals']);
  if (!Array.isArray(raw.approvals) || raw.approvals.length > 256) invalid();
  const seen = new Set<number>();
  const approvals = raw.approvals.map((value): CapabilityApproval => {
    const item = record(value);
    fields(item, ['approval_id', 'intent_version', 'status', 'capability_id', 'tool_name', 'target_device_id',
      'args_sha256', 'source_turn_id', 'expires_at']);
    if (typeof item.approval_id !== 'number' || !Number.isSafeInteger(item.approval_id) || item.approval_id < 1
      || seen.has(item.approval_id) || typeof item.intent_version !== 'string' || !UUID.test(item.intent_version)
      || typeof item.status !== 'string' || !APPROVAL_STATUSES.includes(item.status as CapabilityApprovalStatus)
      || !capabilityId(item.capability_id) || typeof item.tool_name !== 'string' || !TOOL_ID.test(item.tool_name)
      || typeof item.target_device_id !== 'string' || !UUID.test(item.target_device_id)
      || typeof item.args_sha256 !== 'string' || !HEX64.test(item.args_sha256)
      || typeof item.source_turn_id !== 'string' || !UUID.test(item.source_turn_id) || !unixTime(item.expires_at)
      || !item.capability_id.startsWith(`cap://device/${encodeURIComponent(item.target_device_id)}/mcp/`)
      || !item.capability_id.endsWith(`/${encodeURIComponent(item.tool_name)}`)) invalid();
    seen.add(item.approval_id);
    return Object.freeze({ approval_id: item.approval_id, intent_version: item.intent_version,
      status: item.status as CapabilityApprovalStatus, capability_id: item.capability_id, tool_name: item.tool_name,
      target_device_id: item.target_device_id, args_sha256: item.args_sha256,
      source_turn_id: item.source_turn_id, expires_at: item.expires_at });
  });
  return Object.freeze({ approvals: Object.freeze(approvals) });
}

export const parseCapabilityApprovalPage = parseCapabilityApprovals;

function parseAdopted(value: unknown, approvalId: number): AdoptedCapabilityApproval {
  const raw = record(value); fields(raw, ['approval_id', 'intent_version', 'status', 'expires_at']);
  if (raw.approval_id !== approvalId || typeof raw.intent_version !== 'string' || !UUID.test(raw.intent_version)
    || raw.status !== 'armed' || !unixTime(raw.expires_at)) invalid();
  return Object.freeze({ approval_id: approvalId, intent_version: raw.intent_version, status: 'armed', expires_at: raw.expires_at });
}

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

function parseClosedJson(text: string): unknown {
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[offset] ?? '')) offset++; };
  const string = (): string => {
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const code = text.charCodeAt(offset++);
      if (!escaped && code === 0x22) {
        try { return JSON.parse(text.slice(start, offset)) as string; } catch { invalid(); }
      }
      if (!escaped && code === 0x5c) escaped = true; else escaped = false;
    }
    invalid();
  };
  const value = (depth = 0): unknown => {
    whitespace(); if (depth >= 32 || offset >= text.length) invalid();
    const code = text.charCodeAt(offset);
    if (code === 0x22) return string();
    if (code === 0x7b) {
      offset++; whitespace(); const out: Record<string, unknown> = {}; const seen = new Set<string>();
      if (text.charCodeAt(offset) === 0x7d) { offset++; return out; }
      for (;;) {
        if (text.charCodeAt(offset) !== 0x22) invalid();
        const key = string(); if (seen.has(key)) invalid(); seen.add(key); whitespace();
        if (text.charCodeAt(offset++) !== 0x3a) invalid();
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        whitespace();
        const delimiter = text.charCodeAt(offset++);
        if (delimiter === 0x7d) return out;
        if (delimiter !== 0x2c) invalid(); whitespace();
      }
    }
    if (code === 0x5b) {
      offset++; whitespace(); const out: unknown[] = [];
      if (text.charCodeAt(offset) === 0x5d) { offset++; return out; }
      for (;;) {
        out.push(value(depth + 1)); whitespace();
        const delimiter = text.charCodeAt(offset++);
        if (delimiter === 0x5d) return out;
        if (delimiter !== 0x2c || out.length > 4096) invalid();
      }
    }
    for (const [raw, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(raw, offset)) { offset += raw.length; return parsed; }
    }
    const match = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) invalid(); offset += match[0].length;
    const number = Number(match[0]); if (!Number.isFinite(number)) invalid(); return number;
  };
  const result = value(); whitespace(); if (offset !== text.length) invalid(); return result;
}

async function boundedJson(response: Response, maximum: number, signal?: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { void cancel(response); invalid(); }
  const reader = response.body?.getReader();
  if (!reader) invalid();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) invalid();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return parseClosedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    abort(); signal?.throwIfAborted();
    if (error instanceof AgentCapabilitiesProtocolError) throw error;
    invalid();
  } finally {
    signal?.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* no state escapes */ }
  }
}

/** No retry, cookies, redirects or legacy credentials. */
export class AgentCapabilitiesClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(origin: string, private readonly proof: AgentCapabilitiesProofSource, fetchImpl?: typeof fetch) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new TypeError('Canonical capability API requires an exact HTTPS origin'); }
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new TypeError('Canonical capability API requires an exact HTTPS origin');
    }
    this.origin = origin; this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new TypeError('Fetch is required');
  }

  async catalog(sessionId: string, signal?: AbortSignal): Promise<CapabilityCatalog> {
    this.session(sessionId);
    const response = await this.request('GET', `/api/agentflow/agent-sessions/${sessionId}/capabilities`, undefined, signal, false);
    return parseCapabilityCatalog(await boundedJson(response, MAX_CATALOG_BYTES, signal));
  }

  async select(sessionId: string, input: SelectCapabilitiesInput, signal?: AbortSignal): Promise<CapabilitySelection> {
    this.session(sessionId); const body = validateSelectCapabilities(input);
    const response = await this.request('PUT', `/api/agentflow/agent-sessions/${sessionId}/capabilities`, body, signal, true);
    try { return parseSelection(await boundedJson(response, MAX_RESPONSE_BYTES, signal), body.capability_ids); }
    catch { throw new AgentCapabilitiesOutcomeUnknown(); }
  }

  async approvals(sessionId: string, signal?: AbortSignal): Promise<CapabilityApprovalList> {
    this.session(sessionId);
    const response = await this.request('GET', `/api/agentflow/agent-sessions/${sessionId}/capability-approvals`, undefined, signal, false);
    return parseCapabilityApprovals(await boundedJson(response, MAX_RESPONSE_BYTES, signal));
  }

  async adopt(sessionId: string, approvalId: number, expectedVersion: string, signal?: AbortSignal): Promise<AdoptedCapabilityApproval> {
    this.session(sessionId);
    if (!Number.isSafeInteger(approvalId) || approvalId < 1 || !UUID.test(expectedVersion)) invalidInput();
    const response = await this.request('POST', `/api/agentflow/agent-sessions/${sessionId}/capability-approvals/${approvalId}/adopt`,
      { expected_version: expectedVersion }, signal, true);
    try { return parseAdopted(await boundedJson(response, MAX_RESPONSE_BYTES, signal), approvalId); }
    catch { throw new AgentCapabilitiesOutcomeUnknown(); }
  }

  private session(value: string): void { if (typeof value !== 'string' || !UUID.test(value)) invalidInput(); }

  private async request(method: 'GET' | 'PUT' | 'POST', path: string, body: object | undefined,
    signal: AbortSignal | undefined, write: boolean): Promise<Response> {
    signal?.throwIfAborted();
    const token = await this.proof.accessToken(); signal?.throwIfAborted();
    if (!token || !TOKEN.test(token)) throw new TypeError('Active Platform Session credential unavailable');
    const htu = `${this.origin}${path}`;
    const dpop = await this.proof.signProof(method, htu, token); signal?.throwIfAborted();
    if (typeof dpop !== 'string' || !TOKEN.test(dpop)) throw new TypeError('Platform proof unavailable');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength > MAX_SELECTION_BYTES) invalidInput();
    let response: Response;
    try {
      response = await this.fetchImpl(htu, { method, headers: { Authorization: `DPoP ${token}`, DPoP: dpop,
        Accept: 'application/json', ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: encoded, credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
    } catch {
      if (!write) signal?.throwIfAborted();
      if (write) throw new AgentCapabilitiesOutcomeUnknown();
      throw new AgentCapabilitiesTransportError();
    }
    if (signal?.aborted) {
      void cancel(response);
      if (write) throw new AgentCapabilitiesOutcomeUnknown();
      signal.throwIfAborted();
    }
    if (response.redirected || (response.url && response.url !== htu) || (response.status >= 300 && response.status < 400)) {
      void cancel(response); if (write) throw new AgentCapabilitiesOutcomeUnknown(); invalid();
    }
    if (!response.ok) { void cancel(response); throw new AgentCapabilitiesHttpError(response.status); }
    if (response.status !== 200) { void cancel(response); if (write) throw new AgentCapabilitiesOutcomeUnknown(); invalid(); }
    return response;
  }
}
