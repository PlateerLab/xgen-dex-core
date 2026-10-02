/**
 * 답변 아래 "만든 파일" — 턴이 끝나면 에이전트 작업 공간 목록을 한 번 받아, 그 턴 동안 생기거나 바뀐 파일 중
 * **사용자가 요청한 결과물**만 칩으로 보여 준다. 중간 파일(원본 수집·임시 결과 등)은 "그 외 N개" 로 접어 둔다
 * — 전부 늘어놓으면 받을 파일을 찾을 수 없다(9/16 사용자 지적). 이름을 누르면 파일 뷰어 탭, ↓ 는 바로 저장.
 * 고르는 규칙은 @dex/protocol turn-files 에 있다(모바일과 같다).
 *
 * 도구가 **파일 저장소**에 올린 결과물(문서 편집·표 내보내기·그림 생성)과 API 응답 임시 파일도 여기 함께
 * 그린다 — 웹 채팅의 다운로드 단추·그림 카드와 같은 것이다. 예전에는 앱이 이것을 버려, 이력을 열면 표식
 * 원문만 보였다. 그림 생성 도구는 같은 그림을 작업 공간에도 두므로, 같은 이름이 이미 보이면 한 장만 그린다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  answerTurnFiles,
  isChatImageName,
  sharedTreeFetch,
  shouldLookForTurnFiles,
  withoutShownFiles,
  type ChatDownload,
  type WsNode,
} from '@dex/protocol';
import { xgen } from '../bridge';
import type { ChatMsg } from '../session-store';
import { DocIcon, DownloadIcon } from '../brand/icons';
import { formatFileSize, splitRequestedFiles } from './turn-files-model';
import { saveBytes } from './file-save';
import { isImageFile } from './attachment-model';

/** 미리보기로 그릴 그림의 크기 상한 — 이보다 크면 칩으로만 둔다(대화창이 무거워지지 않게). */
const IMAGE_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;

function blobOf(bytes: Uint8Array, contentType: string): Blob {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: contentType || 'application/octet-stream' });
}

/** 작업 공간 목록 — 대화를 열 때 답마다 묻던 것을 동시 요청 하나로 묶는다. */
const workspaceTree = sharedTreeFetch((workflowId: string) => xgen.agentData.workspaceTree(workflowId));

/** 다운로드 한 개의 열쇠 — 같은 파일이면 같다. */
const downloadKey = (d: ChatDownload): string => d.artifactId ?? `${d.storageId}:${d.fileId}`;

