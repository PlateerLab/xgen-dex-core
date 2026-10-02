import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const RENDERER = resolve(__dirname, '..', 'src', 'renderer', 'src');
/** Dex 화면 코드를 가져와도 되는 곳 — 부품은 dex.ts, 스타일은 main.tsx (DESIGN.md §8). */
const ALLOWED = new Set(['dex.ts', 'main.tsx']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

test('XD 화면은 Dex 부품을 dex.ts 한 곳으로만 가져온다', () => {
  const offenders = files(RENDERER)
    .map((p) => ({ file: relative(RENDERER, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') }))
    .filter(({ file, src }) => !ALLOWED.has(file) && /(?:from|import)\s*\(?\s*['"][^'"]*\/desktop\/src\//.test(src))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});
