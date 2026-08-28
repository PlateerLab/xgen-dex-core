import * as vscode from 'vscode';
import { ChatViewProvider } from './chat-view-provider';
import { DexService } from './dex-service';
import type { Agent, AuthStatus, ProfileSummary } from './protocol';
import { DexRpcError } from './rpc-client';

let activeService: DexService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const service = new DexService(context);
  activeService = service;
  const chat = new ChatViewProvider(context, service);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = 'XGEN Dex';
  status.command = 'xgenDex.login';
  status.text = '$(loading~spin) Dex';
  status.tooltip = 'XGEN Dex CLI 엔진에 연결하는 중입니다.';
  status.show();

  const refreshAll = async (): Promise<void> => {
    await Promise.all([chat.refreshSession(), updateStatus(service, status)]);
  };

  context.subscriptions.push(
    service,
    chat,
    status,
    vscode.window.registerWebviewViewProvider('xgenDex.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('xgenDex.refresh', () => refreshAll()),
    vscode.commands.registerCommand('xgenDex.searchAgents', async () => {
      const search = await vscode.window.showInputBox({
        title: 'XGEN Dex Agent 검색',
        prompt: '이름 또는 설명으로 Agent를 검색합니다. 비우면 전체 목록을 표시합니다.',
        placeHolder: '검색어',
      });
      if (search === undefined) return;
      await chat.showAgents(search);
    }),
    vscode.commands.registerCommand('xgenDex.showAgents', () => chat.showAgents()),
    vscode.commands.registerCommand('xgenDex.showSettings', () => chat.showSettings()),
    vscode.commands.registerCommand('xgenDex.openAgent', async (value: unknown) => {
      const agent = resolveAgent(value);
      if (!agent) return;
      await chat.selectAgent(agent);
    }),
    vscode.commands.registerCommand('xgenDex.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('xgenDex.cancelChat', () => chat.cancel()),
    vscode.commands.registerCommand('xgenDex.openHistory', () => chat.openHistory()),
    vscode.commands.registerCommand('xgenDex.setupProfile', async (value?: unknown) => {
      if (await setupProfile(service, profileNameOf(value))) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode.commands.registerCommand('xgenDex.login', async () => {
      if (await login(service)) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode.commands.registerCommand('xgenDex.switchProfile', async (value?: unknown) => {
      if (await switchProfile(service, profileNameOf(value))) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode.commands.registerCommand('xgenDex.logout', async () => {
      if (await logout(service)) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode.commands.registerCommand('xgenDex.restartEngine', async () => {
      await withProgress('dex-cli 엔진을 다시 시작하는 중...', () => service.restart());
      await refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('xgenDex.cliPath')) {
        await service.restart().catch((error: unknown) => showError(service, 'CLI 엔진을 다시 시작하지 못했습니다.', error));
      }
      if (event.affectsConfiguration('xgenDex.cliPath') || event.affectsConfiguration('xgenDex.profile')) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
  );

  void refreshAll();
}

export async function deactivate(): Promise<void> {
  await activeService?.shutdown();
  activeService = undefined;
}

async function updateStatus(service: DexService, status: vscode.StatusBarItem): Promise<void> {
  status.text = '$(loading~spin) Dex';
  status.tooltip = 'XGEN Dex 상태를 확인하는 중입니다.';
  try {
    const profiles = await service.request<ProfileSummary[]>('profile/list');
    if (profiles.length === 0) {
      status.text = '$(tools) Dex 설정';
      status.tooltip = 'XGEN 서버 프로필을 설정하세요.';
      status.command = 'xgenDex.setupProfile';
      return;
    }
    const auth = await service.request<AuthStatus>('auth/status', service.profileParams());
    if (auth.authenticated) {
      status.text = `$(hubot) ${auth.user?.username ?? auth.profile}`;
      status.tooltip = `${auth.profile} · ${auth.serverUrl}`;
      status.command = 'xgenDex.showSettings';
    } else if (auth.reason === 'network') {
      status.text = '$(cloud-off) Dex 오프라인';
      status.tooltip = `${auth.serverUrl}에 연결할 수 없습니다.`;
      status.command = 'xgenDex.restartEngine';
    } else {
      status.text = '$(key) Dex 로그인';
      status.tooltip = `${auth.profile} 프로필에 로그인이 필요합니다.`;
      status.command = 'xgenDex.login';
    }
  } catch (error) {
    status.text = '$(error) Dex CLI';
    status.tooltip = errorMessage(error);
    status.command = 'xgenDex.restartEngine';
  }
}

async function setupProfile(service: DexService, requestedProfile?: string): Promise<boolean> {
  const profiles = await service.request<ProfileSummary[]>('profile/list').catch(() => []);
  const existing = requestedProfile ? profiles.find((profile) => profile.name === requestedProfile) : undefined;
  const name =
    existing?.name ??
    (await vscode.window.showInputBox({
      title: 'XGEN Dex 회사 / 환경 프로필',
      prompt: '회사 또는 연결 환경을 구분할 프로필 이름을 입력하세요.',
      value: 'default',
      validateInput: (value) => (/^[A-Za-z0-9._-]{1,64}$/.test(value) ? undefined : '영문, 숫자, ., _, -만 사용할 수 있습니다.'),
    }));
  if (!name) return false;
  const serverUrl = await vscode.window.showInputBox({
    title: existing ? `${name} 연결 수정` : 'XGEN Gateway 주소',
    prompt: '연결할 HTTPS Gateway URL을 입력하세요.',
    placeHolder: 'https://xgen.example.com',
    value: existing?.serverUrl,
    validateInput: (value) => validateServerUrl(value),
  });
  if (!serverUrl) return false;
  try {
    await withProgress('서버 프로필을 저장하는 중...', async () => {
      await service.request('profile/set', { name, serverUrl });
      await service.request('profile/use', { name });
      await vscode.workspace.getConfiguration('xgenDex').update('profile', name, vscode.ConfigurationTarget.Global);
    });
    const action = await vscode.window.showInformationMessage(
      `${name} 회사 / 환경 연결을 저장했습니다.`,
      ...(existing ? [] : ['로그인']),
    );
    if (action === '로그인') await login(service, name);
    return true;
  } catch (error) {
    await showError(service, '프로필을 저장하지 못했습니다.', error);
    return false;
  }
}

async function login(service: DexService, requestedProfile?: string): Promise<boolean> {
  try {
    let profiles = await service.request<ProfileSummary[]>('profile/list');
    if (profiles.length === 0) return setupProfile(service);
    const configured = requestedProfile || service.profileParams().profile;
    const current = profiles.find((profile) => profile.name === configured) ?? profiles.find((profile) => profile.current) ?? profiles[0];
    if (!current) return false;
    if (!requestedProfile && profiles.length > 1) {
      const selected = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.name,
          description: profile.current ? '현재 프로필' : undefined,
          detail: profile.serverUrl,
          profile,
        })),
        { title: '로그인할 XGEN Dex 프로필' },
      );
      if (!selected) return false;
      profiles = [selected.profile];
    } else {
      profiles = [current];
    }
    const profile = profiles[0];
    if (!profile) return false;
    const email = await vscode.window.showInputBox({
      title: `${profile.name} 로그인`,
      prompt: profile.serverUrl,
      placeHolder: 'me@corp.com',
      ignoreFocusOut: true,
    });
    if (!email?.trim()) return false;
    let password = await vscode.window.showInputBox({
      title: `${profile.name} 로그인`,
      prompt: '비밀번호는 dex-cli 프로세스로만 전달되고 저장되지 않습니다.',
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return false;
    const secret = password;
    password = undefined;
    const auth = await withProgress('XGEN에 로그인하는 중...', () =>
      service.request<AuthStatus>('auth/login', { profile: profile.name, email: email.trim(), password: secret }),
    );
    await vscode.workspace.getConfiguration('xgenDex').update('profile', profile.name, vscode.ConfigurationTarget.Global);
    await vscode.window.showInformationMessage(`${auth.user?.username ?? email} 계정으로 로그인했습니다.`);
    return true;
  } catch (error) {
    await showError(service, '로그인하지 못했습니다.', error);
    return false;
  }
}

async function switchProfile(service: DexService, requestedProfile?: string): Promise<boolean> {
  try {
    const profiles = await service.request<ProfileSummary[]>('profile/list');
    if (profiles.length === 0) return setupProfile(service);
    const requested = requestedProfile ? profiles.find((profile) => profile.name === requestedProfile) : undefined;
    const selected = requested
      ? { profile: requested }
      : await vscode.window.showQuickPick(
          profiles.map((profile) => ({
            label: profile.name,
            description: profile.current ? '현재 프로필' : undefined,
            detail: profile.serverUrl,
            profile,
          })),
          { title: '사용할 회사 / 환경 프로필' },
        );
    if (!selected) return false;
    await service.request('profile/use', { name: selected.profile.name });
    await vscode.workspace.getConfiguration('xgenDex').update('profile', selected.profile.name, vscode.ConfigurationTarget.Global);
    return true;
  } catch (error) {
    await showError(service, '프로필을 전환하지 못했습니다.', error);
    return false;
  }
}

async function logout(service: DexService): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    '현재 XGEN Dex 프로필에서 로그아웃할까요?',
    { modal: true },
    '로그아웃',
  );
  if (choice !== '로그아웃') return false;
  try {
    await service.request('auth/logout', service.profileParams());
    await vscode.window.showInformationMessage('XGEN Dex에서 로그아웃했습니다.');
    return true;
  } catch (error) {
    await showError(service, '로그아웃하지 못했습니다.', error);
    return false;
  }
}

function resolveAgent(value: unknown): Agent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const candidate = (record.agent && typeof record.agent === 'object' ? record.agent : record) as Partial<Agent>;
  return typeof candidate.workflowId === 'string' && typeof candidate.workflowName === 'string'
    ? (candidate as Agent)
    : undefined;
}

function profileNameOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' ? name.trim() || undefined : undefined;
}

function validateServerUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'http 또는 https URL이어야 합니다.';
    return undefined;
  } catch {
    return '올바른 URL을 입력하세요.';
  }
}

async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

async function showError(service: DexService, prefix: string, error: unknown): Promise<void> {
  const action = await vscode.window.showErrorMessage(`${prefix} ${errorMessage(error)}`, '로그 보기');
  if (action === '로그 보기') service.showOutput();
}

function errorMessage(error: unknown): string {
  if (error instanceof DexRpcError && error.engineCode) return `[${error.engineCode}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
