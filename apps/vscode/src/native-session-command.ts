import * as vscode from 'vscode';
import type { NativeTrustOverview } from '@dex/protocol/native-platform-session';
import type { ProfileSummary } from '@dex/rpc';
import { NativeSessionController, nativeSessionSummary } from './native-session-controller';
import type { NativeConversationDocument } from './native-conversation-document';
import type { DexService } from './dex-service';

const actions = [
  { label: '기기 등록', action: 'register', device: true }, { label: '기기 승인 요청', action: 'request-approval', device: true },
  { label: '기기 등록 상태', action: 'status', device: true }, { label: '플랫폼 로그인', action: 'login', device: false },
  { label: '플랫폼 세션 상태', action: 'status', device: false }, { label: '플랫폼 세션 갱신', action: 'refresh', device: false },
  { label: '현재 대화 포커스 구독', action: 'watch', device: false },
  { label: '현재 공유 대화 읽기', action: 'conversation', device: false },
  { label: '현재 공유 대화 폴링', action: 'watch-conversation', device: false },
  { label: '대화 폴링 중단', action: 'stop-conversation', device: false },
  { label: '플랫폼 로그아웃', action: 'logout', device: false },
  { label: '중단된 로컬 세션 기록 삭제', action: 'forget-local', device: false },
];
async function credentials(email = true): Promise<{ email?: string; password: string } | null> {
  const address = email ? await vscode.window.showInputBox({ title: 'VSCode 기기·세션 계정', placeHolder: 'me@example.com', ignoreFocusOut: true }) : undefined;
  if (email && !address?.trim()) return null;
  const password = await vscode.window.showInputBox({ title: '현재 계정 비밀번호', password: true, ignoreFocusOut: true });
  return password ? { ...(address ? { email: address.trim() } : {}), password } : null;
}
export async function nativeSessionCommand(service: DexService, controller: NativeSessionController,
  conversationDocument: Pick<NativeConversationDocument, 'show'>): Promise<void> {
  const connection = controller.connectionVersion;
  const current = () => connection === controller.connectionVersion;
  const perform = async (method: 'native/device' | 'native/session', params: Record<string, unknown>) => current() ? controller.perform(method, params) : null;
  try {
    const profiles = await service.request<ProfileSummary[]>('profile/list');
    if (!profiles.length) { await vscode.commands.executeCommand('xgenDex.setupProfile'); return; }
    const profile = profiles.length === 1 ? profiles[0] : (await vscode.window.showQuickPick(profiles.map((p) => ({ label: p.name, detail: p.serverUrl, profile: p })), { title: '기기·세션을 확인할 서버' }))?.profile;
    if (!profile) return;
    const origin = new URL(profile.serverUrl);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
      throw new Error('기기·세션에는 HTTPS origin으로 설정한 서버 프로필이 필요합니다.');
    }
    const choice = await vscode.window.showQuickPick(actions, { title: 'VSCode 기기 및 플랫폼 세션' }); if (!choice) return;
    if (choice.action === 'stop-conversation') { await controller.stopWatch(); await conversationDocument.show(); return; }
    const params: Record<string, unknown> = { profile: profile.name, action: choice.action };
    if (choice.device || choice.action === 'login') {
      const secret = await credentials(); if (!secret) return; Object.assign(params, secret);
      if (choice.action === 'request-approval') {
        const overview = await perform('native/device', { ...params, action: 'approvers' }); if (!overview) return;
        const devices = (overview.result as NativeTrustOverview).trusted_devices.filter((d) => d.platform === 'web');
        if (!devices.length) throw new Error('승인할 신뢰 브라우저가 없습니다. 먼저 브라우저의 내 페이지에서 기기를 등록하세요.');
        const device = await vscode.window.showQuickPick(devices.map((d) => ({ label: d.device_name ?? '브라우저',
          description: d.is_default_approver ? '기본 승인 기기' : undefined, detail: d.device_id, id: d.device_id })), { title: '승인할 브라우저 기기 선택' });
        if (!device) return; params.approver_device_id = device.id;
      }
    } else {
      let userId = controller.account(profile.name, profile.serverUrl);
      if (!userId) {
        const secret = await credentials(); if (!secret) return;
        const identity = await perform('native/device', { profile: profile.name, action: 'status', ...secret });
        if (!identity) return; userId = identity.user_id;
      }
      params.user_id = userId;
      if (choice.action === 'watch') { if (current()) await controller.watch(profile.name, userId); return; }
      if (choice.action === 'conversation') {
        await conversationDocument.show();
        if (current()) await controller.conversation(profile.name, userId);
        return;
      }
      if (choice.action === 'watch-conversation') {
        await conversationDocument.show();
        if (current()) await controller.watchConversation(profile.name, userId);
        return;
      }
      if (choice.action === 'logout') { const secret = await credentials(false); if (!secret) return; params.password = secret.password; }
      if (choice.action === 'forget-local' && await vscode.window.showWarningMessage('로컬 기록만 삭제합니다. 먼저 내 페이지에서 해당 서버 세션을 폐기했는지 확인하세요.',
        { modal: true }, '로컬 기록 삭제') !== '로컬 기록 삭제') return;
    }
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: choice.label, cancellable: true }, async (_progress, token) => {
      const listener = token.onCancellationRequested(() => controller.reset());
      try { return await perform(choice.device ? 'native/device' : 'native/session', params); }
      finally { listener.dispose(); }
    });
    if (!result || !current()) return;
    const summary = nativeSessionSummary(result);
    if (summary?.state === 'active') await controller.watch(result.profile, result.user_id);
    if (result.result && 'confirmation_code' in result.result) {
      await vscode.window.showInformationMessage(`승인 요청을 보냈습니다. 선택한 브라우저의 내 페이지에서 비교 코드 ${result.result.confirmation_code}를 확인하고 승인하세요.`);
    } else if (choice.device) {
      const state = result.result && 'state' in result.result ? result.result.state : '미등록';
      await vscode.window.showInformationMessage(`VSCode 기기 상태: ${state}. 승인 대기 중이면 기기 승인 요청을 실행하세요.`);
    } else await vscode.window.showInformationMessage(`VSCode 플랫폼 세션: ${summary?.state ?? '확인 완료'}`);
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'VSCode 기기·세션 작업을 완료하지 못했습니다.');
  }
}
