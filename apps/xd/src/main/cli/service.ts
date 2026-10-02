/**
 * CLI 관리 — 감지(캐시)·설치(진행 알림)·로그인(세션)·상태·로그아웃을 한 곳에서. Electron 을 모른다.
 *
 * CLI 마다 XD 전용 홈이 하나다(`<루트>/.xd/cli/<이름>/home`) — 로그인도 하나다. 같은 CLI 계정을 여럿 만들어도 같은
 * 로그인을 쓴다(v1).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectCli, cliVersion, type CliFound, type CliName } from './detect';
import { httpFetcher, installCli, planClaude, planCodex, type Fetcher } from './install';
import { cliLogout, cliStatus, startLogin, type CliStatus, type LoginEvent, type LoginSession } from './login';

export const CLI_NAMES: readonly CliName[] = ['claude', 'codex'];

export type CliEvent =
  | { cli: CliName; type: 'install_progress'; received: number; total: number }
  | { cli: CliName; type: 'login'; event: LoginEvent };

export interface CliState {
  name: CliName;
  installed: CliFound | null;
  login: CliStatus | null;
  /** 로그인 중이면 true. */
  loggingIn: boolean;
}

export interface CliServiceOptions {
  /** `<루트>/.xd/cli` */
  cliDir: string;
  /** 로그인 셸로 보강한 PATH. */
  pathStr: () => Promise<string>;
  emit: (event: CliEvent) => void;
  fetcher?: Fetcher;
  /** 시험이 바꾼다 — 실행 파일의 판 읽기. */
  version?: (path: string) => Promise<string | null>;
}

export class CliService {
  private found = new Map<CliName, CliFound | null>();
  private logins = new Map<CliName, LoginSession>();

  constructor(private readonly opts: CliServiceOptions) {}

  home(name: CliName): string {
    const home = join(this.opts.cliDir, name, 'home');
    mkdirSync(home, { recursive: true });
    return home;
  }

  /** 마지막으로 찾은 실행 파일(턴 설정이 부른다 — 프로세스를 띄우지 않는다). */
  binary(name: CliName): string | null {
    return this.found.get(name)?.path ?? null;
  }

  async detect(name: CliName, refresh = false): Promise<CliFound | null> {
    if (!refresh && this.found.has(name)) return this.found.get(name) ?? null;
    const result = await detectCli(name, {
      cliDir: this.opts.cliDir,
      pathStr: await this.opts.pathStr(),
      version: this.opts.version,
    });
    this.found.set(name, result);
    return result;
  }

  async state(name: CliName): Promise<CliState> {
    const installed = await this.detect(name);
    const login = installed ? await cliStatus(name, { binary: installed.path, home: this.home(name) }).catch(() => null) : null;
    return { name, installed, login, loggingIn: this.logins.has(name) };
  }

  /** 공식 배포처에서 받아 XD 의 자리에 둔다. 그 뒤로는 XD 의 것을 먼저 쓴다. */
  async install(name: CliName): Promise<CliFound> {
    const fetcher = this.opts.fetcher ?? httpFetcher;
    const plan = name === 'claude' ? await planClaude(fetcher) : await planCodex(fetcher);
    const done = await installCli(plan, {
      cliDir: this.opts.cliDir,
      fetcher,
      verify: this.opts.version ?? ((p) => cliVersion(p)),
      onProgress: (received, total) => this.opts.emit({ cli: name, type: 'install_progress', received, total }),
    });
    const found: CliFound = { name, path: done.path, version: done.version, source: 'xd' };
    this.found.set(name, found);
    return found;
  }

  /** 로그인을 시작한다 — 주소·코드·끝은 `emit` 으로. 이미 하는 중이면 그것을 끝내고 새로 시작한다. */
  async login(name: CliName): Promise<void> {
    const installed = await this.detect(name);
    if (!installed) throw new Error(`${name} is not installed`);
    this.logins.get(name)?.cancel();
    const session = startLogin(name, { binary: installed.path, home: this.home(name) }, (event) =>
      this.opts.emit({ cli: name, type: 'login', event }),
    );
    this.logins.set(name, session);
    void session.finished.finally(() => {
      if (this.logins.get(name) === session) this.logins.delete(name);
    });
  }

  submitLoginCode(name: CliName, code: string): void {
    const session = this.logins.get(name);
    if (!session) throw new Error(`no ${name} login in progress`);
    session.submit(code);
  }

  cancelLogin(name: CliName): void {
    this.logins.get(name)?.cancel();
  }

  async logout(name: CliName): Promise<void> {
    const installed = await this.detect(name);
    if (installed) await cliLogout(name, { binary: installed.path, home: this.home(name) });
  }
}
