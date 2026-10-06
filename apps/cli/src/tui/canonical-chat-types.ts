import type { AgentFocus, OwnedAgentSession } from '@dex/protocol/agent-session';
import type { parseAgentSessionCatalogPage } from '@dex/protocol/agent-session-catalog';
import type { AgentTurnComposeRequest, AgentTurnComposerView } from '@dex/protocol/agent-turn-composer';
import type { AgentAttachmentReference, AgentAttachmentReceipt } from '@dex/protocol/agent-session-attachments';
import type { CreateAgentSessionInput, CreatedAgentSession, SwitchAgentFocusInput } from '@dex/protocol/agent-session-lifecycle';
import type { CanonicalTuiSource, CanonicalTuiView } from './canonical-types';

export type CanonicalTuiAttachmentStatus = 'selected' | 'reserved' | 'uncertain' | 'ready';

/** Safe metadata rendered by Ink. Local paths, hashes and server identifiers stay private. */
export interface CanonicalTuiAttachmentView {
  filename: string;
  sizeBytes: number;
  mediaType: string;
  status: CanonicalTuiAttachmentStatus;
}

export interface CanonicalTuiAttachmentScope {
  agentSessionId: string;
  workflowId: string;
}

/** Private source/model boundary. The model strips handle, hash and receipt before publishing. */
export interface CanonicalTuiAttachmentDraft extends CanonicalTuiAttachmentView {
  handle: string;
  sha256: string;
  receipt?: AgentAttachmentReceipt;
}

/** Native host scope binding is private to the model; never copied into the Ink view. */
export interface CanonicalTuiChatSource extends CanonicalTuiSource {
  binding(): string | null;
  catalog(signal: AbortSignal, beforeId?: string): Promise<{
    binding: string; focus: AgentFocus; sessions: ReturnType<typeof parseAgentSessionCatalogPage>;
  }>;
  create(binding: string, input: CreateAgentSessionInput, signal: AbortSignal): Promise<CreatedAgentSession>;
  select(binding: string, input: SwitchAgentFocusInput, signal: AbortSignal): Promise<AgentFocus>;
  send(binding: string, request: AgentTurnComposeRequest, signal: AbortSignal): Promise<unknown>;
  attachments(binding: string, scope: CanonicalTuiAttachmentScope): readonly CanonicalTuiAttachmentDraft[];
  selectAttachments(binding: string, scope: CanonicalTuiAttachmentScope, paths: readonly string[], signal: AbortSignal): Promise<readonly CanonicalTuiAttachmentDraft[]>;
  uploadAttachment(binding: string, scope: CanonicalTuiAttachmentScope, handle: string, signal: AbortSignal): Promise<readonly CanonicalTuiAttachmentDraft[]>;
  recoverAttachment(binding: string, scope: CanonicalTuiAttachmentScope, handle: string, signal: AbortSignal): Promise<readonly CanonicalTuiAttachmentDraft[]>;
  cancelAttachment(binding: string, scope: CanonicalTuiAttachmentScope, handle: string, signal: AbortSignal): Promise<readonly CanonicalTuiAttachmentDraft[]>;
  discardAttachments(binding: string, scope: CanonicalTuiAttachmentScope): readonly CanonicalTuiAttachmentDraft[];
  attachmentReferences(binding: string, scope: CanonicalTuiAttachmentScope): readonly AgentAttachmentReference[];
  clearAttachments(): void;
}

export interface CanonicalTuiChatView extends CanonicalTuiView {
  draft: string;
  writing: boolean;
  canEdit: boolean;
  attachments: {
    items: CanonicalTuiAttachmentView[];
    /** Public reset signal; carries no binding, path or server attachment identity. */
    epoch: number;
    busy: boolean;
    canSelect: boolean;
    canSubmit: boolean;
    notice: string;
  };
  turn: AgentTurnComposerView;
  catalog: {
    focus: AgentFocus | null;
    items: OwnedAgentSession[];
    nextCursor: string | null;
    hasMore: boolean;
    olderPage: boolean;
    busy: boolean;
    writeBlocked: boolean;
    canWrite: boolean;
    canLoadOlder: boolean;
    notice: string;
  };
}
