/**
 * ArtifactFrame — 에이전트가 만든 React 아티팩트를 **격리해서** 실행한다.
 *
 * 무엇이 이 코드를 가두고 있나 (실측)
 * ------------------------------------
 * 이 앱의 렌더러에는 `window.xgen` 이 있고, 그것은 이 PC 의 셸·파일·키체인·브라우저
 * 로 이어지는 다리다. 에이전트가 쓴 코드를 여기서 그대로 돌리면 그 코드가 다리를
 * 건넌다. 자물쇠는 넷이고, **순서대로 무게가 다르다** — Electron 에서 직접 재 봤다
 * (verify/artifact-frame-smoke.cjs).
 *
 *  1. **다른 스킴** — 프레임 문서는 `xgenartifact://frame/` 에서 오고 렌더러는
 *     file:// (개발은 http://) 다. 스킴이 다르면 오리진이 다르고, `window.parent.*`
 *     접근은 평범한 교차 오리진 규칙으로 막힌다. **`window.xgen` 이 닿지 않는 진짜
 *     이유가 이것이다** — sandbox 속성이 아니다.
 *  2. `sandbox="allow-scripts"` (allow-same-origin **없이**) — 오리진을 불투명하게
 *     만들어 쿠키·localStorage 까지 막는다.
 *  3. 그 스킴을 `standard: true` 로 등록하지 않은 것 — 이것만으로도 오리진이
 *     불투명해진다. 2 와 3 은 서로의 예비다: **둘 다 틀려야** 프레임이 오리진을
 *     되찾는다(실측: standard:true + allow-same-origin 일 때만 document.cookie 가
 *     열렸다). 그래서 둘 중 하나도 풀지 않는다.
 *  4. `nodeIntegrationInSubFrames: false` — 하위 프레임에는 preload 도 Node 도 없다.
 *
 * 프레임에는 네트워크도 없다 — main 이 `xgenartifact://frame/` 응답에 붙이는 CSP 가
 * `connect-src` 를 통째로 닫는다(문서 안의 `<meta>` 가 같은 값의 이중 잠금). 필요한
 * 것은 전부 이 컴포넌트가 건넨다:
 *
 *   런타임   React + Babel 을 **텍스트로** 넘긴다. 프레임이 직접 불러올 수 없는
 *            이유는 불투명 오리진에서 CSP `'self'` 가 아무 것도 가리키지 않기
 *            때문이다. 앱 번들의 별도 청크라 첫 아티팩트를 열 때 한 번만 받는다.
 *   데이터   선언된 파일은 처음에 함께, 선언된 API 는 프레임이 alias 로 부탁하면
 *            main 이 **사용자 권한으로** 대신 호출해 결과만 돌려준다. 프레임은
 *            무엇을 부를지 고르지 못한다.
 *
 * 프레임에서 오는 메시지는 `ev.origin` 으로 가릴 수 없다 — 불투명 오리진이라 값이
 * null 이다. 그래서 창 자체, 즉 `ev.source` 로 판정한다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactDetail } from '@dex/protocol';
import { ARTIFACT_FRAME_URL } from '../../../main/ipc';
import { xgen } from '../bridge';

/**
 * 런타임 두 조각은 앱 수명 동안 한 번만 받는다 (3MB 짜리 Babel 포함).
 *
 * 동적 import + `?raw` — 아티팩트를 한 번도 열지 않으면 이 3MB 는 앱에 실리지
 * 않는다. 확장자가 `.txt` 인 것은 실수가 아니다: 브라우저가 스크립트로 불러오는
 * 파일이 아니라 우리가 텍스트로 읽어 프레임에 넘기는 payload 다.
 */
let runtimePromise: Promise<{ runtimeJs: string; babelJs: string }> | null = null;

