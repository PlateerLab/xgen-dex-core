import React, { useEffect, useRef, useState } from 'react';
import type { NativeTrustOverview } from '@dex/protocol/native-platform-session';
import type { NativeSessionSummary } from '@dex/rpc';
import { xgen } from '../bridge';
import { DesktopNativeSessionModel, type DesktopNativeView } from '../native-session-model';
import { SettingsSection } from './SettingsSection';

const states: Record<string, string> = { pending: '승인 대기', trusted: '승인됨', revoked: '폐기됨', signed_out: '로그아웃', active: '사용 가능',
  access_expired: '갱신 필요', access_unavailable: 'access 발급 대기', login_pending: '로그인 중단', refreshing: '갱신 중단', logout_pending: '로그아웃 중단', pending_takeover: '기존 세션 전환 승인 대기' };
const connections = { idle: '구독 안 함', waiting: '현재 대화 확인 중', connected: '연결됨', reconnecting: '재연결 중', stopped: '인증·연결 확인 필요' };

export const NativeSessionSettings: React.FC<{ origin: string }> = ({ origin }) => {
  const [view, setView] = useState<DesktopNativeView>({ busy: false, result: null, focus: null, conversation: null, hasMore: false, connection: 'idle', error: '' });
  const model = useRef<DesktopNativeSessionModel | null>(null);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [approver, setApprover] = useState(''); const [overview, setOverview] = useState<NativeTrustOverview | null>(null);
  const [message, setMessage] = useState(''); const [forget, setForget] = useState(false);
  useEffect(() => {
    const controller = new DesktopNativeSessionModel(xgen.nativeSession, (next) => {
      setView(next);
      if (!next.result && !next.busy) { setOverview(null); setApprover(''); setMessage(''); setForget(false); setPassword(''); }
    });
    model.current = controller;
    return () => { model.current = null; controller.dispose(); };
  }, [origin]);
  let https = false;
  try { const url = new URL(origin); https = url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password; } catch { /* shown below */ }
  const run = async (kind: 'device' | 'session', action: string) => {
    const controller = model.current; if (!controller) return;
    setMessage(''); const params: Record<string, unknown> = { action };
    if (kind === 'device' || action === 'login') Object.assign(params, { email: email.trim(), password });
    if (action === 'logout') params.password = password;
    if (action === 'request-approval') params.approver_device_id = approver;
    setPassword(''); setForget(false);
    const result = await controller.execute(kind, params);
    if (model.current !== controller || !result) return;
    if (result.result && 'trusted_devices' in result.result) {
      const trusted = result.result; setOverview(trusted);
      const browsers = trusted.trusted_devices.filter((d) => d.platform === 'web');
      setApprover((browsers.find((d) => d.is_default_approver) ?? browsers[0])?.device_id ?? '');
      if (!browsers.length) setMessage('승인할 신뢰 브라우저가 없습니다. 브라우저 내 페이지에서 먼저 기기를 등록하세요.');
    } else if (result.result && 'confirmation_code' in result.result) setMessage(`비교 코드 ${result.result.confirmation_code}. 선택한 브라우저의 내 페이지에서 확인하고 승인하세요.`);
    else if (kind === 'device') setMessage(`Desktop 기기: ${result.result && 'state' in result.result ? states[result.result.state] ?? result.result.state : '미등록'}`);
    else if (action === 'forget-local') setMessage('로컬 기록을 삭제했습니다. 서버 세션 폐기는 별도로 확인하세요.');
    const summary = result.result && 'session_id' in result.result ? result.result as NativeSessionSummary : null;
    if (summary?.state === 'active') await controller.execute('watch');
  };
  const disabled = !https || view.busy;
  const credentials = !email.trim() || !password;
  const summary = view.result?.result && 'session_id' in view.result.result ? view.result.result as NativeSessionSummary : null;
  const completeMessages = view.conversation?.messages.filter((item) => item.content_complete) ?? [];
  const incompleteMessages = (view.conversation?.messages.length ?? 0) - completeMessages.length;
  return <>
    <SettingsSection title="이 PC의 기기 인증">
      <p className="settings-hint">현재 앱에 로그인한 계정으로 이 Desktop 기기를 등록하고 신뢰 브라우저에서 승인받으세요.</p>
      <p className="small muted">서버: {origin || '미설정'}</p>
      {!https && <p className="settings-hint warn">HTTPS origin으로 서버 주소를 설정해야 합니다.</p>}
      <label className="field"><span>현재 계정 이메일</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="field"><span>현재 비밀번호</span><input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <div className="field-row">
        <button disabled={disabled || credentials} onClick={() => void run('device', 'register')}>기기 등록</button>
        <button className="secondary" disabled={disabled || credentials} onClick={() => void run('device', 'status')}>등록 상태 확인</button>
        <button className="secondary" disabled={disabled || credentials} onClick={() => void run('device', 'approvers')}>승인 기기 조회</button>
      </div>
      {overview && <label className="field"><span>승인할 브라우저</span><select value={approver} onChange={(e) => setApprover(e.target.value)} disabled={view.busy}>
        <option value="">기기 선택</option>{overview.trusted_devices.filter((d) => d.platform === 'web').map((d) => <option key={d.device_id} value={d.device_id}>{d.device_name ?? '브라우저'}{d.is_default_approver ? ' (기본)' : ''} · {d.device_id.slice(0, 8)}</option>)}
      </select></label>}
      <button disabled={disabled || credentials || !approver} onClick={() => void run('device', 'request-approval')}>선택 기기에 승인 요청</button>
      <p className="settings-hint">비밀번호는 작업마다 확인하며 입력은 요청 후 지웁니다. 기기 승인이 완료돼도 세션 로그인은 별도로 필요합니다.</p>
    </SettingsSection>
    <SettingsSection title="Desktop 플랫폼 세션">
      <div className="field-row">
        <button disabled={disabled || credentials} onClick={() => void run('session', 'login')}>플랫폼 로그인</button>
        <button className="secondary" disabled={disabled} onClick={() => void run('session', 'status')}>세션 상태</button>
        <button className="secondary" disabled={disabled} onClick={() => void run('session', 'refresh')}>세션 갱신</button>
        <button className="secondary" disabled={disabled || !password} onClick={() => void run('session', 'logout')}>플랫폼 로그아웃</button>
      </div>
      <p>세션: {summary ? states[summary.state] ?? summary.state : '상태를 확인하세요'}</p>
      {summary?.session_id && <p className="small muted">세션 ID: {summary.session_id}</p>}
      <p>현재 대화: {view.focus?.active_agent_session_id ?? view.conversation?.snapshot?.id ?? '없음'} · {connections[view.connection]}</p>
      <div className="field-row">
        <button className="secondary" disabled={disabled} onClick={() => void model.current?.execute('watch')}>현재 대화 포커스 구독</button>
        <button className="secondary" disabled={disabled} onClick={() => void model.current?.execute('conversation')}>공유 대화 읽기</button>
        <button className="secondary" disabled={disabled} onClick={() => void model.current?.execute('watch-conversation')}>공유 대화 폴링</button>
        <button className="secondary" disabled={view.busy || view.connection === 'idle'} onClick={() => void model.current?.stopWatch()}>폴링 중단</button>
        <button className="secondary" onClick={() => void model.current?.execute('cancel')}>작업·구독 중단</button>
        <button className="secondary" disabled={disabled} onClick={() => setForget(true)}>중단된 로컬 기록 삭제</button>
      </div>
      {forget && <div className="field"><p className="settings-hint warn">먼저 브라우저 내 페이지에서 서버 세션을 폐기하세요. 이 작업은 서버 폐기 없이 로컬 기록만 삭제합니다.</p>
        <button disabled={disabled} onClick={() => void run('session', 'forget-local')}>확인하고 로컬 기록 삭제</button><button className="secondary" onClick={() => setForget(false)}>취소</button></div>}
      {view.conversation?.snapshot && <div className="field">
        <p><strong>{view.conversation.snapshot.title}</strong></p>
        <p className="small muted">턴: {view.conversation.snapshot.latest_turn?.status ?? '없음'} · 메시지 {completeMessages.length}개</p>
        {(view.conversation.omittedMessages > 0 || !view.conversation.snapshot.message_history_complete || incompleteMessages > 0 || view.hasMore) && <p className="settings-hint warn">
          {[
            view.conversation.omittedMessages > 0 ? `이전 ${view.conversation.omittedMessages}개 메시지 생략` : '',
            !view.conversation.snapshot.message_history_complete ? '전체 이력이 아님' : '',
            incompleteMessages > 0 ? `본문 미완전 ${incompleteMessages}개` : '', view.hasMore ? '추가 내용 확인 중' : '',
          ].filter(Boolean).join(' · ')}
        </p>}
        {completeMessages.map((item) => <div className="field" key={item.turn_id}>
          <p className="small muted">{item.status} · {item.source}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{item.input_text}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{item.output_text}</p>
        </div>)}
        {!completeMessages.length && <p className="settings-hint">표시할 완전한 메시지가 없습니다.</p>}
      </div>}
      {view.conversation && !view.conversation.snapshot && <p className="settings-hint">현재 공유 대화가 없습니다.</p>}
      <p className="settings-hint">포커스 구독은 현재 대화 ID만, 공유 대화 읽기·폴링은 검증된 메시지와 턴 상태를 표시합니다. 서버가 세션 발급을 준비 중이면 로그인에 503이 반환됩니다.</p>
      {view.busy && <p role="status">기기·세션 확인 중…</p>}
      {view.error && <p className="settings-hint warn" role="alert">{view.error}</p>}
      {message && <p role="status">{message}</p>}
    </SettingsSection>
  </>;
};
