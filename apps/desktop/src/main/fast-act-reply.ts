/**
 * 빠른 조작의 답 — 채팅으로 시킨 것(fast-act-chat)과 말로 시킨 것(음성)이 같은 문장으로 답한다.
 *
 * 서버 에이전트가 답하듯 한 일을 문장으로 쓴다("\"블로그\" 탭을 눌렀어요."). 걸린 시간·판단 점수·요소 번호는
 * 답이 아니라 작업 과정(도구 줄)에 둔다 — 같은 에이전트가 빠른 조작이냐 서버냐에 따라 말투가 바뀌면 사용자가 당황한다.
 */
import type { VoiceAction } from './fast-act-voice';

/** 받침이 있는가 — 한글은 종성, 숫자는 읽는 소리(영·일·삼·육·칠·팔), 영문은 확실한 끝 글자만. 모르면 null. */
function hasBatchim(word: string): boolean | null {
  const ch = word.replace(/["'“”‘’)\]\s.,!?…]+$/u, '').slice(-1);
  if (!ch) return null;
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(ch)) return '013678'.includes(ch);
  // 영문은 읽는 소리를 글자만으로 알 수 없다 — l·m·n(엘·엠·엔, "xgen"→젠) 과 모음·r·w·y(네이버·메뉴·쇼) 만 정한다.
  if (/[lmn]/i.test(ch)) return true;
  if (/[aiouyrw]/i.test(ch)) return false;
  return null;
}

/** 말 + 조사 — josa('"블로그" 탭', '을', '를') → '"블로그" 탭을'. 받침을 모르면 '을(를)'. */
export function josa(word: string, withBatchim: string, without: string): string {
  // ㄹ 받침 뒤에는 '으로' 가 아니라 '로'다 — "3일로", "서울로"(숫자는 1·7·8 이 일·칠·팔).
  const ch = word.replace(/["'“”‘’)\]\s.,!?…]+$/u, '').slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  if (withBatchim === '으로' && ((code >= 0 && code <= 11171 && code % 28 === 8) || /[178]/.test(ch))) return `${word}${without}`;
  const b = hasBatchim(word);
  return `${word}${b === null ? `${withBatchim}(${without})` : b ? withBatchim : without}`;
}

const hostOf = (url?: string): string | null => {
  try {
    return url ? new URL(url).host.replace(/^www\./, '') || null : null;
  } catch {
    return null;
  }
};

/**
 * 열린 페이지를 가리키는 말 — 새 제목이 있으면 제목, 없으면 다른 사이트로 갔을 때만 호스트.
 * 같은 사이트 안에서 제목도 그대로면(검색 결과 등) 따로 말하지 않는다.
 */
function pageName(a: VoiceAction): string | null {
  if (a.title) return `"${a.title.length > 40 ? `${a.title.slice(0, 40)}…` : a.title}"`;
  const host = hostOf(a.url);
  return host && (a.newTab || host !== hostOf(a.from)) ? host : null;
}

/** 조작 하나의 답 문장. forAgent = BrowserFill 을 부른 LLM 이 읽는다 — 사용자에게 묻는 말(ask)은 넣지 않는다. */
export function actionSentence(a: VoiceAction, forAgent = false): string {
  const q = a.text !== null ? `"${a.text}"` : '';
  if (a.app) return `${josa(a.display, '을', '를')} 열었어요.`;
  let did: string;
  if (a.sentence) did = a.sentence;
  else if (a.action === 'click' || a.text === null) did = `${josa(a.display, '을', '를')} 눌렀어요.`;
  else if (a.action === 'type') did = `${a.display}에 ${josa(q, '을', '를')} 입력했어요.`;
  // 검색칸의 이름은 대개 안내 문구("검색어를 입력하고 버튼을 누르세요")라 답에 옮기지 않는다.
  else if (/검색|search/i.test(a.display)) did = `${josa(q, '을', '를')} 검색했어요.`;
  else did = `${a.display}에 ${josa(q, '을', '를')} 입력하고 Enter 키를 눌렀어요.`;
  if (a.dismissed) did = `가리던 팝업을 닫고 ${did}`;
  const page = a.navigated ? pageName(a) : null;
  const where = a.reusedTab ? '열려 있던 창에서 다시 ' : a.newTab ? '새 탭에서 ' : '';
  const sentence = page ? `${did} ${page} 페이지가 ${where}열렸어요.` : did;
  const ask = a.ask && !forAgent ? [a.ask] : [];
  // 화면이 띄운 알림(입력 검사 등)은 닫았어도 사용자가 알아야 한다 — 문구 그대로.
  const notices = (a.notices ?? []).filter(Boolean).map((n) => `화면에 뜬 알림 ${josa(`"${n}"`, '을', '를')} 닫았어요.`);
  return [sentence, ...notices, ...(a.tell ? [a.tell] : []), ...ask].join(' ');
}

/** 빠른 조작으로 끝낸 턴의 답 — 한 문단으로(문단을 나누면 채팅은 마지막 문단만 답으로 보여 준다). */
export function replyFor(actions: VoiceAction[], forAgent = false): string {
  return actions.map((a) => actionSentence(a, forAgent)).join(' ');
}

/** 작업 과정 한 줄 — 무엇을 어떻게, 걸린 시간. 음성이면 말하는 도중이었는지도. */
export function actionRow(a: VoiceAction, voice: boolean): string {
  const how = a.app ? '열기' : a.action === 'click' ? '클릭' : `${a.action === 'type' ? '입력' : '입력 후 Enter'} "${a.text ?? ''}"`;
  return [
    a.display,
    how,
    ...(a.dismissed ? [`가린 팝업 닫음(${a.dismissed})`] : []),
    ...(a.notices?.length ? [`알림 닫음(${a.notices.length})`] : []),
    ...(voice ? [a.partial ? '말하는 도중' : '말이 끝난 뒤'] : []),
    `판단 ${a.decideMs}ms`,
    `실행 ${a.actMs}ms`,
  ].join(' · ');
}
