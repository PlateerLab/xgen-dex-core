/** 설정 — 이 앱이 어디에 자리 잡았는지, 키를 어떻게 지키는지, 실행 엔진의 상태. */
import React, { useEffect, useState } from 'react';
import type { SecretStatus } from '../../../main/secrets';
import { xd } from '../bridge';
import { useData } from '../data';
import { FolderOpenIcon } from '../dex';

/** 루트가 어디서 정해졌는지 — "이 폴더(…)" 의 괄호 안. */
const SOURCE_TEXT: Record<string, string> = {
  install: '설치 폴더',
  home: '홈 폴더',
  moved: '옮긴 폴더',
  env: '환경 변수로 정한 폴더',
  dev: '개발용 폴더',
};

export const SettingsView: React.FC = () => {
  const { info } = useData();
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [engine, setEngine] = useState<{ running: boolean; info: Record<string, unknown> | null } | null>(null);
  useEffect(() => {
    void xd.accounts.secretsStatus().then(setSecrets);
    void xd.engine.status().then((s) => setEngine(s as { running: boolean; info: Record<string, unknown> | null }));
  }, []);
  if (!info) return null;
  return (
    <div className="xd-page">
      <div className="xd-page-head">
        <h2>설정</h2>
      </div>
      <section className="xd-card">
        <h3>폴더</h3>
        <div className="xd-kv">
          <span>루트 폴더</span>
          <code title={info.root}>{info.root}</code>
          <button type="button" className="icon-btn sm" aria-label="루트 폴더 열기" onClick={() => void xd.openFolder('root')}>
            <FolderOpenIcon size={15} />
          </button>
        </div>
        <p className="muted small">
          이 폴더{SOURCE_TEXT[info.rootSource] ? `(${SOURCE_TEXT[info.rootSource]})` : ''}에 에이전트의 작업 공간과 대화가 모두 있습니다.
        </p>
        <div className="xd-kv">
          <span>작업 공간</span>
          <code title={info.workspace}>{info.workspace}</code>
          <button type="button" className="icon-btn sm" aria-label="작업 공간 열기" onClick={() => void xd.openFolder('workspace')}>
            <FolderOpenIcon size={15} />
          </button>
        </div>
      </section>
      <section className="xd-card">
        <h3>API 키 보관</h3>
        {secrets === null ? (
          <p className="muted small">확인하는 중…</p>
        ) : secrets.encrypted ? (
          <p className="small">키는 이 PC 의 보안 저장소로 암호화해 둡니다.</p>
        ) : (
          <p className="xd-warn small">이 PC 에서는 암호화를 쓸 수 없어 키를 파일 권한으로만 지킵니다.</p>
        )}
      </section>
      <section className="xd-card">
        <h3>실행 엔진</h3>
        <p className="small">{engine === null ? '확인하는 중…' : engine.running ? '실행 중입니다.' : '첫 대화를 보낼 때 시작합니다.'}</p>
      </section>
      <p className="muted small xd-version">
        XD {info.version}
        {engine?.running && engine.info?.runtime ? ` · 런타임 ${String(engine.info.runtime)}` : ''}
      </p>
    </div>
  );
};
