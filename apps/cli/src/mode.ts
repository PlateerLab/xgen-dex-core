export interface TerminalModeInput {
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  term?: string;
  ci?: string;
}

export function isInteractiveTerminal(input: TerminalModeInput): boolean {
  const ci = input.ci?.trim().toLowerCase();
  const isCi = !!ci && ci !== 'false' && ci !== '0';
  return input.stdinIsTty && input.stdoutIsTty && input.term !== 'dumb' && !isCi;
}

export function shouldLaunchTui(positionals: string[], terminal: TerminalModeInput): boolean {
  if (!isInteractiveTerminal(terminal)) return false;
  return positionals.length === 0 || (positionals.length === 1 && positionals[0] === 'ui');
}
