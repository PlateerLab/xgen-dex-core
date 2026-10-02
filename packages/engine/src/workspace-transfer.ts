/**
 * 연결한 폴더 ↔ 에이전트 작업 공간을 서버 연결로 잇는다 — 데스크톱·CLI·VSCode 가 같은 구현을 쓴다.
 *
 * 올리는 자리는 그 대화의 첨부 폴더다(채팅 첨부와 같은 권한·같은 자리). 남의 에이전트(공유·스토어)와
 * 대화해도 실행 권한으로 올라간다. 같은 파일을 다시 옮기면 덮어쓴다 — 사용자가 고친 판이 이긴다.
 */
import { randomUUID } from 'node:crypto';
import type { XgenClient } from '@dex/protocol';
import type { WorkspaceTransfer } from './local-tools';

export function clientWorkspaceTransfer(client: () => XgenClient): WorkspaceTransfer {
  return {
    async upload({ workflowId, interactionId, bytes, name, relDir, mimeType }) {
      const res = await client().agentData.workspaceUpload(
        workflowId,
        bytes,
        name,
        mimeType,
        interactionId,
        `dex-copy-${randomUUID()}`,
        { relDir, replace: true },
      );
      if (res.status === 'pending_approval') throw new Error('업로드가 승인 대기 중입니다.');
      if (!res.workspace_path) throw new Error('작업 공간 경로를 받지 못했습니다.');
      return { path: res.workspace_path, size: res.size ?? bytes.byteLength, ...(res.sha256 ? { sha256: res.sha256 } : {}) };
    },
    async download({ url, token }) {
      return (await client().chatFiles.artifactBytes(url, token)).bytes;
    },
  };
}
