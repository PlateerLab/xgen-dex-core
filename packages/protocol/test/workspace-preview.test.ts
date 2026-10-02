/**
 * 작업 공간 문서 미리보기 — [파일 저장소] 와 같은 렌더러(서버 doc-preview)의 페이지 목록과 페이지 그림 (2026-10-02).
 *
 * 예전에는 이 길이 프로토콜에 없어 데스크톱은 에이전트가 만든 docx·pptx 를 "다운로드해 여세요" 로 끝냈다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentDataApi, DOC_PREVIEW_PAGE_PREFIX } from '../src/agent-data';
import { HttpClient } from '../src/client';

function recording(respond: (url: URL) => Response) {
  const calls: URL[] = [];
  const api = new AgentDataApi(
    new HttpClient({
      baseUrl: 'https://x.example',
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url);
        return respond(url);
      },
    }),
  );
  return { api, calls };
}

test('문서 미리보기 — workspace/ 를 붙여 묻고 페이지 경로를 그대로 돌려준다', async () => {
  const { api, calls } = recording(() =>
    new Response(JSON.stringify({ kind: 'svg', count: 2, pages: ['.canvas-preview/k/1/slide_001.svg', '.canvas-preview/k/1/slide_002.svg'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const res = await api.workspaceDocPreview('wf 1', '보고서/분석.pptx');
  assert.equal(calls[0].pathname, '/api/agentflow/geny-workspace/wf%201/doc-preview');
  assert.equal(calls[0].searchParams.get('path'), 'workspace/보고서/분석.pptx');
  assert.equal(res.kind, 'svg');
  assert.deepEqual(res.pages, ['.canvas-preview/k/1/slide_001.svg', '.canvas-preview/k/1/slide_002.svg']);
});

test('PDF 는 서버가 그리지 않는다고 말한다 — 화면이 원바이트로 그린다', async () => {
  const { api } = recording(() => new Response(JSON.stringify({ kind: 'pdf', count: 0, pages: [] }), { status: 200 }));
  const res = await api.workspaceDocPreview('wf', 'a.pdf');
  assert.equal(res.kind, 'pdf');
  assert.deepEqual(res.pages, []);
});

test('페이지 그림 — 스토리지 루트 기준 경로 그대로(workspace/ 를 붙이지 않는다)', async () => {
  const { api, calls } = recording(() => new Response(new Uint8Array([0x3c, 0x73]), { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }));
  const page = `${DOC_PREVIEW_PAGE_PREFIX}abc/17/slide_001.svg`;
  const res = await api.workspacePreviewPage('wf', page);
  assert.equal(decodeURIComponent(calls[0].pathname), `/api/agentflow/geny-workspace/wf/storage-raw/${page}`);
  assert.equal(res.contentType, 'image/svg+xml');
  assert.equal(res.bytes.byteLength, 2);
});

test('렌더 결과가 아닌 곳은 페이지로 읽지 않는다', async () => {
  const { api, calls } = recording(() => new Response('', { status: 200 }));
  await assert.rejects(api.workspacePreviewPage('wf', 'workspace/secret.txt'));
  await assert.rejects(api.workspacePreviewPage('wf', '.canvas-preview/../workspace/secret.txt'));
  assert.equal(calls.length, 0);
});
