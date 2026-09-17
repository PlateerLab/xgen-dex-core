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
import { saveBytes } from './file-save';
import { isImageFile } from './attachment-model';

/** 미리보기로 그릴 그림의 크기 상한 — 이보다 크면 칩으로만 둔다(대화창이 무거워지지 않게). */
const IMAGE_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;

function blobOf(bytes: Uint8Array, contentType: string): Blob {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: contentType || 'application/octet-stream' });
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
  /** 대화창에 바로 그린 그림: 작업 공간 경로 → blob URL. */
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
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

  // 그림은 받아서 여는 게 아니라 그냥 보이는 게 맞다 — 요청한 결과물 중 그림만 골라 실물을 읽어 온다.
  const previews = useMemo(
    () => requested.filter((node) => isImageFile(node.name) && (node.size ?? 0) <= IMAGE_PREVIEW_MAX_BYTES),
    [requested],
  );
  const previewKey = previews.map((node) => node.path).join('\n');

  useEffect(() => {
    if (!workflowId || previews.length === 0) {
      setImageUrls((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let alive = true;
    const made: string[] = [];
    void Promise.all(
      previews.map(async (node) => {
        try {
          const bin = await xgen.agentData.workspaceBinary(workflowId, node.path);
          const url = URL.createObjectURL(blobOf(bin.bytes, bin.contentType));
          made.push(url);
          return [node.path, url] as const;
        } catch {
          return null; // 못 읽은 그림은 예전처럼 칩으로 남는다
        }
      }),
    ).then((pairs) => {
      if (!alive) {
        made.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      setImageUrls(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair !== null)));
    });
    return () => {
      alive = false;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
    // previews 는 매번 새 배열이라 경로 목록(previewKey)으로 같은 그림인지 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, previewKey]);

  if (!finished || files.length === 0) return null;

  const shown = previews.filter((node) => imageUrls[node.path]);
  const chips = requested.filter((node) => !imageUrls[node.path]);

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
      {shown.length > 0 && (
        <div className={`turn-images count-${Math.min(shown.length, 3)}`} aria-label="이 답변에서 만든 그림">
          {shown.map((node) => (
            <figure key={node.path} className={`turn-image${failed === node.path ? ' failed' : ''}`}>
              <button
                type="button"
                className="turn-image-open"
                onClick={() => onOpenFile?.(workflowId, node.path, node.name)}
                disabled={!onOpenFile}
                title={`${node.path} — 눌러서 크게 보기`}
              >
                <img src={imageUrls[node.path]} alt={node.name} />
              </button>
              <figcaption className="turn-image-foot">
                <span className="turn-file-name" title={node.path}>
                  {node.name}
                </span>
                <span className="turn-file-size">{formatFileSize(node.size)}</span>
                <button
                  type="button"
                  className="turn-image-dl"
                  onClick={() => void download(node)}
                  disabled={busy === node.path}
                  title={failed === node.path ? '받기 실패 — 다시 시도' : '이 PC 에 저장'}
                  aria-label={`${node.name} 받기`}
                >
                  {busy === node.path ? <span className="ptl-spin" /> : <DownloadIcon size={13} />}
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {chips.length > 0 && <span className="turn-files-label">만든 파일</span>}
      {chips.map((node) => chip(node, false))}
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
