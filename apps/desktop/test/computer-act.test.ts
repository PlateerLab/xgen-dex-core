/**
 * 말로 다른 맥 앱 조작 — 후보 규칙. 판단은 결정 모델이 하지만 무엇을 후보로 보일지는 여기서 정한다:
 *   · 발표(앱 창이 화면 하나를 덮음) 중이면 발표 끝내기·다음·이전을 붙인다 — 없으면 "장표 내려줘" 에 `파일 > 닫기` 를 고른다.
 *   · 되돌릴 수 없을 수 있는 항목(닫기·저장·종료·삭제 …)과 누를 수 없는 입력칸은 후보에서 뺀다.
 *   · 시스템 후보는 화면 줄 맨 앞(60줄 안)에 둔다 — 요소가 많은 앱에서도 보이게.
 * 예시 이름은 PowerPoint(맥) 메뉴 그대로다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { appRefs, systemActions } from '../src/main/fast-act-computer';
import { buildScreen } from '../src/main/fast-act-e13';

const names = (o: Record<string, { name: string }>): string[] => Object.values(o).map((a) => a.name);

test('발표 중이면 발표 끝내기·다음·이전을 붙이고, 창 최소화는 뺀다', () => {
  const sys = systemActions({ app: 'PowerPoint', pid: 1, presenting: true, window: 'PowerPoint 슬라이드 쇼' }, () => undefined);
  assert.deepEqual(names(sys), [
    '발표(전체 화면) 끝내기 (Esc 키)',
    '다음 슬라이드·장 (→ 키)',
    '이전 슬라이드·장 (← 키)',
    'PowerPoint 앱 숨기기',
    'XGen Dex 앞으로 가져오기',
  ]);
  assert.deepEqual(Object.keys(sys), ['e9001', 'e9002', 'e9003', 'e9004', 'e9005']);
});

test('발표 중이 아니면 키 조작 없이 숨기기·최소화·DeX 앞으로', () => {
  const sys = systemActions({ app: 'Finder', pid: 1, presenting: false, window: '다운로드' }, () => undefined);
  assert.deepEqual(names(sys), ['Finder 앱 숨기기', 'Finder 창 최소화', 'XGen Dex 앞으로 가져오기']);
  // 창이 없으면 최소화할 것도 없다
  assert.deepEqual(names(systemActions({ app: 'Finder', pid: 1, presenting: false }, () => undefined)), [
    'Finder 앱 숨기기',
    'XGen Dex 앞으로 가져오기',
  ]);
});

test('되돌릴 수 없을 수 있는 항목·입력칸·이름 없는 요소는 후보에서 뺀다', () => {
  const { refs } = appRefs({
    refs: [
      { ref: 'e1', role: 'menuitem', name: '파일 > 닫기' },
      { ref: 'e2', role: 'menuitem', name: '파일 > 저장' },
      { ref: 'e3', role: 'menuitem', name: 'PowerPoint > PowerPoint 끝내기' },
      { ref: 'e10', role: 'menuitem', name: '파일 > 인쇄...' },
      { ref: 'e11', role: 'button', name: '보내기' },
      { ref: 'e4', role: 'menuitem', name: '편집 > 삭제' },
      { ref: 'e5', role: 'menuitem', name: '보기 > 슬라이드 쇼' },
      { ref: 'e6', role: 'menuitem', name: 'PowerPoint > PowerPoint 가리기' },
      { ref: 'e7', role: 'textbox', name: '검색' },
      { ref: 'e8', role: 'button', name: '' },
      { ref: 'e9', role: 'button', name: 'Close' },
    ],
  });
  assert.deepEqual(Object.values(refs).map((r) => r.name), ['보기 > 슬라이드 쇼', 'PowerPoint > PowerPoint 가리기']);
});

test('창 안 위치로 바꾸고, 창 밖(스크롤로 가려진) 요소는 보이지 않는 것으로', () => {
  const { list, size } = appRefs({
    windowFrame: [100, 50, 800, 600],
    refs: [
      { ref: 'e1', role: 'button', name: '새 슬라이드', frame: [120, 70, 40, 20] },
      { ref: 'e2', role: 'button', name: '아래쪽', frame: [120, 900, 40, 20] },
      { ref: 'e3', role: 'menuitem', name: '보기 > 기본' },
    ],
  });
  assert.deepEqual(size, [800, 600]);
  assert.deepEqual(list[0].frame, [20, 20, 40, 20]);
  assert.equal(list[0].visible, true);
  assert.equal(list[1].visible, false);
  assert.equal(list[2].frame, undefined);
});

test('시스템 후보는 정렬하지 않고 화면 줄 맨 앞에 — 요소가 60개를 넘어도 보인다', () => {
  const sys = systemActions({ app: 'PowerPoint', pid: 1, presenting: true }, () => undefined);
  const head = Object.entries(sys).map(([ref, a]) => ({ ref, role: a.role, name: a.name }));
  const many = Array.from({ length: 80 }, (_, i) => ({ ref: `e${i + 1}`, role: 'button', name: `버튼 ${i + 1}`, frame: [10, 10 + i, 5, 5] }));
  const scr = buildScreen('PowerPoint (전체 화면)', many, [800, 600], head);
  assert.deepEqual(scr.ids.slice(0, 5), ['e9001', 'e9002', 'e9003', 'e9004', 'e9005']);
  assert.equal(scr.ids.length, 60);
  assert.match(scr.text.split('\n')[0], /^e9001 \| button \| "발표\(전체 화면\) 끝내기 \(Esc 키\)"$/);
  assert.match(scr.text.split('\n')[5], /^e1 \| button \| "버튼 1" \| 왼쪽 위$/);
});
