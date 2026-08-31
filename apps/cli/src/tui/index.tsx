import { render } from 'ink';
import { stdout } from 'node:process';
import type { DexEngine } from '@dex/engine';
import { App } from './app';
import { createScreenGuard } from './screen';

/**
 * TUI 를 대체 화면에서 띄운다. 규칙은 `./screen` 에 있다 — 여기서는 프로세스가
 * **어떻게 끝나든** 되돌아가게 배선만 한다.
 */
export async function runTui(engine: DexEngine): Promise<void> {
  const screen = createScreenGuard(stdout);
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

  screen.enter();

  try {
    const instance = render(<App engine={engine} />, {
      exitOnCtrlC: true,
      patchConsole: true,
    });
    await instance.waitUntilExit();
  } finally {
    restore();
    process.off('exit', restore);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
