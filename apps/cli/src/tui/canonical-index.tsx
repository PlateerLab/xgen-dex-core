import { render } from 'ink';
import { stdout } from 'node:process';
import { CanonicalTuiController } from './canonical-controller';
import { CanonicalScreen } from './canonical-screen';
import { createScreenGuard } from './screen';
import type { CanonicalTuiAccount, CanonicalTuiSource } from './canonical-types';

export async function runCanonicalTui(account: CanonicalTuiAccount, source: CanonicalTuiSource): Promise<void> {
  const controller = new CanonicalTuiController(source, account.userId);
  const screen = createScreenGuard(stdout);
  let exit: (() => void) | undefined;
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    // Clear private display immediately. The finally block owns actual request/socket drain.
    void controller.stop();
    exit?.();
  };
  const restore = () => screen.restore();
  process.once('exit', restore);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  screen.enter();
  try {
    const instance = render(<CanonicalScreen account={account} controller={controller} onExit={close} />, {
      exitOnCtrlC: false, patchConsole: true,
    });
    exit = () => instance.unmount();
    if (closing) exit();
    else void controller.read();
    await instance.waitUntilExit();
  } finally {
    try { await controller.dispose(); }
    finally {
      restore();
      process.off('exit', restore);
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
    }
  }
}
