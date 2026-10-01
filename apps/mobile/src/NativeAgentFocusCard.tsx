import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import type { AgentFocus } from '@dex/protocol/agent-session';
import type { XgenMobileClient } from './lib/xgen';
import { useP } from './theme';
import { createMobileAgentFocusSource } from './lib/native-agent-focus';
import { createMobileAgentFocusWatcher, mobileFocusMessage } from './lib/native-agent-focus-watch';
import { mobileAgentFetch } from './lib/native-agent-http-expo';
import { mobileDeviceKeys } from './lib/native-device-key-expo';
import { mobileSessionVault } from './lib/native-session-vault-expo';

type Owner = { source: ReturnType<typeof createMobileAgentFocusSource>; watcher: ReturnType<typeof createMobileAgentFocusWatcher> };
export function NativeAgentFocusCard({ client, visible }: { client: XgenMobileClient; visible: boolean }): React.ReactElement {
  const p = useP(); const owner = useRef<Owner | null>(null); const run = useRef<AbortController | null>(null);
  const [available, setAvailable] = useState(false); const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<AgentFocus | null>(null); const [status, setStatus] = useState('미확인'); const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const reset = () => { run.current?.abort(); run.current = null; owner.current?.source.dispose(); owner.current = null;
      setAvailable(false); setBusy(false); setFocus(null); setStatus('미확인'); setError(''); };
    const activate = () => {
      reset(); if (!live || !visible || AppState.currentState !== 'active') return;
      const account = client.nativeAccount(); if (!account) return;
      try {
        const current = () => live && visible && AppState.currentState === 'active' ? client.nativeAccount() : null;
        const source = createMobileAgentFocusSource({ current, keys: mobileDeviceKeys(current), vault: mobileSessionVault, fetch: mobileAgentFetch(account.origin) });
        owner.current = { source, watcher: createMobileAgentFocusWatcher(source) }; setAvailable(true);
      } catch { setError('Agent 포커스는 HTTPS 서버와 지원되는 네이티브 앱에서 사용할 수 있습니다.'); }
    };
    activate(); const listener = AppState.addEventListener('change', (next) => next === 'active' ? activate() : reset());
    return () => { live = false; run.current?.abort(); run.current = null; owner.current?.source.dispose(); owner.current = null; listener.remove(); };
  }, [client, visible]);
  const start = (once: boolean) => {
    const selected = owner.current; if (!selected || run.current) return;
    const control = new AbortController(); run.current = control; setBusy(true); setError(''); setFocus(null); setStatus('조회 중…');
    void selected.watcher.run((update) => {
      if (owner.current !== selected || run.current !== control || AppState.currentState !== 'active') return;
      if (update.type === 'focus') { setFocus(update.focus); setStatus(once ? '조회 완료' : `구독 중 · ${update.source}`); }
      else { setFocus(null); setStatus(update.type === 'reconnecting' ? `${update.retryInMs / 1000}초 후 재연결` : update.type === 'reset' ? '조회 중…' : '구독 중단'); }
    }, control.signal, once).catch((e: unknown) => {
      if (owner.current === selected && run.current === control) { setFocus(null); setError(mobileFocusMessage(e)); }
    }).finally(() => { if (owner.current === selected && run.current === control) { run.current = null; setBusy(false); } });
  };
  const stop = () => { run.current?.abort(); setFocus(null); setStatus('구독 중단'); };
  const button = (label: string, disabled: boolean, action: () => void) => <Pressable accessibilityRole="button" disabled={disabled} onPress={action}
    style={{ padding: 12, borderWidth: 1, borderColor: p.border, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: p.text }}>{label}</Text></Pressable>;
  return <View style={{ padding: 14, marginBottom: 12, borderRadius: 12, backgroundColor: p.panel, gap: 10 }}>
    <Text style={{ color: p.text, fontSize: 16, fontWeight: '700' }}>계정 Agent 포커스</Text>
    <Text style={{ color: p.muted }}>등록·승인된 휴대폰 세션으로 다른 클라이언트와 공유하는 현재 Agent 세션을 확인합니다. 세션 발급·갱신 후 직접 시작하세요.</Text>
    <Text style={{ color: p.text }}>상태: {status}</Text>
    {focus && <Text style={{ color: p.text }}>현재 Agent 세션: {focus.active_agent_session_id ?? '없음'}{'\n'}포커스 버전: {focus.version}</Text>}
    {button('현재 Agent 포커스 조회', !available || busy, () => start(true))}
    {button('포커스 변경 구독 시작', !available || busy, () => start(false))}
    {button('구독 중단', !busy, stop)}
    <Text style={{ color: p.muted }}>화면 이탈·백그라운드에서는 구독이 중단됩니다. 돌아오면 직접 다시 시작하세요. 만료·접근 변경·세션 처리 중에는 세션을 확인한 뒤 다시 조회하세요.</Text>
    {!!error && <Text accessibilityRole="alert" style={{ color: p.danger }}>{error}</Text>}
  </View>;
}
