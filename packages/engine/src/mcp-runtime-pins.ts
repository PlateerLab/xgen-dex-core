/**
 * 앱이 직접 내려받아 쓰는 런타임의 **고정 판** — 버전 · 주소 · SHA-256 · 크기를 한 곳에 둔다.
 *
 * 범위("최신 LTS")로 받지 않는 이유: 같은 카탈로그 항목이 PC 마다 다른 Node 로 돌면
 * "내 PC 에선 되는데" 가 생기고, 무엇을 받았는지 검증할 근거(해시)도 미리 알 수 없다.
 *
 * 값의 출처(갱신할 때 같은 곳에서 다시 옮긴다):
 *  - Node: https://nodejs.org/dist/v<ver>/SHASUMS256.txt (크기는 같은 파일의 Content-Length)
 *  - uv:   https://github.com/astral-sh/uv/releases/download/<ver>/<asset>.sha256
 *          (GitHub API 의 asset `digest` · `size` 와 같다)
 * 설치기는 내려받기 전에 위 체크섬 파일을 **다시 받아 고정 값과 맞춰 보고**, 받은 파일의
 * 해시 · 크기도 고정 값과 맞춰 본다 — 둘 중 하나라도 다르면 설치하지 않는다.
 *
 * 사내망(외부 차단)에서는 `DEX_RUNTIME_MIRROR` 로 같은 경로 구조의 미러를 가리킬 수 있다.
 * 해시가 고정이라 미러가 파일을 바꿔치기해도 설치되지 않는다.
 */

export type ManagedRuntimeKind = 'node' | 'uv';

/** `process.platform-process.arch` — 지원하는 6개 조합. */
export type RuntimeTarget =
  'win32-x64' | 'win32-arm64' | 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64';

export interface RuntimeAsset {
  /** 받을 파일 이름(체크섬 파일 안의 이름과 같다). */
  file: string;
  sha256: string;
  size: number;
  format: 'tar.gz' | 'zip';
}

export interface RuntimePin {
  kind: ManagedRuntimeKind;
  label: string;
  version: string;
  /** 파일이 놓인 디렉터리 URL(끝 `/` 없음). */
  baseUrl: string;
  /** 체크섬 파일 URL — 내려받기 전에 고정 해시와 맞춰 본다. */
  checksumUrl: (asset: RuntimeAsset) => string;
  assets: Record<RuntimeTarget, RuntimeAsset>;
  /** 압축을 풀고 맨 위 폴더 하나를 벗겨낸 뒤의 실행 파일 폴더(상대). */
  binDir: (target: RuntimeTarget) => string;
  /** 실행 시험에 쓸 실행 파일 이름. */
  probe: (target: RuntimeTarget) => string;
  /** 압축 맨 위 폴더를 벗길지 — Windows uv zip 은 맨 위에 바로 exe 가 있다. */
  strip: (target: RuntimeTarget) => number;
  /** 시험 실행 결과가 이 판인지. */
  matches: (stdout: string) => boolean;
}

const NODE_VERSION = '24.22.3'; // Node 24 "Krypton" LTS (2026-11-10). 생태계 호환을 위해 26 대신 24.
const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

export const NODE_PIN: RuntimePin = {
  kind: 'node',
  label: 'Node.js',
  version: NODE_VERSION,
  baseUrl: NODE_BASE,
  checksumUrl: () => `${NODE_BASE}/SHASUMS256.txt`,
  assets: {
    'darwin-arm64': {
      file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      sha256: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
      size: 53084299,
      format: 'tar.gz',
    },
    'darwin-x64': {
      file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
      sha256: '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
      size: 54395976,
      format: 'tar.gz',
    },
    'linux-arm64': {
      file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
      sha256: '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
      size: 58051304,
      format: 'tar.gz',
    },
    'linux-x64': {
      file: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
      sha256: '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
      size: 58330843,
      format: 'tar.gz',
    },
    'win32-arm64': {
      file: `node-v${NODE_VERSION}-win-arm64.zip`,
      sha256: 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14',
      size: 33802073,
      format: 'zip',
    },
    'win32-x64': {
      file: `node-v${NODE_VERSION}-win-x64.zip`,
      sha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
      size: 37762649,
      format: 'zip',
    },
  },
  binDir: (target) => (target.startsWith('win32') ? '.' : 'bin'),
  probe: (target) => (target.startsWith('win32') ? 'node.exe' : 'node'),
  strip: () => 1,
  matches: (stdout) => stdout.trim() === `v${NODE_VERSION}`,
};

