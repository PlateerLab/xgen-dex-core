import { resolve } from 'node:path';
import { NativeAgentLiveWatcher, NativeCliSession, DexError } from '@dex/engine';
import { readSelectedNativeAttachments } from '@dex/engine/native-attachment-files';
import { readNativeAgentConversation } from '@dex/engine/native-agent-conversation-watch';
import type { NativeAgentLiveSource } from '@dex/engine/native-agent-live-watch';
import { prepareAgentAttachmentReferences } from '@dex/protocol/agent-session-attachments';
import { AgentTurnComposeFailure } from '@dex/protocol/agent-turn-composer';
import type { AgentSessionMutationConflict } from '@dex/protocol/agent-session-mutation';
import {
  NativeAttachmentDraftRegistry,
  type NativeAttachmentDraftScope,
  type NativeAttachmentDraftView,
  type TrustedNativeAttachment,
} from '@dex/rpc/native-attachment-drafts';
import type { CanonicalTuiAccount } from './tui/canonical-types';
import type {
  CanonicalTuiAttachmentDraft,
  CanonicalTuiAttachmentScope,
  CanonicalTuiChatSource,
} from './tui/canonical-chat-types';

const ATTACHMENT_ERROR = '첨부 파일 작업을 완료할 수 없습니다.';

function outcomeUnknown(error: unknown): boolean {
  const details = error instanceof DexError && error.details && typeof error.details === 'object'
    ? error.details as { outcome?: unknown } : undefined;
  return details?.outcome === 'unknown';
}

function authenticationFailed(error: unknown): boolean {
  return error instanceof DexError && ['auth_required', 'auth_invalid'].includes(error.code);
}

function wipe(values: readonly TrustedNativeAttachment[]): void {
  for (const value of values) value.bytes.fill(0);
}

function privateViews(values: readonly NativeAttachmentDraftView[]): readonly CanonicalTuiAttachmentDraft[] {
  return Object.freeze(values.map((value) => Object.freeze({
    handle: value.selection_id,
    filename: value.filename,
    sizeBytes: value.size_bytes,
    mediaType: value.media_type,
    status: value.status,
    sha256: value.sha256,
    ...(value.receipt ? { receipt: Object.freeze({ ...value.receipt }) } : {}),
  })));
}

