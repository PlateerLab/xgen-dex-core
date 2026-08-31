/**
 * The renderer's single SessionStore instance + a React subscription hook.
 *
 * Kept separate from `session-store.ts` so the store class stays free of the
 * Electron bridge (window.xgen) and can be unit-tested under node. Only this
 * module touches the bridge.
 */
import { useSyncExternalStore } from 'react';
import { xgen } from './bridge';
import { SessionStore, type StoreSnapshot } from './session-store';
import { browserStateStore } from './browser-state';
import { teamsContextStore } from './teams-context';
import { xgenyHistoryWorkspacePath } from '@dex/protocol/history';

const HISTORY_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const sessionStore = new SessionStore({
  // 컨텍스트 봉투는 **바깥쪽이 브라우저**가 되도록 겹친다. 히스토리를 다시 읽을 때
  // 벗기는 순서(`session-store.ts`: browser → teams)와 짝이 맞아야 한다.
  stream: (req, onEvent, context) =>
    xgen.chat.stream(
      browserStateStore.contextualize(
        teamsContextStore.contextualize(req),
        context?.browserSelections,
      ),
      onEvent,
    ),
  historyTurns: (workflowId, interactionId, name) =>
    xgen.history.turns(workflowId, interactionId, name),
  historyImage: async (workflowId, attachment) => {
    const path = xgenyHistoryWorkspacePath(attachment);
    if (!path) return null;
    const file = await xgen.agentData.workspaceBinary(workflowId, path, 'chat_attachment');
    const responseMime = String(file.contentType || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const attachmentMime = String(attachment.contentType || '').toLowerCase();
    const mime = HISTORY_IMAGE_MIMES.has(responseMime)
      ? responseMime
      : HISTORY_IMAGE_MIMES.has(attachmentMime)
        ? attachmentMime
        : '';
    if (!mime) return null;
    const bytes = file.bytes;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return {
      dataUrl: URL.createObjectURL(new Blob([buffer], { type: mime })),
      name: attachment.name,
      mime,
      size: bytes.byteLength,
    };
  },
  releaseHistoryImage: (previewUrl) => URL.revokeObjectURL(previewUrl),
  uploadWorkspaceImage: async ({
    workflowId,
    interactionId,
    attachmentId,
    name,
    mimeType,
    bytes,
  }) =>
    xgen.agentData.workspaceUpload(workflowId, bytes, name, mimeType, interactionId, attachmentId),
});

/** Subscribe a component to the whole session snapshot. */
export function useSessions(): StoreSnapshot {
  return useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSnapshot,
    sessionStore.getSnapshot,
  );
}