const UV_VERSION = '0.13.9'; // 2026-11-17
const UV_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

export const UV_PIN: RuntimePin = {
  kind: 'uv',
  label: 'uv',
  version: UV_VERSION,
  baseUrl: UV_BASE,
  checksumUrl: (asset) => `${UV_BASE}/${asset.file}.sha256`,
  assets: {
    'darwin-arm64': {
      file: 'uv-aarch64-apple-darwin.tar.gz',
      sha256: '5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca',
      size: 14554974,
      format: 'tar.gz',
    },
    'darwin-x64': {
      file: 'uv-x86_64-apple-darwin.tar.gz',
      sha256: '617a3211261b0fc739562f0071aa34e9739797c510208ede8e2977c30903d041',
      size: 17362924,
      format: 'tar.gz',
    },
    // glibc 빌드 — uv 가 이 PC 에 맞는 Python 을 고를 때 libc 판단이 정확하다.
    'linux-arm64': {
      file: 'uv-aarch64-unknown-linux-gnu.tar.gz',
      sha256: '0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d',
      size: 16120245,
      format: 'tar.gz',
    },
    'linux-x64': {
      file: 'uv-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5',
      size: 17068176,
      format: 'tar.gz',
    },
    'win32-arm64': {
      file: 'uv-aarch64-pc-windows-msvc.zip',
      sha256: '72eed595983a4d7d22d79f21065b0f4479cc7e5c7a89104bb410c8f47559a878',
      size: 15747415,
      format: 'zip',
    },
    'win32-x64': {
      file: 'uv-x86_64-pc-windows-msvc.zip',
      sha256: 'edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb',
      size: 15567875,
      format: 'zip',
    },
  },
  binDir: () => '.',
  probe: (target) => (target.startsWith('win32') ? 'uv.exe' : 'uv'),
  strip: (target) => (target.startsWith('win32') ? 0 : 1),
  matches: (stdout) => stdout.trim().startsWith(`uv ${UV_VERSION}`),
};

/** `runtime.kind: python` 항목에 uv 로 설치하는 Python. 3.12 — MCP 패키지 호환이 가장 넓다. */
export const PYTHON_VERSION = '3.12.16';

export const RUNTIME_PINS: Record<ManagedRuntimeKind, RuntimePin> = { node: NODE_PIN, uv: UV_PIN };

/** 내려받기 상한 — 고정 크기를 넘으면 바로 끊지만, 이 값은 그보다 앞선 방어선이다. */
export const RUNTIME_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** 풀린 파일 합계 · 항목 수 상한(Node win zip 은 약 107MB · 2,459 항목). */
export const RUNTIME_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const RUNTIME_MAX_ENTRIES = 50_000;

export function runtimeTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): RuntimeTarget | null {
  const key = `${platform}-${arch}`;
  return (
    (
      [
        'win32-x64',
        'win32-arm64',
        'darwin-x64',
        'darwin-arm64',
        'linux-x64',
        'linux-arm64',
      ] as const
    ).find((t) => t === key) ?? null
  );
}

/** 미러가 지정돼 있으면 공식 주소의 origin 을 미러로 바꾼다(경로 구조는 같다고 본다). */
export function mirrored(
  url: string,
  mirror: string | undefined = process.env.DEX_RUNTIME_MIRROR,
): string {
  if (!mirror) return url;
  const u = new URL(url);
  return `${mirror.replace(/\/+$/, '')}/${u.host}${u.pathname}`;
}
