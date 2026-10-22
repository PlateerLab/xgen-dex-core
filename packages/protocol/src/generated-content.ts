import { ApiError, HttpClient } from './client';
import { sha256HexOfBytes } from './sha256';

export const GENERATED_CONTENT_MAX_PROOF_BYTES = 8192;
export const GENERATED_CONTENT_MAX_MARKER_BYTES = 16 * 1024;
export const GENERATED_CONTENT_MAX_MARKERS = 64;

const HEX_256 = /^[0-9a-f]{64}$/;
const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+\-/]{0,126}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GeneratedContentVerificationStatus =
    | 'verified'
    | 'changed'
    | 'other_actor'
    | 'invalid'
    | 'unsigned_legacy'
    | 'unavailable';

export interface GeneratedContentProvenance {
    indication: 'ai_generated';
    generated_by?: string;
    proof: string | null;
    sha256?: string;
    content_type?: string;
    byte_length?: number;
    source_id?: string;
    artifact_path?: string;
}

export interface GeneratedContentVerification {
    status: GeneratedContentVerificationStatus;
    signature_valid: boolean;
    content_match: boolean;
    actor_match: boolean;
    statement: Record<string, unknown> | null;
}

export interface ParsedStoredGeneratedContent {
    visibleText: string;
    text: GeneratedContentProvenance[];
    media: GeneratedContentProvenance[];
    malformed: boolean;
}

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function exactPositiveOrZeroInteger(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== 'string' || value.length > 16 || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Validate the public generated_content event without trusting it as observed bytes. */
export function parseGeneratedContentEvent(value: unknown): GeneratedContentProvenance | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const proof = item.proof;
    const sha256 = item.sha256;
    const contentType = item.content_type;
    const byteLength = exactPositiveOrZeroInteger(item.byte_length);
    const sourceId = item.source_id;
    if (
        item.indication !== 'ai_generated'
        || typeof proof !== 'string'
        || proof.length > GENERATED_CONTENT_MAX_PROOF_BYTES
        || !JWS.test(proof)
        || typeof sha256 !== 'string'
        || !HEX_256.test(sha256)
        || typeof contentType !== 'string'
        || !MIME.test(contentType)
        || byteLength === null
        || typeof sourceId !== 'string'
        || !UUID_V4.test(sourceId)
    ) return null;
    return {
        indication: 'ai_generated',
        generated_by: typeof item.generated_by === 'string' ? item.generated_by : undefined,
        proof,
        sha256,
        content_type: contentType,
        byte_length: byteLength,
        source_id: sourceId,
        artifact_path: typeof item.artifact_path === 'string' ? item.artifact_path : undefined,
    };
}

function parseMarkerBody(body: string): GeneratedContentProvenance | null {
    if (utf8Length(body) > GENERATED_CONTENT_MAX_MARKER_BYTES) return null;
    const fields: Record<string, string> = {};
    for (const token of body.trim().split(/\s+/)) {
        const separator = token.indexOf('=');
        if (separator <= 0) return null;
        const key = token.slice(0, separator);
        const value = token.slice(separator + 1);
        if (!value || Object.prototype.hasOwnProperty.call(fields, key)) return null;
        fields[key] = value;
    }
    if (Object.keys(fields).length !== 5) return null;
    if (!['proof', 'sha256', 'content_type', 'byte_length', 'source_id'].every((key) => key in fields)) {
        return null;
    }
    return parseGeneratedContentEvent({ indication: 'ai_generated', ...fields });
}

/**
 * Remove private history envelopes and return only strictly valid proofs.
 * Marker-like comments are hidden even when malformed, so metadata never becomes
 * visible UI or model replay text. Parsing work and marker counts are bounded.
 */
