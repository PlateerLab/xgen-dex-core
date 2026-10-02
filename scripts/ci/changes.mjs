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
 * 결과는 $GITHUB_OUTPUT(있으면)과 표준 출력에 core · mobile · native · engine = true|false.
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
  // 데스크톱·CLI·VS Code·패키지·XD — verify 잡(XD 는 Dex 의 화면 코드를 함께 쓴다)
  core: under([
    'packages/',
    'apps/cli/',
    'apps/vscode/',
    'apps/desktop/',
    'apps/xd/',
    'scripts/',
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.json',
  ]),
  // 모바일 JS(타입·테스트) — @dex/protocol 을 소스로 번들하므로 그것도 본다
  mobile: under(['apps/mobile/', 'packages/protocol/']),
  // XD 엔진(동봉 Python) — 세 OS 에서 동봉본을 만들고 그 인터프리터로 시험한다. 위험 명령 규칙은 Dex 의 것을
  // 그대로 넘기므로(엔진 시험이 두 언어의 판정을 맞춰 본다) 그 파일도 본다.
  engine: under(['apps/xd/engine/', 'apps/xd/scripts/bundle-engine.mjs', 'packages/engine/src/dangerous-commands.ts']),
  // XD 설치본 — 설치본에 닿는 것(설치 설정·NSIS·의존성·동봉 엔진의 목록·엔진 자리·업데이트)이 바뀔 때만 세 OS 에서
  // 실제 설치본을 만든다(무겁다).
  xdpack: under([
    'apps/xd/electron-builder.yml',
    'apps/xd/build/',
    'apps/xd/package.json',
    'apps/xd/package-lock.json',
    'apps/xd/scripts/',
    'apps/xd/engine/bundle/',
    'apps/xd/src/main/engine-service.ts',
    'apps/xd/src/main/data-root.ts',
    'apps/xd/src/main/updater.ts',
    'apps/xd/src/main/update-feed.ts',
    'apps/xd/e2e/packaged.e2e.ts',
  ]),
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

/**
 * CI 정의(ci.yml)가 바뀌면 — **정의가 바뀐 잡만** 한 번 돌아 그 정의를 검증한다.
 *
 * 예전에는 ci.yml 을 조금만 고쳐도 모든 잡이 돌았다. verify 잡에 검사 한 줄을 넣었을 뿐인데
 * iOS·안드로이드 네이티브 빌드까지 다시 돌았다. 이제는 바뀐 줄이 어느 잡에 속하는지 보고 그 잡만
 * 켠다. 잡 밖(트리거·동시성 같은 공통 부분)이 바뀌면 전부 돈다. 주석·빈 줄은 동작이 아니라 뺀다.
 *
 * 이 파일(changes.mjs)이 바뀐 것은 무거운 잡으로 검증되지 않는다 — 판정 결과는 이 잡의 출력에
 * 그대로 찍힌다(아래 `core: …` 줄).
 */
const JOB_AREA = {
  verify: 'core',
  mobile: 'mobile',
  android: 'native',
  ios: 'native',
  'xd-engine': 'engine',
  'xd-app': 'core',
  'xd-package': 'xdpack',
};

function ciDefinitionAreas() {
  const CI = '.github/workflows/ci.yml';
  if (!files.includes(CI)) return [];
  let text;
  try {
    text = git('show', `${head}:${CI}`);
  } catch {
    return 'all'; // 파일이 지워졌거나 읽을 수 없다 — 전부 돌려 드러낸다
  }
  // 줄 번호(1부터) → 그 줄이 속한 잡 이름. 잡 밖이면 null.
  const owner = [null];
  let inJobs = false;
  let job = null;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      job = null;
    } else if (/^[^\s#]/.test(line)) {
      inJobs = false;
      job = null;
    } else if (inJobs) {
      const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m) job = m[1];
    }
    owner.push(inJobs ? job : null);
  }
  const trivial = (line) => /^\s*(#.*)?$/.test(line);
  const out = new Set();
  let next = 0; // 새 파일에서 다음 줄 번호
  for (const line of git('diff', '-U0', `${base}...${head}`, '--', CI).split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      // 지우기만 한 덩어리는 "그 줄 뒤" 를 가리킨다 — 다음에 올 줄은 그 다음이다.
      if (/ \+\d+,0 @@/.test(line)) next += 1;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    let at;
    if (line.startsWith('+')) {
      at = next;
      next += 1;
    } else if (line.startsWith('-')) {
      at = next - 1; // 지운 자리 바로 앞 줄이 속한 잡(맨 앞이면 머리줄 = 그 잡)
    } else continue;
    if (trivial(line.slice(1))) continue;
    const j = owner[at];
    if (!j) return 'all';
    if (JOB_AREA[j]) out.add(JOB_AREA[j]);
  }
  return [...out];
}

const forced = ciDefinitionAreas();
if (forced === 'all') console.log('CI 정의의 공통 부분이 바뀜 — 모든 잡이 돈다');
else if (forced.length) console.log(`CI 정의가 바뀐 잡: ${forced.join(', ')}`);

const result = Object.fromEntries(
  Object.entries(areas).map(([name, match]) => [
    name,
    forced === 'all' || forced.includes(name) || meaningful.some(match),
  ]),
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
