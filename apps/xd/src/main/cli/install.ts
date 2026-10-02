/**
 * Claude Code·Codex 설치·업데이트 — 공식 배포처에서 직접 받아 sha256 을 확인하고 `<루트>/.xd/cli/<이름>/bin` 에 둔다.
 *
 * 설치 스크립트(install.sh/ps1)를 돌리지 않는다: 그 스크립트는 사용자의 셸 설정·PATH 를 고치고(Windows 는 따로),
 * XD 는 그 실행 파일 하나만 있으면 된다. 대신 스크립트가 쓰는 것과 같은 배포 경로·같은 검증을 따른다.
 *
 * - Claude Code: `downloads.claude.ai/claude-code-releases/{stable|latest}` → 판,
 *   `{판}/manifest.json` 의 `platforms[<플랫폼>].checksum` → `{판}/<플랫폼>/claude(.exe)` (단일 실행 파일).
 * - Codex: GitHub `openai/codex` 릴리스(`rust-v<판>`) — 자산 sha256 은 API 의 `digest`. 맥·리눅스는
 *   `codex-<삼중항>.tar.gz`(안에 `codex-<삼중항>` 하나), Windows 는 `codex-<삼중항>.exe` 그대로.
 *
 * 받는 동안은 옆 이름에 쓰고 검증이 끝난 뒤에만 바꿔 끼운다 — 실패해도 쓰던 판이 남는다.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliName } from './detect';
import { xdCliPath } from './detect';

export const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases';
export const CODEX_RELEASES_API = 'https://api.github.com/repos/openai/codex/releases';

export interface InstallPlan {
  name: CliName;
  version: string;
  url: string;
  sha256: string;
  /** 받은 것이 압축본이면 그 안의 실행 파일 이름. */
  archiveMember?: string;
}

export interface Fetcher {
  text(url: string): Promise<string>;
  json(url: string): Promise<unknown>;
  bytes(url: string, onProgress?: (received: number, total: number) => void): Promise<Buffer>;
}

