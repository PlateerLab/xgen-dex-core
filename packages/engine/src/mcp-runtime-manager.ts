/**
 * MCP 런타임 관리 — 카탈로그 항목이 요구하는 Node · uv · Python 이 이 PC 에 있는지 보고,
 * 없으면 **앱 데이터 폴더에 직접** 설치한다(관리자 권한 · 시스템 패키지 매니저 없이).
 *
 *   <base>/node/<ver>-<id>/   Node LTS(고정 판) — node · npm · npx
 *   <base>/uv/<ver>-<id>/     uv(고정 판) — uv · uvx, Python 도 uv 가 관리한다
 *   <base>/python/            `uv python install <고정 판>` 의 설치 폴더
 *   <base>/<kind>/current.json  지금 쓰는 판(원자적 교체)
 *
 * 설치 순서(음성 전처리 설치와 같은 원칙): 체크섬 파일을 받아 고정 해시와 맞춤 → 임시
 * 폴더로 내려받기(크기 · SHA-256) → 항목 검사 후 풀기 → 시험 실행(`node -v` · `uv --version`)
 * → 판 폴더로 이동 → current.json 교체 → exec-resolve 의 PATH 맨 앞에 bin 추가.
 * 실패하면 이전 활성 판을 그대로 둔다. 이전 판 폴더는 지우지 않는다(그 판으로 저장된
 * 서버가 절대 경로로 가리키고 있을 수 있다).
 *
 * 이미 설치된 시스템 런타임이 `runtime.min_version` 을 만족하면 그것을 쓰고 받지 않는다.
 * Docker 는 자동 설치할 수 없다 — 찾지 못하면 안내(링크 + 단계)를 돌려준다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CatalogRuntimeKind } from '@dex/protocol/mcp-catalog';
import { compareLooseVersions } from '@dex/protocol/mcp-catalog';
import { safeExtract } from './archive-extract';
import {
  augmentedPath,
  buildChildEnv,
  resolveExecutable,
  runtimeFor,
  setManagedBinDirs,
  systemPath,
} from './exec-resolve';
import {
  mirrored,
  PYTHON_VERSION,
  RUNTIME_MAX_DOWNLOAD_BYTES,
  RUNTIME_MAX_ENTRIES,
  RUNTIME_MAX_EXPANDED_BYTES,
  RUNTIME_PINS,
  runtimeTarget,
  type ManagedRuntimeKind,
  type RuntimeAsset,
  type RuntimePin,
  type RuntimeTarget,
} from './mcp-runtime-pins';
import { runProcess } from './proc-run';

export type RuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type RuntimeErrorCode =
  | 'runtime_unsupported'
  | 'runtime_manual_required'
  | 'download_failed'
  | 'checksum_mismatch'
  | 'extract_failed'
  | 'runtime_test_failed'
  | 'python_install_failed'
  | 'cancelled';

export class RuntimeInstallError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly runtime?: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = 'RuntimeInstallError';
  }
}

export type RuntimeComponent = ManagedRuntimeKind | 'python';

export interface RuntimeProgress {
  component: RuntimeComponent;
  phase: 'checksum' | 'download' | 'verify' | 'extract' | 'test' | 'activate' | 'python';
  received?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface RuntimeDownload {
  component: RuntimeComponent;
  label: string;
  version: string;
  /** 내려받을 주소(미러 반영). Python 은 uv 가 python-build-standalone 에서 받는다. */
  url: string;
  /** 바이트. Python 은 미리 알 수 없어 대략값. */
  size: number;
  approximate?: boolean;
}

export interface ManualAction {
  title: string;
  summary: string;
  steps: string[];
  url: string;
}

export interface RuntimeFound {
  component: RuntimeComponent | 'docker';
  source: 'system' | 'managed';
  version: string;
  path: string;
}

