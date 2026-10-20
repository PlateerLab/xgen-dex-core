import assert from 'node:assert/strict';
import test from 'node:test';
import { actionRow, actionSentence, josa, replyFor } from '../src/main/fast-act-reply';
import type { VoiceAction } from '../src/main/fast-act-voice';
import { Segmenter, type VoiceAgent } from '../src/main/voice-segmenter';

const act = (over: Partial<VoiceAction>): VoiceAction => ({
  said: '블로그 탭',
  label: 'tab "블로그"',
  display: '"블로그" 탭',
  action: 'click',
  text: null,
  partial: false,
  decideMs: 672,
  actMs: 64,
  at: 800,
  navigated: false,
  ...over,
});

test('조사는 받침을 따르고, 모르면 둘 다 적는다', () => {
  assert.equal(josa('"블로그" 탭', '을', '를'), '"블로그" 탭을');
  assert.equal(josa('"장바구니" 링크', '을', '를'), '"장바구니" 링크를');
  assert.equal(josa('"xgen"', '을', '를'), '"xgen"을');
  assert.equal(josa('"naver"', '을', '를'), '"naver"를');
  assert.equal(josa('"3"', '을', '를'), '"3"을');
  assert.equal(josa('"3일"', '으로', '로'), '"3일"로');
  assert.equal(josa('"일반상품"', '으로', '로'), '"일반상품"으로');
  assert.equal(josa('"전체"', '으로', '로'), '"전체"로');
  assert.equal(josa('"7"', '으로', '로'), '"7"로');
  assert.equal(josa('"2"', '을', '를'), '"2"를');
  assert.equal(josa('"google"', '을', '를'), '"google"을(를)');
});

test('누른 것은 에이전트 답처럼 문장으로, 이동했으면 열린 페이지까지', () => {
  assert.equal(actionSentence(act({})), '"블로그" 탭을 눌렀어요.');
  assert.equal(
    actionSentence(act({ navigated: true, url: 'https://section.blog.naver.com/', title: '네이버 블로그' })),
    '"블로그" 탭을 눌렀어요. "네이버 블로그" 페이지가 열렸어요.',
  );
  // 새 제목이 아직 없으면 다른 사이트로 갔을 때만 호스트로
  assert.equal(
    actionSentence(act({ navigated: true, from: 'https://www.google.com/search?q=xgen', url: 'https://www.xgen.im/?gad_source=1&gclid=abc' })),
    '"블로그" 탭을 눌렀어요. xgen.im 페이지가 열렸어요.',
  );
  assert.equal(
    actionSentence(act({ navigated: true, from: 'https://www.naver.com/', url: 'https://www.naver.com/news' })),
    '"블로그" 탭을 눌렀어요.',
  );
  assert.equal(
    actionSentence(act({ display: '"블로그" 링크', navigated: true, newTab: true, url: 'https://section.blog.naver.com/BlogHome.naver', title: '네이버 블로그' })),
    '"블로그" 링크를 눌렀어요. "네이버 블로그" 페이지가 새 탭에서 열렸어요.',
  );
  assert.equal(
    actionSentence(act({ display: '"AI 경쟁력 강화의 시작 XGEN" 링크', dismissed: '닫기' })),
    '가리던 팝업을 닫고 "AI 경쟁력 강화의 시작 XGEN" 링크를 눌렀어요.',
  );
});

test('입력은 칸과 글자로 — 검색칸 제출은 검색했다고', () => {
  assert.equal(
    actionSentence(
      act({
        display: '"검색어를 입력하고 버튼을 누르세요" 입력칸',
        action: 'type_submit',
        text: 'xgen',
        navigated: true,
        from: 'https://section.blog.naver.com/BlogHome.naver',
        url: 'https://section.blog.naver.com/Search/Post.naver?keyword=xgen',
      }),
    ),
    '"xgen"을 검색했어요.',
  );
  assert.equal(actionSentence(act({ display: '"이름" 입력칸', action: 'type', text: '홍길동' })), '"이름" 입력칸에 "홍길동"을 입력했어요.');
  assert.equal(
    actionSentence(act({ display: '"메모" 입력칸', action: 'type_submit', text: '내일 회의' })),
    '"메모" 입력칸에 "내일 회의"를 입력하고 Enter 키를 눌렀어요.',
  );
});

test('닫은 알림창 문구는 답에 그대로 전한다', () => {
  assert.equal(
    actionSentence(act({ display: '"판매가" 입력칸', action: 'type', text: '15000', notices: ['가격정보 입력전에 협력사를 먼저 입력해 주세요.'] })),
    '"판매가" 입력칸에 "15000"을 입력했어요. 화면에 뜬 알림 "가격정보 입력전에 협력사를 먼저 입력해 주세요."를 닫았어요.',
  );
  assert.equal(actionRow(act({ notices: ['a'] }), false), '"블로그" 탭 · 클릭 · 알림 닫음(1) · 판단 672ms · 실행 64ms');
});

