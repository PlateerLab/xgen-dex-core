/**
 * 배포물을 만든다 — 모노레포 안에서 쓰는 것과 **같은 소스, 다른 포장**.
 *
 * 왜 따로 만드나
 * ──────────────
 * 워크스페이스에서 이 패키지는 `@dex/protocol` 이고 `main` 이 `src/index.ts` 다.
 * 그대로는 배포할 수 없다: 소비자(웹 Next.js)는 우리 tsconfig 의 paths 도, 원본
 * TypeScript 도 모른다. 그래서 배포용으로는 JS + .d.ts 를 내고 매니페스트를 새로
 * 쓴다.
 *
 * 이름이 둘인 이유
 * ────────────────
 * npm 에 `@xgen` org 권한이 없다(403 실측). 그래서 공개 이름은 기존 규약을 따라
 * 무스코프 `xgen-dex-protocol` 이다 — 이미 나가 있는 `xgen-dex-cli` 와 같은 꼴.
 * 모노레포 안에서는 별칭이 tsconfig·vite·metro 에 박혀 있어 이름을 바꾸면 90여
 * 파일과 번들러 설정이 함께 움직인다. 얻는 것 없이 위험만 큰 변경이라, 안은
 * `@dex/protocol` 로 두고 **밖으로 나가는 이름만** 정한다.
 *
 * 확장자 문제
 * ───────────
 * 소스의 상대 임포트에는 확장자가 없다(`from './chat'`). 모노레포는 bundler
 * 해석이라 괜찮지만, Node ESM 은 그것을 못 찾는다. 소스 63줄을 고치는 대신
 * **낸 결과물만** 고친다 — 생성물에 대한 결정적 변환이고, 소스는 지금 쓰는
 * 도구들(vite·metro·tsx)이 기대하는 모양 그대로 남는다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const distDir = join(pkgDir, 'dist');
const outDir = join(pkgDir, 'dist-pkg');

/** 공개 이름. 내부 별칭(@dex/protocol)과 다르다 — 위 주석 참조. */
const PUBLIC_NAME = 'xgen-dex-protocol';

rmSync(distDir, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });

execFileSync('npx', ['tsc', '-p', join(pkgDir, 'tsconfig.build.json')], {
  stdio: 'inherit',
  cwd: pkgDir,
});

/** 상대 임포트에 `.js` 를 붙인다 — Node ESM 은 확장자 없는 것을 못 찾는다. */
const REL = /(\bfrom\s+|\bimport\s*\(\s*|\bexport\s+\*\s+from\s+)(['"])(\.{1,2}\/[^'"]*?)(['"])/g;
function fixSpecifiers(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { fixSpecifiers(full); continue; }
    if (!/\.(js|d\.ts)$/.test(entry)) continue;
    const before = readFileSync(full, 'utf8');
    const after = before.replace(REL, (m, kw, q1, spec, q2) =>
      /\.(js|json|mjs|cjs)$/.test(spec) ? m : `${kw}${q1}${spec}.js${q2}`);
    if (after !== before) writeFileSync(full, after);
  }
}
fixSpecifiers(distDir);

// ── 배포 디렉터리 ─────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
cpSync(distDir, join(outDir, 'dist'), { recursive: true });
// README 는 **배포용 머리말**을 붙여 낸다. 레포 안 README 의 제목은 내부 이름
// (`@dex/protocol`)인데, 그대로 올리면 npm 페이지가 설치 이름과 다른 제목을 단다 —
// 받는 사람은 무엇을 설치해야 하는지 알 수 없다.
const readme = readFileSync(join(pkgDir, 'README.md'), 'utf8')
  .replace(/^#\s*@dex\/protocol\s*\n/, '');
writeFileSync(join(outDir, 'README.md'), [
  `# ${PUBLIC_NAME}`,
  '',
  '```bash',
  `npm i ${PUBLIC_NAME}`,
  '```',
  '',
  '> 모노레포(`PlateerLab/xgen-dex-core`) 안에서는 `@dex/protocol` 이라는 별칭으로',
  '> 쓴다. 같은 코드이고, 밖으로 나갈 때만 이 이름이다 — npm 에 `@xgen` 스코프',
  '> 권한이 없어 기존 `xgen-dex-cli` 와 같은 무스코프 규약을 따른다.',
  '',
  readme.trimStart(),
].join('\n'));

const source = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
/**
 * 버전은 **워크스페이스 매니페스트가 정본**이다. 여기서 따로 적으면 릴리스마다
 * 두 숫자를 맞춰야 하고, 어긋나면 npm 에 엉뚱한 버전이 나간다.
 */
const manifest = {
  name: PUBLIC_NAME,
  version: source.version,
  description: source.description,
  license: 'UNLICENSED',
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    // 서브경로 — `@dex/protocol/browser` 처럼 쓰던 것이 공개 이름으로도 그대로 된다.
    './*': { types: './dist/*.d.ts', default: './dist/*.js' },
  },
  files: ['dist', 'README.md'],
  sideEffects: false,
  repository: { type: 'git', url: 'git+https://github.com/PlateerLab/xgen-dex-core.git',
                directory: 'packages/protocol' },
  publishConfig: { access: 'public' },
};
writeFileSync(join(outDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`배포물 준비됨 → ${outDir}  (${manifest.name}@${manifest.version})`);
