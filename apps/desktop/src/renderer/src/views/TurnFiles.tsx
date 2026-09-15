/**
 * 답변 아래 "만든 파일" — 턴이 끝나면 에이전트 작업 공간 목록을 한 번 받아, 그 턴 동안 생기거나 바뀐 파일 중
 * **사용자가 요청한 결과물**만 칩으로 보여 준다. 중간 파일(원본 수집·임시 결과 등)은 "그 외 N개" 로 접어 둔다
 * — 전부 늘어놓으면 받을 파일을 찾을 수 없다(9/16 사용자 지적). 이름을 누르면 파일 뷰어 탭, ↓ 는 바로 저장.
 * 고르는 규칙은 turn-files-model 에 있다. 이 창이 스트림으로 받은 턴은 시작 시각으로, 이력에서 되살린
 * 마지막 답은 답 글에 적힌 경로로 파일을 찾는다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { WsNode } from '@dex/protocol';
import { xgen } from '../bridge';
import type { ChatMsg } from '../session-store';
import { DocIcon, DownloadIcon } from '../brand/icons';
import { filesChangedDuringTurn, filesNamedInAnswer, formatFileSize, splitRequestedFiles } from './turn-files-model';

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
  /** 이 답변을 부른 사용자 요청 글 — 요청한 결과물을 고르는 근거. */
  request?: string;
  /** 파일 뷰어 탭 열기 — 없으면 이름을 눌러도 열지 않는다. */
  onOpenFile?: (workflowId: string, rel: string, name: string) => void;
  /**
   * 대화의 마지막 답인가. 이력에서 되살린 답(시작 시각 없음)은 마지막 것만 답 글에 적힌 경로로 파일을 찾는다
   * — 앞선 답이 가리키던 파일은 그 뒤 실행에서 이미 바뀌었을 수 있다.
   */
  latest?: boolean;
}> = ({ workflowId, msg, request = '', onOpenFile, latest = false }) => {
  const [files, setFiles] = useState<WsNode[]>([]);
  const [showOthers, setShowOthers] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const startedAt = msg.startedAt;
  const endedAt = msg.lastEventAt;
  const answer = msg.text ?? '';
  const restored = startedAt === undefined;
  const finished = msg.role === 'assistant' && !msg.streaming && (!restored || latest);

  useEffect(() => {
    if (!finished || !workflowId) return;
    let alive = true;
    xgen.agentData
      .workspaceTree(workflowId)
      .then((res) => {
        if (!alive) return;
        const nodes = res.files ?? [];
        setFiles(
          startedAt === undefined
            ? filesNamedInAnswer(nodes, answer)
            : filesChangedDuringTurn(nodes, startedAt, endedAt ?? Date.now()),
        );
      })
      .catch(() => {
        // 목록을 못 받으면 아무것도 그리지 않는다(답변 자체는 그대로)
      });
    return () => {
      alive = false;
    };
  }, [finished, workflowId, startedAt, endedAt, answer]);

  const { requested, others } = useMemo(() => splitRequestedFiles(files, request, answer), [files, request, answer]);

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

  const chip = (node: WsNode, minor: boolean) => (
    <span
      key={node.path}
      className={`turn-file-chip${minor ? ' minor' : ''}${failed === node.path ? ' failed' : ''}`}
      title={node.path}
    >
      <button
        type="button"
        className="turn-file-open"
        onClick={() => onOpenFile?.(workflowId, node.path, node.name)}
        disabled={!onOpenFile}
        title={`${node.path} — 눌러서 열기`}
      >
        <DocIcon size={13} />
        <span className="turn-file-name">{node.name}</span>
        <span className="turn-file-size">{formatFileSize(node.size)}</span>
      </button>
      <button
        type="button"
        className="turn-file-dl"
        onClick={() => void download(node)}
        disabled={busy === node.path}
        title={failed === node.path ? '받기 실패 — 다시 시도' : '이 PC 에 저장'}
        aria-label={`${node.name} 받기`}
      >
        {busy === node.path ? <span className="ptl-spin" /> : <DownloadIcon size={13} />}
      </button>
    </span>
  );

  return (
    <div className="turn-files" aria-label="이 답변에서 만든 파일">
      {requested.length > 0 && <span className="turn-files-label">만든 파일</span>}
      {requested.map((node) => chip(node, false))}
      {others.length > 0 && (
        <button
          type="button"
          className="turn-files-more"
          onClick={() => setShowOthers((v) => !v)}
          aria-expanded={showOthers}
          title="요청한 결과물 외에 이 답변 동안 바뀐 파일(중간 파일 등)"
        >
          {requested.length > 0 ? `그 외 ${others.length}개` : `바뀐 파일 ${others.length}개`} {showOthers ? '▾' : '▸'}
        </button>
      )}
      {showOthers && <div className="turn-files-others">{others.map((node) => chip(node, true))}</div>}
    </div>
  );
};
