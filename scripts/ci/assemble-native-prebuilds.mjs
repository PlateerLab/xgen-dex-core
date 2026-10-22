import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_RELEASE_TRIPLES } from '../native-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const triple of NATIVE_RELEASE_TRIPLES) {
  const source = join(root, 'packages/native-fs/downloaded', `native-fs-${triple}`, 'native-fs.node');
  const bytes = await readFile(source);
  if (!bytes.length) throw new Error(`Missing prebuild: ${triple}`);
  const destination = join(root, 'packages/native-fs/prebuilds', triple);
  await mkdir(destination, { recursive: true });
  await cp(source, join(destination, 'native-fs.node'));
}
