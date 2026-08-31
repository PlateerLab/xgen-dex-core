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

/**
 * kitty 가 보내는 키 사건을 **ink 이 읽을 수 있는 모양으로** 고친다.
 *
 * 프로토콜은 필드를 비워 둘 수 있고, 글쇠 코드 뒤에 대체 글쇠를 `:` 로 붙일 수 있다.
 * 실제 kitty 는 수식이 없으면 그 자리를 비워 `ESC[97;;97u` 로, 시프트가 걸리면
 * `ESC[97:65;2;65u` 로 보낸다. ink 의 파서는 이 두 모양을 알아보지 못하고 통째로
 * 흘려보낸다 — **글자가 하나도 입력되지 않는다.**
 *
 * 그래서 우리가 사이에서 고쳐 준다: 빈 수식 자리를 1 로 채우고, 대체 글쇠를 떼어
 * 낸다. 글자 필드는 그대로 남겨 두므로 시프트 기호(`!`)도, 자판이 무엇이든,
 * 입력기가 만들어 준 한글도 있는 그대로 들어간다.
 */
const KEY_EVENT = /\u001B\[([0-9]+)(?::[0-9:]*)?(?:;([0-9]*(?::[0-9]+)?))?(?:;([0-9:]+))?u/g;

export function normalizeKeyEvents(chunk: string): string {
  return chunk.replace(
    KEY_EVENT,
    (all: string, code: string, modifiers: string | undefined, text: string | undefined) => {
      // 이미 ink 이 읽을 수 있는 모양이면 손대지 않는다. 멀쩡한 것을 고치면 그 자체가
      // 새 위험이다.
      const hasAlternate = all.slice(0, all.indexOf(';') === -1 ? all.length : all.indexOf(';')).includes(':');
      const needsModifier = modifiers !== undefined && modifiers.length === 0;
      if (!hasAlternate && !needsModifier) return all;

      const mods = modifiers === undefined ? undefined : modifiers.length > 0 ? modifiers : '1';
      const fields = [code, mods, text].filter((field) => field !== undefined).join(';');
      return `\u001B[${fields}u`;
    },
  );
}

/** 아직 끝나지 않은 제어 시퀀스의 꼬리. 다음 덩어리와 이어 붙여야 온전해진다. */
const PARTIAL_TAIL = /\u001B\[[0-9:;]*$/;
/** 이만큼 모였는데도 안 끝나면 시퀀스가 아니다 — 붙들고 있지 말고 흘려보낸다. */
const MAX_PARTIAL = 64;

/**
 * 덩어리 경계에서 잘린 시퀀스를 이어 붙이며 고친다.
 *
 * 터미널 입력은 아무 데서나 쪼개져 도착한다. 잘린 채로 고치려 들면 반쪽짜리가
 * 글자로 새어 나간다.
 */
export function createNormalizer(): (chunk: string) => string {
  let pending = '';
  return (chunk) => {
    const combined = pending + chunk;
    const match = PARTIAL_TAIL.exec(combined);
    if (match && combined.length - match.index <= MAX_PARTIAL) {
      pending = combined.slice(match.index);
      return normalizeKeyEvents(combined.slice(0, match.index));
    }
    pending = '';
    return normalizeKeyEvents(combined);
  };
}

/**
 * ink 에게 건넬 stdin.
 *
 * ink 은 `data` 이벤트가 아니라 **`readable` + `read()`** 로 읽는다. 그래서 곁에서
 * `data` 리스너를 붙이면 스트림이 흐름 모드로 바뀌어 ink 의 `read()` 가 굶는다 —
 * 글자가 하나도 들어가지 않는다. 읽는 길은 하나뿐이어야 한다.
 *
 * 그래서 `read()` 한 곳에서 다 한다: kitty 가 보낸 모양을 ink 이 읽을 수 있게 고치고,
 * 지나가는 김에 한/영 키와 Caps Lock 키를 알려 준다.
 */
export function normalizedStdin<T extends NodeJS.ReadStream>(
  stdin: T,
  onSpecialKey?: (name: string) => void,
): T {
  const normalize = createNormalizer();

  return new Proxy(stdin, {
    get(target, property, receiver) {
      if (property === 'read') {
        return (...args: unknown[]): string | null => {
          const chunk = (target.read as (...rest: unknown[]) => unknown)(...args);
          if (chunk === null || chunk === undefined) return null;
          const text = typeof chunk === 'string' ? chunk : String(chunk);
          if (onSpecialKey) {
            for (const event of parseKeyEvents(text)) {
              // 뗄 때가 아니라 누를 때 한 번만 알린다.
              if (event.name && event.eventType === 1) onSpecialKey(event.name);
            }
          }
          return normalize(text);
        };
      }
      void receiver;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * 키 하나를 여러 곳에 알리는 아주 작은 신호통.
 *
 * 한/영 키는 stdin 을 읽는 자리에서 보이는데, 그것을 다루는 곳은 화면 쪽이다.
 */
export interface KeySignal {
  notify(name: string): void;
  subscribe(listener: (name: string) => void): () => void;
}

export function createKeySignal(): KeySignal {
  const listeners = new Set<(name: string) => void>();
  return {
    notify(name) {
      for (const listener of listeners) listener(name);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