function loadRuntime(): Promise<{ runtimeJs: string; babelJs: string }> {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import('./runtime/react-runtime.js.txt?raw'),
      import('./runtime/babel.min.js.txt?raw'),
    ])
      .then(([runtime, babel]) => ({ runtimeJs: runtime.default, babelJs: babel.default }))
      .catch((e: unknown) => {
        runtimePromise = null; // 실패는 캐시하지 않는다 — 다음 시도에서 다시 받는다
        throw e;
      });
  }
  return runtimePromise;
}

export interface ArtifactFrameProps {
  artifact: ArtifactDetail;
  /** 이 값이 바뀌면 프레임을 새로 세운다 (에이전트가 소스를 고쳤을 때). */
  reloadKey?: string | number;
  /** 최소 높이(px). 내용이 길면 프레임이 알려 주는 높이로 자란다. */
  minHeight?: number;
}

export const ArtifactFrame: React.FC<ArtifactFrameProps> = ({
  artifact,
  reloadKey,
  minHeight = 420,
}) => {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(minHeight);
  const [error, setError] = useState('');

  // 프레임에서 오는 말 — 창 자체로 판정한다 (불투명 오리진이라 origin 은 'null').
  useEffect(() => {
    const onMessage = (ev: MessageEvent): void => {
      const frame = frameRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'artifact:height') {
        const h = Number(msg.height) || 0;
        if (h > 0) setHeight(Math.max(minHeight, Math.min(h + 8, 20000)));
        return;
      }
      if (msg.type === 'artifact:ready') {
        setError('');
        return;
      }
      if (msg.type === 'artifact:error') {
        // 프레임은 자기 오류를 자기 화면에 이미 그린다(변환 실패·렌더 예외·비동기
        // 예외 전부). 여기서 같은 문장을 한 번 더 띄우면 사용자는 같은 오류를 두 번
        // 읽는다. 이 배너는 **호스트만 아는 실패**(런타임을 못 받아온 경우) 자리다.
        return;
      }
      if (msg.type === 'artifact:fetch') {
        const id = msg.id;
        const reply = (payload: Record<string, unknown>): void => {
          frame.contentWindow?.postMessage({ type: 'artifact:fetch-result', id, ...payload }, '*');
        };
        const call = xgen?.artifacts?.callApi;
        if (!call) {
          // 다리가 없으면 **반드시 답을 준다.** 조용히 넘기면 프레임의 promise 가
          // 영원히 안 풀려, 아티팩트는 '불러오는 중' 에서 멈춘 채 이유를 못 밝힌다.
          reply({ ok: false, error: '이 창에서는 아티팩트 데이터를 불러올 수 없습니다.' });
          return;
        }
        void call(
          artifact.apis,
          String(msg.alias ?? ''),
          (msg.params as Record<string, string | number | boolean | undefined> | null) ?? null,
        )
          .then((data) => reply({ ok: true, data }))
          .catch((e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [artifact.apis, minHeight]);

  // 프레임이 뜨면 런타임과 소스를 건넨다. 목적지 오리진은 '*' 일 수밖에 없다
  // (샌드박스 문서라 오리진이 없다) — 대신 보내는 내용에 비밀이 없다.
  const onLoad = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    setError('');
    loadRuntime()
      .then(({ runtimeJs, babelJs }) => {
        frame.contentWindow?.postMessage(
          {
            type: 'artifact:init',
            runtimeJs,
            babelJs,
            entry: artifact.entry,
            source: artifact.source,
            files: artifact.files,
          },
          '*',
        );
      })
      .catch((e: unknown) => {
        setError(`실행 런타임을 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [artifact.entry, artifact.source, artifact.files]);

  return (
    <div className="artifact-frame-host">
      {error ? <pre className="artifact-run-error">{error}</pre> : null}
      <iframe
        key={`${artifact.slug}:${reloadKey ?? ''}`}
        ref={frameRef}
        title={artifact.title}
        src={ARTIFACT_FRAME_URL}
        onLoad={onLoad}
        /* allow-same-origin 을 **절대** 더하지 않는다 (위 2번 자물쇠). */
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ width: '100%', height, border: 0, background: '#fff' }}
      />
    </div>
  );
};

export default ArtifactFrame;
