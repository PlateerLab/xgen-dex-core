import * as vscode from 'vscode';
import type { NativeTrustOverview } from '@dex/protocol/native-platform-session';
import { parseCapabilityApprovals, parseCapabilityCatalog } from '@dex/protocol/agent-capabilities';
import type { NativeRpcResult, ProfileSummary } from '@dex/rpc';
import { NativeSessionController, nativeSessionSummary } from './native-session-controller';
import { NativeCapabilityController, nativeCapabilityArgumentDisplay,
  type NativeCapabilityConfirmation } from './native-capability-controller';
import type { NativeConversationDocument } from './native-conversation-document';
import type { DexService } from './dex-service';

const actions = [
  { label: '기기 등록', action: 'register', device: true }, { label: '기기 승인 요청', action: 'request-approval', device: true },
  { label: '기기 등록 상태', action: 'status', device: true }, { label: '플랫폼 로그인', action: 'login', device: false },
  { label: '플랫폼 세션 상태', action: 'status', device: false }, { label: '플랫폼 세션 갱신', action: 'refresh', device: false },
  { label: '현재 대화 포커스 구독', action: 'watch', device: false },
  { label: '현재 공유 대화 읽기', action: 'conversation', device: false },
  { label: '현재 공유 대화 HTTP 폴링', action: 'watch-conversation', device: false },
  { label: '현재 공유 대화 실시간 연결', action: 'watch-live', device: false },
  { label: '현재 Agent Session capability 선택', action: 'select-capabilities', device: false },
  { label: '현재 Agent Session capability 승인 가져오기', action: 'adopt-capability', device: false },
  { label: '이 기기의 capability 연결 시작', action: 'connect-capabilities', device: false },
  { label: '이 기기의 capability 연결 상태', action: 'capability-status', device: false },
  { label: '이 기기의 capability 연결 중단', action: 'disconnect-capabilities', device: false },
  { label: '대화 연결·폴링 중단', action: 'stop-conversation', device: false },
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
  conversationDocument: Pick<NativeConversationDocument, 'show'>,
  capabilities: NativeCapabilityController): Promise<void> {
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
      if (choice.action === 'watch-live') {
        await conversationDocument.show();
        if (current()) await controller.watchLive(profile.name, userId);
        return;
      }
      if (choice.action === 'select-capabilities' || choice.action === 'adopt-capability') {
        const target = controller.capabilityTarget();
        if (!target || target.profile !== profile.name || target.userId !== userId) {
          throw new Error('먼저 이 프로필의 현재 공유 대화를 읽거나 연결해 정확한 Agent Session을 확인하세요.');
        }
        const targetCurrent = () => {
          const latest = controller.capabilityTarget();
          return current() && latest?.profile === target.profile && latest.userId === target.userId
            && latest.agentSessionId === target.agentSessionId;
        };
        if (choice.action === 'select-capabilities') {
          const result = await service.request<NativeRpcResult>('native/capabilities', {
            profile: profile.name, user_id: userId, agent_session_id: target.agentSessionId,
          });
          if (!targetCurrent() || !result.capability_catalog) return;
          const catalog = parseCapabilityCatalog(result.capability_catalog);
          const selected = new Set(catalog.selected_capability_ids);
          const picks = await vscode.window.showQuickPick(catalog.capabilities.map((item) => ({
            label: `${item.server} · ${item.name}`,
            description: item.device_id,
            detail: item.description,
            picked: selected.has(item.capability_id),
            capabilityId: item.capability_id,
          })), { title: '현재 Agent Session에서 사용할 capability', canPickMany: true });
          if (!picks || !targetCurrent()) return;
          await service.request('native/select-capabilities', {
            profile: profile.name, user_id: userId, agent_session_id: target.agentSessionId,
            expected_auth_scope: result.capability_catalog.authScope,
            capability_ids: picks.map((item) => item.capabilityId), expected_version: catalog.version,
          });
          if (!targetCurrent()) return;
          await vscode.window.showInformationMessage('현재 Agent Session의 capability 선택을 저장했습니다.');
          return;
        }
        const scoped = await service.request<NativeRpcResult>('native/capabilities', {
          profile: profile.name, user_id: userId, agent_session_id: target.agentSessionId,
        });
        if (!targetCurrent() || !scoped.capability_catalog) return;
        const result = await service.request<NativeRpcResult>('native/capability-approvals', {
          profile: profile.name, user_id: userId, agent_session_id: target.agentSessionId,
          expected_auth_scope: scoped.capability_catalog.authScope,
        });
        if (!targetCurrent() || !result.capability_approvals) return;
        const approvals = parseCapabilityApprovals(result.capability_approvals).approvals
          .filter((item) => item.status === 'approved');
        if (!approvals.length) {
          await vscode.window.showInformationMessage('이 Agent Session에서 가져올 승인된 capability 요청이 없습니다.');
          return;
        }
        const approval = await vscode.window.showQuickPick(approvals.map((item) => ({
          label: item.tool_name,
          description: `요청 ${item.approval_id}`,
          detail: `${item.capability_id}\nargs sha256: ${item.args_sha256}`,
          approval: item,
        })), { title: '현재 Agent Session으로 가져올 승인 요청' });
        if (!approval || !targetCurrent()) return;
        await service.request('native/adopt-capability-approval', {
          profile: profile.name, user_id: userId, agent_session_id: target.agentSessionId,
          approval_id: approval.approval.approval_id, expected_version: approval.approval.intent_version,
          expected_auth_scope: scoped.capability_catalog.authScope,
        });
        if (!targetCurrent()) return;
        await vscode.window.showInformationMessage('선택한 capability 승인을 현재 Agent Session으로 가져왔습니다.');
        return;
      }
      if (choice.action === 'connect-capabilities') {
        const snapshot = await capabilities.connect(profile.name, userId);
        if (snapshot && current()) await vscode.window.showInformationMessage(`이 기기의 capability 연결: ${snapshot.state}`);
        return;
      }
      if (choice.action === 'capability-status') {
        const snapshot = await capabilities.status(profile.name, userId);
        if (snapshot && current()) await vscode.window.showInformationMessage(`이 기기의 capability 연결: ${snapshot.state}`);
        return;
      }
      if (choice.action === 'disconnect-capabilities') {
        await capabilities.disconnect(profile.name, userId);
        if (current()) await vscode.window.showInformationMessage('이 기기의 capability 연결을 중단했습니다.');
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
    if (['login', 'logout', 'refresh', 'forget-local'].includes(choice.action)) capabilities.reset(false);
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

export async function confirmNativeCapability(request: NativeCapabilityConfirmation): Promise<boolean> {
  const maximum = 6000;
  const encoded = nativeCapabilityArgumentDisplay(request.args, maximum);
  if (encoded === null) {
    await vscode.window.showWarningMessage(`${request.server} · ${request.tool} 요청을 확인할 수 없어 거부했습니다.`,
      { modal: true, detail: `인수를 안전하게 전부 표시할 수 없거나 ${maximum}자 표시 한도를 초과했습니다. 요청을 거부합니다.\nsha256 ${request.argsSha256}` });
    return false;
  }
  const allow = '이번 요청 허용';
  const answer = await vscode.window.showWarningMessage(
    `${request.server} · ${request.tool} 실행을 허용할까요?`,
    { modal: true, detail: `도구: ${request.server}.${request.tool}\n인수:\n${encoded}` },
    allow,
  );
  return answer === allow;
}
