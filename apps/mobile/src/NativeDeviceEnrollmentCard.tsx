import React, { useEffect, useState } from 'react';
import { AppState, Pressable, Text, TextInput, View } from 'react-native';
import type { XgenMobileClient } from './lib/xgen';
import { useP } from './theme';
import { createMobileEnrollment, browserApprovers, mobileEnrollmentMessage, type MobileEnrollmentState } from './lib/native-device-enrollment';
import { mobileDeviceKeys } from './lib/native-device-key-expo';
import { MobileDeviceKeyError } from './lib/native-device-key';
import { mobileEnrollmentFetch } from './lib/native-enrollment-http-expo';

type Controller = ReturnType<typeof createMobileEnrollment>;
const EMPTY: MobileEnrollmentState = { registration: null, overview: null, selectedApproverId: null, approval: null, outcomeUncertain: false };
const TRUST = { pending: '승인 대기', trusted: '신뢰 기기', suspended: '정지됨', revoked: '폐기됨' };
const ENROLLMENT = {
  first_device_available: 'PC 브라우저에서 최초 신뢰 기기를 등록하세요.', first_device_pending: 'PC 브라우저의 최초 등록을 완료하세요.',
  recovery_required: 'PC 브라우저에서 기기 복구를 완료하세요.', migration_required: 'PC 브라우저에서 기존 인증 기기를 이관하세요.', existing_trust: '',
};
export function NativeDeviceEnrollmentCard({ client, visible }: { client: XgenMobileClient; visible: boolean }): React.ReactElement {
  const p = useP(); const [controller, setController] = useState<Controller | null>(null);
  const [state, setState] = useState<MobileEnrollmentState>(EMPTY); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [name, setName] = useState('Mobile');
  const currentController = React.useRef<Controller | null>(null);
  const operationOwner = React.useRef<Controller | null>(null);
  useEffect(() => {
    let live = true; let current: Controller | null = null;
    const reset = () => { current?.dispose(); current = null; currentController.current = null; operationOwner.current = null; setController(null); setState(EMPTY); setBusy(false); setError(''); setName('Mobile'); };
    const activate = () => {
      reset(); if (!visible || !live || AppState.currentState !== 'active') return;
      const account = client.nativeAccount(); if (!account) return;
      try {
        const source = () => live && visible && AppState.currentState === 'active' ? client.nativeAccount() : null;
        current = createMobileEnrollment({ current: source, keys: mobileDeviceKeys(source), fetch: mobileEnrollmentFetch(account.origin) });
        currentController.current = current;
        setController(current);
      } catch { setError('기기 등록은 HTTPS 서버와 지원되는 네이티브 앱에서 사용할 수 있습니다.'); }
    };
    activate();
    const listener = AppState.addEventListener('change', (value) => { if (value === 'active') activate(); else reset(); });
    return () => { live = false; currentController.current = null; operationOwner.current = null; current?.dispose(); listener.remove(); };
  }, [client, visible]);
  const run = (action: 'inspect' | 'register' | 'request') => {
    if (!controller || busy || operationOwner.current) return; const selected = controller; operationOwner.current = selected; setBusy(true); setError('');
    const operation = action === 'inspect' ? selected.inspect() : action === 'register' ? selected.register(name) : selected.requestApproval();
    void operation.then((result) => { if (selected === currentController.current) setState(result); })
      .catch((e: unknown) => { if (selected === currentController.current) { setState(selected.snapshot()); setError(e instanceof MobileDeviceKeyError ? e.message : mobileEnrollmentMessage(e)); } })
      .finally(() => { if (selected === currentController.current) { operationOwner.current = null; setBusy(false); } });
  };
  // Effects replace/dispose the owner on account, screen and app-state changes.
  const button = { padding: 12, borderWidth: 1, borderColor: p.border, borderRadius: 8, opacity: busy || !controller ? 0.5 : 1 };
  const browsers = browserApprovers(state);
  return <View style={{ padding: 14, marginBottom: 12, borderRadius: 12, backgroundColor: p.panel, gap: 10 }}>
    <Text style={{ color: p.text, fontSize: 16, fontWeight: '700' }}>휴대폰 기기 등록</Text>
    <Text style={{ color: p.muted }}>위에서 인증 키를 준비한 뒤 등록하고, 승인할 PC 브라우저를 선택하세요. 기기 등록은 새 로그인 세션을 발급하지 않습니다.</Text>
    <TextInput accessibilityLabel="휴대폰 기기 이름" value={name} onChangeText={setName} editable={!busy} maxLength={80}
      style={{ color: p.text, borderWidth: 1, borderColor: p.border, padding: 10, borderRadius: 8 }} />
    <Pressable accessibilityRole="button" style={button} disabled={!controller || busy} onPress={() => run('register')}><Text style={{ color: p.text }}>이 휴대폰 등록</Text></Pressable>
    <Pressable accessibilityRole="button" style={button} disabled={!controller || busy} onPress={() => run('inspect')}><Text style={{ color: p.text }}>등록·승인 상태 확인</Text></Pressable>
    {state.registration && <Text style={{ color: p.text }}>현재 상태: {TRUST[state.registration.state]}</Text>}
    {state.overview && !state.registration && <Text style={{ color: p.muted }}>현재 상태: 서버 미등록</Text>}
    {state.overview && !!ENROLLMENT[state.overview.enrollment_state] && <Text style={{ color: p.muted }}>{ENROLLMENT[state.overview.enrollment_state]}</Text>}
    {state.overview && browsers.length === 0 && <Text style={{ color: p.muted }}>승인 가능한 신뢰 브라우저가 없습니다.</Text>}
    {browsers.map((browser) => <Pressable key={browser.device_id} accessibilityRole="radio" accessibilityState={{ selected: browser.device_id === state.selectedApproverId }}
      disabled={busy || !controller} onPress={() => { try { if (controller) setState(controller.selectApprover(browser.device_id)); } catch (e) { setError(mobileEnrollmentMessage(e)); } }}
      style={{ padding: 12, borderWidth: 1, borderColor: browser.device_id === state.selectedApproverId ? p.primary : p.border, borderRadius: 8 }}>
      <Text style={{ color: p.text }}>{browser.device_id === state.selectedApproverId ? '● ' : '○ '}{browser.device_name ?? '신뢰 브라우저'}{browser.is_default_approver ? ' · 기본 승인 기기' : ''}</Text>
      <Text style={{ color: p.muted }}>{browser.device_id.slice(0, 8)} · 최근 사용 {browser.last_seen_at ?? browser.registered_at}</Text>
    </Pressable>)}
    {state.overview?.more_trusted_devices && <Text style={{ color: p.muted }}>일부 기기만 표시됩니다. PC 브라우저에서 전체 신뢰 기기를 확인하세요.</Text>}
    {state.registration?.state === 'pending' && <>
      <Text style={{ color: p.muted }}>새 요청을 보내면 이전 승인 요청이 취소됩니다. 표시된 6자리 코드를 선택한 브라우저와 대조한 뒤 그 브라우저에서 승인하세요.</Text>
      <Pressable accessibilityRole="button" style={button} disabled={busy || !controller || !state.selectedApproverId} onPress={() => run('request')}><Text style={{ color: p.text }}>선택한 브라우저에 승인 요청</Text></Pressable>
    </>}
    {state.approval && <Text style={{ color: p.text }}>대조 코드: {state.approval.confirmation_code}\n만료: {state.approval.expires_at}\n브라우저 승인 후 ‘등록·승인 상태 확인’을 누르세요.</Text>}
    {state.outcomeUncertain && <Text style={{ color: p.muted }}>서버에 요청이 반영됐을 수 있습니다. 상태와 브라우저의 요청을 확인하세요. 자동 재시도하지 않습니다.</Text>}
    {busy && <Text style={{ color: p.muted }}>확인 중…</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: p.danger }}>{error}</Text>}
  </View>;
}
