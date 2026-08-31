import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DexRpcClient, type RpcProcessSpec } from './rpc-client';

export class DexService implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('XGEN Dex');
  readonly rpc: DexRpcClient;

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
    await this.rpc.restart(this.resolveProcess());
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
    const configured = vscode.workspace.getConfiguration('xgenDex').get<string>('cliPath', 'dex').trim();
    let cliPath = configured || 'dex';
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
