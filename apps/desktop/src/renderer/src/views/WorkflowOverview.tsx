/**
 * Geny 가 아닌 에이전트(Agent Xgen · 일반 워크플로우)의 [개요].
 *
 * Geny 의 개요는 서버가 턴 프롬프트를 다시 조립한 것(basic-info)인데 그 조립은 Agent Geny 노드에만 있다.
 * 여기서는 저장된 워크플로우를 읽어 사람이 알아야 할 것만 보인다: 무슨 에이전트인가, 무슨 모델로 도는가,
 * 시스템 프롬프트, 에이전트에 연결된 노드, 워크플로우 구성. 바꾸는 일은 [워크플로우] 탭의 캔버스가 한다
 * (웹 에이전트 상세의 [기본정보]와 같은 내용이다. 판정은 @dex/protocol/agent-workflow 한 곳).
 */
import React, { useMemo } from 'react';
import { summarizeWorkflow, type AgentWorkflow } from '@dex/protocol/agent-workflow';
import { RefreshIcon } from '../brand/icons';
import { useViewerScroll } from './agent-viewer-state';
import type { AgentViewerSub } from './workspace-layout';

export const WorkflowOverview: React.FC<{
  workflow: AgentWorkflow;
  loading: boolean;
  onReload: () => void;
  onNavigate: (sub: AgentViewerSub) => void;
}> = ({ workflow, loading, onReload, onNavigate }) => {
  const summary = useMemo(() => summarizeWorkflow(workflow), [workflow]);
  const scroll = useViewerScroll('overview.workflow.scroll', true);
  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar inspector-toolbar">
        <div>
          <strong>에이전트 개요</strong>
          <span>저장된 워크플로우의 구성을 보여 줍니다.</span>
        </div>
        <button className="viewer-btn" disabled={loading} onClick={onReload}>
          <RefreshIcon size={13} /> 새로고침
        </button>
      </div>
      <div className="viewer-scroll overview-scroll" {...scroll}>
        <div className="overview-content">
          <section className="overview-model" aria-label="에이전트 종류">
            <div>
              <span className="inspector-eyebrow">{summary.agentNodeType ? '실행 모델' : '종류'}</span>
              <h2>{summary.agentNodeType ? summary.model || '모델을 정하지 않았습니다' : summary.kind}</h2>
              <span className="inspector-muted">
                {summary.agentNodeType
                  ? summary.kind
                  : '에이전트 노드 없이 노드를 이어 만든 워크플로우입니다.'}
              </span>
            </div>
            <span className="viewer-badge gray">
              노드 {summary.nodeCount}개 · 연결 {summary.edgeCount}개
            </span>
          </section>

          {summary.agentNodeType && summary.prompt !== null && (
            <section className="overview-section">
              <div className="inspector-section-head">
                <div>
                  <h2>시스템 프롬프트</h2>
                  <span>에이전트 노드에 적어 둔 지시입니다.</span>
                </div>
              </div>
              <div className="overview-prompt-body">
                {summary.prompt ? (
                  <pre className="viewer-body">{summary.prompt}</pre>
                ) : (
                  <div className="viewer-note">시스템 프롬프트를 적지 않았습니다.</div>
                )}
              </div>
            </section>
          )}

          {summary.agentNodeType && (
            <section className="overview-section">
              <div className="inspector-section-head">
                <div>
                  <h2>에이전트에 연결된 노드</h2>
                  <span>에이전트로 값을 넘기는 노드와 받는 자리입니다.</span>
                </div>
              </div>
              {summary.connected.length ? (
                summary.connected.map((item) => (
                  <div key={item.key} className="overview-execution workflow-overview-row">
                    <span className="overview-execution-title">
                      <strong>{item.name}</strong>
                    </span>
                    <span className="viewer-badge gray">{item.port}</span>
                  </div>
                ))
              ) : (
                <div className="overview-prompt-body">
                  <div className="viewer-note">에이전트에 연결된 노드가 없습니다.</div>
                </div>
              )}
            </section>
          )}

          <section className="overview-section">
            <div className="inspector-section-head">
              <div>
                <h2>워크플로우 구성</h2>
                <span>구성은 [워크플로우] 탭의 캔버스에서 바꿉니다.</span>
              </div>
              <button className="viewer-btn sm" onClick={() => onNavigate('workflow')}>
                워크플로우 열기
              </button>
            </div>
            <div className="overview-prompt-body workflow-overview-nodes">
              {summary.nodeNames.map((node) => (
                <span key={node.id} className="viewer-badge gray" title={node.type}>
                  {node.name}
                </span>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
