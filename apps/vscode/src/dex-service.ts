import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DexRpcClient, type RpcProcessSpec } from '@dex/rpc/client';
import { installCli, locateCli, type CliLocation, type InstallOutcome } from './cli-installer';

export class DexService implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('XGEN Dex');
  readonly rpc: DexRpcClient;
  /**
   * 찾아 둔 `dex` 의 절대 경로.
   *
   * VS Code 의 PATH 는 사용자의 셸 PATH 와 다르다 — 깔려 있는데도 `spawn dex
   * ENOENT` 가 나는 흔한 이유다. 한 번 찾으면 그 경로를 쥐고 쓴다.
   */
  private located: CliLocation | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.rpc = new DexRpcClient({
      process: this.resolveProcess(),
      clientVersion: String(context.extension.packageJSON.version ?? '0.1.0'),
      log: (message) => this.output.appendLine(message),
    });
  }

  profileParams(): { profile?: string } {
    const profile = vscode.workspace.getConfiguration('xgenDex').get<string>('profile', '').trim();
    return profile ? { profile } : {};
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.rpc.request<T>(method, params);
  }

  async restart(): Promise<void> {
    this.located = undefined;
    await this.rpc.restart(this.resolveProcess());
  }

  /** 확장의 버전. CLI 도 같은 버전을 쓴다 — 한 태그가 검증된 조합 하나다. */
  cliVersion(): string {
    return String(this.context.extension.packageJSON.version ?? 'latest');
  }

  /** 설정에 적힌 경로. 비어 있으면 알아서 찾으라는 뜻이다. */
  private configuredCliPath(): string {
    return vscode.workspace.getConfiguration('xgenDex').get<string>('cliPath', '').trim();
  }

  /**
   * `dex` 가 어디 있는지 확인한다. 못 찾으면 `undefined`.
   *
   * 찾았으면 절대 경로를 기억해 두고, 다음부터는 그것으로 띄운다.
   */
  async findCli(): Promise<CliLocation | undefined> {
    const located = await locateCli(this.configuredCliPath());
    if (located) this.located = located;
    return located;
  }

  /**
   * CLI 를 확장과 **같은 버전**으로 깐다. 둘은 한 태그에서 함께 검증된 조합이라,
   * 아무 최신이나 끌어오면 확장이 모르는 엔진과 말하게 된다.
   */
  async installCli(): Promise<InstallOutcome> {
    const outcome = await installCli(this.cliVersion(), { log: (line) => this.output.appendLine(line) });
    if (outcome.ok) this.located = outcome.location;
    return outcome;
  }

  showOutput(): void {
    this.output.show(true);
  }

  dispose(): void {
    void this.rpc.stop();
    this.output.dispose();
  }

  async shutdown(): Promise<void> {
    await this.rpc.stop();
  }

  private resolveProcess(): RpcProcessSpec {
    const configured = this.configuredCliPath();
    let cliPath = configured || this.located?.command || 'dex';
    if (cliPath === 'dex' && this.context.extensionMode === vscode.ExtensionMode.Development) {
      const developmentCli = path.resolve(this.context.extensionPath, '..', 'dist', 'cli.js');
      if (fs.existsSync(developmentCli)) cliPath = developmentCli;
    }
    if (cliPath.startsWith('.')) {
      const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionPath;
      cliPath = path.resolve(base, cliPath);
    }
    const extension = path.extname(cliPath).toLowerCase();
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
      return {
        command: 'node',
        args: [cliPath, 'serve', '--stdio'],
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      };
    }
    return {
      command: cliPath,
      args: ['serve', '--stdio'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    };
  }
}
