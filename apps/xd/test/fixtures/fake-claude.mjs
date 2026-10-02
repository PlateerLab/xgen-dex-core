#!/usr/bin/env node
// 가짜 claude — `auth status --json` · `auth login --claudeai`(코드 GOOD 이면 로그인) · `auth logout`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.CLAUDE_CONFIG_DIR || '';
const state = join(home, 'fake-state.json');
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('2.1.999 (Claude Code)'); process.exit(0); }
if (args === 'auth status --json') {
  const s = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {};
  console.log(JSON.stringify({ loggedIn: !!s.loggedIn, authMethod: s.loggedIn ? 'claude.ai' : 'none', email: s.email ?? null, configDirectory: home }));
  process.exit(0);
}
if (args === 'auth logout') { rmSync(state, { force: true }); process.exit(0); }
if (args === 'auth login --claudeai') {
  // 섞이면 안 되는 것이 들어왔는지 적어 둔다
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'fake-env.json'), JSON.stringify({ key: !!process.env.ANTHROPIC_API_KEY, simple: !!process.env.CLAUDE_CODE_SIMPLE, quiet: process.env.DISABLE_AUTOUPDATER }));
  process.stdout.write('Opening browser to sign in…\n\x1b[1mIf the browser didn\'t open, visit:\x1b[0m https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'GOOD#state') {
      writeFileSync(state, JSON.stringify({ loggedIn: true, email: 'me@example.com' }));
      console.log('\nLogin successful.');
      process.exit(0);
    } else {
      console.log('\nOAuth error: Invalid code. Press Enter to retry.');
    }
  });
}
