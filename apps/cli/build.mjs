import { chmod, rm } from 'node:fs/promises';
import { build } from 'esbuild';

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
});

await chmod('dist/cli.js', 0o755);
