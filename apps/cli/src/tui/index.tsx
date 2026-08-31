import { render } from 'ink';
import type { DexEngine } from '../engine';
import { App } from './app';

export async function runTui(engine: DexEngine): Promise<void> {
  const instance = render(<App engine={engine} />, {
    exitOnCtrlC: true,
    patchConsole: true,
  });
  await instance.waitUntilExit();
}
