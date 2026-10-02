#!/usr/bin/env node
// 가짜 codex — `login --device-auth`(곧 스스로 끝내며 auth.json 을 쓴다) · `login status` · `logout`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.CODEX_HOME || '';
const auth = join(home, 'auth.json');
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('codex-cli 0.999.0'); process.exit(0); }
if (args === 'login status') { console.log(existsSync(auth) ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(0); }
if (args === 'logout') { rmSync(auth, { force: true }); process.exit(0); }
if (args === 'login --device-auth') {
  mkdirSync(home, { recursive: true });
  process.stdout.write('\nWelcome to Codex\n\n1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mAB12-CD3EF\x1b[0m\n');
  setTimeout(() => {
    if (process.env.FAKE_FAIL) process.exit(1);
    writeFileSync(auth, '{"tokens":{}}');
    console.log('Successfully logged in');
    process.exit(0);
  }, 200);
}
