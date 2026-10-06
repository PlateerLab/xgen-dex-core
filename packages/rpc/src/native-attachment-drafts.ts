import { createHash, randomUUID } from 'node:crypto';
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  parseAgentAttachmentReceipt,
  validateReserveAgentAttachment,
  type AgentAttachmentReceipt,
  type AgentAttachmentReference,
  type ReserveAgentAttachment,
} from '@dex/protocol/agent-session-attachments';

export interface TrustedNativeAttachment {
  readonly filename: string;
  readonly media_type: string;
  /** Ownership transfers to the host, which wipes this array after making its defensive copy. */
  readonly bytes: Uint8Array;
}

export interface NativeAttachmentSelectionLimits {
  readonly max_files: number;
  readonly max_bytes: number;
}

export type NativeAttachmentDraftStatus = 'selected' | 'reserved' | 'uncertain' | 'ready';

export interface NativeAttachmentDraftView {
  readonly selection_id: string;
  readonly filename: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly sha256: string;
  readonly status: NativeAttachmentDraftStatus;
  readonly attachment_id?: string;
  readonly receipt?: AgentAttachmentReceipt;
}

export interface NativeAttachmentDraftScope {
  readonly profile: string;
  readonly origin: string;
  readonly user_id: string;
  readonly agent_session_id: string;
  readonly workflow_id: string;
  readonly auth_scope: string;
}

interface NativeAttachmentDraft {
  readonly selectionId: string;
  readonly uploadKey: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  status: NativeAttachmentDraftStatus;
  attachmentId?: string;
  receipt?: AgentAttachmentReceipt;
}

function sameScope(left: NativeAttachmentDraftScope, right: NativeAttachmentDraftScope): boolean {
  return left.profile === right.profile && left.origin === right.origin && left.user_id === right.user_id
    && left.agent_session_id === right.agent_session_id && left.workflow_id === right.workflow_id
    && left.auth_scope === right.auth_scope;
}

function copyReceipt(receipt: AgentAttachmentReceipt): AgentAttachmentReceipt {
  return Object.freeze({ ...receipt });
}

function metadata(draft: NativeAttachmentDraft): Readonly<ReserveAgentAttachment> {
  return Object.freeze({
    upload_key: draft.uploadKey,
    filename: draft.filename,
    size_bytes: draft.bytes.byteLength,
    media_type: draft.mediaType,
    sha256: draft.sha256,
  });
}

/** Private, bounded attachment bytes owned by one exact native login and Agent Session scope. */
export class NativeAttachmentDraftRegistry {
  private scope: NativeAttachmentDraftScope | null = null;
  private readonly drafts = new Map<string, NativeAttachmentDraft>();

  clear(): void {
    this.clearDrafts();
  }

  /** Cancellation destroys bytes while preserving a bytes-free exact retry binding. */
  clearDrafts(): void {
    for (const draft of this.drafts.values()) draft.bytes.fill(0);
    this.drafts.clear();
    this.scope = null;
  }

  clearIfPublicScopeChanged(profile: string, origin: string, userId: string): boolean {
    const changed = this.scope && (this.scope.profile !== profile || this.scope.origin !== origin || this.scope.user_id !== userId);
    if (changed) {
      this.clear();
      return true;
    }
    return false;
  }

  /** Returns false after destroying drafts that belonged to another exact private scope. */
  bind(scope: NativeAttachmentDraftScope): boolean {
    if (this.scope && !sameScope(this.scope, scope)) {
      this.clear();
      this.scope = { ...scope };
      return false;
    }
    if (!this.scope) this.scope = { ...scope };
    return true;
  }

  views(scope: NativeAttachmentDraftScope): readonly NativeAttachmentDraftView[] {
    this.bind(scope);
    return Object.freeze([...this.drafts.values()].map((draft) => this.view(draft)));
  }

