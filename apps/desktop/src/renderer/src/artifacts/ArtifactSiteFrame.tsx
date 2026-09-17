/**
 * 사이트 아티팩트를 앱에서 여는 자리 — **서버가 서빙하는 사이트를 그대로 띄운다.**
 *
 * 한 파일짜리 아티팩트(ArtifactFrame)는 소스를 받아 프레임 안에서 변환해 돌리지만,
 * 사이트는 파일이 여럿이라 그럴 수 없다. 웹에서는 브라우저가 쿠키를 싣고 같은
 * 오리진으로 열어 끝나는데, 앱에는 쿠키가 없고 토큰은 main 이 들고 있다. 그래서
 * 전용 스킴(xgensite://)으로 열고, main 이 자격을 붙여 서버에서 받아 온다.
 *
 * 그 오리진은 렌더러와 **다르다** — 사이트는 window.xgen(이 PC 의 셸·파일·키체인
 * 으로 이어지는 다리)에 닿지 못한다.
 */
import React from 'react';
import { artifactSiteUrl } from '../../../main/ipc';

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
  const base = artifactSiteUrl(workflowId, slug);
  const mark = reloadKey === undefined || reloadKey === '' ? '' : String(reloadKey);
  const src = mark ? `${base}?v=${encodeURIComponent(mark)}` : base;
  // 한 파일 프레임과 **같은 상자**를 쓴다 — 높이는 바깥이 주고 iframe 은 흐름
  // 밖(absolute inset)에 둔다. 두 모양이 다른 상자를 쓰면 한쪽만 주저앉는다.
  return (
    <div className="artifact-frame-host">
      <div className="artifact-frame-box">
        <iframe key={src} title={title || '아티팩트'} src={src} />
      </div>
    </div>
  );
};

export default ArtifactSiteFrame;
