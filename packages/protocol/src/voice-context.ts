/**
 * 음성 대화 지침 봉투 — 사용자가 **음성으로** 보낸 턴에만 사용자 문장 앞에 붙인다.
 *
 * 답은 TTS 로 소리 내어 읽히므로, 화면에 읽을 글(목록·마크다운·긴 설명)이 아니라 비서처럼 짧게 말하는
 * 답이 필요하다. 지침 글은 이 기기 설정(음성 설정 → 음성 대화 지침)에서 고칠 수 있고, 비우면 붙이지 않는다.
 * 화면에 보이기 전·히스토리를 다시 읽을 때는 `stripVoiceContext` 로 뗀다(브라우저·Teams 봉투와 같은 처리).
 * 봉투는 가장 안쪽(사용자 문장 바로 앞)에 둔다 — 벗기는 순서: browser → teams → voice.
 */
export const VOICE_CONTEXT_START = '<xgen_voice_reply>';
export const VOICE_CONTEXT_END = '</xgen_voice_reply>';

/** 기본 음성 대화 지침. */
export const DEFAULT_VOICE_REPLY_STYLE = [
  '사용자는 음성으로 말하고 있고, 답은 소리(TTS)로 읽힌다. 곁에 있는 비서처럼 대답한다.',
  '- 한두 문장으로 짧게, 말하듯 자연스러운 존댓말로.',
  '- 목록·표·마크다운·코드·주소(URL)·이모지는 쓰지 않는다. 숫자와 이름은 말로 읽기 좋게.',
  '- 한 일은 결과만 짧게 말한다("열었어요", "세 건 찾았어요, 맨 위는 …예요").',
  '- 도구를 쓰거나 화면을 다시 읽는 과정은 말로 설명하지 않는다.',
  '- 무엇을 원하는지 모호하면 짧은 질문 하나만 한다.',
].join('\n');

/** 지침이 비었으면 입력을 그대로 둔다. */
export function prependVoiceContext(input: string, style: string): string {
  const s = (style ?? '').trim();
  if (!s) return input;
  return `${VOICE_CONTEXT_START}\n${s}\n${VOICE_CONTEXT_END}\n${input}`;
}

/** 화면에 보이기 전에 봉투를 뗀다. */
export function stripVoiceContext(text: string): string {
  if (typeof text !== 'string' || !text.startsWith(VOICE_CONTEXT_START)) return text;
  const end = text.indexOf(VOICE_CONTEXT_END);
  if (end < 0) return text;
  return text.slice(end + VOICE_CONTEXT_END.length).replace(/^\r?\n/, '');
}