export interface RuntimePlan {
  kind: CatalogRuntimeKind;
  minVersion?: string;
  /** 지금 바로 실행할 수 있다(받을 것이 없다). */
  ready: boolean;
  found: RuntimeFound[];
  /** 사용자 동의 뒤 받을 것(순서대로). */
  downloads: RuntimeDownload[];
  /** 사람이 직접 해야 하는 일(Docker). 있으면 설치를 진행하지 않는다. */
  manual?: ManualAction;
  /** 이 PC 에서 자동 설치를 할 수 없는 이유(지원하지 않는 OS/CPU · 판 부족). */
  unsupported?: string;
  /** 화면 한 줄 요약 — "Node 20 이상 필요 — 자동 설치". */
  summary: string;
}

export interface RuntimeEnsureResult {
  installed: Array<{ component: RuntimeComponent; version: string; durationMs: number }>;
}

interface Pointer {
  version: string;
  directory: string;
  sha256?: string;
  binDir?: string;
}

export interface RuntimeManagerOptions {
  baseDir: string;
  fetch: RuntimeFetch;
  platform?: string;
  arch?: string;
  /** 다운로드가 이 시간 동안 한 바이트도 안 오면 끊는다. */
  stallMs?: number;
  /** 시험용 — 고정 판 대신 쓸 판. */
  pins?: Partial<Record<ManagedRuntimeKind, RuntimePin>>;
  /** 시험용 — 시스템 런타임을 찾을 PATH. */
  systemPath?: () => Promise<string>;
}

const DOCKER_URL = 'https://docs.docker.com/get-started/get-docker/';
const PYTHON_APPROX_BYTES = 30 * 1024 * 1024;

function versionOf(text: string): string | null {
  return text.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
}

function meets(version: string | null, min?: string | null): boolean {
  if (!version) return false;
  return !min || compareLooseVersions(version, min) >= 0;
}

function abortError(signal?: AbortSignal): RuntimeInstallError {
  void signal;
  return new RuntimeInstallError('cancelled', '사용자가 설치를 취소했습니다.');
}

/** 카탈로그가 runtime 을 none/binary 로 적었어도 실행 명령이 npx/uvx 면 그 런타임이 필요하다. */
export function effectiveRuntimeKind(
  kind: CatalogRuntimeKind,
  command?: string,
): CatalogRuntimeKind {
  if (kind !== 'none' && kind !== 'binary') return kind;
  const rt = command ? runtimeFor(command) : null;
  if (!rt) return kind;
  if (rt.label === 'Node.js') return 'node';
  if (rt.label === 'uv') return 'uv';
  if (rt.label === 'Python') return 'python';
  if (rt.label === 'Docker') return 'docker';
  return kind;
}

