import { build, context } from 'esbuild';

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
};

if (process.argv.includes('--watch')) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log('Watching XGEN Dex VS Code extension sources...');
} else {
  await build(options);
}
