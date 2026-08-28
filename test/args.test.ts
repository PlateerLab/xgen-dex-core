import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flag, option, parseArgs, positiveIntegerOption } from '../src/args';

test('CLI arguments support commands, values, equals, and boolean flags', () => {
  const args = parseArgs([
    'agents',
    'list',
    '--profile',
    'corp',
    '--page=2',
    '--include-harness',
    '--json',
  ]);
  assert.deepEqual(args.positionals, ['agents', 'list']);
  assert.equal(option(args, 'profile'), 'corp');
  assert.equal(positiveIntegerOption(args, 'page'), 2);
  assert.equal(flag(args, 'include-harness'), true);
  assert.equal(flag(args, 'json'), true);
});

test('CLI arguments reject missing option values', () => {
  assert.throws(() => parseArgs(['login', '--email']), /--email 값이 필요합니다/);
});
