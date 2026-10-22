import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_RELEASE_TRIPLES = ['linux-x64', 'win32-x64', 'darwin-arm64'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Copy the real prebuilds into each self-contained host; never compile on install. */
export async function copyNativeAssets(destination, all = process.env.DEX_NATIVE_RELEASE === '1') {
  const triples = all ? NATIVE_RELEASE_TRIPLES : [`${process.platform}-${process.arch}`];
  const manifest = {};
  for (const triple of triples) {
    const source = join(root, 'packages/native-fs/prebuilds', triple, 'native-fs.node');
    const bytes = await readFile(source);
    if (bytes.length === 0) throw new Error(`Empty native prebuild: ${triple}`);
    await mkdir(join(destination, triple), { recursive: true });
    await cp(source, join(destination, triple, 'native-fs.node'));
    manifest[triple] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