/** Claude Code 의 플랫폼 이름(설치 스크립트와 같다). 리눅스 musl 은 XD 대상이 아니다. */
export function claudePlatform(platform: NodeJS.Platform, arch: string): string {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : '';
  if (!a || !['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`Claude Code does not support ${platform}-${arch}`);
  return `${platform}-${a}`;
}

/** Codex 의 Rust 삼중항. */
export function codexTriple(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : '';
  const os = platform === 'darwin' ? 'apple-darwin' : platform === 'linux' ? 'unknown-linux-musl' : platform === 'win32' ? 'pc-windows-msvc' : '';
  if (!cpu || !os) throw new Error(`Codex does not support ${platform}-${arch}`);
  return `${cpu}-${os}`;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?$/;

export async function planClaude(
  fetcher: Fetcher,
  opts: { channel?: 'stable' | 'latest'; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<InstallPlan> {
  const platform = opts.platform ?? process.platform;
  const key = claudePlatform(platform, opts.arch ?? process.arch);
  const version = (await fetcher.text(`${CLAUDE_RELEASES}/${opts.channel ?? 'stable'}`)).trim();
  // 지역 제한·오류 페이지가 판 대신 올 수 있다 — 판처럼 생기지 않으면 멈춘다.
  if (!VERSION_RE.test(version)) throw new Error('could not read the Claude Code version (the download service may be unavailable here)');
  const manifest = (await fetcher.json(`${CLAUDE_RELEASES}/${version}/manifest.json`)) as {
    platforms?: Record<string, { checksum?: string }>;
  };
  const sha256 = manifest.platforms?.[key]?.checksum ?? '';
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Claude Code ${version} has no build for ${key}`);
  const file = platform === 'win32' ? 'claude.exe' : 'claude';
  return { name: 'claude', version, url: `${CLAUDE_RELEASES}/${version}/${key}/${file}`, sha256 };
}

interface GithubRelease {
  tag_name?: string;
  assets?: Array<{ name: string; browser_download_url: string; digest?: string | null }>;
}

export async function planCodex(
  fetcher: Fetcher,
  opts: { version?: string; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<InstallPlan> {
  const platform = opts.platform ?? process.platform;
  const triple = codexTriple(platform, opts.arch ?? process.arch);
  const release = (await fetcher.json(
    opts.version ? `${CODEX_RELEASES_API}/tags/rust-v${opts.version}` : `${CODEX_RELEASES_API}/latest`,
  )) as GithubRelease;
  const m = /^rust-v(.+)$/.exec(release.tag_name ?? '');
  if (!m) throw new Error(`unexpected Codex release tag: ${String(release.tag_name)}`);
  const wanted = platform === 'win32' ? `codex-${triple}.exe` : `codex-${triple}.tar.gz`;
  const asset = (release.assets ?? []).find((a) => a.name === wanted);
  const sha256 = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? '')?.[1] ?? '';
  if (!asset || !sha256) throw new Error(`Codex ${m[1]} has no verified build for ${triple}`);
  return {
    name: 'codex',
    version: m[1],
    url: asset.browser_download_url,
    sha256,
    archiveMember: platform === 'win32' ? undefined : `codex-${triple}`,
  };
}

function untarOne(archive: string, member: string, into: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', into, member], { windowsHide: true }, (err) => {
      if (err) reject(new Error(`could not unpack ${member}: ${err.message}`));
      else resolve(join(into, member));
    });
  });
}

/**
 * 받고 → sha256 확인 → (압축본이면 풀고) → 옆 이름에 두고 → 실행해 판을 확인 → 바꿔 끼운다.
 * 판 확인은 부르는 쪽이 준다(`verify`) — 받은 파일이 이 PC 에서 실제로 도는지.
 */
export async function installCli(
  plan: InstallPlan,
  opts: {
    cliDir: string;
    fetcher: Fetcher;
    verify: (path: string) => Promise<string | null>;
    platform?: NodeJS.Platform;
    onProgress?: (received: number, total: number) => void;
  },
): Promise<{ path: string; version: string }> {
  const platform = opts.platform ?? process.platform;
  const target = xdCliPath(opts.cliDir, plan.name, platform);
  const binDir = join(opts.cliDir, plan.name, 'bin');
  mkdirSync(binDir, { recursive: true });
  const work = mkdtempSync(join(opts.cliDir, `.${plan.name}-download-`));
  try {
    const body = await opts.fetcher.bytes(plan.url, opts.onProgress);
    const got = createHash('sha256').update(body).digest('hex');
    if (got !== plan.sha256) throw new Error(`checksum mismatch for ${plan.name} ${plan.version}`);
    const downloaded = join(work, 'download');
    writeFileSync(downloaded, body);
    const binary = plan.archiveMember ? await untarOne(downloaded, plan.archiveMember, work) : downloaded;
    if (platform !== 'win32') chmodSync(binary, 0o755);
    const staged = `${target}.new`;
    rmSync(staged, { force: true });
    renameSync(binary, staged);
    const version = await opts.verify(staged);
    if (!version) {
      rmSync(staged, { force: true });
      throw new Error(`${plan.name} ${plan.version} did not run on this computer`);
    }
    // Windows 는 실행 중인 파일을 덮을 수 없다 — 지금 판을 옆으로 비킨 뒤 새 판을 넣는다.
    if (existsSync(target)) {
      const old = `${target}.old`;
      rmSync(old, { force: true });
      renameSync(target, old);
      try {
        rmSync(old, { force: true });
      } catch {
        /* 실행 중이면 다음 설치 때 지운다 */
      }
    }
    renameSync(staged, target);
    return { path: target, version };
  } finally {
    rmSync(work, { recursive: true, force: true });
    // 지난 번에 지우지 못한 옛 판 정리
    for (const name of existsSync(binDir) ? readdirSync(binDir) : []) {
      if (name.endsWith('.old')) {
        try {
          rmSync(join(binDir, name), { force: true });
        } catch {
          /* 아직 실행 중 */
        }
      }
    }
  }
}

/** 실제 네트워크 — Electron main 의 fetch. 리디렉트를 따르고, GitHub API 는 JSON 으로. */
export const httpFetcher: Fetcher = {
  async text(url) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.text();
  },
  async json(url) {
    const res = await fetch(url, { redirect: 'follow', headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.json();
  },
  async bytes(url, onProgress) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
      onProgress?.(received, total);
    }
    return Buffer.concat(chunks);
  },
};
