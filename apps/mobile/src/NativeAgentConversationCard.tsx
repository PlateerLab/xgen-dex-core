import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import type { XgenMobileClient } from './lib/xgen';
import { useP } from './theme';
import { createMobileAgentFocusSource } from './lib/native-agent-focus';
import { createMobileAgentConversationWatcher, type MobileConversationView } from './lib/native-agent-conversation-watch';
import { MobileFocusWatchError } from './lib/native-agent-focus-watch';
import { mobileAgentFetch } from './lib/native-agent-http-expo';
import { mobileDeviceKeys } from './lib/native-device-key-expo';
import { mobileSessionVault } from './lib/native-session-vault-expo';
import { stripAgentMarkers } from './lib/chat-ws';

type Owner = { source: ReturnType<typeof createMobileAgentFocusSource>; watcher: ReturnType<typeof createMobileAgentConversationWatcher> };
const TURN_STATUS = { accepted: '대기', running: '실행 중', completed: '완료', failed: '실패', cancelled: '취소' };
export function NativeAgentConversationCard({ client, visible }: { client: XgenMobileClient; visible: boolean }): React.ReactElement {
  const p = useP(); const owner = useRef<Owner | null>(null); const running = useRef<AbortController | null>(null);
  const [available, setAvailable] = useState(false); const [busy, setBusy] = useState(false); const [view, setView] = useState<MobileConversationView | null>(null);
  const [status, setStatus] = useState('미확인'); const [error, setError] = useState(''); const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    let live = true;
    const reset = () => { running.current?.abort(); running.current = null; owner.current?.source.dispose(); owner.current = null;
      setAvailable(false); setBusy(false); setView(null); setHasMore(false); setStatus('미확인'); setError(''); };
    const activate = () => {
      reset(); if (!live || !visible || AppState.currentState !== 'active') return;
      const account = client.nativeAccount(); if (!account) return;
      try {
        const current = () => live && visible && AppState.currentState === 'active' ? client.nativeAccount() : null;
        const source = createMobileAgentFocusSource({ current, keys: mobileDeviceKeys(current), vault: mobileSessionVault, fetch: mobileAgentFetch(account.origin) });
        owner.current = { source, watcher: createMobileAgentConversationWatcher(source) }; setAvailable(true);
      } catch { setError('공유 대화는 HTTPS 서버와 지원되는 네이티브 앱에서 사용할 수 있습니다.'); }
    };
    activate(); const listener = AppState.addEventListener('change', (next) => next === 'active' ? activate() : reset());
    return () => { live = false; running.current?.abort(); running.current = null; owner.current?.source.dispose(); owner.current = null; listener.remove(); };
  }, [client, visible]);
  const start = (once: boolean) => {
    const selected = owner.current; if (!selected || running.current) return;
    const control = new AbortController(); running.current = control; setBusy(true); setView(null); setError(''); setStatus('조회 중…');
    void selected.watcher.run((update) => {
      if (owner.current !== selected || running.current !== control || AppState.currentState !== 'active') return;
      if (update.type === 'value') { setView(update.value); setHasMore(update.hasMore); setStatus(update.hasMore ? once ? '일부 조회 완료 · 구독을 시작하면 이어서 조회합니다' : '기록을 이어서 불러오는 중' : once ? '조회 완료' : '변경 확인 중'); }
      else { setView(null); setStatus(update.type === 'reset' ? '조회 중…' : update.type === 'reconnecting' ? `${update.retryInMs / 1000}초 후 재연결` : '조회 중단'); }
    }, control.signal, once).catch((e: unknown) => {
      if (owner.current === selected && running.current === control) { setView(null); setError(e instanceof MobileFocusWatchError && e.code === 'authentication'
        ? '휴대폰 세션이 만료되었거나 접근이 변경되었습니다. 세션을 확인·갱신한 뒤 다시 조회하세요.'
        : '공유 대화를 확인하지 못했습니다. 기기 키·세션과 서버 상태를 확인한 뒤 다시 조회하세요.'); }
    }).finally(() => { if (owner.current === selected && running.current === control) { running.current = null; setBusy(false); } });
  };
  const button = (label: string, disabled: boolean, action: () => void) => <Pressable accessibilityRole="button" disabled={disabled} onPress={action}
    style={{ padding: 12, borderWidth: 1, borderColor: p.border, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: p.text }}>{label}</Text></Pressable>;
  return <View style={{ padding: 14, marginBottom: 12, borderRadius: 12, backgroundColor: p.panel, gap: 10 }}>
    <Text style={{ color: p.text, fontSize: 16, fontWeight: '700' }}>공유 대화 보기</Text>
    <Text style={{ color: p.muted }}>현재 계정의 Agent 대화와 확인된 완결 메시지를 조회합니다. 전체 과거 이력은 추가 확인이 필요합니다.</Text>
    <Text style={{ color: p.text }}>상태: {status}</Text>
    {button('현재 공유 대화 조회', !available || busy, () => start(true))}
    {button('대화 변경 구독 시작', !available || busy, () => start(false))}
    {button('조회·구독 중단', !busy, () => { running.current?.abort(); setView(null); setStatus('조회 중단'); })}
    {view && !view.snapshot && <Text style={{ color: p.muted }}>{hasMore ? '대화 선택 기록을 확인하고 있습니다.' : '현재 공유 Agent 대화가 없습니다.'}</Text>}
    {view?.snapshot && <>
      <Text style={{ color: p.text, fontWeight: '700' }}>{view.snapshot.title || '공유 대화'}</Text>
      <Text style={{ color: p.muted }}>실행 상태: {view.snapshot.latest_turn ? TURN_STATUS[view.snapshot.latest_turn.status] : '확인된 실행 없음'}</Text>
      {view.omittedMessages > 0 && <Text style={{ color: p.muted }}>화면 크기 제한으로 오래된 {view.omittedMessages}개 턴을 생략했습니다.</Text>}
      {!view.messages.length && <Text style={{ color: p.muted }}>확인된 완결 메시지가 없습니다. 진행 중 출력은 완료 후 표시됩니다.</Text>}
      {view.messages.map((m) => <View key={`${m.turn_id}:${m.sequence}`} style={{ gap: 6, borderTopWidth: 1, borderColor: p.border, paddingTop: 10 }}>
        <Text style={{ color: p.muted }}>{m.source === 'subagent_report' ? '에이전트 보고' : m.source === 'user' ? '사용자' : '출처 미확인'} · {TURN_STATUS[m.status]}</Text>
        <Text selectable style={{ color: p.text }}>{m.input_text === null ? '질문 내용을 확인할 수 없습니다.' : stripAgentMarkers(m.input_text)}</Text>
        <Text selectable style={{ color: p.text }}>{m.output_text === null ? '답변 내용을 확인할 수 없습니다.' : stripAgentMarkers(m.output_text)}</Text>
        {!m.content_complete && <Text style={{ color: p.muted }}>일부 내용을 확인할 수 없습니다.</Text>}
      </View>)}
    </>}
    <Text style={{ color: p.muted }}>화면 이탈·백그라운드·인증 만료 시 표시와 구독을 지웁니다. 돌아오면 직접 다시 시작하세요.</Text>
    {!!error && <Text accessibilityRole="alert" style={{ color: p.danger }}>{error}</Text>}
  </View>;
}
