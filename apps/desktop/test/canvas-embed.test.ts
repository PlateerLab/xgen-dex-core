/**
 * 에이전트 뷰어 [워크플로우] 탭의 캔버스 주소: webview 를 붙여도 되는 곳은 설정된 서버의 /canvas 뿐이다.
 * 토큰 쿠키를 심은 세션이라, 다른 주소가 붙으면 그 페이지가 이 앱의 자격으로 서버를 부를 수 있다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasUrl, isCanvasUrl } from '../src/main/canvas-url';

test('캔버스 주소는 내장 모드로 그 워크플로우를 연다', () => {
  assert.equal(canvasUrl('https://xgen.example.com/', 'wf_1', '7'), 'https://xgen.example.com/canvas?load=wf_1&embed=1&user_id=7');
  assert.equal(canvasUrl('http://10.0.0.5:3000', 'wf 2', null), 'http://10.0.0.5:3000/canvas?load=wf+2&embed=1');
});

test('설정된 서버의 /canvas 만 붙인다', () => {
  const server = 'https://xgen.example.com';
  assert.equal(isCanvasUrl(server, canvasUrl(server, 'wf_1')), true);
  assert.equal(isCanvasUrl(server, 'https://xgen.example.com/main'), false);
  assert.equal(isCanvasUrl(server, 'https://evil.example.com/canvas?load=wf_1'), false);
  assert.equal(isCanvasUrl(server, 'http://xgen.example.com/canvas'), false);
  assert.equal(isCanvasUrl('', 'https://xgen.example.com/canvas'), false);
});
