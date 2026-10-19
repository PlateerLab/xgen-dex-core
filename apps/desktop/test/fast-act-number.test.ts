import assert from 'node:assert/strict';
import test from 'node:test';
import { judgedText, quotedText, saysValue, textFromWordAnswers, withoutDisabledTwins } from '../src/main/fast-act';
import { maskedDate, plainNumber } from '../src/main/fast-act-number';

test('단위 붙은 말과 한글 자릿수를 숫자만으로 바꾼다', () => {
  assert.equal(plainNumber('20000원'), '20000');
  assert.equal(plainNumber('2만 원'), '20000');
  assert.equal(plainNumber('2만원'), '20000');
  assert.equal(plainNumber('1만 8천원'), '18000');
  assert.equal(plainNumber('1.5만'), '15000');
  assert.equal(plainNumber('3백만 원'), '3000000');
  assert.equal(plainNumber('20,000'), '20000');
  assert.equal(plainNumber(' 15% '), '15');
  assert.equal(plainNumber('100개'), '100');
  assert.equal(plainNumber('2.5kg'), '2.5');
  assert.equal(plainNumber('5일'), '5');
});

test('한글 숫자는 자릿수와 함께일 때 숫자로 바꾼다', () => {
  assert.equal(plainNumber('이만 원'), '20000');
  assert.equal(plainNumber('만 팔천 원'), '18000');
  assert.equal(plainNumber('만 원'), '10000');
  assert.equal(plainNumber('오천원'), '5000');
  assert.equal(plainNumber('2만 오천'), '25000');
  assert.equal(plainNumber('십만'), '100000');
  assert.equal(plainNumber('1억 2천만'), '120000000');
  assert.equal(plainNumber('삼백 개'), '300');
  assert.equal(plainNumber('삼성'), null);
  assert.equal(plainNumber('삼'), null);
  assert.equal(plainNumber('이삼만'), null);
  assert.equal(plainNumber('구매'), null);
});

test('고유어 수는 셈 단위 말이 뒤따를 때만 숫자로 바꾼다', () => {
  assert.equal(plainNumber('열 개'), '10');
  assert.equal(plainNumber('열개'), '10');
  assert.equal(plainNumber('열두 개'), '12');
  assert.equal(plainNumber('열 두 개'), '12');
  assert.equal(plainNumber('스물다섯 장'), '25');
  assert.equal(plainNumber('스무 개'), '20');
  assert.equal(plainNumber('세 개'), '3');
  assert.equal(plainNumber('한 번'), '1');
  assert.equal(plainNumber('하나'), null);
  assert.equal(plainNumber('네'), null);
  assert.equal(plainNumber('열'), null);
  assert.equal(plainNumber('열한'), null);
  assert.equal(plainNumber('열어'), null);
  assert.equal(plainNumber('세탁기'), null);
  assert.equal(plainNumber('한국 상품'), null);
});

test('숫자만이거나 숫자 말이 아니면 null', () => {
  assert.equal(plainNumber('20000'), null);
  assert.equal(plainNumber('3.5'), null);
  assert.equal(plainNumber('아이폰 15'), null);
  assert.equal(plainNumber('10 20'), null);
  assert.equal(plainNumber('15일 이내 배송'), null);
  assert.equal(plainNumber(''), null);
  assert.equal(plainNumber('1만만'), null);
  assert.equal(plainNumber('1만 2만'), null);
  assert.equal(plainNumber('3천 2천'), null);
});

/** 어절마다 두 질문의 '예' 확률 — textWordQuestions 의 답 꼴. */
const wordAnswers = (ps: number[]) =>
  Object.fromEntries(ps.flatMap((p, i) => [0, 1].map((j) => [`w${i}_${j}`, { choice: p >= 0.5 ? 'yes' : 'no', probabilities: { yes: p, no: 1 - p } }])));

test('넣을 글자는 수 말과 그 단위를 함께 — 단위만 골랐어도 앞의 수 말까지, 조사는 뗀다', () => {
  assert.equal(textFromWordAnswers('정상가 이만 원으로 해줘', wordAnswers([0.01, 0.4, 0.95, 0])), '이만 원');
  assert.equal(textFromWordAnswers('판매가 만 팔천 원으로 해줘', wordAnswers([0.01, 0.3, 0.6, 0.97, 0])), '만 팔천 원');
  assert.equal(textFromWordAnswers('정상가 20000원으로 해줘', wordAnswers([0.01, 0.97, 0])), '20000원');
  assert.equal(textFromWordAnswers('집에서 입력해줘', wordAnswers([0.97, 0])), '집');
  assert.equal(textFromWordAnswers('도로 입력해줘', wordAnswers([0.97, 0])), '도로');
  assert.equal(textFromWordAnswers('아이폰 15 입력해줘', wordAnswers([0.2, 0.97, 0])), '15');
  assert.equal(textFromWordAnswers('안전재고 수량 열 개 입력해줘', wordAnswers([0.01, 0.05, 0.3, 0.9, 0])), '열 개');
  assert.equal(textFromWordAnswers('안전재고 수량 열 개 입력해줘', wordAnswers([0, 0, 0.53, 0.49, 0])), '열 개');
  assert.equal(textFromWordAnswers('정상가 2만 원으로 해줘', wordAnswers([0, 0.97, 0.3, 0])), '2만 원');
  assert.equal(textFromWordAnswers('정상가 15 해줘', wordAnswers([0, 0.97, 0])), '15');
  assert.equal(textFromWordAnswers('안전재고 열 개로 바꿔줘', wordAnswers([0, 0.9, 0.9, 0])), '열 개');
  assert.equal(textFromWordAnswers('안전재고 열 개로 바꿔줘', wordAnswers([0, 0.9, 0.3, 0])), '열 개');
  assert.equal(textFromWordAnswers('재고 백 개로 해줘', wordAnswers([0, 0.97, 0, 0])), '백 개');
  assert.equal(textFromWordAnswers('도로 입력해줘', wordAnswers([0.97, 0])), '도로');
  assert.equal(textFromWordAnswers('통로 입력해줘', wordAnswers([0.97, 0])), '통로');
  assert.equal(textFromWordAnswers('지하 통로 입력해줘', wordAnswers([0.97, 0.97, 0])), '지하 통로');
});

