import React, { useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useP } from './theme';
import type { XgenMobileClient } from './lib/xgen';
import { mobileDeviceKeys } from './lib/native-device-key-expo';
import { MobileDeviceKeyError, type MobileKeyStorage } from './lib/native-device-key';

/** Key readiness is local. It never grants trust or issues a PlatformSession. */
export function NativeDeviceKeyCard({ client, visible }: { client: XgenMobileClient; visible: boolean }): React.ReactElement {
  const p = useP(); const [busy, setBusy] = useState(false); const [storage, setStorage] = useState<MobileKeyStorage | null>(null); const [error, setError] = useState('');
  const [run, setRun] = useState<((create: boolean) => void) | null>(null);
  useEffect(() => {
    let live = true; let active: AbortController | null = null;
    const context = { origin: client.session.serverUrl, userId: client.session.userId, authScope: 'selected-mobile-account' };
    const keys = mobileDeviceKeys(() => live && visible && AppState.currentState === 'active' ? context : null);
    const cancel = () => { active?.abort(); active = null; setBusy(false); setStorage(null); setError(''); };
    const listener = AppState.addEventListener('change', (state) => { if (state !== 'active') cancel(); });
    setRun(() => (create: boolean) => {
      if (active || !visible) return; const controller = new AbortController(); active = controller; setBusy(true); setError('');
      void keys.identity(create, controller.signal).then((identity) => { if (live && !controller.signal.aborted) setStorage(identity.storage); })
        .catch((e: unknown) => { if (live && !controller.signal.aborted) { setStorage(null); setError(e instanceof MobileDeviceKeyError ? e.message : '기기 키를 확인하지 못했습니다.'); } })
        .finally(() => { if (live && active === controller) { active = null; setBusy(false); } });
    });
    cancel();
    return () => { live = false; active?.abort(); listener.remove(); };
  }, [client, visible]);
  const button = { padding: 12, borderRadius: 8, borderWidth: 1, borderColor: p.border, opacity: busy ? 0.5 : 1 };
  return <View style={{ padding: 14, marginBottom: 12, borderRadius: 12, backgroundColor: p.panel, gap: 10 }}>
    <Text style={{ color: p.text, fontSize: 16, fontWeight: '700' }}>기기 보안</Text>
    <Text style={{ color: p.muted }}>이 휴대폰의 인증 키를 준비합니다. 브라우저에서 승인되기 전에는 신뢰 기기가 아닙니다.</Text>
    <Pressable accessibilityRole="button" disabled={busy || !visible} style={button} onPress={() => run?.(false)}><Text style={{ color: p.text }}>기기 키 상태 확인</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={busy || !visible} style={button} onPress={() => run?.(true)}><Text style={{ color: p.text }}>인증 키 준비</Text></Pressable>
    {busy && <Text style={{ color: p.muted }}>확인 중…</Text>}
    {storage && <Text style={{ color: p.ok }}>기기 키 준비됨 · {storage === 'secure-enclave' ? 'Secure Enclave' : storage === 'android-strongbox' ? 'StrongBox' : '보안 하드웨어'}</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: p.danger }}>{error}</Text>}
  </View>;
}