test('답에는 시간·판단 점수가 없고, 작업 과정 줄에만 있다', () => {
  const actions = [act({}), act({ display: '"첫 글" 링크', said: '첫 글 열어' })];
  const reply = replyFor(actions);
  assert.equal(reply, '"블로그" 탭을 눌렀어요. "첫 글" 링크를 눌렀어요.');
  assert.doesNotMatch(reply, /ms|고속|결정 모델|판별/);
  assert.equal(actionRow(actions[0], false), '"블로그" 탭 · 클릭 · 판단 672ms · 실행 64ms');
  assert.equal(actionRow(act({ partial: true }), true), '"블로그" 탭 · 클릭 · 말하는 도중 · 판단 672ms · 실행 64ms');
});

test('판단 중 오류가 나도 final 은 끝나고 그 말은 서버로 넘긴다', async () => {
  const agent: VoiceAgent = {
    lastTarget: null,
    boundary: async () => ({ start: -1, conf: 0 }),
    readiness: async () => {
      throw new Error('decision timeout');
    },
    handle: async () => {
      throw new Error('decision timeout');
    },
  };
  const seg = new Segmenter(agent, () => undefined);
  await seg.final('블로그 탭 눌러줘 그리고 첫 글');
  assert.equal(seg.acted, false);
  assert.equal(seg.unhandled, '블로그 탭 눌러줘 그리고 첫 글');
});

test('확인하지 못한 조작과 남은 요청은 버리지 않고 서버로 넘긴다', async () => {
  let calls = 0;
  const agent: VoiceAgent = {
    lastTarget: null,
    boundary: async () => ({ start: 0, conf: 1 }),
    readiness: async (texts) => texts.map(() => ({ ready: 'multi', p: 1 })),
    handle: async () => {
      calls++;
      return { acted: true, kind: 'type', target: '제목', ms: 0, effect: 'none' };
    },
  };
  const seg = new Segmenter(agent, () => undefined);
  const text = '제목 입력하고 배송도 선택해줘';
  await seg.final(text);
  assert.equal(seg.unhandled, text);
  assert.equal(calls, 1);
});

test('음성 중간 조작 실패 뒤 최종 인식도 끝나고 뒷말까지 서버로 넘긴다', async () => {
  let calls = 0;
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => { failed = resolve; });
  const agent: VoiceAgent = {
    lastTarget: null,
    boundary: async () => ({ start: 0, conf: 1 }),
    readiness: async (texts) => texts.map(() => ({ ready: 'act_now', p: 1 })),
    handle: async () => {
      calls++;
      return { acted: true, kind: 'type', target: '제목', ms: 0, effect: 'none' };
    },
  };
  const seg = new Segmenter(agent, (event) => { if (event.type === 'decide') failed(); });
  seg.partial('제목 입력해줘');
  await failure;
  await seg.final('제목 입력해줘 그리고 배송도 선택해줘');
  assert.equal(seg.unhandled, '제목 입력해줘 그리고 배송도 선택해줘');
  assert.equal(calls, 1);
});

test('앞 요청의 꼬리라는 남은 말도 그것만으로 누를 대상이 분명하면 누르고, 아니면 서버로 넘기지 않는다', async () => {
  const run = async (tailPick: { target: string; conf: number } | null) => {
    const handled: string[] = [];
    let pressed: string | null = null;
    let lastTarget: string | null = null;
    const agent: VoiceAgent = {
      get lastTarget() {
        return lastTarget;
      },
      // 앞부분을 실행하기 전 확인에는 새 요청(검색해줘), 실행한 뒤에는 꼬리말로 답한다 — 꼬리말 처리를 보려고.
      boundary: async () => (lastTarget ? { start: -1, conf: 0.999 } : { start: 0, conf: 0.9 }),
      readiness: async (texts) =>
        texts.map((t) => ({ ready: t === '브랜드명에 삼성 입력하고' ? 'act_now' : 'wait', p: 0.9 })),
      handle: async (text, _th, guard) => {
        handled.push(text);
        if (text === '브랜드명에 삼성 입력하고') {
          if (!(await guard('textbox ""', 'type', 0.99))) return { acted: false, reason: 'guarded', ms: 0 };
          lastTarget = 'textbox ""';
          return { acted: true, kind: 'type', target: 'textbox ""', text: '삼성', ms: 0, effect: 'ok' };
        }
        if (!tailPick || !(await guard(tailPick.target, 'press', tailPick.conf)))
          return { acted: false, reason: 'guarded', ms: 0 };
        pressed = tailPick.target;
        return { acted: true, kind: 'press', target: tailPick.target, ms: 0, effect: 'ok' };
      },
    };
    const seg = new Segmenter(agent, () => undefined);
    await seg.final('브랜드명에 삼성 입력하고 검색해줘');
    return { handled, pressed, unhandled: seg.unhandled };
  };
  assert.deepEqual(await run({ target: 'button "조회"', conf: 0.97 }), {
    handled: ['브랜드명에 삼성 입력하고', '검색해줘'],
    pressed: 'button "조회"',
    unhandled: null,
  });
  // 확신이 낮거나 이름을 가리키지 않으면 꼬리말로 친다 — 서버로 넘기지 않는다
  assert.deepEqual(await run({ target: 'button "닫기"', conf: 0.6 }), {
    handled: ['브랜드명에 삼성 입력하고', '검색해줘'],
    pressed: null,
    unhandled: null,
  });
  assert.deepEqual(await run(null), {
    handled: ['브랜드명에 삼성 입력하고', '검색해줘'],
    pressed: null,
    unhandled: null,
  });
});

