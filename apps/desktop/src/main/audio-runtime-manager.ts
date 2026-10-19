import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import * as tar from 'tar';
import { AudioProcessor, audioRuntime, type AudioRuntime } from './audio-preprocessor';

const REPO = 'PlateerLab/xgen-audio-preprecessing';
const TAG = 'audio-runtime-v1'; // JSONL worker protocol v1; incompatible bundles require a new release tag.
const API = `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_BYTES = 512 * 1024 * 1024;
export type AudioAsset = { version: string; url: string; sha256: string; size: number };
export type AudioInstallProgress = { phase: 'download' | 'verify' | 'install'; percent: number };
export type AudioRuntimeStatus = { available: boolean; error: string; version: string | null; supported: boolean };
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
export function compareAudioVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
export function selectAudioAsset(release: any): AudioAsset {
  if (!Array.isArray(release.assets)) throw new Error('전처리 릴리스 정보가 올바르지 않습니다.');
  const assets = release.assets.flatMap((asset: any) => {
    const match = /^xgen-audio-runtime-(\d+\.\d+\.\d+)-darwin-arm64\.tar\.gz$/.exec(asset.name);
    if (!match || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES) return [];
    const expected = `https://github.com/${REPO}/releases/download/${TAG}/${asset.name}`;
    if (asset.browser_download_url !== expected) return [];
    return [{ version: match[1], url: expected, sha256: asset.digest.slice(7), size: asset.size }];
  });
  assets.sort((a: AudioAsset, b: AudioAsset) => compareAudioVersions(b.version, a.version));
  if (!assets[0]) throw new Error('호환되는 전처리 파일이 아직 GitHub에 게시되지 않았습니다.');
  return assets[0];
}
export function validateAudioEntry(path: string, type: string, linkpath = ''): void {
  const safe = (p: string) => !posix.isAbsolute(p) && !p.includes('\\') && !/^[a-z]:/i.test(p) && !p.split('/').includes('..');
  if (!safe(path) || !['File', 'Directory', 'SymbolicLink', 'Link'].includes(type)) throw new Error('안전하지 않은 전처리 압축 파일입니다.');
  if (linkpath) {
    const target = type === 'SymbolicLink' ? posix.join(posix.dirname(path), linkpath) : linkpath;
    if (posix.isAbsolute(linkpath) || !safe(target)) throw new Error('전처리 파일의 링크가 설치 폴더를 벗어납니다.');
  }
}
const bundledRuntime = (root: string): AudioRuntime => ({ python: join(root, 'python/bin/python3.11'), library: join(root, 'lib/librnnoise.dylib') });
export class AudioRuntimeManager {
  private busy = false;
  constructor(private base: string, private appPath: string, private resources: string, private fetcher: Fetcher) {}
  private installed(): { version: string; root: string } | null {
    try {
      const { version, directory = version } = JSON.parse(readFileSync(join(this.base, 'current.json'), 'utf8'));
      if (!VERSION.test(version) || typeof directory !== 'string' || !(directory === version || new RegExp('^' + version.replaceAll('.', '\\.') + '-[a-f0-9-]+$').test(directory))) return null;
      const root = join(this.base, directory);
      if (!existsSync(bundledRuntime(root).python) || !existsSync(bundledRuntime(root).library)) return null;
      return { version, root };
    } catch { return null; }
  }
  runtime(): AudioRuntime {
    const installed = this.installed();
    if (installed && !process.env.DEX_AUDIO_ROOT && !process.env.DEX_AUDIO_PYTHON && !process.env.XGEN_RNNOISE_LIBRARY) return bundledRuntime(installed.root);
    return audioRuntime(this.appPath, this.resources);
  }
  async status(): Promise<AudioRuntimeStatus> {
    const version = this.installed()?.version ?? null;
    const supported = process.platform === 'darwin' && process.arch === 'arm64';
    const processor = new AudioProcessor({ noise: true, vad: true }, this.runtime());
    try { await processor.open(); await processor.finish(); return { available: true, error: '', version, supported }; }
    catch (error) { processor.cancel(); return { available: false, error: String(error), version, supported }; }
  }
  async check(): Promise<AudioAsset> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('전처리 다운로드는 현재 macOS Apple Silicon만 지원합니다.');
    const response = await this.fetcher(API, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.github+json' } });
    if (response.status === 404) throw new Error('전처리 파일이 아직 GitHub에 게시되지 않았습니다.');
    if (!response.ok) throw new Error(`GitHub 업데이트 확인 실패 (${response.status})`);
    return selectAudioAsset(await response.json());
  }
  async install(progress: (value: AudioInstallProgress) => void): Promise<AudioRuntimeStatus> {
    if (this.busy) throw new Error('전처리를 설치하고 있습니다.');
    this.busy = true;
    let temporary: string | undefined;
    try {
      const asset = await this.check();
      const old = this.installed();
      if (old && compareAudioVersions(old.version, asset.version) >= 0) {
        const status = await this.status(); if (status.available) return status;
      }
      await mkdir(this.base, { recursive: true });
      temporary = await mkdtemp(join(this.base, '.install-'));
      const archive = join(temporary, 'runtime.tar.gz');
      const response = await this.fetcher(asset.url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw new Error(`전처리 다운로드 실패 (${response.status})`);
      const hash = createHash('sha256'); let bytes = 0, last = -1;
      const file = await open(archive, 'wx');
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > asset.size || bytes > MAX_BYTES) throw new Error('전처리 파일 크기가 올바르지 않습니다.');
          hash.update(value); await file.writeFile(value);
          const percent = Math.floor(bytes / asset.size * 100);
          if (percent !== last) { progress({ phase: 'download', percent }); last = percent; }
        }
      } finally { await file.close(); await reader.cancel().catch(() => {}); }
      progress({ phase: 'verify', percent: 100 });
      if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('전처리 파일 무결성 검증에 실패했습니다. 다시 다운로드해 주세요.');
      let expanded = 0, entries = 0; let archiveError: Error | undefined;
      await tar.t({ file: archive, strict: true, onReadEntry(entry) {
        try { validateAudioEntry(entry.path, entry.type, entry.linkpath); } catch (error) { archiveError = error as Error; }
        expanded += entry.size; entries++;
        if (expanded > 2 * 1024 ** 3 || entries > 100000) archiveError = new Error('전처리 압축 파일이 너무 큽니다.');
      } });
      if (archiveError) throw archiveError;
      const root = join(temporary, 'runtime'); await mkdir(root);
      progress({ phase: 'install', percent: 100 });
      await tar.x({ file: archive, cwd: root, strict: true, preservePaths: false });
      for (const notice of ['THIRD_PARTY_NOTICES.txt', 'licenses/audio/RNNoise-COPYING.txt', 'licenses/models/silero_vad_v6.2.1.LICENSE.txt'])
        if (!existsSync(join(root, notice))) throw new Error('전처리 라이선스 고지가 누락되었습니다.');
      const probe = new AudioProcessor({ noise: true, vad: true }, bundledRuntime(root));
      try { await probe.open(); await probe.push(new Uint8Array(32000)); await probe.finish(); }
      finally { probe.cancel(); }
      const directory = `${asset.version}-${randomUUID()}`;
      const target = join(this.base, directory);
      await rename(root, target);
      const pointer = join(temporary, 'current.json');
      await writeFile(pointer, JSON.stringify({ version: asset.version, directory, sha256: asset.sha256 }));
      await rename(pointer, join(this.base, 'current.json'));
      return this.status();
    } finally {
      this.busy = false;
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}
