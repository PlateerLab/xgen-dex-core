import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { MemoryConfigStore, defaultConfig } from '@dex/engine';
import { parseArgs } from '../src/args';
import { runCanonicalTuiCommand } from '../src/canonical-tui-command';
import type { CanonicalTuiAccount, CanonicalTuiSource } from '../src/tui/canonical-types';

const terminal = { stdinIsTty: true, stdoutIsTty: true, term: 'xterm', ci: 'false' };
const base = ['ui', '--canonical', '--user-id', '7'];
const configs = (origin = 'https://app.example.test') => new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'corp', profiles: { corp: { serverUrl: origin } } });
test('invalid canonical UI options and non-TTY fail before credentials, Ink, config or legacy host', async () => {
  let reads = 0; let sources = 0; let launches = 0;
  const unreadable = { read: async () => { reads++; return defaultConfig(); }, write: async () => undefined };
  const dependency = { terminal, sourceFactory: () => { sources++; throw new Error('must not create'); }, launch: async () => { launches++; } };
  for (const args of [ ['ui', '--canonical=false', '--user-id', '7'], [...base, 'extra'], [...base, '--password', 'x'], [...base, '--json'], [...base, '--profile='], ['ui', '--canonical'], ['ui', '--canonical', '--user-id', '07'], ['ui', '--canonical', '--user-id', '2147483648'] ]) {
    await assert.rejects(runCanonicalTuiCommand(parseArgs(args), unreadable, dependency));
  }
  for (const mode of [{...terminal, stdinIsTty: false}, {...terminal, stdoutIsTty:false}, {...terminal, term:'dumb'}, {...terminal, ci:'true'}]) {
    await assert.rejects(runCanonicalTuiCommand(parseArgs(base), unreadable, {...dependency, terminal:mode}));
  }
  assert.deepEqual([reads,sources,launches], [0,0,0]);
});
test('validated HTTPS profile launches only fixed CLI account source without doing hidden auth work', async () => {
  let created: CanonicalTuiAccount | undefined; let launched: CanonicalTuiAccount | undefined;
  const source: CanonicalTuiSource = {read: async () => assert.fail('launcher owns read'), watch: async () => assert.fail('launcher owns watch'), settle: async () => undefined};
  await runCanonicalTuiCommand(parseArgs(base), configs('https://app.example.test/'), {terminal,
    sourceFactory: (account) => { created = account; return source; },
    launch: async (account, actual) => { launched = account; assert.equal(actual, source); },
  });
  assert.deepEqual(created, {profile:'corp', origin:'https://app.example.test', userId:'7'});
  assert.deepEqual(launched, created);
  let launches = 0;
  for (const store of [configs('http://localhost:3000'), configs('https://user:secret@app.example.test')]) {
    await assert.rejects(runCanonicalTuiCommand(parseArgs(base), store, {terminal, launch: async () => { launches++; }}));
  }
  await assert.rejects(runCanonicalTuiCommand(parseArgs([...base, '--profile', 'missing']), configs(), {terminal, launch: async () => { launches++; }}));
  assert.equal(launches,0);
});
test('CLI dispatcher rejects Canonical markers without ui before falling into the legacy default path', () => {
  for (const values of [['--canonical', '--user-id', '7'], ['--canonical=false', '--user-id', '7']]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...values], {
      encoding:'utf8', env:{...process.env, TERM:'dumb', CI:'true'}, timeout:5000,
    });
    assert.equal(child.status,2);
    assert.equal(child.stdout,'');
    assert.match(child.stderr,/dex ui --canonical/);
    assert.doesNotMatch(child.stderr,/로그인|local.tools|password/);
  }
});
