// Package a prepared runtime, preserving dependency notices and internal links.
const { resolve, join } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const tar = require('tar');
async function main() {
  const [source, version, output] = process.argv.slice(2);
  if (!source || !/^\d+\.\d+\.\d+$/.test(version) || !output) throw Error('Usage: node build/package-audio-runtime.cjs <runtime> <version> <output>');
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json')));
  if (manifest.platform !== 'darwin' || manifest.arch !== 'arm64') throw Error('Only darwin/arm64 is supported');
  for (const path of ['python/bin/python3.11', 'lib/librnnoise.dylib', 'THIRD_PARTY_NOTICES.txt', 'licenses/audio/RNNoise-COPYING.txt', 'licenses/models/silero_vad_v6.2.1.LICENSE.txt'])
    if (!existsSync(join(source,path))) throw Error(`Missing ${path}`);
  mkdirSync(output,{recursive:true});
  const file=resolve(output,`xgen-audio-runtime-${version}-darwin-arm64.tar.gz`);
  if (existsSync(file)) throw Error('Output already exists');
  await tar.c({cwd:source,file,gzip:true,portable:true},['python','lib','licenses','THIRD_PARTY_NOTICES.txt','manifest.json']);
  const sha256=createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(file+'.sha256',sha256+'  '+file.split('/').pop()+'\n');
  console.log(JSON.stringify({file,sha256}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
