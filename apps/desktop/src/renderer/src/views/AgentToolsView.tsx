import React, { useEffect, useMemo, useState } from 'react';
import type { ForgedTool } from '@dex/protocol';
import { xgen, copyText } from '../bridge';
import { CopyIcon, RefreshIcon } from '../brand/icons';
import { errText, StateNote, ViewerEmpty, useLoader } from './agent-viewer-shared';
import { useViewerState, useViewerScroll } from './agent-viewer-state';
import { connectedToolGroups } from './agent-inspector-model';

const ConnectedToolsView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const loader = useLoader(() => xgen.agentData.basicInfo(workflowId), [workflowId]);
  const [query, setQuery] = useViewerState('tools.connected.query', '');
  const [groupKey, setGroupKey] = useViewerState('tools.connected.group', 'all');
  const [selected, setSelected] = useViewerState<string | null>('tools.connected.selected', null);
  const surface = loader.data?.surfaces?.connector;
  const groups = useMemo(() => connectedToolGroups(surface), [surface]);
  const all = groups.flatMap((group) => group.tools.map((tool) => ({ tool, group })));
  const activeGroup = groups.some((group) => group.key === groupKey) ? groupKey : 'all';
  const text = query.trim().toLowerCase();
  const shown = all.filter(
    ({ tool, group }) =>
      (activeGroup === 'all' || group.key === activeGroup) &&
      (!text || `${tool.name} ${tool.description}`.toLowerCase().includes(text)),
  );
  const current = shown.find(({ tool }) => tool.name === selected) ?? shown[0];
  const listScroll = useViewerScroll('tools.connected.list', !!loader.data);
  const detailScroll = useViewerScroll(`tools.connected.detail:${current?.tool.name}`, !!current);
  return (
    <div className="viewer-pane">
      <div className="tools-controls">
        <input
          className="viewer-search"
          aria-label="연결된 도구 검색"
          placeholder="도구 이름이나 설명 검색…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="도구 그룹"
          value={activeGroup}
          onChange={(event) => setGroupKey(event.target.value)}
        >
          <option value="all">모든 그룹 · {all.length}</option>
          {groups.map((group) => (
            <option key={group.key} value={group.key}>
              {group.title} · {group.tools.length}
            </option>
          ))}
        </select>
        <span className="inspector-muted">{shown.length}개</span>
        <button className="viewer-btn" disabled={loader.loading} onClick={loader.reload}>
          <RefreshIcon size={13} /> 새로고침
        </button>
      </div>
      {loader.loading || loader.error || !all.length ? (
        <ViewerEmpty
          title={
            loader.loading
              ? '연결된 도구를 불러오는 중…'
              : loader.error
                ? '연결된 도구를 불러오지 못했습니다'
                : !surface || surface.available === false
                  ? '연결된 도구 정보를 확인할 수 없습니다'
                  : '연결된 도구가 없습니다'
          }
          description={
            loader.error ||
            surface?.note ||
            '이 에이전트의 데스크톱 실행에 연결된 도구가 표시됩니다.'
          }
          error={!!loader.error}
          onRetry={loader.loading ? undefined : loader.reload}
        />
      ) : !shown.length ? (
        <div className="execution-no-results">
          <ViewerEmpty
            title="검색 결과가 없습니다"
            description="다른 이름이나 그룹으로 검색해 보세요."
          />
          <button
            className="viewer-btn"
            onClick={() => {
              setQuery('');
              setGroupKey('all');
            }}
          >
            검색·필터 초기화
          </button>
        </div>
      ) : (
        <div className="viewer-split tools-split">
          <div className="viewer-list tools-list" {...listScroll}>
            {shown.map(({ tool, group }) => (
              <button
                key={tool.name}
                className={`viewer-listitem ${current?.tool.name === tool.name ? 'active' : ''}`}
                aria-pressed={current?.tool.name === tool.name}
                onClick={() => setSelected(tool.name)}
              >
                <div className="viewer-listitem-title">{tool.name}</div>
                <div className="viewer-listitem-sub">
                  {group.title}
                  {tool.gateway ? ' · 시작점' : ''}
                </div>
              </button>
            ))}
          </div>
          <div className="viewer-detail tools-reader" {...detailScroll}>
            {current && (
              <div className="tools-document">
                <div className="inspector-eyebrow">{current.group.title}</div>
                <h2>{current.tool.name}</h2>
                {current.tool.gateway && <span className="viewer-badge blue">시작점</span>}
                <p className="tools-description">
                  {current.tool.description || '도구 설명이 없습니다.'}
                </p>
                {current.group.note && <div className="inspector-notice">{current.group.note}</div>}
                {current.group.disclosure && (
                  <div className="inspector-notice">{current.group.disclosure}</div>
                )}
                {(surface?.provision?.mode_note ||
                  surface?.native_tools ||
                  !!loader.data?.errors?.length) && (
                  <details className="tools-provision">
                    <summary>도구 제공 방식</summary>
                    {surface?.provision?.mode_note && <p>{surface.provision.mode_note}</p>}
                    {surface?.native_tools && (
                      <>
                        <h3>CLI 네이티브 도구</h3>
                        <p>{surface.native_tools.note}</p>
                        <p>
                          유지 {surface.native_tools.kept.length}개 · 차단{' '}
                          {surface.native_tools.removed.length}개
                        </p>
                      </>
                    )}
                    {!!loader.data?.errors?.length && (
                      <p className="inspector-error">
                        일부 구성 확인 실패: {loader.data.errors.join(' · ')}
                      </p>
                    )}
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const AgentToolsView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const [tab, setTab] = useViewerState<'connected' | 'forged'>('tools.tab', 'connected');
  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar inspector-toolbar">
        <div>
          <strong>도구</strong>
          <span>에이전트에 연결된 기능과 직접 제작한 도구</span>
        </div>
      </div>
      <div className="tools-tabs" role="tablist" aria-label="도구 종류">
        {(
          [
            ['connected', '연결된 도구'],
            ['forged', '제작한 도구'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`viewer-subtab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'connected' ? (
        <ConnectedToolsView workflowId={workflowId} />
      ) : (
        <ForgedToolsView workflowId={workflowId} />
      )}
    </div>
  );
};

const ForgedToolsView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.toolsList(workflowId), [workflowId]);
  const [sel, setSel] = useViewerState<string | null>('tools.selected', null);
  const [detail, setDetail] = useState<ForgedTool | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [detailVersion, setDetailVersion] = useState(0);
  const open = (tool: ForgedTool) => {
    setSel(tool.name);
    setDetailVersion((value) => value + 1);
  };
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailErr(null);
    setDetailLoading(!!sel);
    if (sel)
      void xgen.agentData
        .toolGet(workflowId, sel)
        .then((result) => {
          if (alive) setDetail(result);
        })
        .catch((error) => {
          if (alive) setDetailErr(errText(error));
        })
        .finally(() => {
          if (alive) setDetailLoading(false);
        });
    return () => {
      alive = false;
    };
  }, [workflowId, sel, detailVersion]);
  const listScroll = useViewerScroll('tools.list', !!list.data);
  const detailScroll = useViewerScroll(`tools.detail:${sel}`, !!list.data && !!detail);

  const tools = list.data?.tools ?? [];
  if (!list.data || tools.length === 0)
    return (
      <ViewerEmpty
        title={
          list.loading
            ? '도구를 불러오는 중…'
            : list.error
              ? '도구를 불러오지 못했습니다'
              : '아직 제작된 도구가 없습니다'
        }
        description={
          list.error ||
          (!list.loading
            ? '에이전트가 직접 제작한 도구가 표시됩니다. 연결된 도구는 위의 연결된 도구 탭에서 확인할 수 있습니다.'
            : undefined)
        }
        error={!!list.error}
        onRetry={list.loading ? undefined : list.reload}
      />
    );

  return (
    <div className="viewer-pane">
      <div className="tools-controls">
        <span className="inspector-muted">제작한 도구 {tools.length}개</span>
        <button className="viewer-btn" onClick={list.reload} disabled={list.loading}>
          <RefreshIcon size={13} /> 새로고침
        </button>
      </div>
      <div className="viewer-split">
        <div className="viewer-list" {...listScroll}>
          <StateNote
            loading={list.loading}
            error={list.error}
            empty={!!list.data && tools.length === 0}
            emptyText="제작된 도구가 없습니다."
          />
          {tools.map((t) => (
            <button
              key={t.name}
              className={`viewer-listitem ${sel === t.name ? 'active' : ''}`}
              onClick={() => void open(t)}
            >
              <div className="viewer-listitem-title">
                <span
                  className={`viewer-badge ${
                    t.status === 'broken' ? 'red' : t.verified ? 'emerald' : 'amber'
                  }`}
                >
                  {t.status === 'broken' ? '고장' : t.verified ? '검증됨' : '미검증'}
                </span>
                {t.name}
              </div>
              <div className="viewer-listitem-sub">
                {t.runtime || ''}
                {typeof t.calls === 'number' ? ` · 호출 ${t.calls}` : ''}
                {!t.enabled ? ' · 비활성' : ''}
              </div>
            </button>
          ))}
        </div>
        <div className="viewer-detail" {...detailScroll}>
          {!sel && !detailLoading && <div className="viewer-note">왼쪽에서 도구를 고르세요.</div>}
          <StateNote loading={detailLoading} error={detailErr} />
          {detailErr && (
            <button className="viewer-btn" onClick={() => setDetailVersion((value) => value + 1)}>
              다시 불러오기
            </button>
          )}
          {detail && (
            <>
              <div className="viewer-detail-head">
                <strong>{detail.name}</strong>
                {detail.source && (
                  <button
                    className="viewer-btn sm"
                    onClick={() => void copyText(detail.source || '')}
                  >
                    <CopyIcon size={12} /> 코드 복사
                  </button>
                )}
              </div>
              {detail.description && <div className="viewer-sub">{detail.description}</div>}
              <div className="viewer-kv">
                {detail.entrypoint && (
                  <span>
                    <b>엔트리</b> {detail.entrypoint}
                  </span>
                )}
                {detail.runtime && (
                  <span>
                    <b>런타임</b> {detail.runtime}
                  </span>
                )}
                {detail.env_keys && detail.env_keys.length > 0 && (
                  <span>
                    <b>ENV</b> {detail.env_keys.join(', ')}
                  </span>
                )}
                {detail.dependencies && detail.dependencies.length > 0 && (
                  <span>
                    <b>의존성</b> {detail.dependencies.join(', ')}
                  </span>
                )}
              </div>
              {detail.last_test_error && (
                <>
                  <div className="viewer-label err">마지막 테스트 오류</div>
                  <pre className="err">{detail.last_test_error}</pre>
                </>
              )}
              <div className="viewer-label">소스 코드</div>
              {detail.source_error ? (
                <div className="viewer-note err">{detail.source_error}</div>
              ) : (
                <pre className="viewer-body code">{detail.source || '(소스 없음)'}</pre>
              )}
              {detail.source_truncated && <div className="viewer-sub">※ 소스가 잘렸습니다.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