export const TurnFiles: React.FC<{
  workflowId: string;
  msg: ChatMsg;
  /** 이 답의 파일 저장소 결과물·API 응답 임시 파일(스트림 + 본문 표식). */
  downloads?: readonly ChatDownload[];
  /** 그림을 크게 본다(채팅의 그림 확대 창). */
  onPreviewImage?: (image: { name: string; url: string }) => void;
  /** 이 답변을 부른 사용자 요청 글 — 요청한 결과물을 고르는 근거. */
  request?: string;
  /** 파일 뷰어 탭 열기 — 없으면 이름을 눌러도 열지 않는다. */
  onOpenFile?: (workflowId: string, rel: string, name: string) => void;
  /**
   * 대화의 마지막 답인가. 이력에서 되살린 답(시작 시각 없음)은 마지막 것만 답 글에 적힌 경로로 파일을 찾는다
   * — 앞선 답이 가리키던 파일은 그 뒤 실행에서 이미 바뀌었을 수 있다.
   */
  latest?: boolean;
}> = ({ workflowId, msg, downloads = [], onPreviewImage, request = '', onOpenFile, latest = false }) => {
  const [files, setFiles] = useState<WsNode[]>([]);
  /** 대화창에 바로 그린 그림: 작업 공간 경로 → blob URL. */
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  /** 파일 저장소의 그림: 다운로드 열쇠 → blob URL. */
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const [showOthers, setShowOthers] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const startedAt = msg.startedAt;
  const endedAt = msg.lastEventAt;
  const answer = msg.text ?? '';
  const finished = shouldLookForTurnFiles(msg, latest);
  const done = msg.role === 'assistant' && !msg.streaming && !msg.remotePartial;

  useEffect(() => {
    if (!finished || !workflowId) return;
    let alive = true;
    workspaceTree(workflowId)
      .then((res) => {
        if (!alive) return;
        setFiles(answerTurnFiles(res.files ?? [], { startedAt, lastEventAt: endedAt, text: answer }, { latest }));
      })
      .catch(() => {
        // 목록을 못 받으면 아무것도 그리지 않는다(답변 자체는 그대로)
      });
    return () => {
      alive = false;
    };
  }, [finished, workflowId, startedAt, endedAt, answer, latest]);

  const { requested, others } = useMemo(() => splitRequestedFiles(files, request, answer), [files, request, answer]);
  // 작업 공간에 같은 이름이 보이면 그 다운로드는 뺀다 — 같은 그림이 두 장 서지 않게.
  const extra = useMemo(
    () => (done ? withoutShownFiles(downloads, files.map((f) => f.name)) : []),
    [done, downloads, files],
  );
  const extraImages = useMemo(() => extra.filter((d) => isChatImageName(d.name)), [extra]);
  const extraImageKey = extraImages.map(downloadKey).join('\n');

  useEffect(() => {
    if (extraImages.length === 0) {
      setDownloadUrls((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let alive = true;
    const made: string[] = [];
    void Promise.all(
      extraImages.map(async (item) => {
        try {
          const bin = await xgen.chatFiles.download(item, { preview: !item.artifactId });
          const url = URL.createObjectURL(blobOf(bin.bytes, bin.contentType));
          made.push(url);
          return [downloadKey(item), url] as const;
        } catch {
          return null; // 못 받은 그림은 칩으로 남는다
        }
      }),
    ).then((pairs) => {
      if (!alive) {
        made.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      setDownloadUrls(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair !== null)));
    });
    return () => {
      alive = false;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraImageKey]);

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

  if ((!finished || files.length === 0) && extra.length === 0) return null;

  const shown = previews.filter((node) => imageUrls[node.path]);
  const chips = requested.filter((node) => !imageUrls[node.path]);
  const extraShown = extraImages.filter((d) => downloadUrls[downloadKey(d)]);
  const extraChips = extra.filter((d) => !downloadUrls[downloadKey(d)]);

  const saveDownload = async (item: ChatDownload) => {
    const key = downloadKey(item);
    setBusy(key);
    setFailed(null);
    try {
      const bin = await xgen.chatFiles.download(item);
      saveBytes(bin.bytes, bin.contentType || item.contentType || '', item.name);
    } catch {
      setFailed(key);
    } finally {
      setBusy(null);
    }
  };

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

  const downloadChip = (item: ChatDownload) => {
    const key = downloadKey(item);
    return (
      <span key={key} className={`turn-file-chip${failed === key ? ' failed' : ''}`} title={item.path || item.name}>
        <button
          type="button"
          className="turn-file-open"
          onClick={() => void saveDownload(item)}
          disabled={busy === key}
          title={`${item.name} — 눌러서 저장`}
        >
          <DocIcon size={13} />
          <span className="turn-file-name">{item.name}</span>
          <span className="turn-file-size">{formatFileSize(item.size)}</span>
        </button>
        <button
          type="button"
          className="turn-file-dl"
          onClick={() => void saveDownload(item)}
          disabled={busy === key}
          title={failed === key ? '받기 실패 — 다시 시도' : '이 PC 에 저장'}
          aria-label={`${item.name} 받기`}
        >
          {busy === key ? <span className="ptl-spin" /> : <DownloadIcon size={13} />}
        </button>
      </span>
    );
  };

  const allImages = shown.length + extraShown.length;

  return (
    <div className="turn-files" aria-label="이 답변에서 만든 파일">
      {allImages > 0 && (
        <div className={`turn-images count-${Math.min(allImages, 3)}`} aria-label="이 답변에서 만든 그림">
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
          {extraShown.map((item) => {
            const key = downloadKey(item);
            const url = downloadUrls[key];
            return (
              <figure key={key} className={`turn-image${failed === key ? ' failed' : ''}`}>
                <button
                  type="button"
                  className="turn-image-open"
                  onClick={() => onPreviewImage?.({ name: item.name, url })}
                  disabled={!onPreviewImage}
                  title={`${item.name} — 눌러서 크게 보기`}
                >
                  <img src={url} alt={item.name} />
                </button>
                <figcaption className="turn-image-foot">
                  <span className="turn-file-name" title={item.path || item.name}>
                    {item.name}
                  </span>
                  <span className="turn-file-size">{formatFileSize(item.size)}</span>
                  <button
                    type="button"
                    className="turn-image-dl"
                    onClick={() => void saveDownload(item)}
                    disabled={busy === key}
                    title={failed === key ? '받기 실패 — 다시 시도' : '이 PC 에 저장'}
                    aria-label={`${item.name} 받기`}
                  >
                    {busy === key ? <span className="ptl-spin" /> : <DownloadIcon size={13} />}
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {chips.length + extraChips.length > 0 && <span className="turn-files-label">만든 파일</span>}
      {chips.map((node) => chip(node, false))}
      {extraChips.map(downloadChip)}
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
