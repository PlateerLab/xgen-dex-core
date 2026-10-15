/**
 * 에이전트 뷰어의 [워크플로우] 탭: 웹의 캔버스 편집기를 그대로 띄운다.
 *
 * 서버의 `/canvas?load={id}&embed=1` 을 <webview> 로 연다(main/canvas-embed: 전용 메모리 세션, 서버의 /canvas
 * 만 허용, 토큰은 main 이 쿠키로 심는다). 내장 모드의 캔버스는 사이드바와 헤더가 없고, 저장은 캔버스 하단 바의
 * [저장]과 Ctrl+S, 이름은 뷰어 머리의 이름을 두 번 눌러 바꾼다. 웹 에이전트 상세의 [워크플로우] 탭과 같다.
 *
 * 키 입력: 초점이 캔버스 안이면 캔버스가 받는다. 초점이 앱 쪽(방금 누른 탭 등)이면 이 탭이 열려 있는 동안
 * Ctrl+S · Ctrl+Z · Ctrl+Shift+Z(Ctrl+Y)를 캔버스로 넘긴다(입력칸에서 누른 것은 넘기지 않는다). 넘기는 길은
 * 웹 상세 화면과 같은 말(xgen:canvas-command)이다. 이름을 바꾸면 xgen:agentflow-renamed 로 알린다: 캔버스가
 * 옛 이름으로 저장하면 서버가 이름이 다른 새 워크플로우로 보고 같은 id 에 행을 하나 더 만든다.
 *
 * 뷰어는 이 탭을 한 번 연 뒤로는 다른 하위 탭으로 옮겨도 지우지 않고 숨긴다(저장하지 않은 편집 보존).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { ViewerEmpty } from './agent-viewer-shared';

type CanvasWebview = HTMLElement & {
  executeJavaScript(code: string): Promise<unknown>;
};

/** 캔버스 문서 안에서 자기 창에 말을 건다: 내장 캔버스는 같은 출처의 말만 듣는다. */
function postToCanvas(view: CanvasWebview | null, message: Record<string, unknown>): void {
  if (!view) return;
  const code = `window.postMessage(${JSON.stringify(message)}, window.location.origin)`;
  try {
    void view.executeJavaScript(code).catch(() => undefined);
  } catch {
    // 아직 붙지 않았다(dom-ready 전): 이번 입력은 버린다.
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export const AgentWorkflowCanvas: React.FC<{
  workflowId: string;
  workflowName: string;
  ownerUserId: string | null;
  active: boolean;
}> = ({ workflowId, workflowName, ownerUserId, active }) => {
  const [target, setTarget] = useState<{ src: string; partition: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const viewRef = useRef<CanvasWebview | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    xgen.canvas
      .prepare(workflowId, ownerUserId)
      .then((next) => {
        if (alive) setTarget(next);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // 주인 힌트가 늦게 와도 다시 열지 않는다: 캔버스가 불러온 결과로 주인을 다시 정한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, nonce]);

  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const command =
        key === 's' ? 'save' : key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' ? 'redo' : null;
      if (!command) return;
      event.preventDefault();
      postToCanvas(viewRef.current, { type: 'xgen:canvas-command', command });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  // 이름이 바뀌었으면 캔버스에도 알린다. 처음 이름은 캔버스가 스스로 불러온다.
  const lastName = useRef(workflowName);
  useEffect(() => {
    if (!workflowName || lastName.current === workflowName) return;
    lastName.current = workflowName;
    postToCanvas(viewRef.current, { type: 'xgen:agentflow-renamed', workflowId, name: workflowName });
  }, [workflowId, workflowName]);

  const setRef = useCallback((element: HTMLElement | null) => {
    viewRef.current = element as CanvasWebview | null;
  }, []);

  if (error) {
    return (
      <ViewerEmpty
        title="캔버스를 열지 못했습니다"
        description={error}
        error
        onRetry={() => setNonce((value) => value + 1)}
      />
    );
  }
  if (!target) return <ViewerEmpty title="캔버스를 여는 중…" loading />;
  return (
    <div className="agent-canvas-host">
      {React.createElement('webview', {
        ref: setRef,
        className: 'agent-canvas-webview',
        src: target.src,
        partition: target.partition,
        // 실행 패널 떼어 내기(새 창)가 setWindowOpenHandler 까지 오려면 이 속성이 있어야 한다.
        // 무엇을 열지는 main(canvas-embed)이 정한다: 같은 출처만 같은 세션의 창으로, 나머지는 기본 브라우저.
        allowpopups: 'true',
        webpreferences: 'sandbox=yes,contextIsolation=yes,nodeIntegration=no,webSecurity=yes',
      })}
    </div>
  );
};
