#!/usr/bin/env node
/**
 * PR 이 **실제로** 무엇을 바꿨는가 — CI 가 돌릴 잡을 여기서 고른다.
 *
 * 예전 CI 는 무엇을 바꾸든 전부 돌렸다. 문서 한 줄·버전 숫자 하나에도 데스크톱
 * 빌드와 모바일 네이티브 빌드가 다시 돌았고, 같은 산출물이 한 릴리스에 네다섯 번
 * 만들어졌다. 그래서 바뀐 파일을 영역으로 나누고, 영역에 해당하는 잡만 돈다.
 *
 * 무시하는 변경:
 *   - 문서(*.md)
 *   - 버전 숫자만 바뀐 줄 — 버전은 릴리스 워크플로가 올리고 `version.mjs check`
 *     가 따로 지킨다. 숫자 하나 때문에 전체 빌드를 다시 돌릴 이유가 없다.
 *
 *   node scripts/ci/changes.mjs <base> <head>
 *
 * 결과는 $GITHUB_OUTPUT(있으면)과 표준 출력에 core · mobile · native = true|false.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('사용법: node scripts/ci/changes.mjs <base> <head>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** 버전 숫자만 담은 변경 줄 — package.json·잠금 파일·app.json·Info.plist. */
const VERSION_LINE = /^\s*("version"\s*:\s*"\d+\.\d+\.\d+",?|<string>\d+(\.\d+\.\d+)?<\/string>)\s*$/;

function onlyVersionLines(file) {
  const diff = git('diff', '-U0', `${base}...${head}`, '--', file);
  const changed = diff
    .split('\n')
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
    .map((line) => line.slice(1));
  return changed.length > 0 && changed.every((line) => VERSION_LINE.test(line));
}

const files = git('diff', '--name-only', `${base}...${head}`)
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean);

const meaningful = files.filter((file) => !file.endsWith('.md') && !onlyVersionLines(file));

const under = (prefixes) => (file) => prefixes.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

const areas = {
  // 데스크톱·CLI·VS Code·패키지 — verify 잡
  core: under([
    'packages/',
    'apps/cli/',
    'apps/vscode/',
    'apps/desktop/',
    'scripts/',
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.json',
  ]),
  // 모바일 JS(타입·테스트) — @dex/protocol 을 소스로 번들하므로 그것도 본다
  mobile: under(['apps/mobile/', 'packages/protocol/']),
  // 모바일 네이티브 컴파일 — 로컬 모듈·네이티브 프로젝트·의존성이 바뀔 때만
  native: under([
    'apps/mobile/modules/',
    'apps/mobile/android/',
    'apps/mobile/ios/',
    'apps/mobile/app.json',
    'apps/mobile/package.json',
    'apps/mobile/package-lock.json',
  ]),
};

// CI 정의 자체가 바뀌면 모든 잡이 한 번 돌아야 그 정의가 검증된다.
const ciChanged = meaningful.includes('.github/workflows/ci.yml') || meaningful.includes('scripts/ci/changes.mjs');

const result = Object.fromEntries(
  Object.entries(areas).map(([name, match]) => [name, ciChanged || meaningful.some(match)]),
);

const ignored = files.filter((file) => !meaningful.includes(file));
console.log(`바뀐 파일 ${files.length}개 — 의미 있는 변경 ${meaningful.length}개`);
if (ignored.length) console.log(`  무시(문서·버전 숫자): ${ignored.join(', ')}`);
for (const [name, on] of Object.entries(result)) console.log(`  ${name}: ${on}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(result)
      .map(([name, on]) => `${name}=${on}\n`)
      .join(''),
  );
}
