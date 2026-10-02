import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatAnswerFiles,
  chatDownloadRequest,
  extractChatDownloads,
  isChatImageName,
  mergeChatDownload,
  resolveArtifactCapability,
  stripChatDownloadMarkers,
  withoutShownFiles,
} from '../src/chat-files';

// 웹(@xgen/api-client download-artifacts.test.ts)과 같은 사례 — 같은 표식은 같은 단추가 되어야 한다.
const fullMarker =
  '📎 다운로드: [File: 보고서.pptx]__[Path: file-storage/1/보고서/결과물/보고서.pptx]__[StorageId: 109]__[FileId: 10114]';

test('이력 본문의 표식(접힌 도구 출력 안까지)에서 파일을 되살린다', () => {
  const content = `<TOOLOUTPUTLOG>${fullMarker}</TOOLOUTPUTLOG>\n완료했습니다.\n${fullMarker}`;
  assert.deepEqual(extractChatDownloads(content), [
    { name: '보고서.pptx', path: 'file-storage/1/보고서/결과물/보고서.pptx', storageId: 109, fileId: 10114 },
  ]);
});

test('download_artifact 이벤트를 같은 파일은 한 번만 쌓는다', () => {
  const once = mergeChatDownload([], { file_name: '보고서.pptx', storage_id: 109, file_id: 10114 });
  const twice = mergeChatDownload(once, { file_name: '보고서.pptx', storage_id: '109', file_id: '10114' });
  assert.equal(twice, once);
  assert.equal(twice.length, 1);
  assert.deepEqual(mergeChatDownload([], { file_name: 'x', storage_id: 0, file_id: 1 }), [], '모양이 어긋나면 버린다');
});

test('API 응답 임시 파일 — 이벤트와 이력 링크가 같은 파일이 되고, 토큰은 머리로 옮긴다', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const url = `/api/agentflow/files/artifacts/${id}/download#token=test-token`;
  const live = mergeChatDownload([], { file_name: '월별.xlsx', artifact_id: id, download_url: url, size: 4096 });
  assert.equal(mergeChatDownload(live, { file_name: '월별.xlsx', artifact_id: id, download_url: url }), live);
  assert.equal(extractChatDownloads(`[월별.xlsx](${url})`)[0].artifactId, id);
  assert.equal(stripChatDownloadMarkers(`완료했습니다.\n[월별.xlsx](${url})`, live), '완료했습니다.', '걷은 자리의 끝 빈 줄도 걷는다');
  assert.deepEqual(resolveArtifactCapability(url), {
    requestUrl: `/api/agentflow/files/artifacts/${id}/download`,
    headers: { 'X-XGEN-Artifact-Token': 'test-token' },
  });
  assert.equal(
    mergeChatDownload([], { artifact_id: id, download_url: `/api/agentflow/files/artifacts/${id}/forged#token=v` }).length,
    0,
    '다른 길을 가리키는 주소는 받지 않는다',
  );
  assert.deepEqual(chatDownloadRequest(live[0]), {
    path: `/api/agentflow/files/artifacts/${id}/download`,
    headers: { 'X-XGEN-Artifact-Token': 'test-token' },
  });
});

test('보일 본문 — 단추로 그릴 표식만 걷고, 스트림으로 받은 것이 먼저 온다', () => {
  const answer = `그림을 만들었어요.\n\n${fullMarker}\n[File: 모름.txt]__[Path: x]`;
  const live = mergeChatDownload([], { file_name: 'a.png', storage_id: 1, file_id: 2 });
  const { text, downloads } = chatAnswerFiles(answer, live);
  assert.deepEqual(
    downloads.map((d) => d.name),
    ['a.png', '보고서.pptx'],
  );
  assert.equal(text.includes('StorageId'), false);
  assert.equal(text.includes('[File: 모름.txt]'), true, '모르는 표식은 남긴다 — 지우면 받을 길이 없다');
  assert.deepEqual(chatDownloadRequest(downloads[0], { preview: true }), { path: '/api/storage/file/preview/2', headers: {} });
});

test('작업 공간에 같은 이름이 이미 보이면 그 다운로드는 뺀다(같은 그림 두 장 방지)', () => {
  const list = [
    { name: 'abc_1.png', storageId: 1, fileId: 2 },
    { name: '보고서.docx', storageId: 1, fileId: 3 },
  ];
  assert.deepEqual(
    withoutShownFiles(list, ['ABC_1.PNG']).map((d) => d.name),
    ['보고서.docx'],
  );
  assert.equal(isChatImageName('x.WEBP'), true);
  assert.equal(isChatImageName('x.svg'), false);
});
