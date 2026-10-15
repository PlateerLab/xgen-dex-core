/**
 * 연결한 폴더 ↔ 에이전트 작업 공간 — 폰 쪽 길. 복사 도구(CopyToWorkspace·CopyFromWorkspace)가 호출마다
 * 그 대화로 묶은 이것을 받는다.
 *
 * 올리는 자리는 그 대화의 첨부 폴더다(채팅 첨부와 같은 권한·같은 자리). 파일은 경로로 흘려보낸다 —
 * RN 의 Blob 은 바이트로 만들 수 없고, 큰 파일을 JS 메모리에 올릴 이유도 없다.
 */
import * as FileSystem from 'expo-file-system';
import { mimeForFile } from '@dex/protocol';
import type { XgenMobileClient } from './xgen';
import { serverLink } from './links';
import type { WorkspaceTransfer } from './mobile-tools';

export function mobileWorkspaceTransfer(client: XgenMobileClient, workflowId: string, interactionId: string): WorkspaceTransfer {
  return {
    async upload(localUri, name, relDir) {
      const res = await client.api.agentData.workspaceUpload(
        workflowId,
        { uri: localUri },
        name,
        mimeForFile(name) || 'application/octet-stream',
        interactionId,
        `mob-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        { relDir, replace: true },
      );
      if (res.status === 'pending_approval') throw new Error('업로드가 승인 대기 중입니다.');
      if (!res.workspace_path) throw new Error('작업 공간 경로를 받지 못했습니다.');
      return { path: res.workspace_path, size: res.size ?? 0, ...(res.sha256 ? { sha256: res.sha256 } : {}) };
    },
    async download(url, token, name) {
      const dir = `${FileSystem.cacheDirectory ?? ''}xgen-copy/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      const dest = `${dir}${Date.now()}-${encodeURIComponent(name)}`;
      const res = await FileSystem.downloadAsync(serverLink(client.session.serverUrl, url), dest, {
        headers: {
          Authorization: `Bearer ${client.session.accessToken}`,
          ...(token ? { 'X-XGEN-Artifact-Token': token } : {}),
        },
      });
      if (res.status >= 400) {
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined);
        throw new Error(`작업 공간의 파일을 받지 못했습니다(${res.status}).`);
      }
      return res.uri;
    },
    async discard(localUri) {
      await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
    },
  };
}
