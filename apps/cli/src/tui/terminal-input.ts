/**
 * 터미널이 보내오는 바이트 중 **무엇이 사람이 친 글자인가** 를 가른다.
 *
 * 터미널은 키 입력만 보내지 않는다. 창 포커스가 바뀌면 `ESC[I`/`ESC[O` 를,
 * 마우스를 움직이면 `ESC[<0;1;1M` 을, 크기·장치를 물어본 적이 있으면 `ESC[1;2R`·
 * `ESC[?1;2c` 를, 붙여넣기에는 `ESC[200~` ... `ESC[201~` 로 감싸서 보낸다. 이것들은
 * 사용자가 친 적 없는 입력이고, 앞의 ESC 한 글자는 ink 이 떼어 낸 뒤 우리에게
 * 온다. 그대로 받아 넣으면 메시지 칸에 `[200~`·`[I`·`[<0;1;1M` 같은 것이 타이핑된다.
 *
 * 한글에서 특히 아프다. IME 후보창이 뜨고 닫힐 때마다 터미널 포커스가 오가면서
 * `[I`/`[O` 가 글자 사이에 박히고, 커밋된 글자가 붙여넣기로 오면 `[200~` 이 앞에
 * 붙는다. 사용자에게는 "한글이 입력되지 않는다" 로 보인다.
 *
 * 그래서 두 겹으로 막는다. 터미널에게 이런 보고를 아예 보내지 말라고 하고
 * ([screen.ts] 참고), 그래도 오는 것은 여기서 걸러 낸다 — 모드는 앞서 실행된
 * 프로그램이 켜 두고 끄지 않은 채 남아 있을 수 있다.
 */

export type InputEvent =
  /** 사람이 친 글자. 그대로 넣는다. */
  | { kind: 'text'; text: string }
  /** 붙여넣기 시작 — 여기서부터 오는 것은 키가 아니라 내용이다. */
  | { kind: 'paste-start' }
  | { kind: 'paste-end' }
  /** 터미널이 보낸 보고. 사용자가 친 것이 아니다. */
  | { kind: 'ignore' };

const PASTE_START = '[200~';
const PASTE_END = '[201~';

/**
 * ESC 가 떨어져 나간 제어 시퀀스의 꼬리.
 *
 * CSI 는 `[` + 매개변수 + 마지막 바이트, SS3 는 `O` + 마지막 바이트다. 사람이 친
 * `[` 나 `O` 는 **한 글자짜리 이벤트 하나**로 오므로 이 규칙에 걸리지 않는다 —
 * 두 글자 이상이 한 번에 오면서 이 모양이면 터미널이 보낸 것이다.
 */
const CONTROL_TAIL = /^(?:\[[\d;:<>?!"'$ ]*[@-~]|O[@-~])$/;

/** 화면에 그려지지 않는 C0 제어문자와 DEL. 값에 들어가면 보이지 않는 쓰레기가 된다. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * 한 번의 입력 이벤트를 갈래낸다.
 *
 * `pasting` 이 참이면 내용을 글자로만 본다 — 붙여넣기 안의 `\r` 은 "전송" 이 아니고,
 * `[` 로 시작하는 줄도 제어 시퀀스가 아니다.
 */
export function classifyInput(input: string, pasting = false): InputEvent {
  if (input === PASTE_START) return { kind: 'paste-start' };
  if (input === PASTE_END) return { kind: 'paste-end' };
  if (!pasting && input.length > 1 && CONTROL_TAIL.test(input)) return { kind: 'ignore' };

  // 여러 줄 붙여넣기는 한 줄 입력 칸에 맞게 공백으로 눕힌다. 줄바꿈을 남기면
  // 렌더가 깨지고, 버리면 단어가 붙어 버린다.
  const flattened = input.replace(/\r\n|[\r\n]/g, ' ');
  const text = flattened.replace(CONTROL_CHARS, '');
  return text ? { kind: 'text', text } : { kind: 'ignore' };
}
