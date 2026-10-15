/**
 * 배포물을 만든다 — 모노레포 안에서 쓰는 것과 **같은 소스, 다른 포장**(packages/protocol 과 같은 방식).
 *
 * 모노레포 안에서는 `@dex/ide` 이고 소스(TSX)를 그대로 쓴다(데스크톱의 Vite 가 번역한다).
 * 밖(웹 Next.js)으로는 JS + .d.ts + CSS 한 벌을 `xgen-dex-ide` 로 낸다 — npm 에 `@xgen`
 * 스코프 권한이 없어 기존 `xgen-dex-cli`·`xgen-dex-protocol` 과 같은 무스코프 규약이다.
 *
 * CSS 는 한 파일로 낸다: 소스의 `@import '@xterm/xterm/css/xterm.css'` 를 그 내용으로 펼친다.
 * 소비자의 번들러가 CSS 안의 패키지 경로를 풀 줄 아는지에 기대지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const distDir = join(pkgDir, 'dist');
const outDir = join(pkgDir, 'dist-pkg');
const PUBLIC_NAME = 'xgen-dex-ide';

rmSync(distDir, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });

execFileSync('npx', ['tsc', '-p', join(pkgDir, 'tsconfig.build.json')], { stdio: 'inherit', cwd: pkgDir });

/** 상대 임포트에 `.js` 를 붙인다 — Node ESM 과 엄격한 번들러는 확장자 없는 것을 못 찾는다. */
const REL = /(\bfrom\s+|\bimport\s*\(\s*|\bexport\s+\*\s+from\s+)(['"])(\.{1,2}\/[^'"]*?)(['"])/g;
function fixSpecifiers(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      fixSpecifiers(full);
      continue;
    }
    if (!/\.(js|d\.ts)$/.test(entry)) continue;
    const before = readFileSync(full, 'utf8');
    const after = before.replace(REL, (m, kw, q1, spec, q2) =>
      /\.(js|json|mjs|cjs|css)$/.test(spec) ? m : `${kw}${q1}${spec}.js${q2}`,
    );
    if (after !== before) writeFileSync(full, after);
  }
}
fixSpecifiers(distDir);

// CSS — xterm 의 것을 펼쳐 한 파일로.
const require = createRequire(import.meta.url);
const xtermCss = readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
const ideCss = readFileSync(join(pkgDir, 'src', 'ide.css'), 'utf8');
const IMPORT = /@import\s+['"]@xterm\/xterm\/css\/xterm\.css['"];\s*/;
if (!IMPORT.test(ideCss)) throw new Error('ide.css 에서 xterm @import 를 찾지 못했습니다 — 빌드를 고치세요');
writeFileSync(join(distDir, 'ide.css'), ideCss.replace(IMPORT, `/* @xterm/xterm/css/xterm.css */\n${xtermCss}\n`));

mkdirSync(outDir, { recursive: true });
cpSync(distDir, join(outDir, 'dist'), { recursive: true });

const readme = readFileSync(join(pkgDir, 'README.md'), 'utf8').replace(/^#\s*@dex\/ide\s*\n/, '');
writeFileSync(
  join(outDir, 'README.md'),
  [
    `# ${PUBLIC_NAME}`,
    '',
    '```bash',
    `npm i ${PUBLIC_NAME} monaco-editor`,
    '```',
    '',
    '> 모노레포(`PlateerLab/xgen-dex-core`) 안에서는 `@dex/ide` 라는 별칭으로 쓴다. 같은 코드이고,',
    '> 밖으로 나갈 때만 이 이름이다.',
    '',
    readme.trimStart(),
  ].join('\n'),
);

const source = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const manifest = {
  name: PUBLIC_NAME,
  // 버전은 워크스페이스 매니페스트가 정본이다(모든 앱·패키지가 같은 버전 — scripts/version.mjs).
  version: source.version,
  description: source.description,
  license: 'UNLICENSED',
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    './ide.css': './dist/ide.css',
  },
  files: ['dist', 'README.md'],
  sideEffects: ['*.css'],
  dependencies: source.dependencies,
  peerDependencies: { ...source.peerDependencies, 'monaco-editor': '>=0.45' },
  repository: {
    type: 'git',
    url: 'git+https://github.com/PlateerLab/xgen-dex-core.git',
    directory: 'packages/ide',
  },
  publishConfig: { access: 'public' },
};
writeFileSync(join(outDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`배포물 준비됨 → ${outDir}  (${manifest.name}@${manifest.version})`);
