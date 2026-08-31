import { chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = (name) => resolve(here, '../../packages', name, 'src');

/**
 * 공용 패키지는 **번들에 녹인다** — `packages: 'external'` 이 걸려 있어 그냥 두면
 * node_modules 에서 찾으려 하고, 그러면 배포된 CLI 가 코어를 못 찾는다.
 * 별칭이라 배포물은 자기 완결적이고, 코어를 고치면 다음 빌드에 그대로 들어간다.
 */
const dexAlias = {
  name: 'dex-alias',
  setup(b) {
    b.onResolve({ filter: /^@dex\// }, (args) => {
      const [, name, ...rest] = args.path.split('/');
      const base = pkg(name);
      return { path: rest.length ? resolve(base, `${rest.join('/')}.ts`) : resolve(base, 'index.ts') };
    });
  },
};

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: { cli: 'src/cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  splitting: true,
  target: 'node20',
  sourcemap: true,
  packages: 'external',
  chunkNames: 'chunks/[name]-[hash]',
  plugins: [dexAlias],
});

await chmod('dist/cli.js', 0o755);
