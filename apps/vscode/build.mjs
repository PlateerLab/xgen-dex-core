import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** 공용 패키지는 소스로 번들한다 — 확장은 .vsix 하나로 배포되므로 자기 완결적이어야 한다. */
const dexAlias = {
  name: 'dex-alias',
  setup(b) {
    b.onResolve({ filter: /^@dex\// }, (args) => {
      const [, name, ...rest] = args.path.split('/');
      const base = resolve(here, '../../packages', name, 'src');
      return { path: rest.length ? resolve(base, `${rest.join('/')}.ts`) : resolve(base, 'index.ts') };
    });
  },
};

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info',
  plugins: [dexAlias],
};

if (process.argv.includes('--watch')) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log('Watching XGEN Dex VS Code extension sources...');
} else {
  await build(options);
}
