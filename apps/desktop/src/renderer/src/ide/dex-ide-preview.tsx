/**
 * 데스크톱 IDE 의 미리보기 — 탐색기 탭·[파일 저장소] 와 **같은 뷰어**(FileViewerPane)를 IDE 탭 안에 그린다.
 *
 * 바이트는 IDE 가 고른 길(샌드박스·이 PC 의 연결된 폴더)로 읽는다. 문서(docx·pptx·xlsx·hwp)는 서버가 [파일 저장소] 와
 * 같은 렌더러로 그린 페이지 그림이고, 연결된 폴더의 문서는 서버에 없으니 내려받기 안내로 간다.
 */
import React, { useMemo } from 'react';
import type { IdePreview, IdePreviewRequest } from '@dex/ide';
import { FileViewerPane, workspaceOfficePages, type FileViewerSource } from '../views/FileViewerPane';
import { idePreviewModeFor } from '../views/file-viewer-model';

export function createDexIdePreview(workflowId: string): IdePreview {
  return {
    mode: (path) => idePreviewModeFor(path.split('/').pop() ?? path),
    render: (req) => <IdePreviewView workflowId={workflowId} req={req} />,
  };
}

const IdePreviewView: React.FC<{ workflowId: string; req: IdePreviewRequest }> = ({ workflowId, req }) => {
  const sourceKey = `ide:${workflowId}:${req.path}:${req.version}`;
  const source = useMemo<FileViewerSource>(
    () => ({
      label: req.local ? '이 PC 폴더' : '에이전트 워크스페이스',
      readRaw: req.readRaw,
      office: req.local ? undefined : workspaceOfficePages(workflowId, req.path),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceKey, req.local],
  );
  return (
    <FileViewerPane
      fileName={req.name}
      rel={req.path}
      source={source}
      sourceKey={sourceKey}
      text={req.text}
      embedded
      onDownload={req.download}
    />
  );
};