test('maskedDate: 칸 형식의 자리에 말의 날짜·시각을 차례로', () => {
  const name = '판매기간 YYYY.MM.DD. – YYYY.MM.DD.';
  assert.equal(maskedDate(name, '2026.10.19부터 2026.12.31까지'), '2026.10.19. – 2026.12.31.');
  assert.equal(maskedDate(name, '2026-10-20 ~ 2026-12-31'), '2026.10.20. – 2026.12.31.');
  assert.equal(maskedDate(name, '2026년 11월 1일부터 2027년 1월 5일'), '2026.11.01. – 2027.01.05.');
  assert.equal(maskedDate(name, '2026.10.19'), null); // 자리는 둘인데 날짜는 하나
  assert.equal(maskedDate('시작일 YYYY-MM-DD', '2026.10.19'), '2026-10-19');
  assert.equal(maskedDate('상품명', '2026.10.19'), null);
  // 시각·순서·대소문자·년월만
  assert.equal(maskedDate('시작 YYYY-MM-DD HH:mm', '2026.11.05 14:30'), '2026-11-05 14:30');
  assert.equal(maskedDate('시작 YYYY-MM-DD HH:mm', '2026년 11월 5일 오후 2시 30분'), '2026-11-05 14:30');
  assert.equal(maskedDate('시작 YYYY-MM-DD HH:mm', '2026년 11월 5일 오전 9시'), '2026-11-05 09:00');
  assert.equal(maskedDate('Start MM/DD/YYYY', '2026-11-05'), '11/05/2026');
  assert.equal(maskedDate('기준일 yyyy-mm-dd', '2026.3.7'), '2026-03-07');
  assert.equal(maskedDate('정산월 YYYY.MM', '2026년 11월'), '2026.11');
  assert.equal(maskedDate('시각 HH:mm', '오후 3시 5분'), '15:05');
  assert.equal(maskedDate('발행일 YY.MM.DD', '2026.11.05'), '26.11.05');
  assert.equal(maskedDate('시작 YYYY-MM-DD HH:mm', '2026.11.05'), null); // 시각이 없다
});

test('quotedText: 짝 맞는 따옴표 안 — 「」 안의 다른 따옴표·줄바꿈은 글자다', () => {
  assert.equal(quotedText('"원피스" 검색해줘'), '원피스');
  assert.equal(quotedText('“여름 원피스” 입력해줘'), '여름 원피스');
  assert.equal(quotedText('상품상세 내용에 「첫 문단 "강조" 는 그대로\n\n둘째 문단 it\'s」 입력해줘'), '첫 문단 "강조" 는 그대로\n\n둘째 문단 it\'s');
  assert.equal(quotedText('따옴표 없음'), null);
  assert.equal(quotedText('닫지 않은 "따옴표'), null);
  assert.equal(quotedText('상품상세 내용에 「첫 문단\n둘째 문단» 입력해줘'), '첫 문단\n둘째 문단');
  assert.equal(quotedText('상품상세 내용에 「닫지 않음 입력해줘'), null);
});

test('judgedText: 따옴표 안이 길거나 여러 줄이면 판단에는 줄여서', () => {
  assert.equal(judgedText('제조사에 「이노데모 제조사 (가상)」 입력해줘'), '제조사에 「이노데모 제조사 (가상)」 입력해줘');
  assert.equal(judgedText('상품상세 내용에 「[상품 소개]\n원산지: 대한민국」 입력해줘'), '상품상세 내용에 「…」 입력해줘');
  assert.equal(judgedText(`상품상세 내용에 「${'가'.repeat(41)}」 입력해줘`), '상품상세 내용에 「…」 입력해줘');
});

test('withoutDisabledTwins: 같은 이름의 활성 요소가 있으면 비활성 쪽을 뺀다', () => {
  const refs = {
    e28: { role: 'combobox', name: '표준카테고리' },
    e238: { role: 'textbox', name: '표준 카테고리' },
    e184: { role: 'textbox', name: '공급원가' },
  };
  assert.deepEqual(Object.keys(withoutDisabledTwins(refs, new Set(['e238', 'e184']))), ['e28', 'e184']);
  assert.deepEqual(Object.keys(withoutDisabledTwins(refs, new Set())), ['e28', 'e238', 'e184']);
});

test('saysValue: 말에 그 값이 그대로 — 앞이 띄어쓰기·따옴표일 때만', () => {
  assert.ok(saysValue('배송상품구분을 일반상품으로 설정해줘', '일반상품'));
  assert.ok(!saysValue('배송상품구분을 비일반상품으로 설정해줘', '일반상품'));
  assert.ok(saysValue('출고소요일 3일로 해줘', '3일'));
  assert.ok(!saysValue('출고소요일 13일로 해줘', '3일'));
  assert.ok(saysValue('구매연령을 「만 19세 이상」으로', '만 19세 이상'));
  assert.ok(saysValue('배송비정책을 배송비 무료 / 반품비 6000원 (인천 도서지역 3000원)으로', '배송비 무료 / 반품비 6000원 (인천 도서지역 3000원)'));
});
