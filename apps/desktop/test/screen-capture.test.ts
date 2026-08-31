/**
 * 화면 캡처 — 채팅을 보낼 때 지금 화면을 함께 보낸다.
 *
 * 이 기능의 유일한 위험은 **사용자가 모르는 사이에 화면이 나가는 것**이다.
 * 화면에는 다른 사람의 메시지·비밀번호·미공개 문서가 있다. 그래서 여기서
 * 지키는 것은 기능이 도는가보다 그 경계다:
 *
 *   1. 기본은 꺼짐. 켜는 것은 사용자의 명시적 선택이다.
 *   2. 게이트는 **기기 쪽**에 있다 — 렌더러가 실수로 불러도 나가지 않는다.
 *   3. 켜져 있다는 사실이 항상 보이고, 나간 기록이 대화에 남는다.
 *   4. 실패는 조용히 넘어가지 않는다 (특히 macOS 권한 거부).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(__dirname, '..');
const CAPTURE = readFileSync(join(ROOT, 'src/main/screen-capture.ts'), 'utf8');
const MAIN = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
const PRELOAD = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8');
const CHAT = readFileSync(join(ROOT, 'src/renderer/src/views/Chat.tsx'), 'utf8');
// 전송 페이로드(멀티모달 구성)와 메시지 타입은 SessionStore 가 소유한다 —
// 화면 캡처 트리거·표시는 Chat 에 남는다.
const STORE = readFileSync(join(ROOT, 'src/renderer/src/session-store.ts'), 'utf8');
const CONFIG = readFileSync(join(ROOT, 'src/main/config.ts'), 'utf8');

// ── 1. 기본은 꺼짐, 게이트는 기기에 ────────────────────────────────────

test('설정 항목이 있고 기본값이 없다(= 꺼짐)', () => {
  assert.match(CONFIG, /screenCapture\?: boolean;/);
  assert.match(CONFIG, /screenCaptureSource\?: string;/);
  // `?:` 이므로 미설정이 기본이고, main 은 truthy 검사를 한다 → 꺼짐.
});

test('main 이 설정을 다시 확인한다 — 렌더러를 믿지 않는다', () => {
  const h = MAIN.slice(
    MAIN.indexOf('CHANNELS.captureScreen'),
    MAIN.indexOf('CHANNELS.overlayGetLocked'),
  );
  assert.match(h, /if \(!cfg\.screenCapture\)/, '설정이 꺼져 있어도 찍는다');
  assert.match(h, /return \{ ok: false/);
});

test('목록 조회는 미리보기를 받지 않는다', () => {
  // 설정 화면을 열 때마다 전체 화면 썸네일을 N장 만들 이유가 없다.
  const fn = CAPTURE.slice(CAPTURE.indexOf('export async function listSources'));
  assert.match(fn.slice(0, 400), /thumbnailSize: \{ width: 1, height: 1 \}/);
});

// ── 2. 실패를 감추지 않는다 ────────────────────────────────────────────

test('macOS 권한 거부는 사유와 조치를 알려 준다', () => {
  assert.match(CAPTURE, /getMediaAccessStatus\('screen'\)/);
  assert.match(CAPTURE, /화면 기록/);
  assert.match(CAPTURE, /시스템 설정/, '무엇을 해야 하는지 알려주지 않는다');
});

test('빈 화면을 성공으로 처리하지 않는다', () => {
  // macOS 는 권한이 없으면 검은/빈 이미지를 준다. 그걸 "찍었다" 로 넘기면
  // 사용자는 에이전트가 화면을 본다고 믿은 채 엉뚱한 답을 받는다.
  assert.match(CAPTURE, /img\.isEmpty\(\)/);
  assert.match(CAPTURE, /빈 화면이 캡처되었습니다/);
});

test('소스가 하나도 없으면 실패로 돌려준다', () => {
  assert.match(CAPTURE, /sources\.length === 0/);
});

test('고른 창이 사라져도 무엇이든 준다 — 그리고 무엇을 찍었는지 말한다', () => {
  // 창을 닫았다고 캡처가 통째로 실패하면 사용자는 이유를 모른다.
  assert.match(CAPTURE, /const wanted = sourceId \? sources\.find/);
  assert.match(CAPTURE, /sourceName: chosen\.name/);
});

// ── 3. 크기 ────────────────────────────────────────────────────────────

test('원본 해상도를 그대로 보내지 않는다', () => {
  // 4K 한 장은 수 MB 다. 매 턴 그만큼이면 회선과 토큰을 같이 태운다.
  assert.match(CAPTURE, /const MAX_EDGE = 1600/);
  assert.match(CAPTURE, /function fit\(/);
});

test('비율을 유지한다', () => {
  // thumbnailSize 를 고정값으로 주면 찌그러진 그림이 나온다.
  const fn = CAPTURE.slice(
    CAPTURE.indexOf('function fit('),
    CAPTURE.indexOf('export async function captureScreen'),
  );
  assert.match(fn, /MAX_EDGE \/ longest/);
  assert.match(fn, /width \* k/);
  assert.match(fn, /height \* k/);
});

test('디스플레이 배율을 반영한다', () => {
  // 레티나에서 논리 크기로 잡으면 절반 해상도가 된다.
  assert.match(CAPTURE, /scaleFactor/);
});

// ── 4. 보낼 때 붙고, 붙은 것이 보인다 ─────────────────────────────────

// 캡처는 `send` 가 아니라 `dispatch` 안에 있다. Teams 문맥 확인창이 생기면서
// send 는 "물어볼 것이 있으면 멈추는" 관문이 되었고, **실제 전송 직전**의 자리가
// dispatch 로 내려갔기 때문이다. 지키려는 것은 그대로다: 확인이 끝나고 진짜로
// 보내는 그 순간에 찍고, 못 찍어도 질문은 나간다.
const DISPATCH = CHAT.slice(
  CHAT.indexOf('const dispatch = useCallback'),
  CHAT.indexOf('sessionStore.send(session.key'),
);

test('전송 직전에 찍는다', () => {
  // 주기적으로 올리지 않는다 — 사용자가 언제 무엇이 나갔는지 알아야 한다.
  assert.ok(DISPATCH.length > 0, 'dispatch 를 찾지 못했다');
  assert.match(DISPATCH, /if \(screenCaptureOn\)/);
  assert.match(DISPATCH, /await xgen\.capture\.screen\(\)/);
});

test('캡처 실패가 대화를 막지 않는다', () => {
  // 캡처는 덤이다. 못 찍었다고 사용자의 질문이 사라지면 그게 더 나쁘다.
  // 실패해도 setCaptureNotice 로 알릴 뿐 return 하지 않고 sessionStore.send 로 이어진다.
  assert.match(DISPATCH, /setCaptureNotice/, '실패를 알리지 않는다');
  assert.ok(
    !/\breturn;/.test(DISPATCH.slice(DISPATCH.indexOf('if (screenCaptureOn)'))),
    '캡처 실패 시 전송을 중단한다',
  );
});

test('화면 캡처는 Teams 문맥 확인이 끝난 뒤에 찍는다', () => {
  // 확인창에서 취소할 수 있는데 먼저 찍으면, 보내지도 않은 화면을 캡처한 셈이 된다.
  // send 는 멈출 수 있는 관문이고, dispatch 가 실제 전송이어야 한다.
  const gate = CHAT.slice(
    CHAT.indexOf('const send = useCallback'),
    CHAT.indexOf('const confirmContext'),
  );
  assert.ok(!/xgen\.capture\.screen/.test(gate), 'send 단계에서 미리 찍는다');
  assert.match(gate, /setCtxConfirm/, '확인 없이 바로 보낸다');
});

test('백엔드가 받는 멀티모달 형식으로 보낸다', () => {
  // 페이로드 구성은 스토어(send)로 옮겨졌다.
  assert.match(STORE, /type: 'image_url'/);
  assert.match(STORE, /image_url: \{ url: shot\.dataUrl \}/);
  // 캡처가 없으면 예전처럼 문자열 — shot?.dataUrl 삼항의 else 는 text.
  assert.match(STORE, /shot\?\.dataUrl/);
  assert.match(STORE, /: text;/);
});

test('작성기에서 버튼을 숨긴 동안에는 저장된 화면 캡처 설정도 강제로 끈다', () => {
  assert.match(CHAT, /화면 캡처 버튼은 이미지 첨부 버튼으로 교체하여 임시 비활성화/);
  assert.match(CHAT, /if \(c\.screenCapture\) void xgen\.config\.set\(\{ screenCapture: false \}\)/);
});

test('나간 기록이 대화에 남는다', () => {
  // 대화 기록만 봐도 언제 무엇을 보냈는지 알 수 있어야 한다.
  // 메시지 타입(전사 보존)은 스토어의 ChatMsg, 표시는 Chat.
  assert.match(STORE, /screenshot\?: \{ sourceName: string/);
  assert.match(STORE, /screenshot: shot/, '보낸 스크린샷을 사용자 메시지에 기록하지 않는다');
  assert.match(CHAT, /화면 첨부 · \{m\.screenshot\.sourceName\}/);
});

// ── 5. 브릿지 ─────────────────────────────────────────────────────────

test('preload 가 캡처 브릿지를 노출한다', () => {
  for (const fn of ['listSources', 'accessStatus', 'screen']) {
    assert.match(PRELOAD, new RegExp(`\\b${fn}:`), `capture.${fn} 이 없다`);
  }
});

test('main 에 세 핸들러가 모두 있다', () => {
  for (const ch of ['captureListSources', 'captureScreen', 'captureAccessStatus']) {
    assert.match(MAIN, new RegExp(`CHANNELS\\.${ch}`), `${ch} 핸들러가 없다`);
  }
});
