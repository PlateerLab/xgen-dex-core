import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, Text, TextInput, View } from 'react-native';
import type { XgenMobileClient } from './lib/xgen';
import { useP } from './theme';
import { createMobilePlatformSession, mobilePlatformMessage, type MobilePlatformSummary } from './lib/native-platform-session';
import { mobileDeviceKeys } from './lib/native-device-key-expo';
import { MobileDeviceKeyError } from './lib/native-device-key';
import { mobileEnrollmentFetch } from './lib/native-enrollment-http-expo';
import { mobileSessionFetch } from './lib/native-session-http-expo';
import { mobileSessionGeneration, mobileSessionVault } from './lib/native-session-vault-expo';

type Controller = ReturnType<typeof createMobilePlatformSession>;
const STATES: Record<MobilePlatformSummary['state'], string> = { unchecked: '미확인', signed_out: '로컬 세션 없음', ready: '저장됨', active: '사용 가능',
  access_expired: 'access 만료 · 갱신 필요', access_unavailable: 'access 미발급 · 갱신 필요', login_pending: '로그인 결과 확인 필요',
  refreshing: '갱신 결과 확인 필요', logout_pending: '폐기 결과 확인 필요', pending_takeover: '다른 기기의 세션 인계 대기' };
export function NativePlatformSessionCard({ client, visible }: { client: XgenMobileClient; visible: boolean }): React.ReactElement {
  const p = useP(); const owner = useRef<Controller | null>(null); const running = useRef<Controller | null>(null);
  const [controller, setController] = useState<Controller | null>(null); const [state, setState] = useState<MobilePlatformSummary | null>(null);
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const reset = () => { owner.current?.dispose(); owner.current = null; running.current = null; setController(null); setState(null); setPassword(''); setBusy(false); setError(''); };
    const activate = () => {
      reset(); if (!live || !visible || AppState.currentState !== 'active') return;
      const account = client.nativeAccount(); if (!account) return;
      try {
        const current = () => live && visible && AppState.currentState === 'active' ? client.nativeAccount() : null;
        const selected = createMobilePlatformSession({ current, keys: mobileDeviceKeys(current), vault: mobileSessionVault, generation: mobileSessionGeneration,
          enrollmentFetch: mobileEnrollmentFetch(account.origin), sessionFetch: mobileSessionFetch(account.origin) });
        owner.current = selected; setController(selected); setState(selected.snapshot());
      } catch { setError('휴대폰 세션은 HTTPS 서버와 지원되는 네이티브 앱에서 사용할 수 있습니다.'); }
    };
    activate(); const listener = AppState.addEventListener('change', (next) => next === 'active' ? activate() : reset());
    return () => { live = false; owner.current?.dispose(); owner.current = null; running.current = null; listener.remove(); };
  }, [client, visible]);
  const run = (action: 'inspect' | 'login' | 'refresh' | 'logout' | 'forget', expected = owner.current) => {
    if (!expected || expected !== owner.current || busy || running.current) return;
    const entered = password; setPassword(''); running.current = expected; setBusy(true); setError('');
    const operation = action === 'inspect' ? expected.inspect() : action === 'login' ? expected.login(entered)
      : action === 'refresh' ? expected.refresh() : action === 'logout' ? expected.logout(entered) : expected.forgetLocal();
    void operation.then((result) => { if (owner.current === expected) setState(result); })
      .catch((e: unknown) => { if (owner.current === expected) { setState(expected.snapshot()); setError(e instanceof MobileDeviceKeyError ? e.message : mobilePlatformMessage(e)); } })
      .finally(() => { if (owner.current === expected) { running.current = null; setBusy(false); } });
  };
  const button = (label: string, action: 'inspect' | 'login' | 'refresh' | 'logout') => <Pressable accessibilityRole="button" disabled={!controller || busy}
    onPress={() => run(action)} style={{ padding: 12, borderWidth: 1, borderColor: p.border, borderRadius: 8, opacity: !controller || busy ? 0.5 : 1 }}>
    <Text style={{ color: p.text }}>{label}</Text>
  </Pressable>;
  return <View style={{ padding: 14, marginBottom: 12, borderRadius: 12, backgroundColor: p.panel, gap: 10 }}>
    <Text style={{ color: p.text, fontSize: 16, fontWeight: '700' }}>휴대폰 세션</Text>
    <Text style={{ color: p.muted }}>휴대폰 등록·브라우저 승인 후 현재 계정 비밀번호로 세션을 발급하세요. 기존 채팅에는 아직 연결되지 않습니다.</Text>
    <Text style={{ color: p.text }}>로컬 상태: {state ? STATES[state.state] : '미확인'}</Text>
    {state?.sessionId && <Text style={{ color: p.muted }}>세션: {state.sessionId.slice(0, 8)} · 만료: {state.accessExpiresAt ?? 'access 없음'}</Text>}
    {button('저장된 세션 상태 확인', 'inspect')}
    <TextInput accessibilityLabel="휴대폰 세션 확인용 현재 계정 비밀번호" value={password} onChangeText={setPassword} secureTextEntry autoCorrect={false}
      autoCapitalize="none" editable={!busy} maxLength={1024} textContentType="none" autoComplete="off"
      style={{ color: p.text, borderWidth: 1, borderColor: p.border, padding: 10, borderRadius: 8 }} />
    {button('비밀번호와 기기 키로 세션 발급', 'login')}
    {button('세션 갱신', 'refresh')}
    {button('비밀번호와 기기 키로 서버 세션 폐기', 'logout')}
    <Text style={{ color: p.muted }}>처리 중·인계 대기 기록이 남으면 PC 내 페이지에서 서버 세션을 먼저 확인·폐기하세요. 로컬 삭제는 서버 세션을 폐기하지 않으며 등록된 기기 키를 유지합니다.</Text>
    <Pressable accessibilityRole="button" disabled={!controller || busy} style={{ padding: 12, borderWidth: 1, borderColor: p.border, borderRadius: 8, opacity: !controller || busy ? 0.5 : 1 }}
      onPress={() => { const selected = owner.current; setPassword(''); Alert.alert('로컬 세션 기록 삭제', '서버 세션은 유지됩니다. PC 내 페이지에서 서버 세션을 확인·폐기한 뒤 로컬 기록을 삭제하세요.',
        [{ text: '취소', style: 'cancel' }, { text: '로컬 기록 삭제', style: 'destructive', onPress: () => run('forget', selected) }]); }}>
      <Text style={{ color: p.text }}>로컬 세션 기록만 삭제</Text>
    </Pressable>
    {busy && <Text style={{ color: p.muted }}>확인 중…</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: p.danger }}>{error}</Text>}
  </View>;
}
