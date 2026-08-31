/**
 * 터미널이 **키 자체**를 알려 주게 한다.
 *
 * 보통 터미널은 글자만 보낸다. 그래서 한/영 키(오른쪽 Alt 자리)나 Caps Lock 처럼
 * 글자를 만들지 않는 키는 앱에 아예 도착하지 않는다 — 어떤 터미널 프로그램도 그
 * 키가 눌렸는지 알 수 없다.
 *
 * Kitty 키보드 프로토콜은 그 키들까지 `ESC[<코드>;<수식>u` 로 보고한다. 지원하는
 * 터미널(kitty·ghostty·WezTerm·foot·Alacritty·최신 Konsole 등)에서만 켜지고, 나머지는
 * 물어봐도 대답하지 않으므로 그냥 예전처럼 동작한다 — 켜도 잃는 것이 없다.
 *
 * @see https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

const ESC = '\u001B';
/** 이 프로토콜을 쓸 수 있는지 묻는다. 지원하면 `ESC[?<flags>u` 로 답한다. */
export const QUERY = `${ESC}[?u`;

/**
 * 우리가 알아보고 싶은 키들. 숫자는 프로토콜이 정한 코드다.
 *
 * 한/영 키 자체(keysym Hangul)는 이 프로토콜에도 자리가 없다. 대신 한국어 자판에서
 * **그 키가 놓인 자리**가 오른쪽 Alt 라, 한국어 입력기가 없는 환경에서는 오른쪽
 * Alt 로 도착한다. 그것을 한/영으로 받는다.
 */
export const KEY_CODES: Record<number, string> = {
  57358: 'capslock',
  57449: 'rightalt',
};

/** Caps Lock 이 눌려 있음을 뜻하는 수식 비트. 프로토콜 값은 여기에 1 을 더한 것이다. */
const CAPS_LOCK_BIT = 64;

export interface KeyEvent {
  /** `KEY_CODES` 에 있는 이름. 그 밖의 키는 이름 없이 수식만 실어 나른다. */
  name?: string;
  capsLock: boolean;
  /** 눌림(1)·반복(2)·뗌(3). 없으면 눌림이다. */
  eventType: number;
}

/**
 * 들어온 바이트에서 키 사건을 골라낸다.
 *
 * `ESC[<코드>[:대체];<수식>[:종류][;<글자>]u` 꼴이다. 우리는 코드·수식·종류만 본다.
 */
export function parseKeyEvents(chunk: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  const pattern = /\u001B\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?u/g;
  for (const match of chunk.matchAll(pattern)) {
    const code = Number(match[1]);
    // 프로토콜은 수식을 "실제 값 + 1" 로 싣는다. 없으면 아무 수식도 없다는 뜻이다.
    const modifiers = match[2] ? Number(match[2]) - 1 : 0;
    events.push({
      name: KEY_CODES[code],
      // eslint-disable-next-line no-bitwise
      capsLock: (modifiers & CAPS_LOCK_BIT) !== 0,
      eventType: match[3] ? Number(match[3]) : 1,
    });
  }
  return events;
}

export interface QueryStreams {
  /** 답을 기다릴 곳. 진짜 stdin 도, 시험의 가짜 스트림도 이만큼이면 된다. */
  stdin: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
    removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
    /**
     * 답은 줄바꿈 없이 오므로 **행 단위 모드에서는 커널이 붙들고 있다**.
     * 물어보는 동안만 원시 모드로 바꾼다 — 그러지 않으면 지원하는 터미널도
     * 대답하지 않는 것처럼 보인다.
     */
    isRaw?: boolean;
    setRawMode?(mode: boolean): unknown;
    resume?(): unknown;
    pause?(): unknown;
  };
  stdout: { isTTY?: boolean; write(chunk: string): unknown };
  isTTY?: boolean;
}

/**
 * 이 터미널이 프로토콜을 아는지 물어본다.
 *
 * 대답이 없으면 모르는 것이다 — 기다리다 그냥 넘어간다. 답을 못 받았다고 켜 버리면
 * 모르는 터미널이 우리 질문을 글자로 뱉어 화면에 `[?u` 가 찍힌다.
 */
/**
 * 이름만으로 아는 터미널인가.
 *
 * 물어보고 기다리는 200ms 는 짧지만, 이미 아는 터미널에까지 물을 이유는 없다.
 * SSH 처럼 왕복이 느린 곳에서는 답이 늦어 지원하는 터미널을 놓치기도 한다.
 */
export function knownKittyTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KITTY_WINDOW_ID) return true;
  if (env.GHOSTTY_RESOURCES_DIR) return true;
  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'xterm-kitty' || term === 'xterm-ghostty' || term.includes('foot')) return true;
  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  return program === 'wezterm' || program === 'ghostty' || program === 'kitty';
}

export async function supportsKittyKeyboard(
  streams: QueryStreams,
  timeoutMs = 200,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.DEX_NO_KITTY === '1') return false;
  if (!streams.stdout.isTTY || !streams.isTTY) return false;
  if (knownKittyTerminal(env)) return true;

  const wasRaw = streams.stdin.isRaw === true;
  const wasPaused = !wasRaw;
  streams.stdin.setRawMode?.(true);
  streams.stdin.resume?.();

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let seen = '';
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      streams.stdin.removeListener('data', onData);
      // 물어보기 전 상태로 돌려 놓는다. ink 이 곧 자기 방식대로 다시 잡는다.
      if (!wasRaw) streams.stdin.setRawMode?.(false);
      if (wasPaused) streams.stdin.pause?.();
      resolve(supported);
    };
    const onData = (data: Buffer | string): void => {
      seen += typeof data === 'string' ? data : data.toString('utf8');
      if (/\u001B\[\?\d*u/.test(seen)) finish(true);
    };
    // 이 타이머는 unref 하지 않는다. 답을 기다리는 것 말고 할 일이 없을 때 프로그램이
    // 먼저 끝나 버리면, 대답을 영영 못 받고 넘어간다.
    const timer = setTimeout(() => finish(false), timeoutMs);
    streams.stdin.on('data', onData);
    streams.stdout.write(QUERY);
  });
}
