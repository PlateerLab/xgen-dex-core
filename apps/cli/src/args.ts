import { DexError } from './errors';

const BOOLEAN_OPTIONS = new Set([
  'allow-dangerous',
  'help',
  'include-harness',
  'json',
  'jsonl',
  'no-allow-dangerous',
  'password-stdin',
  'stdin',
  'stdio',
  'version',
]);

export interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h') {
      options.set('help', true);
      continue;
    }
    if (argument === '-v') {
      options.set('version', true);
      continue;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equal = argument.indexOf('=');
    const name = argument.slice(2, equal >= 0 ? equal : undefined);
    if (!name) throw new DexError('usage_error', `잘못된 option입니다: ${argument}`);
    if (equal >= 0) {
      options.set(name, argument.slice(equal + 1));
      continue;
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new DexError('usage_error', `--${name} 값이 필요합니다.`);
    }
    options.set(name, value);
    index += 1;
  }
  return { positionals, options };
}

export function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function requiredOption(args: ParsedArgs, name: string): string {
  const value = option(args, name);
  if (!value) throw new DexError('usage_error', `--${name} 값이 필요합니다.`);
  return value;
}

export function flag(args: ParsedArgs, name: string): boolean {
  return args.options.get(name) === true;
}

export function positiveIntegerOption(args: ParsedArgs, name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new DexError('usage_error', `--${name}은 양의 정수여야 합니다.`);
  }
  return value;
}