/** All vault/proof/cursor state stays in this CLI host. The model gets only an opaque binding. */
export function createCanonicalTuiChatSource(account: CanonicalTuiAccount, session = new NativeCliSession(account.origin)): CanonicalTuiChatSource {
  const fixed = { ...account };
  let binding: string | null = null;
  const attachmentDrafts = new NativeAttachmentDraftRegistry();
  const setBinding = (next: string) => {
    if (binding !== null && binding !== next) attachmentDrafts.clear();
    binding = next;
  };
  const attachmentScope = (expected: string, scope: CanonicalTuiAttachmentScope): NativeAttachmentDraftScope => {
    if (!expected || binding !== expected) throw new DexError('auth_required', ATTACHMENT_ERROR);
    return {
      profile: fixed.profile,
      origin: fixed.origin,
      user_id: fixed.userId,
      agent_session_id: scope.agentSessionId,
      workflow_id: scope.workflowId,
      auth_scope: expected,
    };
  };
  const attachmentViews = (scope: NativeAttachmentDraftScope) => privateViews(attachmentDrafts.views(scope));
  const recover = async (scope: NativeAttachmentDraftScope, handle: string, signal: AbortSignal) => {
    let draft = attachmentDrafts.get(scope, handle);
    if (!draft.attachment_id) {
      if (draft.status !== 'uncertain') throw new DexError('usage_error', ATTACHMENT_ERROR);
      try {
        const reservation = await session.reserveAttachment(
          fixed.userId, scope.agent_session_id, scope.workflow_id, draft.metadata, signal, scope.auth_scope,
        );
        attachmentDrafts.reserved(scope, handle, reservation.attachment_id);
        if (reservation.status === 'reserved') return;
        attachmentDrafts.uncertain(scope, handle, reservation.attachment_id);
        draft = attachmentDrafts.get(scope, handle);
      } catch (error) {
        if (authenticationFailed(error)) attachmentDrafts.clear();
        else if (outcomeUnknown(error)) attachmentDrafts.uncertain(scope, handle);
        throw error;
      }
    }
    let receipt;
    try {
      receipt = await session.readAttachmentReceipt(
        fixed.userId, scope.agent_session_id, scope.workflow_id,
        draft.attachment_id!, signal, scope.auth_scope,
      );
    } catch (error) {
      if (authenticationFailed(error)) attachmentDrafts.clear();
      throw error;
    }
    try { attachmentDrafts.ready(scope, handle, receipt); }
    catch { throw new DexError('protocol_mismatch', ATTACHMENT_ERROR); }
  };
  const reader: NativeAgentLiveSource = {
    reconcileConversation: async (userId, previous, signal) => {
      const value = await session.reconcileConversation(userId, previous, signal);
      signal?.throwIfAborted(); setBinding(value.state.authScope);
      return value;
    },
    openConversationSocket: (userId, state, signal) => session.openConversationSocket(userId, state, signal),
  };
  return {
    binding: () => binding,
    read: async (signal) => {
      try { return await readNativeAgentConversation(reader, fixed.userId, signal); }
      catch (error) {
        if (authenticationFailed(error)) attachmentDrafts.clear();
        binding = null; throw error;
      }
    },
    watch: (update, signal) => new NativeAgentLiveWatcher(reader, fixed.userId).run((value) => {
      if (value.type === 'stopped' && value.reason !== 'cancelled') {
        if (value.reason === 'authentication') attachmentDrafts.clear();
        binding = null;
      }
      update(value);
    }, signal),
    settle: () => session.settleProofOperations(),
    catalog: async (signal, beforeId) => {
      const value = await session.agentSessionCatalog(fixed.userId, beforeId, signal);
      signal.throwIfAborted(); setBinding(value.authScope);
      return { binding: value.authScope, focus: value.focus, sessions: value.sessions };
    },
    create: (expected, input, signal) => session.createAgentSession(fixed.userId, input, signal, expected),
    select: (expected, input, signal) => session.switchAgentFocus(fixed.userId, input, signal, expected),
    send: async (expected, request, signal) => {
      if (request.scope.platform_type !== 'cli' || request.scope.profile !== fixed.profile
        || request.scope.server_url !== fixed.origin || request.scope.user_id !== fixed.userId) {
        throw new AgentTurnComposeFailure('unavailable');
      }
      try {
        const mutation = request.operation === 'submit'
          ? await session.submitTurn(fixed.userId, request.agent_session_id, request.input, signal, expected)
          : await session.stopTurn(fixed.userId, request.agent_session_id, request.input, signal, expected);
        if (request.operation === 'submit' && request.input.attachments) {
          attachmentDrafts.releaseSubmitted(
            fixed.profile, fixed.origin, fixed.userId, request.agent_session_id, request.input.attachments,
          );
        }
        return { ...request.scope, agent_session_id: request.agent_session_id, mutation };
      } catch (error) {
        if (authenticationFailed(error)) attachmentDrafts.clear();
        const details = error instanceof DexError ? error.details as { outcome?: unknown; conflict?: AgentSessionMutationConflict } | undefined : undefined;
        throw new AgentTurnComposeFailure(details?.outcome === 'unknown' ? 'unknown'
          : details?.outcome === 'rejected' ? 'rejected' : 'unavailable', details?.conflict);
      }
    },
    attachments: (expected, value) => {
      const scope = attachmentScope(expected, value);
      return attachmentViews(scope);
    },
    selectAttachments: async (expected, value, paths, signal) => {
      const scope = attachmentScope(expected, value);
      if (!Array.isArray(paths) || paths.length === 0
        || paths.some((path) => typeof path !== 'string' || path.length === 0 || path.length > 4096)) {
        throw new DexError('usage_error', ATTACHMENT_ERROR);
      }
      const limits = attachmentDrafts.remaining(scope);
      if (paths.length > limits.max_files) throw new DexError('usage_error', ATTACHMENT_ERROR);
      let selected: readonly TrustedNativeAttachment[] = [];
      try {
        let before: string;
        try {
          before = await session.withProofSource(fixed.userId, async (_proof, current) => current, signal);
        } catch {
          attachmentDrafts.clear(); signal.throwIfAborted();
          throw new DexError('auth_required', ATTACHMENT_ERROR);
        }
        signal.throwIfAborted();
        if (before !== expected) {
          attachmentDrafts.clear();
          throw new DexError('auth_required', ATTACHMENT_ERROR);
        }
        selected = await readSelectedNativeAttachments(paths.map((path) => resolve(path)), signal, limits);
        signal.throwIfAborted();
        let after: string;
        try {
          after = await session.withProofSource(fixed.userId, async (_proof, current) => current, signal);
        } catch {
          attachmentDrafts.clear(); signal.throwIfAborted();
          throw new DexError('auth_required', ATTACHMENT_ERROR);
        }
        signal.throwIfAborted();
        if (binding !== expected || after !== expected) {
          attachmentDrafts.clear();
          throw new DexError('auth_required', ATTACHMENT_ERROR);
        }
        attachmentDrafts.add(scope, selected);
        return attachmentViews(scope);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DexError) throw error;
        throw new DexError('usage_error', ATTACHMENT_ERROR);
      } finally { wipe(selected); }
    },
    uploadAttachment: async (expected, value, handle, signal) => {
      const scope = attachmentScope(expected, value);
      let draft = attachmentDrafts.get(scope, handle);
      if (draft.status === 'uncertain') {
        throw new DexError('network_error', ATTACHMENT_ERROR, { outcome: 'unknown' });
      }
      if (draft.status === 'ready') {
        await recover(scope, handle, signal);
        return attachmentViews(scope);
      }
      if (draft.status === 'selected') {
        try {
          const reservation = await session.reserveAttachment(
            fixed.userId, scope.agent_session_id, scope.workflow_id, draft.metadata, signal, expected,
          );
          attachmentDrafts.reserved(scope, handle, reservation.attachment_id);
          if (reservation.status !== 'reserved') {
            attachmentDrafts.uncertain(scope, handle, reservation.attachment_id);
            await recover(scope, handle, signal);
            return attachmentViews(scope);
          }
          draft = attachmentDrafts.get(scope, handle);
        } catch (error) {
          if (authenticationFailed(error)) attachmentDrafts.clear();
          else if (outcomeUnknown(error)) attachmentDrafts.uncertain(scope, handle);
          throw error;
        }
      }
      const uploadBytes = attachmentDrafts.uploadBytes(scope, handle);
      try {
        const receipt = await session.uploadAttachment(
          fixed.userId, scope.agent_session_id, scope.workflow_id,
          draft.attachment_id!, draft.metadata, uploadBytes, signal, expected,
        );
        try { attachmentDrafts.ready(scope, handle, receipt); }
        catch { throw new DexError('protocol_mismatch', ATTACHMENT_ERROR); }
      } catch (error) {
        if (authenticationFailed(error)) attachmentDrafts.clear();
        else if (outcomeUnknown(error)) attachmentDrafts.uncertain(scope, handle, draft.attachment_id);
        throw error;
      } finally { uploadBytes.fill(0); }
      return attachmentViews(scope);
    },
    recoverAttachment: async (expected, value, handle, signal) => {
      const scope = attachmentScope(expected, value);
      try { await recover(scope, handle, signal); }
      catch (error) {
        if (authenticationFailed(error)) attachmentDrafts.clear();
        throw error;
      }
      return attachmentViews(scope);
    },
    cancelAttachment: async (expected, value, handle, signal) => {
      const scope = attachmentScope(expected, value);
      const draft = attachmentDrafts.get(scope, handle);
      if (!draft.attachment_id) attachmentDrafts.removeLocal(scope, handle);
      else {
        try {
          await session.cancelAttachment(
            fixed.userId, scope.agent_session_id, scope.workflow_id,
            draft.attachment_id, signal, expected,
          );
          attachmentDrafts.removeLocal(scope, handle);
        } catch (error) {
          if (authenticationFailed(error)) attachmentDrafts.clear();
          else if (outcomeUnknown(error)) attachmentDrafts.uncertain(scope, handle, draft.attachment_id);
          throw error;
        }
      }
      return attachmentViews(scope);
    },
    discardAttachments: (expected, value) => {
      const scope = attachmentScope(expected, value);
      attachmentDrafts.discard(scope);
      return attachmentViews(scope);
    },
    attachmentReferences: (expected, value) => {
      const scope = attachmentScope(expected, value);
      const values = attachmentDrafts.views(scope);
      if (values.some((draft) => draft.status !== 'ready' || !draft.receipt)) {
        throw new DexError('usage_error', ATTACHMENT_ERROR);
      }
      return prepareAgentAttachmentReferences(values.map((draft) => draft.receipt), {
        origin: scope.origin,
        user_id: scope.user_id,
        session_id: scope.agent_session_id,
        workflow_id: scope.workflow_id,
      });
    },
    clearAttachments: () => { attachmentDrafts.clear(); },
  };
}
