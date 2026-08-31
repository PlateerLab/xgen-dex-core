import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInteractiveTerminal, shouldLaunchTui } from '../src/mode';

const tty = { stdinIsTty: true, stdoutIsTty: true, term: 'xterm-256color' };

test('no command and ui command launch TUI only in an interactive terminal', () => {
  assert.equal(shouldLaunchTui([], tty), true);
  assert.equal(shouldLaunchTui(['ui'], tty), true);
  assert.equal(shouldLaunchTui(['agents', 'list'], tty), false);
  assert.equal(shouldLaunchTui([], { ...tty, stdinIsTty: false }), false);
  assert.equal(shouldLaunchTui([], { ...tty, stdoutIsTty: false }), false);
  assert.equal(shouldLaunchTui([], { ...tty, term: 'dumb' }), false);
  assert.equal(shouldLaunchTui([], { ...tty, ci: 'true' }), false);
});

test('CI=false remains interactive', () => {
  assert.equal(isInteractiveTerminal({ ...tty, ci: 'false' }), true);
});
