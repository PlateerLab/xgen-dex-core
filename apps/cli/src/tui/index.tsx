import { render } from 'ink';
import { stdin, stdout } from 'node:process';
import type { DexEngine } from '@dex/engine';
import { App } from './app';
import { createScreenGuard } from './screen';
import { readPreferences, writePreferences } from './preferences';
import { createKeySignal, normalizedStdin, supportsKittyKeyboard } from './kitty';

/**
 * TUI 를 대체 화면에서 띄운다. 규칙은 `./screen` 에 있다 — 여기서는 프로세스가
 * **어떻게 끝나든** 되돌아가게 배선만 한다.
 */
export async function runTui(engine: DexEngine): Promise<void> {
  let screen = createScreenGuard(stdout);
  const restore = (): void => screen.restore();

  // SIGINT/SIGTERM 은 Ink 의 정리를 거치지 않고 곧장 죽을 수 있다. 'exit' 은
  // process.exit() 와 예외로 죽는 경우까지 받는다.
  const onSignal = (): void => {
    restore();
    process.exit(0);
  };
  process.once('exit', restore);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // 취향은 그리기 전에 읽는다. 나중에 읽으면 첫 프레임이 EN 으로 떴다가 바뀌어,
  // 한글로 쓰던 사람에게는 모드가 꺼진 것처럼 보인다.
  const preferences = await readPreferences();

  // 한/영 키(오른쪽 Alt 자리)와 Caps Lock 은 글자를 만들지 않아 보통 앱에 오지
  // 않는다. 그 키들까지 보고하는 터미널인지 먼저 물어본다 — ink 은 kitty·ghostty·
  // WezTerm 만 이름으로 짐작하지만, 요즘은 더 많은 터미널이 이 프로토콜을 안다.
  const kitty = await supportsKittyKeyboard({ stdin, stdout, isTTY: stdin.isTTY });
  screen = createScreenGuard(stdout, { kittyKeyboard: kitty });

  // 한/영 키와 Caps Lock 키는 stdin 을 읽는 자리에서 보이고, 그것을 다루는 곳은
  // 화면 쪽이다. 그 사이를 잇는다.
  const modeKeys = createKeySignal();

  screen.enter();

  try {
    const instance = render(
      <App
        engine={engine}
        preferences={{
          hangulMode: preferences.hangulMode,
          onHangulModeChange: (enabled) => void writePreferences({ hangulMode: enabled }),
          onModeKey: modeKeys.subscribe,
        }}
      />,
      {
        exitOnCtrlC: true,
        patchConsole: true,
        // 프로토콜을 켜면 kitty 가 ink 이 못 읽는 모양으로 키를 보낸다 — 사이에서
        // 고쳐 넘기지 않으면 글자가 하나도 입력되지 않는다.
        ...(kitty
          ? {
              stdin: normalizedStdin(stdin, (name) => {
                if (name === 'rightalt' || name === 'capslock') modeKeys.notify(name);
              }),
            }
          : {}),
        // 모든 키를 이스케이프로 받아야 한/영 키(오른쪽 Alt)와 Caps Lock 이 사건으로
        // 온다. 그런데 그렇게만 켜면 터미널이 **글쇠 코드만** 보내서 Shift+r 이
        // 소문자 `r` 로 도착한다 — 된소리도 영문 대문자도 사라진다. 그래서 글자까지
        // 함께 보내 달라고(reportAssociatedText) 요청한다.
        ...(kitty
          ? {
              kittyKeyboard: {
                mode: 'enabled' as const,
                flags: [
                  'disambiguateEscapeCodes' as const,
                  'reportAllKeysAsEscapeCodes' as const,
                  'reportAssociatedText' as const,
                ],
              },
            }
          : {}),
      },
    );
    await instance.waitUntilExit();
  } finally {
    restore();
    process.off('exit', restore);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