test('고르지 못하고 물어볼 말이 있으면 한 일 뒤에 그대로 붙인다', () => {
  const searched = act({
    label: 'textbox "협력사명 검색어"',
    display: '"협력사명 검색어" 입력칸',
    action: 'type_submit',
    text: '플래티어 3',
    tell: '"플래티어 3"과 정확히 같은 항목이 없어요. 비슷한 항목: 플래티어 2, 플래티어.',
    ask: '어느 것을 고를까요?',
  });
  assert.equal(
    actionSentence(searched),
    '"플래티어 3"을 검색했어요. "플래티어 3"과 정확히 같은 항목이 없어요. 비슷한 항목: 플래티어 2, 플래티어. 어느 것을 고를까요?',
  );
  // BrowserFill 을 부른 LLM 에게는 묻지 않는다 — 까닭만.
  assert.equal(
    replyFor([searched], true),
    '"플래티어 3"을 검색했어요. "플래티어 3"과 정확히 같은 항목이 없어요. 비슷한 항목: 플래티어 2, 플래티어.',
  );
});

test('열려 있던 팝업 창이 다시 불렸으면 새 탭이라 하지 않는다', () => {
  assert.equal(
    actionSentence(act({ display: '"협력사" 선택 상자', navigated: true, newTab: true, reusedTab: true, title: '협력사 조회 - X2BEE ADMIN' })),
    '"협력사" 선택 상자를 눌렀어요. "협력사 조회 - X2BEE ADMIN" 페이지가 열려 있던 창에서 다시 열렸어요.',
  );
});

test('누르지 않은 요소는 그 까닭만 답한다 — 한 일처럼 "눌렀어요" 라 하지 않는다', () => {
  const skipped = act({
    label: 'checkbox "네이버페이"',
    display: '"네이버페이" 체크박스',
    sentence: '"네이버페이" 체크박스는 이미 체크돼 있어요.',
  });
  assert.equal(actionSentence(skipped), '"네이버페이" 체크박스는 이미 체크돼 있어요.');
});

test('말 전체가 여러 단계 작업이면 앞부분만 떼어 실행하지 않고 통째로 판단한다', async () => {
  const handled: string[] = [];
  const agent: VoiceAgent = {
    lastTarget: null,
    boundary: async () => ({ start: -1, conf: 0 }),
    readiness: async (texts) => texts.map((t) => ({ ready: t.endsWith('넣어줘') ? 'multi' : 'act_now', p: 0.96 })),
    handle: async (text) => {
      handled.push(text);
      return { acted: false, reason: '여러 단계 작업 0.94', ms: 0 };
    },
  };
  const seg = new Segmenter(agent, () => undefined);
  await seg.final('PDF에 있는 상품 설명으로 상품상세 써서 넣어줘');
  assert.deepEqual(handled, ['PDF에 있는 상품 설명으로 상품상세 써서 넣어줘']);
  assert.equal(seg.unhandled, 'PDF에 있는 상품 설명으로 상품상세 써서 넣어줘');
});

test('앞부분만 떼면 완결된 말이라도 남은 말이 그 꼬리면 쪼개지 않고 통째로 판단한다', async () => {
  const handled: string[] = [];
  const agent: VoiceAgent = {
    lastTarget: null,
    boundary: async () => ({ start: -1, conf: 0.97 }),
    readiness: async (texts) => texts.map((t) => ({ ready: t === '임시저장한 상품 확인' || t.endsWith('이동해줘') ? 'act_now' : 'wait', p: 0.98 })),
    handle: async (text) => {
      handled.push(text);
      return { acted: false, reason: '요소 확신 낮음 0.4', ms: 0 };
    },
  };
  const seg = new Segmenter(agent, () => undefined);
  await seg.final('임시저장한 상품 확인 페이지로 이동해줘');
  assert.deepEqual(handled, ['임시저장한 상품 확인 페이지로 이동해줘']);
  assert.equal(seg.unhandled, '임시저장한 상품 확인 페이지로 이동해줘');
});
