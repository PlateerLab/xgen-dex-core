import React, { useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { createDesktopScopedBridge, expectedDesktopNativeOrigin } from '../native-session-binding';
import { blankCapabilityView, DesktopCapabilityModel } from '../native-capability-model';

const connectionStates: Record<string, string> = { connecting: '연결 중', ready: '작업 요청 대기',
  confirmation_required: '이 PC에서 확인 필요', executing: '실행 중', closed: '연결 안 됨', failed: '연결 확인 필요' };
const approvalStates: Record<string, string> = { pending: '승인 대기', approved: '승인됨', rejected: '거절됨',
  armed: '다음 턴에 연결됨', consumed: '이미 사용됨', expired: '만료됨', unavailable: '확인 필요' };

export const NativeCapabilities: React.FC<{ origin: string; userId: string; sessionId: string | null; enabled: boolean }> =
({ origin, userId, sessionId, enabled }) => {
  const [view, setView] = useState(blankCapabilityView);
  const model = useRef<DesktopCapabilityModel | null>(null);
  const [, tick] = useState(0);
  const ready = enabled && !!expectedDesktopNativeOrigin(origin) && /^[1-9][0-9]*$/.test(userId);
  useEffect(() => {
    setView(blankCapabilityView());
    if (!ready) return;
    const controller = new DesktopCapabilityModel(createDesktopScopedBridge(xgen.nativeSession, origin, userId), sessionId, setView);
    model.current = controller;
    return () => { if (model.current === controller) model.current = null; controller.dispose(); };
  }, [origin, userId, sessionId, ready]);
  useEffect(() => {
    if (!view.connection?.confirmation) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [view.connection?.confirmation]);
  const connected = view.connection && !['closed', 'failed'].includes(view.connection.state);
  const pending = view.connection?.confirmation;
  const expired = !!pending && pending.expiresAt * 1000 <= Date.now();
  const devices = new Map<string, NonNullable<typeof view.catalog>['capabilities']>();
  for (const capability of view.catalog?.capabilities ?? []) {
    devices.set(capability.device_id, [...(devices.get(capability.device_id) ?? []), capability]);
  }
  return <section className="native-capabilities" aria-labelledby="native-capabilities-heading">
    <h3 id="native-capabilities-heading">기기 도구</h3>
    <p>이 대화에서 사용할 기기를 선택하세요. 실행할 때 대상 기기의 확인이 필요합니다.</p>
    {!ready && <p role="status">HTTPS 플랫폼 세션에 로그인한 뒤 사용할 수 있습니다.</p>}
    <div className="native-capabilities__toolbar">
      <button id="capability-refresh" type="button" disabled={!ready || !sessionId || view.busy}
        onClick={() => void model.current?.refresh()}>기기·승인 새로 고침</button>
      <button id="capability-connect" type="button" className="secondary" disabled={!ready || !!connected || view.busy}
        onClick={() => void model.current?.connection(true)}>이 PC 연결</button>
      <button id="capability-disconnect" type="button" className="secondary" disabled={!ready || !connected}
        onClick={() => void model.current?.connection(false)}>이 PC 연결 해제</button>
      <span role="status">{connectionStates[view.connection?.state ?? 'closed']}</span>
    </div>
    {!sessionId && <p>공유 Agent 대화를 먼저 선택하세요.</p>}
    {view.catalog && <div className="native-capabilities__targets">
      {[...devices].map(([deviceId, tools]) => <fieldset key={deviceId} disabled={view.busy}>
        <legend>기기 {deviceId.slice(0, 8)}</legend>
        {tools.map((tool) => <label key={tool.capability_id} className="native-capabilities__tool">
          <input type="checkbox" checked={view.selected.includes(tool.capability_id)} onChange={() => model.current?.toggle(tool.capability_id)} />
          <span><strong>{tool.name}</strong> · {tool.server}<small>{tool.description}</small></span>
        </label>)}
      </fieldset>)}
      {devices.size === 0 && <p>현재 연결되어 사용할 수 있는 기기가 없습니다.</p>}
      <div className="native-capabilities__toolbar">
        <button id="capability-save" type="button" disabled={view.busy || !view.authScope} onClick={() => void model.current?.save()}>선택 저장</button>
        <button id="capability-revoke" type="button" className="secondary" disabled={view.busy || !view.authScope}
          onClick={() => void model.current?.save(true)}>전체 선택 철회</button>
      </div>
      <p>연결이 바뀌거나 선택이 만료되면 다시 선택해야 합니다.</p>
    </div>}
    {view.approvals.length > 0 && <div className="native-capabilities__approvals">
      <h4>대기·승인된 작업</h4>
      {view.approvals.map((approval) => <article key={approval.approval_id}>
        <strong>{approval.tool_name}</strong> · 기기 {approval.target_device_id.slice(0, 8)}
        <p>#{approval.approval_id} · {approvalStates[approval.status]} · 인자 확인값 {approval.args_sha256.slice(0, 12)}</p>
        <button type="button" disabled={view.busy || approval.status !== 'approved' || approval.expires_at * 1000 <= Date.now()}
          onClick={() => void model.current?.adopt(approval.approval_id)}>다음 턴에 한 번 사용</button>
      </article>)}
      <p>연결한 뒤 새 요청을 보내세요. 승인된 기기·도구·인자가 같아야 실행됩니다.</p>
    </div>}
    {pending && <div className="native-capabilities__confirmation" role="region" aria-label="이 PC의 작업 실행 확인">
      <h4>{view.connection?.state === 'executing' ? '이 PC에서 실행 중' : '이 PC에서 실행할 작업을 확인하세요'}</h4>
      <p><strong>{pending.tool}</strong> · {pending.server}</p>
      <p>Agent 세션 {pending.agentSessionId.slice(0, 8)}</p>
      <pre aria-label="실행 인자">{JSON.stringify(pending.args, null, 2)}</pre>
      <p role="status">{expired ? '확인 시간이 만료되었습니다.' : `남은 확인 시간 ${Math.max(0, Math.ceil(pending.expiresAt - Date.now() / 1000))}초`}</p>
      {view.connection?.state === 'confirmation_required' && <div className="native-capabilities__toolbar">
        <button id="capability-deny" type="button" className="secondary" onClick={() => void model.current?.confirm(false)}>거절</button>
        <button id="capability-allow" type="button" disabled={expired} onClick={() => void model.current?.confirm(true)}>표시된 작업 한 번 허용</button>
      </div>}
    </div>}
    {view.notice && <p role="status">{view.notice}</p>}
    {view.error && <p className="native-capabilities__error" role="alert">{view.error}</p>}
  </section>;
};
