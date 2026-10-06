/**
 * Canonical attachment metadata preparation. This does not enable uploads or
 * attachment turns, authenticate receipts, or grant access to stored bytes.
 * Servers must still verify ownership and stored checksum under their verified
 * principal. MIME is descriptive only; no path, URL or raw data is accepted.
 */

export const AGENT_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const AGENT_ATTACHMENT_MAX_COUNT = 10;
export const AGENT_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;
const DIGEST = /^[0-9a-f]{64}(?![\s\S])/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?![\s\S])/;
const UNSAFE_NAME = /[\/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const SCOPE_FIELDS = ['origin', 'user_id', 'session_id', 'workflow_id'] as const;
const RECEIPT_FIELDS = [
  ...SCOPE_FIELDS, 'attachment_id', 'filename', 'size_bytes', 'media_type', 'sha256',
] as const;

export interface AgentAttachmentScope {
  readonly origin: string;
  readonly user_id: string;
  readonly session_id: string;
  readonly workflow_id: string;
}

export interface AgentAttachmentReceipt extends AgentAttachmentScope {
  readonly attachment_id: string;
  readonly filename: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly sha256: string;
}

/** Future wire reference: does not carry display hints, identity claims or storage locations. */
export interface AgentAttachmentReference {
  readonly attachment_id: string;
  readonly sha256: string;
}

export class AgentAttachmentValidationError extends TypeError {
  constructor() {
    super('Invalid canonical Agent Session attachment metadata');
    this.name = 'AgentAttachmentValidationError';
  }
}

function invalid(): never { throw new AgentAttachmentValidationError(); }

function safe<T>(parse: () => T): T {
  try { return parse(); } catch { return invalid(); }
}

/** JSON-shaped records only; reject symbols, inherited fields and accessors. */
function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !keys.every((key) => typeof key === 'string' && fields.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) invalid();
    result[field] = descriptor.value;
  }
  return result;
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 320 || !/^https:\/\/[\x21-\x7e]+$/.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password
      || (parsed.port && (parsed.port === '443' || Number(parsed.port) < 1))) return false;
    const host = parsed.hostname;
    if (host.startsWith('[')) return true; // URL parser enforces canonical IPv6 through origin equality.
    return host.length <= 253 && host.split('.').every((label) =>
      !label.startsWith('xn--') && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validName(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes
    && wellFormed(value) && !UNSAFE_NAME.test(value)
    && new TextEncoder().encode(value).length <= maxBytes;
}

function parseScopeFields(raw: Record<string, unknown>): AgentAttachmentScope {
  if (!validOrigin(raw.origin) || typeof raw.user_id !== 'string'
    || !/^[1-9][0-9]{0,18}(?![\s\S])/.test(raw.user_id)
    || (raw.user_id.length === 19 && raw.user_id > '9223372036854775807')
    || typeof raw.session_id !== 'string' || !UUID.test(raw.session_id)
    || !validName(raw.workflow_id, 128)) invalid();
  return Object.freeze({
    origin: raw.origin, user_id: raw.user_id, session_id: raw.session_id, workflow_id: raw.workflow_id,
  });
}

/** Use authenticated context as input. Parsing is shape validation, not authentication. */
export function parseAgentAttachmentScope(value: unknown): AgentAttachmentScope {
  return safe(() => parseScopeFields(exactRecord(value, SCOPE_FIELDS)));
}

/** Reject receipts belonging to a different server, account, session or workflow. */
export function parseAgentAttachmentReceipt(value: unknown, expectedScope: unknown): AgentAttachmentReceipt {
  return safe(() => parseReceipt(value, expectedScope));
}

function parseReceipt(value: unknown, expectedScope: unknown): AgentAttachmentReceipt {
  const scope = parseAgentAttachmentScope(expectedScope);
  const raw = exactRecord(value, RECEIPT_FIELDS);
  const receiptScope = parseScopeFields(raw);
  if (!SCOPE_FIELDS.every((key) => receiptScope[key] === scope[key])
    || typeof raw.attachment_id !== 'string' || !UUID.test(raw.attachment_id)
    || !validName(raw.filename, 255) || raw.filename === '.' || raw.filename === '..'
    || typeof raw.size_bytes !== 'number' || !Number.isSafeInteger(raw.size_bytes)
    || raw.size_bytes < 0 || raw.size_bytes > AGENT_ATTACHMENT_MAX_BYTES
    || typeof raw.media_type !== 'string' || raw.media_type.length > 255 || !MEDIA_TYPE.test(raw.media_type)
    || typeof raw.sha256 !== 'string' || !DIGEST.test(raw.sha256)) invalid();
  return Object.freeze({
    ...receiptScope, attachment_id: raw.attachment_id, filename: raw.filename,
    size_bytes: raw.size_bytes, media_type: raw.media_type, sha256: raw.sha256,
  });
}

/**
 * Copy a bounded ordered list for an immutable original intent. A caller must
 * discard it when its authenticated scope changes, and must not send it to the
 * current text-only turn API. Duplicate IDs are never deduplicated silently.
 */
export function prepareAgentAttachmentReferences(
  receipts: unknown, expectedScope: unknown,
): readonly AgentAttachmentReference[] {
  return safe(() => prepareReferences(receipts, expectedScope));
}

function prepareReferences(receipts: unknown, expectedScope: unknown): readonly AgentAttachmentReference[] {
  const scope = parseAgentAttachmentScope(expectedScope);
  if (!Array.isArray(receipts) || receipts.length > AGENT_ATTACHMENT_MAX_COUNT) invalid();
  const seen = new Set<string>();
  let total = 0;
  const result: AgentAttachmentReference[] = [];
  // Indexed iteration rejects sparse arrays instead of silently skipping holes.
  for (let index = 0; index < receipts.length; index++) {
    const receipt = parseAgentAttachmentReceipt(receipts[index], scope);
    total += receipt.size_bytes;
    if (seen.has(receipt.attachment_id) || total > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) invalid();
    seen.add(receipt.attachment_id);
    result.push(Object.freeze({ attachment_id: receipt.attachment_id, sha256: receipt.sha256 }));
  }
  return Object.freeze(result);
}
