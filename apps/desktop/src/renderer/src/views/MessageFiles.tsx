/**
 * 사용자 메시지에 첨부한 파일 — 말풍선 위에 카드로 보인다.
 *
 * 예전에는 말풍선 안에 이름만 적힌 칸이라, 글자가 말풍선색에 묻혀 안 보였고 눌러도 아무 일이 없었다
 * (2026-09-16 사용자 지적 "디자인 신경 쓰고, 누르면 받거나 볼 수 있어야지"). 카드 본체를 누르면 파일 뷰어
 * 탭으로 열고, 오른쪽 ↓ 는 이 PC 에 저장한다. 에이전트 작업 공간에 올라간 파일은 그 자리에서 받고,
 * 아직 올라가기 전(또는 작업 공간이 없는 대화)이면 보낸 원본(data URL)으로 받는다.
 */
import React, { useState } from 'react';
import { xgen } from '../bridge';
import type { ChatAttachment } from '../session-store';
import { DownloadIcon } from '../brand/icons';
import { fileBadge } from './attachment-model';
import { saveBytes, saveDataUrl } from './file-save';
import { formatFileSize } from './turn-files-model';

export const MessageFiles: React.FC<{
  files: ChatAttachment[];
  workflowId?: string;
  onOpenFile?: (workflowId: string, rel: string, name: string) => void;
}> = ({ files, workflowId, onOpenFile }) => {
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);

  const download = async (file: ChatAttachment, index: number) => {
    setBusy(index);
    setFailed(null);
    try {
      if (file.workspacePath && workflowId) {
        const bin = await xgen.agentData.workspaceBinary(workflowId, file.workspacePath);
        saveBytes(bin.bytes, bin.contentType || file.mime, file.name);
      } else if (file.dataUrl) {
        saveDataUrl(file.dataUrl, file.name);
      }
    } catch {
      setFailed(index);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="msg-files" aria-label={`첨부 파일 ${files.length}개`}>
      {files.map((file, index) => {
        const badge = fileBadge(file.name, file.mime);
        const canOpen = Boolean(file.workspacePath && workflowId && onOpenFile);
        const canSave = Boolean((file.workspacePath && workflowId) || file.dataUrl);
        const size = formatFileSize(file.size);
        return (
          <div key={`${file.name}-${index}`} className={`msg-file${failed === index ? ' failed' : ''}`}>
            <button
              type="button"
              className="msg-file-main"
              disabled={!canOpen && !canSave}
              onClick={() => {
                if (canOpen && workflowId && file.workspacePath) onOpenFile?.(workflowId, file.workspacePath, file.name);
                else if (canSave) void download(file, index);
              }}
              title={
                canOpen
                  ? `${file.name} — 눌러서 열기`
                  : canSave
                    ? `${file.name} — 눌러서 저장`
                    : `${file.name} — 원본 파일을 찾을 수 없습니다`
              }
            >
              <span className={`msg-file-badge tone-${badge.tone}`} aria-hidden>
                {badge.label}
              </span>
              <span className="msg-file-text">
                <span className="msg-file-name">{file.name}</span>
                <span className="msg-file-meta">{size ? `${badge.label} · ${size}` : badge.label}</span>
              </span>
            </button>
            {canSave && (
              <button
                type="button"
                className="msg-file-dl"
                onClick={() => void download(file, index)}
                disabled={busy === index}
                title={failed === index ? '받기 실패 — 다시 시도' : '이 PC에 저장'}
                aria-label={`${file.name} 저장`}
              >
                {busy === index ? <span className="ptl-spin" /> : <DownloadIcon size={16} />}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