export function parseStoredGeneratedContent(value: unknown): ParsedStoredGeneratedContent {
    if (typeof value !== 'string' || !value) {
        return { visibleText: typeof value === 'string' ? value : '', text: [], media: [], malformed: false };
    }
    const prefix = '<!--XGEN_GENERATED_';
    let cursor = 0;
    let visibleText = '';
    let count = 0;
    let malformed = false;
    const text: GeneratedContentProvenance[] = [];
    const media: GeneratedContentProvenance[] = [];
    const sourceIds = new Set<string>();

    while (cursor < value.length) {
        const start = value.indexOf(prefix, cursor);
        if (start < 0) {
            visibleText += value.slice(cursor);
            break;
        }
        const preceding = value.slice(cursor, start);
        // The backend always inserts one separator LF immediately before each
        // envelope. Removing that one LF preserves any LF already present in
        // the signed text (including text that deliberately ends in LF).
        visibleText += preceding.endsWith('\n') ? preceding.slice(0, -1) : preceding;
        if (count >= GENERATED_CONTENT_MAX_MARKERS) {
            // The rest is untrusted metadata. Do not keep scanning or copying
            // arbitrarily many envelopes after the public marker budget.
            malformed = true;
            break;
        }
        const end = value.indexOf('-->', start + prefix.length);
        if (end < 0) {
            malformed = true;
            break;
        }
        count += 1;
        if (end + 3 - start > GENERATED_CONTENT_MAX_MARKER_BYTES) {
            malformed = true;
            cursor = end + 3;
            continue;
        }
        const marker = value.slice(start, end + 3);
        if (utf8Length(marker) > GENERATED_CONTENT_MAX_MARKER_BYTES) {
            malformed = true;
            cursor = end + 3;
            continue;
        }
        const headerEnd = marker.indexOf(' ');
        const kind = marker.slice(prefix.length, headerEnd);
        const parsed = headerEnd > 0
            ? parseMarkerBody(marker.slice(headerEnd + 1, -3))
            : null;
        if (!parsed || (kind !== 'CONTENT_V1' && kind !== 'MEDIA_V1') || sourceIds.has(parsed.source_id!)) {
            malformed = true;
        } else {
            sourceIds.add(parsed.source_id!);
            (kind === 'CONTENT_V1' ? text : media).push(parsed);
        }
        cursor = end + 3;
    }

    return { visibleText, text, media, malformed };
}

export function mergeGeneratedContentProvenance(
    existing: readonly GeneratedContentProvenance[] | undefined,
    incoming: GeneratedContentProvenance,
): GeneratedContentProvenance[] {
    const current = existing ?? [];
    if (incoming.source_id && current.some((item) => item.source_id === incoming.source_id)) return [...current];
    return [...current, incoming];
}

/** Verification always hashes the bytes the client actually observed. */
export class GeneratedContentApi {
  constructor(private readonly http: HttpClient) {}

  async verifyText(proof: string | null, text: string): Promise<GeneratedContentVerification> {
    return this.verifyBytes(proof, new TextEncoder().encode(text), 'text/plain');
  }

  async verifyBytes(proof: string | null, bytes: Uint8Array, contentType: string): Promise<GeneratedContentVerification> {
    const content_type = contentType.trim().toLowerCase().split(';', 1)[0] || 'application/octet-stream';
    if (!MIME.test(content_type)) throw new Error('invalid observed content type');
    const observed = { sha256: await sha256HexOfBytes(bytes), content_type, byte_length: bytes.byteLength };
    let raw: unknown;
    try {
      raw = await this.http.post<unknown>('/api/generated-content/verify', { proof, ...observed });
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        return { status: 'unavailable', signature_valid: false, content_match: false, actor_match: false, statement: null };
      }
      throw error;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid generated-content verification response');
    const body = raw as Record<string, unknown>;
    if (!['verified', 'changed', 'other_actor', 'invalid', 'unsigned_legacy'].includes(String(body.status))) {
      throw new Error('invalid generated-content verification response');
    }
    if (body.status === 'verified' && (body.signature_valid !== true || body.content_match !== true || body.actor_match !== true)) {
      throw new Error('inconsistent generated-content verification response');
    }
    return {
      status: body.status as GeneratedContentVerificationStatus,
      signature_valid: body.signature_valid === true,
      content_match: body.content_match === true,
      actor_match: body.actor_match === true,
      statement: body.statement && typeof body.statement === 'object' && !Array.isArray(body.statement) ? body.statement as Record<string, unknown> : null,
    };
  }
}
