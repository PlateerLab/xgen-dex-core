/**
 * 답변 아래 "이 답변에서 만든 파일" — 턴이 끝나면 에이전트 작업 공간 목록을 한 번 받아, 그 턴 동안
 * 생기거나 바뀐 파일을 [열기](파일 뷰어 탭: 미리보기·다운로드) · [받기](바로 저장)로 보여 준다.
 * 고르는 규칙은 turn-files-model 에 있다. 이 창이 스트림으로 받은 턴만 시작 시각을 알아 목록을 그린다.
 */
import React, { useEffect, useState } from 'react';
import type { WsNode } from '@dex/protocol';
import { xgen } from '../bridge';
import type { ChatMsg } from '../session-store';
import { DocIcon, DownloadIcon } from '../brand/icons';
import { filesChangedDuringTurn, formatFileSize, parentDir } from './turn-files-model';

function saveBytes(bytes: Uint8Array, contentType: string, fileName: string): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buffer], { type: contentType || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const TurnFiles: React.FC<{
  workflowId: string;
  msg: ChatMsg;
  /** 파일 뷰어 탭 열기 — 없으면 [열기] 를 숨긴다. */
  onOpenFile?: (workflowId: string, rel: string, name: string) => void;
}> = ({ workflowId, msg, onOpenFile }) => {
  const [files, setFiles] = useState<WsNode[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const startedAt = msg.startedAt;
  const endedAt = msg.lastEventAt;
  const finished = msg.role === 'assistant' && !msg.streaming && startedAt !== undefined;

  useEffect(() => {
    if (!finished || !workflowId || startedAt === undefined) return;
    let alive = true;
    xgen.agentData
      .workspaceTree(workflowId)
      .then((res) => {
        if (alive) setFiles(filesChangedDuringTurn(res.files ?? [], startedAt, endedAt ?? Date.now()));
      })
      .catch(() => {
        // 목록을 못 받으면 아무것도 그리지 않는다(답변 자체는 그대로)
      });
    return () => {
      alive = false;
    };
  }, [finished, workflowId, startedAt, endedAt]);

  if (!finished || files.length === 0) return null;

  const download = async (node: WsNode) => {
    setBusy(node.path);
    setFailed(null);
    try {
      const bin = await xgen.agentData.workspaceBinary(workflowId, node.path);
      saveBytes(bin.bytes, bin.contentType, node.name);
    } catch {
      setFailed(node.path);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="turn-files" aria-label="이 답변에서 만든 파일">
      <div className="turn-files-head">이 답변에서 만든 파일 · {files.length}개</div>
      {files.map((node) => (
        <div key={node.path} className="turn-file">
          <DocIcon size={14} className="turn-file-icon" />
          <span className="turn-file-name" title={node.path}>
            {node.name}
            {parentDir(node.path) && <span className="turn-file-dir">{parentDir(node.path)}/</span>}
          </span>
          <span className="turn-file-size">{formatFileSize(node.size)}</span>
          {failed === node.path && <span className="turn-file-error">받기 실패</span>}
          {onOpenFile && (
            <button type="button" className="secondary sm" onClick={() => onOpenFile(workflowId, node.path, node.name)}>
              열기
            </button>
          )}
          <button
            type="button"
            className="secondary sm"
            onClick={() => void download(node)}
            disabled={busy === node.path}
            title="이 PC 에 저장"
          >
            <DownloadIcon size={13} /> {busy === node.path ? '받는 중…' : '받기'}
          </button>
        </div>
      ))}
    </div>
  );
};
