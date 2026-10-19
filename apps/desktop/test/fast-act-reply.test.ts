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

test('앞 요청의 꼬리라는 남은 말도 그것만으로 누를 대상이 분명하면 누르고, 아니면 서버로 넘기지 않는다', async () => {
  const run = async (tailPick: { target: string; conf: number } | null) => {
    const handled: string[] = [];
    let pressed: string | null = null;
    let lastTarget: string | null = null;
    const agent: VoiceAgent = {
      get lastTarget() {
        return lastTarget;
      },
      boundary: async () => ({ start: -1, conf: 0.999 }),
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
    tell: '"플래티어 3"과 정확히 같은 항목이 없어요. 플래티어 2, 플래티어 중 어느 것을 고를까요?',
  });
  assert.equal(
    actionSentence(searched),
    '"플래티어 3"을 검색했어요. "플래티어 3"과 정확히 같은 항목이 없어요. 플래티어 2, 플래티어 중 어느 것을 고를까요?',
  );
});

test('누르지 않은 요소는 그 까닭만 답한다 — 한 일처럼 "눌렀어요" 라 하지 않는다', () => {
  const skipped = act({
    label: 'checkbox "네이버페이"',
    display: '"네이버페이" 체크박스',
    skipped: '"네이버페이" 체크박스는 이미 체크돼 있어요.',
  });
  assert.equal(actionSentence(skipped), '"네이버페이" 체크박스는 이미 체크돼 있어요.');
});
