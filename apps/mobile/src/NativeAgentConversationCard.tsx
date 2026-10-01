import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, TextInput, View } from 'react-native';
import type { XgenMobileClient } from './lib/xgen';
import { useP } from './theme';
import { createMobileAgentFocusSource } from './lib/native-agent-focus';
import { MobileAgentConversationModel, type MobileConversationModelView } from './lib/native-agent-conversation-model';
import { createMobileAgentMutationSource } from './lib/native-agent-mutation';
import { mobileAgentMutationFetch, mobileTurnKey } from './lib/native-agent-mutation-http-expo';
import { createMobileAgentLiveWatcher } from './lib/native-agent-live-watch';
import { mobileAgentFetch } from './lib/native-agent-http-expo';
import { mobileAgentSocketTransport } from './lib/native-agent-socket-expo';
import { mobileDeviceKeys } from './lib/native-device-key-expo';
import { mobileSessionVault } from './lib/native-session-vault-expo';
import { stripAgentMarkers } from './lib/chat-ws';

const TURN_STATUS = { accepted: '대기', running: '실행 중', completed: '완료', failed: '실패', cancelled: '취소' };
export function NativeAgentConversationCard({ client, visible }: { client: XgenMobileClient; visible: boolean }): React.ReactElement {
  const p = useP(); const owner = useRef<MobileAgentConversationModel | null>(null);
  const [state, setState] = useState<MobileConversationModelView | null>(null); const [unavailable, setUnavailable] = useState('');
  useEffect(() => {
    let live = true; const account = client.nativeAccount(); setState(null); setUnavailable('');
    if (!account) return;
    let source: ReturnType<typeof createMobileAgentFocusSource> | null = null;
    try {
      const current = () => live ? client.nativeAccount() : null; const keys = mobileDeviceKeys(current);
      source = createMobileAgentFocusSource({ current, keys, vault: mobileSessionVault,
        fetch: mobileAgentFetch(account.origin), socket: mobileAgentSocketTransport(account.origin) });
      const writer = createMobileAgentMutationSource({ current, keys, vault: mobileSessionVault, fetch: mobileAgentMutationFetch(account.origin) });
      const selected = source;
      const model = new MobileAgentConversationModel(account, createMobileAgentLiveWatcher(source), writer,
        (value) => { if (live) setState(value); }, mobileTurnKey, () => selected.dispose());
      owner.current = model;
    } catch { source?.dispose(); setUnavailable('공유 대화는 HTTPS 서버와 최신 네이티브 앱에서 사용할 수 있습니다.'); }
    return () => { live = false; owner.current?.dispose(); owner.current = null; };
  }, [client]);
  useEffect(() => {
    const activate = () => owner.current?.setVisible(visible && AppState.currentState === 'active');
    activate(); const listener = AppState.addEventListener('change', activate); return () => listener.remove();
  }, [client, visible]);
  const view = state?.conversation; const busy = Boolean(state?.watching || state?.writing); const hasMore = Boolean(state?.hasMore);
  const available = Boolean(owner.current && state?.visible);
  const button = (label: string, disabled: boolean, action: () => void) => <Pressable accessibilityRole="button" disabled={disabled} onPress={action}
    style={{ padding: 12, borderWidth: 1, borderColor: p.border, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: p.text }}>{label}</Text></Pressable>;
  return <View style={{ padding: 14, marginBottom: 12, borderRadius: 12, backgroundColor: p.panel, gap: 10 }}>
    <Text style={{ color: p.text, fontSize: 16, fontWeight: '700' }}>공유 대화</Text>
    <Text style={{ color: p.muted }}>현재 계정에서 선택한 공유 대화를 확인하고 텍스트를 전송합니다. 다른 기기에서 생성·선택한 대화를 이어 사용할 수 있습니다. 진행 중 출력은 완료 후 표시됩니다.</Text>
    <Text style={{ color: p.text }}>상태: {state?.status ?? '미확인'}</Text>
    {button('현재 공유 대화 조회', !available || busy, () => { void owner.current?.start(true); })}
    {button('대화 변경 구독 시작', !available || busy, () => { void owner.current?.start(false); })}
    {button('조회·구독 중단', !state?.watching || Boolean(state?.writing), () => owner.current?.stopRead())}
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
    <TextInput accessibilityLabel="공유 대화 입력" placeholder="공유 대화에 보낼 내용" placeholderTextColor={p.muted}
      value={state?.draft ?? ''} onChangeText={(value) => owner.current?.setDraft(value)} multiline
      editable={available && Boolean(view?.snapshot) && !state?.writing && !state?.turn.canRetry}
      style={{ minHeight: 88, maxHeight: 240, padding: 12, color: p.text, borderWidth: 1, borderColor: p.border, borderRadius: 8, textAlignVertical: 'top' }} />
    {button('공유 대화 전송', !available || !state?.turn.canSubmit || !state?.draft || Boolean(state?.writing), () => { void owner.current?.submit(); })}
    {button('원래 요청 재확인', !available || !state?.turn.canRetry || Boolean(state?.writing), () => { void owner.current?.retry(); })}
    {button('현재 실행 중단 요청', !available || !state?.turn.canStop || Boolean(state?.writing), () => { void owner.current?.stopTurn(); })}
    {!!state?.turn.notice && <Text accessibilityRole="alert" style={{ color: p.muted }}>{state.turn.notice}</Text>}
    <Text style={{ color: p.muted }}>화면 이탈·백그라운드는 조회와 전송 대기를 취소합니다. 서버 실행 중단은 별도 버튼으로 요청하세요. 돌아오면 직접 대화를 다시 조회하세요. 미확정 요청은 원래 내용·버전으로만 재확인합니다.</Text>
    <Text style={{ color: p.muted }}>텍스트는 UTF-8 262144바이트까지 전송합니다. 첨부와 기기 도구는 아직 지원하지 않습니다. 앱 종료 시 미확정 요청은 보존되지 않습니다.</Text>
    {!!(state?.error || unavailable) && <Text accessibilityRole="alert" style={{ color: p.danger }}>{state?.error || unavailable}</Text>}
  </View>;
}
