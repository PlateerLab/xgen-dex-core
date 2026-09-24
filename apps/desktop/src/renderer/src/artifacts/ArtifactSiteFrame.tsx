/**
 * 사이트·앱 아티팩트를 앱에서 여는 자리 — **서버가 내주는 주소를 그대로 띄운다.**
 *
 * 웹에서는 브라우저가 쿠키를 싣고 같은 오리진으로 열어 끝난다. 앱에는 쿠키가
 * 없고 토큰은 main 이 들고 있으므로, main 이 이 주소로 나가는 요청에 자격을
 * 실어 준다(webRequest). 그래서 **문서·자산·fetch·WebSocket 이 모두 같은 길**을
 * 쓴다 — 전용 스킴으로 중계하던 예전 방식은 WebSocket 을 이을 수 없어서, 실시간
 * 으로 도는 앱이 앱에서만 죽었다.
 *
 * 서버 주소를 아직 모르면(설정 전) 열지 않는다 — 빈 프레임보다 낫다.
 */
import React, { useEffect, useState } from 'react';

export interface ArtifactSiteFrameProps {
  workflowId: string;
  slug: string;
  title: string;
  /** 이 값이 바뀌면 프레임을 새로 세운다 (에이전트가 파일을 고쳤을 때). */
  reloadKey?: string | number;
}

export const ArtifactSiteFrame: React.FC<ArtifactSiteFrameProps> = ({
  workflowId,
  slug,
  title,
  reloadKey,
}) => {
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await window.xgen?.config?.get?.();
        if (alive) setServerUrl(String(cfg?.serverUrl ?? '').replace(/\/+$/, ''));
      } catch {
        if (alive) setServerUrl('');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (serverUrl === null) return <div className="artifact-frame-host" />;
  if (!serverUrl) {
    return (
      <div className="artifact-frame-host" role="alert">
        서버 주소가 설정되지 않았습니다.
      </div>
    );
  }

  const base =
    `${serverUrl}/api/agentflow/agent-artifacts/` +
    `${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}/app/`;
  const mark = reloadKey === undefined || reloadKey === '' ? '' : String(reloadKey);
  const src = mark ? `${base}?v=${encodeURIComponent(mark)}` : base;

  // 한 파일 프레임과 **같은 상자**를 쓴다 — 높이는 바깥이 주고 iframe 은 흐름
  // 밖(absolute inset)에 둔다. 두 모양이 다른 상자를 쓰면 한쪽만 주저앉는다.
  return (
    <div className="artifact-frame-host">
      <div className="artifact-frame-box">
        {/*
          sandbox: 최상위 이동(allow-top-navigation)을 주지 않는다 — 에이전트가 쓴 앱이 클릭 한 번 뒤
          앱 창을 다른 페이지로 옮기면 그 페이지가 preload 다리를 얻는다. allow-same-origin 은 준다:
          이 프레임의 오리진은 서버이고 앱 창(file://)과 달라 부모에는 닿지 못하며, 빼면 주인의 앱도
          오리진이 null 이 되어 자격이 실리지 않는다(주인이 아닌 사람에게는 서버가 따로 격리한다).
        */}
        <iframe
          key={src}
          title={title || '아티팩트'}
          src={src}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
      </div>
    </div>
  );
};

export default ArtifactSiteFrame;
