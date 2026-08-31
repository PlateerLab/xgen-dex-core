/**
 * XGEN 워크스페이스 — 커넥터가 소유하는 가상 드라이브 하나.
 *
 * 예전에는 "에이전트 ↔ 사용자가 고른 임의 폴더"를 하나씩 페어링했다. 폴더가
 * 흩어지니 진실도 흩어졌고, 무엇이 원본인지가 페어마다 달랐다. 지금은 구글
 * 드라이브와 같은 모양이다: **루트 하나**에 **에이전트를 추가**한다.
 *
 * 앱이 켜져 있을 때만 존재하는 폴더이므로, 여기서 하는 일은 (1) 루트 위치를
 * 정하고 (2) 어떤 에이전트를 넣을지 고르는 것뿐이다.
 */
import React, { useEffect, useState } from 'react';
import { useModalDismiss } from './use-modal-dismiss';
import { xgen } from '../bridge';
import type { LocalSyncStatusLike, WorkspaceStatusLike } from '../../../preload/index';
import { syncedAgo } from './explorer-model';
import { Selector } from './Selector';

type AgentOption = { id: string; name: string };

export const SyncSettings: React.FC<{ onClose?: () => void; embedded?: boolean }> = ({
  onClose,
  embedded,
}) => {
  // 모달로 떠 있을 때만 Esc 로 닫는다 — embedded(탭 안)에서는 닫을 대상이 없다.
  useModalDismiss(() => onClose?.(), !embedded && !!onClose);
  const [ws, setWs] = useState<WorkspaceStatusLike | null>(null);
  const [root, setRoot] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState('');
  // 실패를 절대 삼키지 않는다 — v1.7.0 에서 추가 버튼이 조용히 아무 일도
  // 하지 않던 원인이 예외를 잡지 않은 것이었다.
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const refreshRoot = () =>
    xgen.workspace
      .root()
      .then(setRoot)
      .catch(() => undefined);

  /**
   * 고를 수 있는 에이전트 목록.
   *
   * **내 에이전트만** 담는다. 공유받은 에이전트의 workspace 는 서버가 소유자에게만
   * 열어 주므로(check_owner_access), 목록에 넣으면 고를 수는 있는데 추가가 404 로
   * 거절돼 사용자는 이유를 알 수 없는 실패를 본다.
   */
  const refreshAgentOptions = () =>
    xgen.agents
      .list({ page: 1, pageSize: 200, owner: 'personal' })
      .then((r) =>
        setAgents((r.items ?? []).map((a) => ({ id: a.workflowId, name: a.workflowName }))),
      )
      .catch(() => undefined);

  // 에이전트 로컬 동기화 상태 — 행마다 폴더·마지막 동기화·오류를 보여준다.
  const [sync, setSync] = useState<LocalSyncStatusLike | null>(null);

  useEffect(() => {
    xgen.workspace
      .status()
      .then(setWs)
      .catch((e) => setError(String(e?.message ?? e)));
    void refreshRoot();
    // 화면을 여는 순간 서버와 맞춘다. 사용자가 웹에서 에이전트를 붙이고 여기를
    // 열었을 때 옛 목록이 떠 있으면, 그게 곧 "동기화가 안 된다" 로 읽힌다.
    void xgen.workspace.refresh().catch(() => undefined);
    void refreshAgentOptions();
    return xgen.workspace.onStatus(setWs);
  }, []);

  useEffect(() => {
    void xgen.sync
      .status()
      .then(setSync)
      .catch(() => undefined);
    return xgen.sync.onStatus(setSync);
  }, []);

  /** 모든 워크스페이스 조작의 단일 통로 — 실패는 반드시 화면에 뜬다. */
  const act = async (label: string, fn: () => Promise<WorkspaceStatusLike | undefined>) => {
    setBusy(label);
    setError('');
    try {
      const next = await fn();
      if (next) setWs(next);
      await refreshRoot();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const attached = ws?.agents ?? [];
  const addable = agents.filter((a) => !attached.some((x) => x.workflowId === a.id));

  const inner = (
    <>
      <p className="small muted">
        내 클라우드(XGen-Cloud)를 내 컴퓨터의 드라이브처럼 씁니다 — 앱이 켜져 있는 동안에만
        나타나고, 파일의 원본은 항상 서버에 있습니다. 연결된 에이전트의 워크스페이스는 드라이브가
        아니라 <b>[로컬 도구]의 기본 작업 폴더</b> 아래로 <b>실제 파일로 동기화</b>
        됩니다 — 커넥터로 접속한 에이전트는 그 폴더를 자기 작업 공간으로 씁니다.
      </p>

      {ws && !ws.supported ? (
        <div className="mcp-form">
          <div className="small error">{ws.reason}</div>
          {ws.hint && (
            <div className="small muted" style={{ marginTop: 4 }}>
              {ws.hint}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 드라이브 on/off — 끌 수 없는 기능은 고장 났을 때 손 쓸 방법이 없다 */}
          <div className="mcp-form" style={{ marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600 }}>가상 드라이브 사용</div>
                <div className="small muted" style={{ marginTop: 2 }}>
                  끄면 폴더가 사라집니다. 파일의 원본은 서버에 그대로 있습니다.
                </div>
              </div>
              {/* 앱의 다른 on/off 와 같은 토글 (VoiceSettings·McpSettings 동일 컴포넌트) */}
              <label className="switch">
                <input
                  type="checkbox"
                  checked={ws?.enabled !== false}
                  disabled={!!busy}
                  onChange={(e) =>
                    void act('enabled', () => xgen.workspace.setEnabled(e.target.checked))
                  }
                />
                <span className="track" />
              </label>
            </div>
          </div>

          {/* 위치 */}
          <div className="mcp-form" style={{ marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 600 }}>
                위치
                {/* 승인 대기/거절은 '연결됨'보다 우선해 보여준다 — 드라이브가
                      (에이전트 폴더로) 마운트돼 있어도 내 클라우드는 아직 잠겨
                      있다는 사실이 한눈에 보여야 한다. */}
                {ws?.cloudApproval === 'pending' ? (
                  <span className="small notice-warn" style={{ marginLeft: 8 }}>
                    승인 대기중
                  </span>
                ) : ws?.cloudApproval === 'rejected' ? (
                  <span className="small error" style={{ marginLeft: 8 }}>
                    연결 거절됨
                  </span>
                ) : ws?.mounted ? (
                  <span className="small notice-ok" style={{ marginLeft: 8 }}>
                    연결됨
                  </span>
                ) : null}
              </span>
              <div className="row" style={{ gap: 8 }}>
                {ws?.mounted && (
                  <button className="link" onClick={() => void xgen.workspace.open()}>
                    폴더 열기
                  </button>
                )}
                {/*
                    붙어 있으면 [동기화](서버 상태 다시 읽기), 안 붙어 있으면
                    [다시 연결](걷고 재마운트). 실패했을 때 사용자가 스스로
                    되살릴 수단이 없으면 앱을 껐다 켜는 수밖에 없다.
                  */}
                {ws?.enabled !== false &&
                  (ws?.mounted ? (
                    <button
                      className="link"
                      disabled={!!busy}
                      onClick={() => void act('refresh', () => xgen.workspace.refresh())}
                    >
                      {busy === 'refresh' ? '동기화 중…' : '동기화'}
                    </button>
                  ) : (
                    <button
                      className="link"
                      disabled={!!busy}
                      onClick={() => void act('remount', () => xgen.workspace.remount())}
                    >
                      {busy === 'remount' ? '연결 중…' : '다시 연결'}
                    </button>
                  ))}
                <button
                  className="link"
                  disabled={!!busy}
                  onClick={() => void act('root', () => xgen.workspace.setRoot())}
                >
                  {busy === 'root' ? '옮기는 중…' : '위치 변경'}
                </button>
              </div>
            </div>
            <div className="mcp-item-cmd" style={{ marginTop: 4 }}>
              {root || '—'}
            </div>
            {/*
                재연결 안내. **조용히 두면 안 되는 이유**: 이름 없이 등록된 PC 는
                클라우드 안에서 자기 폴더를 갖지 못해 파일이 루트에 섞이고, 웹은
                기기 id 앞 8자를 이름인 줄 보여준다. 사용자는 무엇이 잘못됐는지
                알 방법이 없다 — 그래서 여기서 말하고, 고치는 버튼까지 준다.
              */}
            {ws?.needsReconnect && (
              <div className="small" style={{ marginTop: 6 }}>
                <div className="notice-warn">재연결이 필요합니다</div>
                <div className="muted" style={{ marginTop: 2 }}>
                  {ws.reconnectReason}
                </div>
                <button
                  className="link"
                  style={{ marginTop: 4 }}
                  disabled={!!busy}
                  onClick={() => void act('remount', () => xgen.workspace.remount())}
                >
                  {busy === 'remount' ? '재연결 중…' : '지금 재연결'}
                </button>
              </div>
            )}
            {/* 이 PC 의 폴더. 어디에 넣어야 하는지를 말해 주지 않으면 사용자는
                  루트에 떨어뜨리고, 그러면 모든 PC 의 파일이 한 트리에 섞인다.
                  경로는 실제 드라이브 경로(루트 = 클라우드)와 1:1 로 맞춘다 —
                  클라우드 루트에는 파일을 둘 수 없고, 파일은 이 폴더 안에 넣는다. */}
            {ws?.homeFolder && !ws?.needsReconnect && (
              <div className="small muted" style={{ marginTop: 4 }}>
                이 PC 의 클라우드 폴더: <span className="mcp-item-cmd">/{ws.homeFolder}</span>
                <div style={{ marginTop: 2 }}>
                  파일은 이 폴더 안에 저장하세요 — 클라우드 루트에는 폴더만 둘 수 있습니다.
                </div>
              </div>
            )}
            {/*
                  예전에는 "내 클라우드가 꺼져 있습니다 — 마이페이지에서 켜세요"
                  를 안내했다. 그런데 켜고 끄는 개념 자체가 없어졌고(파일 클라우드는
                  기본 제공), 안내가 가리키던 메뉴도 사라져서 **켤 방법이 없는
                  안내**만 남았다. 커넥터가 결정하는 것은 연결 여부 하나다.

                  그래도 서버가 막으면 그 사실은 말해야 한다 — 조용히 빈 폴더를
                  보여주면 사용자는 파일이 사라진 줄 안다. 다만 "켜라"고 하지
                  않는다. 지금 막히는 경우는 권한 문제이고, 그건 관리자의 일이다.
              */}
            {/* RAG 시스템 통제 — 관리자 승인 게이트. '꺼짐'(storageOff)과 다르다:
                  대기는 관리자가 승인하면 저절로 풀리고, 사용자가 할 일은 기다림
                  (또는 관리자 문의)뿐이다. 권한 안내로 보내면 헤맨다. */}
            {ws?.cloudApproval === 'pending' && (
              <div className="small" style={{ marginTop: 4 }}>
                <div className="notice-warn">클라우드 연결이 관리자 승인 대기중입니다</div>
                <div className="muted" style={{ marginTop: 2 }}>
                  관리자가 [승인 관리]에서 이 PC 의 연결을 승인하면 내 클라우드 폴더 동기화가
                  자동으로 시작됩니다. 에이전트 폴더는 승인과 무관하게 그대로 동작합니다.
                </div>
              </div>
            )}
            {ws?.cloudApproval === 'rejected' && (
              <div className="small" style={{ marginTop: 4 }}>
                <div className="error">클라우드 연결이 관리자에 의해 거절되었습니다</div>
                <div className="muted" style={{ marginTop: 2 }}>
                  {ws.cloudApprovalDetail || '이 PC 의 클라우드 연결 요청이 거절되었습니다.'}{' '}
                  필요하면 관리자에게 문의해 주세요. 에이전트 폴더는 그대로 동작합니다.
                </div>
              </div>
            )}
            {ws?.storageOff && (
              <div className="small muted" style={{ marginTop: 4 }}>
                <div>내 클라우드 폴더를 열 수 없습니다: {ws.storageOff}</div>
                <div style={{ marginTop: 2 }}>
                  계정에 파일 클라우드 권한이 있는지 관리자에게 확인해 주세요. 에이전트 워크스페이스
                  로컬 동기화는 이와 무관하게 그대로 동작합니다.
                </div>
              </div>
            )}
            {ws?.error && (
              <div className="small error" style={{ marginTop: 4 }}>
                <div>{ws.error}</div>
                {ws.errorHint && (
                  <div className="mcp-item-cmd" style={{ marginTop: 2 }}>
                    {ws.errorHint}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 에이전트 — 연결하면 workspace 가 로컬 폴더로 동기화된다 */}
          <div className="mcp-form">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontWeight: 600 }}>연결된 에이전트 (로컬 동기화)</span>
              {/*
                  목록의 원본은 서버다 — 웹에서 붙이거나 뗀 것이 여기 그대로
                  나타나야 한다. 화면을 열 때 한 번 읽고, 그 사이가 궁금하면
                  누른다. 주기적으로 두드리지 않는다: 연결은 거의 바뀌지 않는데
                  타이머를 두면 앱이 켜져 있는 내내 서버를 부른다.
                */}
              <button
                className="link"
                disabled={!!busy}
                onClick={() =>
                  void act('agents', async () => {
                    const next = await xgen.workspace.refreshAgents();
                    await refreshAgentOptions();
                    return next;
                  })
                }
              >
                {busy === 'agents' ? '새로고침 중…' : '새로고침'}
              </button>
            </div>

            {/* 동기화가 안 도는 이유를 목록 위에서 바로 알린다 — 추가는 되는데
                  폴더가 안 생기면 사용자는 고장으로 읽는다. */}
            {sync && !sync.enabled && sync.reason !== 'logged-out' && (
              <div className="small notice-warn" style={{ marginBottom: 6 }}>
                {sync.reason === 'disabled'
                  ? '로컬 동기화가 꺼져 있습니다 — [로컬 도구] 탭에서 로컬 도구 접근을 켜세요.'
                  : '워크스페이스를 둘 [기본 작업 폴더]를 [로컬 도구] 탭에서 지정하세요.'}
              </div>
            )}

            {attached.length === 0 ? (
              <div className="small muted pad">
                아직 연결된 에이전트가 없습니다. 아래에서 골라 추가하면 그 에이전트의 워크스페이스가
                기본 작업 폴더 아래 같은 이름의 폴더로 동기화됩니다.
              </div>
            ) : (
              <div className="mcp-list" style={{ maxHeight: 260 }}>
                {attached.map((a) => {
                  const st = sync?.agents.find((x) => x.workflowId === a.workflowId);
                  return (
                    <div key={a.workflowId} className="mcp-item">
                      <div className="mcp-item-body">
                        <div className="mcp-item-name">
                          {a.label}
                          {st?.syncing && (
                            <span className="small notice-warn" style={{ marginLeft: 8 }}>
                              동기화 중…
                            </span>
                          )}
                          {st && !st.syncing && st.lastSyncAt && !st.lastError && (
                            <span className="small notice-ok" style={{ marginLeft: 8 }}>
                              {syncedAgo(st.lastSyncAt, Date.now())}
                            </span>
                          )}
                          {st?.lastError && (
                            <span
                              className="small error"
                              style={{ marginLeft: 8 }}
                              title={st.lastError}
                            >
                              동기화 오류
                            </span>
                          )}
                        </div>
                        <div className="mcp-item-cmd">{st?.dir ?? a.folder}</div>
                      </div>
                      <div className="mcp-item-actions">
                        {st && (
                          <>
                            <button
                              className="link"
                              disabled={!!busy || st.syncing}
                              onClick={() => void xgen.sync.now(a.workflowId).then(setSync)}
                            >
                              지금 동기화
                            </button>
                            <button
                              className="link"
                              onClick={() => void xgen.sync.openPath(a.workflowId)}
                            >
                              폴더 열기
                            </button>
                          </>
                        )}
                        <button
                          className="link"
                          disabled={!!busy}
                          onClick={() =>
                            void act(`detach:${a.workflowId}`, () =>
                              xgen.workspace.detach(a.workflowId),
                            )
                          }
                        >
                          {busy === `detach:${a.workflowId}` ? '제거 중…' : '제거'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <Selector
                className="grow"
                searchable
                value={sel}
                onChange={setSel}
                options={addable.map((a) => ({ value: a.id, label: a.name }))}
                placeholder={addable.length === 0 ? '추가할 에이전트가 없습니다' : '에이전트 선택…'}
                searchPlaceholder="에이전트 검색…"
                emptyText="일치하는 에이전트가 없습니다"
                disabled={addable.length === 0}
                ariaLabel="연결할 에이전트 선택"
                uiId="sync-agent-selector"
              />
              <button
                className="primary"
                disabled={!sel || !!busy}
                onClick={() => {
                  const agent = addable.find((a) => a.id === sel);
                  if (!agent) return;
                  void act('attach', async () => {
                    const next = await xgen.workspace.attach({
                      workflowId: agent.id,
                      label: agent.name,
                    });
                    setSel('');
                    return next;
                  });
                }}
              >
                {busy === 'attach' ? '추가 중…' : '추가'}
              </button>
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="small error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button
          className="link"
          onClick={() => {
            // 실패를 삼키지 않는다 — 복사가 안 되면 사용자가 알아야 한다.
            setError('');
            void xgen.workspace
              .diagCopy()
              .then((r) => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
                if (!r.chars) setError('진단 로그가 비어 있습니다.');
              })
              .catch((e) => setError(`진단 로그를 복사하지 못했습니다: ${e?.message ?? e}`));
          }}
        >
          {copied ? '복사됨' : '진단 로그 복사'}
        </button>
      </div>
    </>
  );

  // [설정] → [스토리지] 탭에 그대로 임베드할 때는 모달 껍데기·[닫기] 없이
  // 본문만 렌더한다 (한 단계 [관리] 클릭 없이 바로 보이도록).
  if (embedded) return <div className="sync-embedded">{inner}</div>;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h2>XGEN 워크스페이스</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        {inner}
      </div>
    </div>
  );
};
