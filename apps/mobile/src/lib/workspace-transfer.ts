/**
 * 연결한 폴더 ↔ 에이전트 작업 공간 — 폰 쪽 길. 복사 도구(CopyToWorkspace·CopyFromWorkspace)가 호출마다
 * 그 대화로 묶은 이것을 받는다.
 *
 * 올리는 자리는 그 대화의 첨부 폴더다(채팅 첨부와 같은 권한·같은 자리). 파일은 경로로 흘려보낸다 —
 * RN 의 Blob 은 바이트로 만들 수 없고, 큰 파일을 JS 메모리에 올릴 이유도 없다.
 */
import * as FileSystem from 'expo-file-system';
import {
  mimeForFile,
  WORKSPACE_COPY_LIMITS,
  WORKSPACE_TRANSFER_HEADER,
} from '@dex/protocol';
import type { XgenMobileClient } from './xgen';
import { serverLink } from './links';
import type { WorkspaceTransfer } from './mobile-tools';
import { boundedDownload } from './bounded-download';

export function mobileWorkspaceTransfer(client: XgenMobileClient): WorkspaceTransfer {
  return {
    async upload(localUri, name, relDir, transfer, signal) {
      const res = await client.api.agentData.workspaceUpload(
        transfer.workflow_id,
        { uri: localUri },
        name,
        mimeForFile(name) || 'application/octet-stream',
        transfer.interaction_id,
        `mob-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        { relDir, replace: true, signal, transfer },
      );
      if (res.status === 'pending_approval') throw new Error('업로드가 승인 대기 중입니다.');
      if (!res.workspace_path) throw new Error('작업 공간 경로를 받지 못했습니다.');
      return { path: res.workspace_path, size: res.size ?? 0, ...(res.sha256 ? { sha256: res.sha256 } : {}) };
    },
    async download(url, token, name, transfer, signal) {
      if (token !== transfer.token) throw new Error('WORKSPACE_TRANSFER_CAPABILITY_REQUIRED');
      const dir = `${FileSystem.cacheDirectory ?? ''}xgen-copy/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      const dest = `${dir}${Date.now()}-${Math.random().toString(36).slice(2)}-${encodeURIComponent(name)}`;
      return boundedDownload({
        create: (progress) => FileSystem.createDownloadResumable(serverLink(client.session.serverUrl, url), dest, {
          headers: {
            Authorization: `Bearer ${client.session.accessToken}`,
            'X-XGEN-Artifact-Token': token,
            [WORKSPACE_TRANSFER_HEADER]: transfer.token,
          },
        }, (event) => progress(event.totalBytesWritten, event.totalBytesExpectedToWrite)),
        async size(uri) {
          const info = await FileSystem.getInfoAsync(uri);
          return info.exists && !info.isDirectory ? info.size : -1;
        },
        remove: () => FileSystem.deleteAsync(dest, { idempotent: true }),
      }, { signal, maxBytes: WORKSPACE_COPY_LIMITS.maxFileBytes });
    },
    async discard(localUri) {
      await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
    },
  };
}