export class McpRuntimeManager {
  private readonly platform: string;
  private readonly arch: string;
  private readonly target: RuntimeTarget | null;
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: RuntimeManagerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.target = runtimeTarget(this.platform, this.arch);
  }

  get baseDir(): string {
    return this.opts.baseDir;
  }

  private pin(kind: ManagedRuntimeKind): RuntimePin {
    return this.opts.pins?.[kind] ?? RUNTIME_PINS[kind];
  }

  private sysPath(): Promise<string> {
    return (this.opts.systemPath ?? systemPath)();
  }

  private exe(name: string): string {
    return this.platform === 'win32' ? `${name}.exe` : name;
  }

  // ── 설치된 판 ─────────────────────────────────────────────────────

  private pointer(component: RuntimeComponent): Pointer | null {
    try {
      const raw = JSON.parse(
        readFileSync(join(this.opts.baseDir, component, 'current.json'), 'utf8'),
      ) as Pointer;
      if (!raw || typeof raw.version !== 'string' || typeof raw.directory !== 'string') return null;
      if (!/^[0-9A-Za-z][0-9A-Za-z.\-_]*$/.test(raw.directory) || raw.directory.includes('..'))
        return null;
      return raw;
    } catch {
      return null;
    }
  }

  /** 앱이 설치한 판 — 폴더와 실행 파일까지 실제로 있을 때만. */
  installed(component: RuntimeComponent): { version: string; root: string; binDir: string } | null {
    const p = this.pointer(component);
    if (!p) return null;
    const root = join(this.opts.baseDir, component, p.directory);
    let binDir: string;
    let probe: string;
    if (component === 'python') {
      binDir = p.binDir && !p.binDir.includes('..') ? join(root, p.binDir) : root;
      probe = join(binDir, this.platform === 'win32' ? 'python.exe' : 'python3');
    } else {
      const pin = this.pin(component);
      if (!this.target) return null;
      binDir = join(root, pin.binDir(this.target));
      probe = join(binDir, pin.probe(this.target));
    }
    if (!existsSync(probe)) return null;
    return { version: p.version, root, binDir };
  }

  /** 지난 실행이 끊기며 남긴 임시 폴더를 치운다(설치 중이 아닐 때만 부른다). */
  async cleanupTemp(): Promise<void> {
    if (this.running.size) return;
    await rm(join(this.opts.baseDir, '.tmp'), { recursive: true, force: true }).catch(() => {});
  }

  /** 설치된 판들의 bin 을 PATH 맨 앞에 건다. 앱 시작 때 한 번, 설치 뒤마다 부른다. */
  activate(): string[] {
    const dirs = (['node', 'uv', 'python'] as const)
      .map((c) => this.installed(c)?.binDir)
      .filter((d): d is string => !!d);
    setManagedBinDirs(dirs);
    return dirs;
  }

  // ── 찾기 ──────────────────────────────────────────────────────────

  private async probeVersion(file: string, args: string[]): Promise<string | null> {
    try {
      const r = await runProcess(file, args, {
        timeoutMs: 15_000,
        env: buildChildEnv(await augmentedPath()),
      });
      if (r.code !== 0) return null;
      return versionOf(`${r.stdout}\n${r.stderr}`);
    } catch {
      return null;
    }
  }

  /** 시스템(PATH)에서 찾는다. 앱이 설치한 것은 뺀다. */
  private async findSystem(
    commands: string[],
    versionArgs: string[],
    also: string[] = [],
  ): Promise<RuntimeFound | null> {
    const path = await this.sysPath();
    for (const command of commands) {
      const file = resolveExecutable(command, path);
      if (!file) continue;
      if (also.some((sibling) => !resolveExecutable(sibling, path))) continue;
      const version = await this.probeVersion(file, versionArgs);
      if (version) return { component: 'node', source: 'system', version, path: file };
    }
    return null;
  }

  private managedFound(component: RuntimeComponent): RuntimeFound | null {
    const inst = this.installed(component);
    if (!inst) return null;
    const exe =
      component === 'python'
        ? join(inst.binDir, this.platform === 'win32' ? 'python.exe' : 'python3')
        : join(inst.binDir, this.exe(component === 'node' ? 'node' : 'uv'));
    return { component, source: 'managed', version: inst.version, path: exe };
  }

  private async findNode(min?: string | null): Promise<RuntimeFound | null> {
    const managed = this.managedFound('node');
    if (managed && meets(managed.version, min)) return managed;
    const sys = await this.findSystem(['node'], ['-v'], ['npx']);
    return sys && meets(sys.version, min) ? { ...sys, component: 'node' } : null;
  }

  private async findUv(min?: string | null): Promise<RuntimeFound | null> {
    const managed = this.managedFound('uv');
    if (managed && meets(managed.version, min)) return managed;
    const sys = await this.findSystem(['uv'], ['--version'], ['uvx']);
    return sys && meets(sys.version, min) ? { ...sys, component: 'uv' } : null;
  }

  private async findPython(min?: string | null): Promise<RuntimeFound | null> {
    const managed = this.managedFound('python');
    if (managed && meets(managed.version, min)) return managed;
    const sys = await this.findSystem(['python3', 'python'], ['--version']);
    return sys && meets(sys.version, min) ? { ...sys, component: 'python' } : null;
  }

  private async findDocker(): Promise<{ found: RuntimeFound | null; daemon: boolean }> {
    const path = await this.sysPath();
    const file = resolveExecutable('docker', path);
    if (!file) return { found: null, daemon: false };
    const version = (await this.probeVersion(file, ['--version'])) ?? '';
    let daemon = false;
    try {
      const r = await runProcess(file, ['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 10_000,
        env: buildChildEnv(path),
      });
      daemon = r.code === 0 && !!r.stdout.trim();
    } catch {
      daemon = false;
    }
    return { found: { component: 'docker', source: 'system', version, path: file }, daemon };
  }

  // ── 계획 ──────────────────────────────────────────────────────────

  private pinDownload(pin: RuntimePin): RuntimeDownload | null {
    if (!this.target) return null;
    const asset = pin.assets[this.target];
    return {
      component: pin.kind,
      label: pin.label,
      version: pin.version,
      url: mirrored(`${pin.baseUrl}/${asset.file}`),
      size: asset.size,
    };
  }

  private dockerManual(daemonMissing: boolean): ManualAction {
    const steps =
      this.platform === 'win32'
        ? [
            'Docker Desktop for Windows 를 내려받아 설치합니다.',
            'WSL 2 사용을 허용하고 PC 를 다시 시작합니다.',
            'Docker Desktop 을 실행한 뒤 [다시 확인]을 누릅니다.',
          ]
        : this.platform === 'darwin'
          ? [
              'Docker Desktop for Mac(Apple 칩/Intel 칩 중 내 Mac 에 맞는 것)을 내려받아 응용 프로그램에 넣습니다.',
              'Docker Desktop 을 한 번 실행해 권한을 허용합니다.',
              '[다시 확인]을 누릅니다.',
            ]
          : [
              '배포판 안내에 따라 Docker Engine 을 설치합니다(예: Ubuntu 는 docs.docker.com/engine/install/ubuntu).',
              '`sudo usermod -aG docker $USER` 후 다시 로그인해 sudo 없이 쓸 수 있게 합니다.',
              '`docker info` 가 되는지 확인한 뒤 [다시 확인]을 누릅니다.',
            ];
    return daemonMissing
      ? {
          title: 'Docker 가 실행 중이 아닙니다',
          summary:
            'Docker 는 설치되어 있지만 엔진이 꺼져 있습니다. Docker Desktop(또는 docker 서비스)을 켠 뒤 다시 확인하세요.',
          steps:
            this.platform === 'linux'
              ? ['`sudo systemctl start docker` 로 엔진을 켭니다.', '[다시 확인]을 누릅니다.']
              : [
                  'Docker Desktop 을 실행하고 엔진이 켜질 때까지 기다립니다.',
                  '[다시 확인]을 누릅니다.',
                ],
          url: DOCKER_URL,
        }
      : {
          title: 'Docker 를 직접 설치해야 합니다',
          summary:
            'Docker 는 관리자 권한과 시스템 구성 요소가 필요해 Dexon 이 자동으로 설치할 수 없습니다.',
          steps,
          url: DOCKER_URL,
        };
  }

  /** 이 요구 사항을 지금 만족하는지, 아니라면 무엇을 받아야 하는지. 아무것도 바꾸지 않는다. */
  async plan(
    kindIn: CatalogRuntimeKind,
    minVersion?: string | null,
    command?: string,
  ): Promise<RuntimePlan> {
    const kind = effectiveRuntimeKind(kindIn, command);
    const min = minVersion || undefined;
    const base = {
      kind,
      minVersion: min,
      found: [] as RuntimeFound[],
      downloads: [] as RuntimeDownload[],
    };
    const need = (label: string) => (min ? `${label} ${min} 이상 필요` : `${label} 필요`);
    if (kind === 'none' || kind === 'binary')
      return { ...base, ready: true, summary: '추가 런타임 없음' };
    if (kind === 'docker') {
      const { found, daemon } = await this.findDocker();
      if (found && daemon && meets(found.version, min)) {
        return { ...base, ready: true, found: [found], summary: `Docker ${found.version} 사용` };
      }
      return {
        ...base,
        ready: false,
        found: found ? [found] : [],
        manual: this.dockerManual(!!found && !daemon),
        summary:
          found && !daemon ? 'Docker 실행 필요 — 직접 켜 주세요' : `${need('Docker')} — 직접 설치`,
      };
    }
    if (kind === 'node') {
      const found = await this.findNode(min);
      if (found)
        return {
          ...base,
          ready: true,
          found: [found],
          summary: `Node ${found.version} 사용${found.source === 'managed' ? '(앱 설치)' : ''}`,
        };
      if (!this.target)
        return {
          ...base,
          ready: false,
          unsupported: `이 PC(${this.platform}-${this.arch})에는 Node 를 자동 설치할 수 없습니다.`,
          summary: `${need('Node')} — 직접 설치`,
        };
      if (min && compareLooseVersions(this.pin('node').version, min) < 0) {
        return {
          ...base,
          ready: false,
          unsupported: `이 항목은 Node ${min} 이상이 필요하지만 Dexon 이 설치할 수 있는 판은 ${this.pin('node').version} 입니다.`,
          summary: `${need('Node')} — 직접 설치`,
        };
      }
      return {
        ...base,
        ready: false,
        downloads: [this.pinDownload(this.pin('node'))!],
        summary: `${need('Node')} — 자동 설치(${this.pin('node').version})`,
      };
    }
    // uv · python — 둘 다 uv 가 있어야 한다(python 은 uv 로 설치하고 uv run/uvx 로 돌린다).
    const uvMin = kind === 'uv' ? min : undefined;
    const uv = await this.findUv(uvMin);
    const found: RuntimeFound[] = uv ? [uv] : [];
    const downloads: RuntimeDownload[] = [];
    if (!uv) {
      if (!this.target)
        return {
          ...base,
          ready: false,
          unsupported: `이 PC(${this.platform}-${this.arch})에는 uv 를 자동 설치할 수 없습니다.`,
          summary: `${need(kind === 'uv' ? 'uv' : 'Python')} — 직접 설치`,
        };
      if (uvMin && compareLooseVersions(this.pin('uv').version, uvMin) < 0) {
        return {
          ...base,
          ready: false,
          unsupported: `이 항목은 uv ${uvMin} 이상이 필요하지만 Dexon 이 설치할 수 있는 판은 ${this.pin('uv').version} 입니다.`,
          summary: `${need('uv')} — 직접 설치`,
        };
      }
      downloads.push(this.pinDownload(this.pin('uv'))!);
    }
    if (kind === 'python') {
      const py = await this.findPython(min);
      if (py) found.push(py);
      else {
        downloads.push({
          component: 'python',
          label: 'Python',
          version: this.pythonRequest(min),
          url: 'https://github.com/astral-sh/python-build-standalone/releases (uv python install)',
          size: PYTHON_APPROX_BYTES,
          approximate: true,
        });
      }
    }
    if (!downloads.length) {
      const label =
        kind === 'python'
          ? `Python ${found.find((f) => f.component === 'python')?.version ?? ''}`.trim()
          : `uv ${uv?.version ?? ''}`.trim();
      return { ...base, ready: true, found, summary: `${label} 사용` };
    }
    const what = downloads.map((d) => `${d.label} ${d.version}`).join(' · ');
    return {
      ...base,
      ready: false,
      found,
      downloads,
      summary: `${need(kind === 'uv' ? 'uv' : 'Python')} — 자동 설치(${what})`,
    };
  }

  /** 고정 Python 이 요구 판보다 낮으면 요구 판의 major.minor 를 uv 에 맡긴다. */
  private pythonRequest(min?: string): string {
    if (!min || compareLooseVersions(PYTHON_VERSION, min) >= 0) return PYTHON_VERSION;
    const [major, minor] = min.split('.');
    return `${major}.${minor ?? '0'}`;
  }

  // ── 설치 ──────────────────────────────────────────────────────────

  /** 계획의 downloads 를 차례로 설치한다. 같은 구성 요소는 동시에 한 번만 돈다. */
  async ensure(
    plan: RuntimePlan,
    onProgress: (p: RuntimeProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<RuntimeEnsureResult> {
    if (plan.manual)
      throw new RuntimeInstallError(
        'runtime_manual_required',
        plan.manual.summary,
        plan.kind,
        plan.manual.steps,
      );
    if (plan.unsupported)
      throw new RuntimeInstallError('runtime_unsupported', plan.unsupported, plan.kind);
    const installed: RuntimeEnsureResult['installed'] = [];
    for (const d of plan.downloads) {
      if (signal?.aborted) throw abortError(signal);
      const started = Date.now();
      const version = await this.single(d.component, () =>
        d.component === 'python'
          ? this.installPython(d.version, onProgress, signal)
          : this.installManaged(d.component as ManagedRuntimeKind, onProgress, signal),
      );
      installed.push({ component: d.component, version, durationMs: Date.now() - started });
    }
    return { installed };
  }

  private single<T>(key: string, run: () => Promise<T>): Promise<T> {
    const live = this.running.get(key) as Promise<T> | undefined;
    if (live) return live;
    const p = run().finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  private async fetchText(url: string, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      throw new RuntimeInstallError(
        'download_failed',
        `체크섬 파일을 받지 못했습니다: ${(e as Error).message}`,
      );
    }
    if (!res.ok)
      throw new RuntimeInstallError(
        'download_failed',
        `체크섬 파일을 받지 못했습니다 (HTTP ${res.status}).`,
      );
    return (await res.text()).slice(0, 1024 * 1024);
  }

  /** 공식 체크섬 파일에 적힌 해시가 고정 값과 같은지 — 고정 값이 낡았거나 바꿔치기면 멈춘다. */
  private async crossCheck(
    pin: RuntimePin,
    asset: RuntimeAsset,
    signal?: AbortSignal,
  ): Promise<void> {
    const text = await this.fetchText(mirrored(pin.checksumUrl(asset)), signal);
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+\*?/))
      .find(
        ([hash, name]) =>
          /^[a-f0-9]{64}$/i.test(hash ?? '') &&
          (name === asset.file || name?.endsWith(`/${asset.file}`)),
      );
    if (!line)
      throw new RuntimeInstallError(
        'checksum_mismatch',
        `체크섬 파일에 ${asset.file} 이 없습니다.`,
        pin.kind,
      );
    if (line[0].toLowerCase() !== asset.sha256) {
      throw new RuntimeInstallError(
        'checksum_mismatch',
        `${pin.label} 체크섬이 고정 값과 다릅니다. 설치하지 않았습니다.`,
        pin.kind,
      );
    }
  }

  private async download(
    url: string,
    dest: string,
    asset: RuntimeAsset,
    component: RuntimeComponent,
    onProgress: (p: RuntimeProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const stall = new AbortController();
    const stallMs = this.opts.stallMs ?? 60_000;
    let stallTimer = setTimeout(() => stall.abort(), stallMs);
    const bump = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), stallMs);
    };
    const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
    let res: Response;
    try {
      res = await this.opts.fetch(url, { signal: combined });
    } catch (e) {
      clearTimeout(stallTimer);
      if (signal?.aborted) throw abortError(signal);
      throw new RuntimeInstallError(
        'download_failed',
        `내려받지 못했습니다: ${(e as Error).message}`,
        component,
      );
    }
    if (!res.ok || !res.body) {
      clearTimeout(stallTimer);
      throw new RuntimeInstallError(
        'download_failed',
        `내려받지 못했습니다 (HTTP ${res.status}).`,
        component,
      );
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let lastPercent = -1;
    const file = await open(dest, 'wx');
    const reader = res.body.getReader();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal?.aborted) throw abortError(signal);
          if (stall.signal.aborted)
            throw new RuntimeInstallError(
              'download_failed',
              `${Math.round(stallMs / 1000)}초 동안 받은 데이터가 없어 중단했습니다.`,
              component,
            );
          throw new RuntimeInstallError(
            'download_failed',
            `내려받는 중 끊겼습니다: ${(e as Error).message}`,
            component,
          );
        }
        if (chunk.done) break;
        bump();
        bytes += chunk.value.length;
        if (bytes > asset.size || bytes > RUNTIME_MAX_DOWNLOAD_BYTES) {
          throw new RuntimeInstallError(
            'checksum_mismatch',
            '받은 파일 크기가 고정 값과 다릅니다.',
            component,
          );
        }
        hash.update(chunk.value);
        await file.write(chunk.value);
        const percent = Math.floor((bytes / asset.size) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress({ component, phase: 'download', received: bytes, total: asset.size, percent });
        }
      }
    } finally {
      clearTimeout(stallTimer);
      await file.close();
      await reader.cancel().catch(() => {});
    }
    onProgress({ component, phase: 'verify', percent: 100 });
    if (bytes !== asset.size)
      throw new RuntimeInstallError(
        'checksum_mismatch',
        '받은 파일 크기가 고정 값과 다릅니다.',
        component,
      );
    if (hash.digest('hex') !== asset.sha256) {
      throw new RuntimeInstallError(
        'checksum_mismatch',
        `${component} 파일 무결성(SHA-256) 검증에 실패했습니다. 설치하지 않았습니다.`,
        component,
      );
    }
  }

  private async writePointer(
    component: RuntimeComponent,
    tmpDir: string,
    pointer: Pointer,
  ): Promise<void> {
    const dir = join(this.opts.baseDir, component);
    await mkdir(dir, { recursive: true });
    const staged = join(tmpDir, 'current.json');
    await writeFile(staged, JSON.stringify(pointer));
    await rename(staged, join(dir, 'current.json'));
  }

  private async tempDir(component: string): Promise<string> {
    const dir = join(this.opts.baseDir, '.tmp', `${component}-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Node · uv 를 고정 판으로 설치한다. 성공하면 설치한 판을 돌려준다. */
  async installManaged(
    kind: ManagedRuntimeKind,
    onProgress: (p: RuntimeProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<string> {
    const pin = this.pin(kind);
    if (!this.target)
      throw new RuntimeInstallError(
        'runtime_unsupported',
        `이 PC(${this.platform}-${this.arch})에는 ${pin.label} 을 자동 설치할 수 없습니다.`,
        kind,
      );
    const current = this.installed(kind);
    if (current && current.version === pin.version) {
      this.activate();
      return current.version;
    }
    const asset = pin.assets[this.target];
    const tmp = await this.tempDir(kind);
    try {
      onProgress({
        component: kind,
        phase: 'checksum',
        message: `${pin.label} ${pin.version} 체크섬 확인`,
      });
      await this.crossCheck(pin, asset, signal);
      const archive = join(tmp, asset.file);
      await this.download(
        mirrored(`${pin.baseUrl}/${asset.file}`),
        archive,
        asset,
        kind,
        onProgress,
        signal,
      );
      if (signal?.aborted) throw abortError(signal);
      onProgress({ component: kind, phase: 'extract', message: '압축 풀기' });
      const root = join(tmp, 'root');
      try {
        await safeExtract(archive, root, {
          format: asset.format,
          strip: pin.strip(this.target),
          maxEntries: RUNTIME_MAX_ENTRIES,
          maxExpandedBytes: RUNTIME_MAX_EXPANDED_BYTES,
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        throw new RuntimeInstallError(
          'extract_failed',
          `압축을 풀지 못했습니다: ${(e as Error).message}`,
          kind,
        );
      }
      await rm(archive, { force: true });
      onProgress({ component: kind, phase: 'test', message: `${pin.label} 실행 시험` });
      const probe = join(root, pin.binDir(this.target), pin.probe(this.target));
      let ok = false;
      let detail = '';
      try {
        const r = await runProcess(probe, kind === 'node' ? ['-v'] : ['--version'], {
          timeoutMs: 30_000,
          signal,
        });
        detail = (r.stdout || r.stderr).trim().slice(0, 200);
        ok = r.code === 0 && pin.matches(r.stdout);
      } catch (e) {
        detail = (e as Error).message;
      }
      if (signal?.aborted) throw abortError(signal);
      if (!ok)
        throw new RuntimeInstallError(
          'runtime_test_failed',
          `${pin.label} 시험 실행에 실패했습니다: ${detail || '출력 없음'}`,
          kind,
        );
      onProgress({ component: kind, phase: 'activate', message: '설치 마무리' });
      const directory = `${pin.version}-${randomUUID().slice(0, 8)}`;
      await mkdir(join(this.opts.baseDir, kind), { recursive: true });
      await rename(root, join(this.opts.baseDir, kind, directory));
      await this.writePointer(kind, tmp, { version: pin.version, directory, sha256: asset.sha256 });
      this.activate();
      return pin.version;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** uv 로 Python 을 앱 폴더에 설치한다(uv 는 먼저 준비돼 있어야 한다). */
  async installPython(
    version: string = PYTHON_VERSION,
    onProgress: (p: RuntimeProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<string> {
    const uv = this.managedFound('uv')?.path ?? resolveExecutable('uv', await augmentedPath());
    if (!uv)
      throw new RuntimeInstallError(
        'python_install_failed',
        'Python 을 설치하려면 uv 가 필요합니다.',
        'python',
      );
    const installDir = join(this.opts.baseDir, 'python', 'installs');
    await mkdir(installDir, { recursive: true });
    const env = buildChildEnv(await augmentedPath(), {
      UV_PYTHON_INSTALL_DIR: installDir,
      // 실행 파일 링크를 사용자 ~/.local/bin 이 아니라 앱 폴더에 둔다.
      UV_PYTHON_BIN_DIR: join(this.opts.baseDir, 'python', 'links'),
    });
    onProgress({ component: 'python', phase: 'python', message: `Python ${version} 설치(uv)` });
    const tmp = await this.tempDir('python');
    try {
      const r = await runProcess(uv, ['python', 'install', version], {
        env,
        timeoutMs: 15 * 60_000,
        signal,
        onOutput: (tail) =>
          onProgress({
            component: 'python',
            phase: 'python',
            message: tail.trim().split(/\r?\n/).pop(),
          }),
      });
      if (r.aborted || signal?.aborted) throw abortError(signal);
      if (r.code !== 0) {
        throw new RuntimeInstallError(
          'python_install_failed',
          `Python 설치에 실패했습니다: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' / ')}`,
          'python',
        );
      }
      const found = await runProcess(uv, ['python', 'find', '--managed-python', version], {
        env,
        timeoutMs: 30_000,
      });
      const exe = found.stdout.trim().split(/\r?\n/).pop() ?? '';
      if (found.code !== 0 || !exe || !exe.startsWith(installDir)) {
        throw new RuntimeInstallError(
          'python_install_failed',
          '설치한 Python 을 찾지 못했습니다.',
          'python',
        );
      }
      const ver = await this.probeVersion(exe, ['--version']);
      if (!ver)
        throw new RuntimeInstallError(
          'runtime_test_failed',
          'Python 시험 실행에 실패했습니다.',
          'python',
        );
      // python 폴더 기준 상대 경로로 기록한다: installs/<cpython-…>/bin
      const pythonRoot = join(this.opts.baseDir, 'python');
      const binDir = dirname(exe).slice(pythonRoot.length + 1);
      const [directory, ...rest] = binDir.split(/[\\/]/);
      await this.writePointer('python', tmp, { version: ver, directory, binDir: rest.join('/') });
      this.activate();
      return ver;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
