/**
 * IDE 의 미리보기 — Dex 와 같은 뷰어(FileViewerPane)를 IDE 탭 안에 그린다. 바이트는 IDE 가 고른 길(작업 공간·연결
 * 폴더)로 읽는다. 문서(docx·pptx·xlsx·hwp)를 그려 줄 서버가 XD 에는 없어, 그런 파일은 뷰어가 내려받기 안내로 간다.
 */
import React, { useMemo } from 'react';
import type { IdePreview, IdePreviewMode, IdePreviewRequest } from '@dex/ide';
import { FileViewerPane, type FileViewerSource } from '../dex';

export function createXdIdePreview(agentId: string, modeFor: (name: string) => IdePreviewMode | null): IdePreview {
  return {
    mode: (path) => modeFor(path.split('/').pop() ?? path),
    render: (req) => <XdPreviewView agentId={agentId} req={req} />,
  };
}

const XdPreviewView: React.FC<{ agentId: string; req: IdePreviewRequest }> = ({ agentId, req }) => {
  const sourceKey = `xd-ide:${agentId}:${req.path}:${req.version}`;
  const source = useMemo<FileViewerSource>(
    () => ({ label: req.local ? '연결 폴더' : '작업 공간', readRaw: req.readRaw }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceKey, req.local],
  );
  return <FileViewerPane fileName={req.name} rel={req.path} source={source} sourceKey={sourceKey} text={req.text} embedded onDownload={req.download} />;
};