  remaining(scope: NativeAttachmentDraftScope): Readonly<NativeAttachmentSelectionLimits> {
    this.bind(scope);
    const retainedBytes = [...this.drafts.values()].reduce((sum, draft) => sum + draft.bytes.byteLength, 0);
    return Object.freeze({
      max_files: AGENT_ATTACHMENT_MAX_COUNT - this.drafts.size,
      max_bytes: AGENT_ATTACHMENT_MAX_TOTAL_BYTES - retainedBytes,
    });
  }

  add(scope: NativeAttachmentDraftScope, values: readonly TrustedNativeAttachment[]): readonly NativeAttachmentDraftView[] {
    if (!this.bind(scope)) throw new TypeError('Native attachment scope changed');
    if (!Array.isArray(values) || this.drafts.size + values.length > AGENT_ATTACHMENT_MAX_COUNT) {
      throw new TypeError('Native attachment selection exceeds its bound');
    }
    const added: NativeAttachmentDraft[] = [];
    let total = [...this.drafts.values()].reduce((sum, draft) => sum + draft.bytes.byteLength, 0);
    try {
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (!value || typeof value !== 'object' || typeof value.filename !== 'string'
          || typeof value.media_type !== 'string' || !(value.bytes instanceof Uint8Array)) {
          throw new TypeError('Invalid trusted native attachment selection');
        }
        if (value.bytes.byteLength > AGENT_ATTACHMENT_MAX_TOTAL_BYTES
          || total + value.bytes.byteLength > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
          throw new TypeError('Native attachment selection exceeds its bound');
        }
        total += value.bytes.byteLength;
        const bytes = new Uint8Array(value.bytes);
        let retained = false;
        try {
          const draft: NativeAttachmentDraft = {
            selectionId: randomUUID(),
            uploadKey: randomUUID(),
            filename: value.filename,
            mediaType: value.media_type,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes,
            status: 'selected',
          };
          // Reuse the canonical validators before retaining any selected bytes.
          validateReserveAgentAttachment({
            origin: scope.origin,
            user_id: scope.user_id,
            session_id: scope.agent_session_id,
            workflow_id: scope.workflow_id,
          }, metadata(draft));
          added.push(draft);
          retained = true;
        } finally { if (!retained) bytes.fill(0); }
      }
    } catch (error) {
      for (const draft of added) draft.bytes.fill(0);
      throw error;
    }
    for (const draft of added) this.drafts.set(draft.selectionId, draft);
    return this.views(scope);
  }

  get(scope: NativeAttachmentDraftScope, selectionId: string): {
    readonly status: NativeAttachmentDraftStatus;
    readonly attachment_id?: string;
    readonly receipt?: AgentAttachmentReceipt;
    readonly metadata: Readonly<ReserveAgentAttachment>;
  } {
    this.assertScope(scope);
    const draft = this.require(selectionId);
    return Object.freeze({
      status: draft.status,
      ...(draft.attachmentId ? { attachment_id: draft.attachmentId } : {}),
      ...(draft.receipt ? { receipt: copyReceipt(draft.receipt) } : {}),
      metadata: metadata(draft),
    });
  }

  uploadBytes(scope: NativeAttachmentDraftScope, selectionId: string): Uint8Array {
    this.assertScope(scope);
    return new Uint8Array(this.require(selectionId).bytes);
  }

  reserved(scope: NativeAttachmentDraftScope, selectionId: string, attachmentId: string): void {
    this.assertScope(scope);
    const draft = this.require(selectionId);
    if (draft.attachmentId && draft.attachmentId !== attachmentId) throw new TypeError('Attachment reservation changed identity');
    draft.attachmentId = attachmentId;
    draft.status = 'reserved';
    draft.receipt = undefined;
  }

  uncertain(scope: NativeAttachmentDraftScope, selectionId: string, attachmentId?: string): void {
    this.assertScope(scope);
    const draft = this.require(selectionId);
    if (attachmentId) {
      if (draft.attachmentId && draft.attachmentId !== attachmentId) throw new TypeError('Attachment reservation changed identity');
      draft.attachmentId = attachmentId;
    }
    draft.status = 'uncertain';
    draft.receipt = undefined;
  }

  ready(scope: NativeAttachmentDraftScope, selectionId: string, receiptValue: unknown): void {
    this.assertScope(scope);
    const draft = this.require(selectionId);
    const receipt = parseAgentAttachmentReceipt(receiptValue, {
      origin: scope.origin,
      user_id: scope.user_id,
      session_id: scope.agent_session_id,
      workflow_id: scope.workflow_id,
    });
    if (!draft.attachmentId || receipt.attachment_id !== draft.attachmentId
      || receipt.filename !== draft.filename || receipt.size_bytes !== draft.bytes.byteLength
      || receipt.media_type !== draft.mediaType || receipt.sha256 !== draft.sha256) {
      throw new TypeError('Attachment receipt does not match selected content');
    }
    draft.status = 'ready';
    draft.receipt = copyReceipt(receipt);
  }

  removeLocal(scope: NativeAttachmentDraftScope, selectionId: string): void {
    this.assertScope(scope);
    const draft = this.require(selectionId);
    draft.bytes.fill(0);
    this.drafts.delete(selectionId);
  }

  discard(scope: NativeAttachmentDraftScope): readonly NativeAttachmentDraftView[] {
    this.assertScope(scope);
    for (const draft of this.drafts.values()) draft.bytes.fill(0);
    this.drafts.clear();
    return Object.freeze([]);
  }

  authScopeForReferences(
    profile: string, origin: string, userId: string, sessionId: string,
    references: readonly AgentAttachmentReference[],
  ): string {
    const scope = this.scope;
    if (!scope || scope.profile !== profile || scope.origin !== origin || scope.user_id !== userId
      || scope.agent_session_id !== sessionId) throw new TypeError('Native attachment scope changed');
    const ready = [...this.drafts.values()].filter((draft) => draft.status === 'ready' && draft.receipt);
    if (ready.length !== this.drafts.size || references.length !== ready.length || references.length === 0
      || references.some((reference) => !ready.some((draft) => draft.receipt!.attachment_id === reference.attachment_id
        && draft.receipt!.sha256 === reference.sha256))) throw new TypeError('All selected receipts must be ready');
    return scope.auth_scope;
  }

  hasDraftsFor(profile: string, origin: string, userId: string, sessionId: string): boolean {
    return this.drafts.size > 0 && this.scope !== null && this.scope.profile === profile
      && this.scope.origin === origin && this.scope.user_id === userId && this.scope.agent_session_id === sessionId;
  }

  releaseSubmitted(
    profile: string, origin: string, userId: string, sessionId: string,
    references: readonly AgentAttachmentReference[],
  ): void {
    const scope = this.scope;
    if (!scope || scope.profile !== profile || scope.origin !== origin || scope.user_id !== userId
      || scope.agent_session_id !== sessionId) return;
    const submitted = new Set(references.map((reference) => `${reference.attachment_id}:${reference.sha256}`));
    for (const [selectionId, draft] of this.drafts) {
      if (draft.receipt && submitted.has(`${draft.receipt.attachment_id}:${draft.receipt.sha256}`)) {
        draft.bytes.fill(0);
        this.drafts.delete(selectionId);
      }
    }
  }

  private assertScope(scope: NativeAttachmentDraftScope): void {
    if (!this.scope || !sameScope(this.scope, scope)) {
      if (this.scope) this.clear();
      throw new TypeError('Native attachment scope changed');
    }
  }

  private require(selectionId: string): NativeAttachmentDraft {
    const draft = this.drafts.get(selectionId);
    if (!draft) throw new TypeError('Unknown native attachment selection');
    return draft;
  }

  private view(draft: NativeAttachmentDraft): NativeAttachmentDraftView {
    return Object.freeze({
      selection_id: draft.selectionId,
      filename: draft.filename,
      size_bytes: draft.bytes.byteLength,
      media_type: draft.mediaType,
      sha256: draft.sha256,
      status: draft.status,
      ...(draft.attachmentId ? { attachment_id: draft.attachmentId } : {}),
      ...(draft.receipt ? { receipt: copyReceipt(draft.receipt) } : {}),
    });
  }
}
