/**
 * XD 의 첫 화면 — 지금은 이 앱이 어디에 자리 잡았는지(루트·작업 공간)를 보여 준다.
 *
 * 화면은 Dex 와 같은 코드를 쓴다(2026-10-02 결정). 여기서 쓰는 마크다운 렌더러가 그 첫 조각이다 — 채팅·
 * 작업 과정·파일 보기·IDE 도 같은 방식으로 붙는다.
 */
import React, { useEffect, useState } from 'react';
import { Markdown } from '../../../../desktop/src/renderer/src/views/Markdown';
import { xd } from './bridge';
import type { XdInfo } from '../../main/ipc';

const SOURCE_TEXT: Record<XdInfo['rootSource'], string> = {
  install: '설치 폴더',
  home: '홈 폴더',
  moved: '설정에서 옮긴 곳',
  env: '환경 변수(XD_DATA_ROOT)',
  dev: '개발 실행',
};

export const App: React.FC = () => {
  const [info, setInfo] = useState<XdInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    xd.info()
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="center">{error}</div>;
  if (!info) return <div className="center muted small">불러오는 중…</div>;
  const text = [
    '## XD',
    '',
    '이 PC 에서 에이전트를 돌리는 로컬용 XGEN Dex 입니다.',
    '',
    `- 루트 폴더: \`${info.root}\` (${SOURCE_TEXT[info.rootSource]})`,
    `- 작업 공간: \`${info.workspace}\``,
    `- 판: v${info.version}`,
  ].join('\n');
  return (
    <div className="center" style={{ alignItems: 'stretch', maxWidth: 640, margin: '0 auto', gap: 16 }}>
      <Markdown text={text} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="primary" onClick={() => void xd.openFolder('workspace')}>
          작업 공간 열기
        </button>
        <button type="button" className="secondary" onClick={() => void xd.openFolder('root')}>
          루트 폴더 열기
        </button>
      </div>
    </div>
  );
};
