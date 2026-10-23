import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const compiled = readFile(new URL('../src/extension.ts', import.meta.url), 'utf8')
  .then((source) => transformSync(source, { loader: 'ts', format: 'cjs' }).code);
const reloadCommand = 'workbench.action.reloadWindow';

async function harness(options: {
  inputs?: ReadonlyArray<string | undefined>;
  confirmLogout?: boolean;
  authFailure?: boolean;
  reloadFailure?: boolean;
  setup?: boolean;
} = {}) {
  const events: string[] = [];
  const errors: string[] = [];
  const commands = new Map<string, () => Promise<void>>();
  const inputs = [...(options.inputs ?? ['me@example.com', 'secret'])];
  let hasProfile = !options.setup;
  const profile = { name: 'default', current: true, serverUrl: 'https://example.com' };
  const disposable = { dispose() {} };
  class Service {
    async findCli() { return {}; }
    profileParams() { return { profile: 'default' }; }
    async request(method: string) {
      events.push(method);
      if (method === 'profile/list') return hasProfile ? [profile] : [];
      if (method === 'profile/set') hasProfile = true;
      if (method === 'auth/login' || method === 'auth/logout') {
        if (options.authFailure) throw new Error('auth failed');
      }
      return { authenticated: true, profile: 'default', user: { username: 'me' } };
    }
  }
  class Chat {
    async refreshSession() {}
    async connectionChanged() {}
  }
  const vscode = {
    StatusBarAlignment: { Right: 1 },
    ProgressLocation: { Notification: 1 },
    ConfigurationTarget: { Global: 1 },
    window: {
      createStatusBarItem: () => ({ show() {} }),
      registerWebviewViewProvider: () => disposable,
      showInputBox: async () => inputs.shift(),
      showWarningMessage: async () => options.confirmLogout ? '로그아웃' : undefined,
      showInformationMessage: (message: string) => {
        if (message.includes('연결을 저장했습니다.')) return Promise.resolve('로그인');
        events.push('notification');
        // 사용자가 알림을 닫지 않아도 재시작해야 한다.
        return new Promise(() => {});
      },
      showErrorMessage: async (message: string) => { errors.push(message); },
      withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
    },
    workspace: {
      getConfiguration: () => ({
        update: async () => { events.push('profile-saved'); },
      }),
      onDidChangeConfiguration: () => disposable,
    },
    commands: {
      registerCommand: (name: string, callback: () => Promise<void>) => {
        commands.set(name, callback);
        return disposable;
      },
      executeCommand: async (name: string) => {
        events.push(name);
        if (options.reloadFailure) throw new Error('reload failed');
      },
    },
  };
  const module: { exports: { activate?: (context: unknown) => void } } = { exports: {} };
  runInNewContext(await compiled, {
    exports: module.exports,
    module,
    require: (name: string) => {
      if (name === 'vscode') return vscode;
      if (name === './dex-service') return { DexService: Service };
      if (name === './chat-view-provider') return { ChatViewProvider: Chat };
      if (name === '@dex/rpc/client') return { DexRpcError: class extends Error {} };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  module.exports.activate!({ subscriptions: [] });
  await new Promise((resolve) => setImmediate(resolve));
  events.length = 0;
  return {
    events,
    errors,
    run: (command: string) => commands.get(command)!(),
  };
}

test('login saves the profile before reloading without waiting for notification dismissal', async () => {
  const app = await harness();
  await app.run('xgenDex.login');
  assert.ok(app.events.indexOf('auth/login') < app.events.indexOf('profile-saved'));
  assert.ok(app.events.indexOf('profile-saved') < app.events.indexOf(reloadCommand));
  assert.equal(app.events.filter((event) => event === reloadCommand).length, 1);
});

test('confirmed logout reloads only after the auth request completes', async () => {
  const app = await harness({ confirmLogout: true });
  await app.run('xgenDex.logout');
  assert.ok(app.events.indexOf('auth/logout') < app.events.indexOf(reloadCommand));
  assert.equal(app.events.filter((event) => event === reloadCommand).length, 1);
});

test('login from initial profile setup also reloads exactly once', async () => {
  const app = await harness({ setup: true, inputs: ['default', 'https://example.com', 'me@example.com', 'secret'] });
  await app.run('xgenDex.setupProfile');
  assert.ok(app.events.includes('auth/login'));
  assert.equal(app.events.filter((event) => event === reloadCommand).length, 1);
});

test('cancelled or failed authentication does not reload', async () => {
  for (const [command, options] of [
    ['xgenDex.login', { inputs: [undefined] }],
    ['xgenDex.login', { inputs: ['me@example.com', undefined] }],
    ['xgenDex.logout', { confirmLogout: false }],
    ['xgenDex.login', { authFailure: true }],
    ['xgenDex.logout', { confirmLogout: true, authFailure: true }],
  ] as const) {
    const app = await harness(options);
    await app.run(command);
    assert.ok(!app.events.includes(reloadCommand), command);
  }
});

test('reload failure reports a restart error without claiming authentication failed', async () => {
  const app = await harness({ reloadFailure: true });
  await app.run('xgenDex.login');
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0], /인증 상태는 변경했지만 확장을 다시 시작하지 못했습니다/);
});
