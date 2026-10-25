import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AudioRuntimeManager, selectAudioAsset, validateAudioEntry } from '../src/main/audio-runtime-manager';
const url = 'https://github.com/PlateerLab/xgen-audio-preprecessing/releases/download/audio-runtime-v1/xgen-audio-runtime-0.1.1-darwin-arm64.tar.gz';
const asset = (digest = 'sha256:' + 'a'.repeat(64)) => ({ name: 'xgen-audio-runtime-0.1.1-darwin-arm64.tar.gz', browser_download_url: url, digest, size: 3 });
test('GitHub assets require the expected origin, platform, size and digest', () => {
  assert.equal(selectAudioAsset({assets:[asset()]}).version,'0.1.1');
  for(const patch of [{browser_download_url:'https://evil.test/file'}, {digest:null}, {size:-1}, {name:'xgen-audio-runtime-0.1.1-win32-x64.tar.gz'}])
    assert.throws(()=>selectAudioAsset({assets:[{...asset(),...patch}]}));
});
test('archive paths reject traversal, devices and external links', () => {
  validateAudioEntry('python/bin/python3','SymbolicLink','python3.11');
  validateAudioEntry('python/lib/link','SymbolicLink','../bin/python3.11');
  for(const args of [['../outside','File',''],['/outside','File',''],['python/link','SymbolicLink','../../outside'],['python/link','Link','../outside'],['device','CharacterDevice','']])
    assert.throws(()=>validateAudioEntry(...args as [string,string,string]));
});
test('checksum failure keeps the previous activation pointer', async (t) => {
  const dir=await mkdtemp(join(tmpdir(),'audio-failed-'));
  try {
    const before=JSON.stringify({version:'0.0.1'});await writeFile(join(dir,'current.json'),before);
    const manager=new AudioRuntimeManager(dir,'/missing','/missing',async address=>address.includes('api.github.com')?Response.json({assets:[asset()]}):new Response('bad'));
    // Isolate checksum handling from the host platform's release eligibility.
    t.mock.method(manager, 'check', async () => selectAudioAsset({ assets: [asset()] }));
    await assert.rejects(manager.install(()=>{}),/무결성/);
    assert.equal(await readFile(join(dir,'current.json'),'utf8'),before);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('prepared runtime downloads, verifies, installs and upgrades atomically', {skip:!process.env.DEX_AUDIO_TEST_ARCHIVE}, async () => {
  const bytes=await readFile(process.env.DEX_AUDIO_TEST_ARCHIVE!);
  const dir=process.env.DEX_AUDIO_TEST_TARGET || await mkdtemp(join(tmpdir(),'audio-install-'));
  const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  let version='0.1.1';
  const manager=new AudioRuntimeManager(dir,'/missing','/missing',async address=>address.includes('api.github.com')?Response.json({assets:[{...asset(digest),name:`xgen-audio-runtime-${version}-darwin-arm64.tar.gz`,browser_download_url:url.replace('0.1.1',version),size:bytes.length}]}):new Response(bytes));
  const progress:number[]=[];
  try {
    assert.equal((await manager.install(p=>progress.push(p.percent))).available,true);
    assert.equal((await manager.status()).version,'0.1.1');
    assert.ok(progress.includes(100));
    version='0.1.2';
    assert.equal((await manager.install(()=>{})).version,'0.1.2');
    assert.equal(JSON.parse(await readFile(join(dir,'current.json'),'utf8')).version,'0.1.2');
    assert.ok(manager.runtime().python.includes('0.1.2'));
  } finally {if(!process.env.DEX_AUDIO_TEST_TARGET)await rm(dir,{recursive:true,force:true});}
});
