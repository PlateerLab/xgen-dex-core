import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatFilesApi,
  chatAnswerFiles,
  chatDownloadKey,
  chatDownloadRequest,
  extractChatDownloads,
  isChatImageName,
  mergeChatDownload,
  resolveArtifactCapability,
  sharedNames,
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

test('답이 건넨 결과물 이름은 파일 저장소 것만 — API 응답 임시 파일은 뺀다', () => {
  assert.deepEqual(
    sharedNames([
      { name: '도면_표시.png', storageId: 123, fileId: 10707 },
      { name: 'response.json', artifactId: 'a1', downloadUrl: '/api/agentflow/files/artifacts/a1' },
    ]),
    ['도면_표시.png'],
  );
});

// ── 새 파일 저장소(filestore) 표식: 웹(@xgen/api-client filestore-download-artifacts.test.ts)과 같은 사례 ──

const proof = 'header.payload.signature';
const sha256 = 'a'.repeat(64);
const sourceId = '00000000-0000-4000-8000-000000000001';
const envelope = `__[Provenance: ${proof}]__[SHA256: ${sha256}]__[ContentType: image/png]__[ByteLength: 12]__[SourceId: ${sourceId}]`;

test('새 저장소 번호와 옛 저장소 번호는 같은 숫자라도 다른 파일이다', () => {
  const text =
    '📎 다운로드: [File: new.txt]__[Path: filestore/blob]__[FilestoreItemId: 7]\n' +
    '📎 다운로드: [File: old.txt]__[Path: file-storage/1/old]__[StorageId: 1]__[FileId: 7]';
  const items = extractChatDownloads(text);
  assert.deepEqual(items, [
    { name: 'new.txt', itemId: 7, path: 'filestore/blob' },
    { name: 'old.txt', path: 'file-storage/1/old', storageId: 1, fileId: 7 },
  ]);
  assert.deepEqual(items.map(chatDownloadKey), ['filestore:7', '1:7'], '옛 열쇠의 모양은 그대로다');
  assert.equal(stripChatDownloadMarkers(text, items).trim(), '');
});

test('이력에서 되살린 새 저장소 결과물과 스트림 이벤트는 단추 하나가 된다', () => {
  const restored = extractChatDownloads('[File: result.txt]__[Path: filestore/blob]__[FilestoreItemId: 18]');
  assert.equal(mergeChatDownload(restored, { backend: 'filestore', item_id: 18, file_name: 'result.txt' }), restored);
  const live = mergeChatDownload([], { backend: 'filestore', item_id: 18, file_name: 'result.txt', path: 'filestore/blob' });
  const { text, downloads } = chatAnswerFiles('결과입니다.\n\n📎 다운로드: [File: result.txt]__[Path: filestore/blob]__[FilestoreItemId: 18]', live);
  assert.equal(downloads.length, 1);
  assert.equal(text, '결과입니다.');
});

test('새 저장소 번호가 어긋나면 버리고, 옛 저장소 번호로 물러서지 않는다', () => {
  for (const item_id of [true, false, 0, -1, 1.5, {}, null, '7a']) {
    assert.deepEqual(mergeChatDownload([], { backend: 'filestore', item_id, storage_id: 1, file_id: 1 }), []);
  }
});

test('모르는 새 저장소 표식은 통째로 남긴다(앞부분만 걷지 않는다)', () => {
  const text = '[File: x]__[Path: filestore/blob]__[FilestoreItemId: 18]';
  assert.equal(stripChatDownloadMarkers(text, [{ name: 'x', fileId: 2, storageId: 1 }]), text);
  assert.equal(stripChatDownloadMarkers(text, [{ name: 'x', itemId: 19 }]), text);
});

test('새 저장소 표식의 생성물 증명은 이벤트와 같게 읽고, 꼬리까지 걷는다', () => {
  const text = `[File: generated.png]__[Path: filestore/blob]__[FilestoreItemId: 7]${envelope}`;
  const restored = extractChatDownloads(text);
  const streamed = mergeChatDownload([], {
    backend: 'filestore', item_id: 7, file_name: 'generated.png', path: 'filestore/blob',
    indication: 'ai_generated', proof, sha256, content_type: 'image/png', byte_length: 12, source_id: sourceId,
  });
  assert.deepEqual(restored, streamed);
  assert.equal(restored[0].provenance?.proof, proof);
  assert.equal(restored[0].provenance?.byte_length, 12);
  assert.equal(stripChatDownloadMarkers(text, restored), '');
});

test('옛 저장소 표식 뒤의 생성물 증명도 함께 걷는다(꼬리가 본문에 남지 않는다)', () => {
  const text = `그렸어요.\n${fullMarker}${envelope}`;
  const { text: shown, downloads } = chatAnswerFiles(text);
  assert.equal(shown, '그렸어요.');
  assert.equal(downloads[0].storageId, 109);
  assert.equal(downloads[0].provenance?.source_id, sourceId);
});

test('새 저장소 결과물은 filestore 항목 주소로 받는다(그림 미리보기도 원본 그대로)', async () => {
  const item = { name: 'a.png', itemId: 42 };
  assert.deepEqual(chatDownloadRequest(item), { path: '/api/filestore/items/42/download', headers: {} });
  assert.deepEqual(chatDownloadRequest(item, { preview: true }), { path: '/api/filestore/items/42/download', headers: {} });
  assert.equal(chatDownloadRequest({ name: 'x', itemId: 0, storageId: 1, fileId: 2 }), null, '어긋난 번호는 옛 길로 가지 않는다');
  assert.deepEqual(sharedNames([item, { name: 'r.json', artifactId: 'a1', downloadUrl: '/api/agentflow/files/artifacts/a1' }]), ['a.png']);

  const calls: string[] = [];
  const api = new ChatFilesApi({
    async getBinary(path: string) {
      calls.push(path);
      return { bytes: new Uint8Array([1]), contentType: 'image/png' };
    },
  } as never);
  await api.download(item, { preview: true });
  assert.deepEqual(calls, ['/api/filestore/items/42/download']);
});
