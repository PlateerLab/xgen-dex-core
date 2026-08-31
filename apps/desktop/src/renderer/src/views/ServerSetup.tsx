import React, { useState } from 'react';
import { xgen } from '../bridge';
import { XgenWordmark } from '../brand/Logo';
import { ServerIcon } from '../brand/icons';
import type { ConnectorConfig } from '../../../main/config';

/** First-run / change-server screen: set the XGEN gateway base URL. */
export const ServerSetup: React.FC<{
  initialConfig: Pick<
    ConnectorConfig,
    'serverUrl' | 'allowPrivateCertificate' | 'ssoEnabled' | 'ssoPath' | 'updateServer'
  >;
  onSaved: () => void;
}> = ({ initialConfig, onSaved }) => {
  const [url, setUrl] = useState(initialConfig.serverUrl);
  const [allowPrivateCertificate, setAllowPrivateCertificate] = useState(
    initialConfig.allowPrivateCertificate ?? false,
  );
  const [ssoEnabled, setSsoEnabled] = useState(initialConfig.ssoEnabled ?? false);
  const [ssoPath, setSsoPath] = useState(initialConfig.ssoPath ?? '/sso/signin');
  const [updateServer, setUpdateServer] = useState<'github' | 'xgen'>(
    initialConfig.updateServer ?? 'github',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) {
      setError('서버 주소를 입력하세요.');
      return;
    }
    const normalizedSsoPath = ssoPath.trim();
    if (ssoEnabled && (!normalizedSsoPath.startsWith('/') || normalizedSsoPath.startsWith('//'))) {
      setError('SSO PATH는 /로 시작하는 상대 경로로 입력하세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 스킴은 사용자가 몰라도 된다 — main 이 https → http 순으로 실제 연결해
      // 확정한 주소를 저장한다. 입력창에도 결과를 되비춰 무엇이 저장됐는지 보인다.
      const probed = await xgen.config.probeServer(trimmed);
      if ('error' in probed) {
        setError(probed.error);
        return;
      }
      setUrl(probed.url);
      await xgen.config.set({
        serverUrl: probed.url,
        allowPrivateCertificate,
        ssoEnabled,
        ssoPath: normalizedSsoPath || '/sso/signin',
        updateServer,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-bg" />
      <div className="card">
        <div className="card-brand">
          <XgenWordmark height={34} variant="color" title="XGEN" />
          <span className="sub">Agentic AI Platform</span>
        </div>
        <h1>서버 연결</h1>
        <p className="muted small">접속할 XGEN 서버(게이트웨이) 주소를 입력하세요.</p>
        <label className="field">
          <span>서버 주소</span>
          <input
            type="text"
            placeholder="xgen.example.com (https는 자동으로 붙습니다)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            autoFocus
          />
        </label>
        <label className="setup-option">
          <input
            type="checkbox"
            checked={allowPrivateCertificate}
            onChange={(e) => setAllowPrivateCertificate(e.target.checked)}
          />
          <span>
            사설 인증서 허용
            <small>설정한 서버의 사설 CA 신뢰 오류만 허용합니다.</small>
          </span>
        </label>
        <label className="setup-option">
          <input
            type="checkbox"
            checked={ssoEnabled}
            onChange={(e) => setSsoEnabled(e.target.checked)}
          />
          <span>SSO 로그인 사용</span>
        </label>
        {ssoEnabled && (
          <label className="field setup-nested-field">
            <span>SSO PATH</span>
            <input
              type="text"
              placeholder="/sso/signin"
              value={ssoPath}
              onChange={(e) => setSsoPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          </label>
        )}
        <div className="setup-update-server">
          <span>
            업데이트 서버
            <small>
              {updateServer === 'xgen'
                ? '설정한 XGEN 서버의 다운로드 센터를 사용합니다.'
                : 'GitHub Releases에서 업데이트를 확인합니다.'}
            </small>
          </span>
          <div className="seg">
            {(['github', 'xgen'] as const).map((source) => (
              <button
                key={source}
                type="button"
                className={updateServer === source ? 'active' : ''}
                onClick={() => setUpdateServer(source)}
              >
                {source === 'github' ? 'GitHub' : 'XGEN'}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <div className="alert-error" role="alert">
            <span aria-hidden>⚠️</span>
            <span>{error}</span>
          </div>
        )}
        <button className="primary" disabled={busy} onClick={() => void save()}>
          <ServerIcon size={15} />
          {busy ? '확인 중…' : '계속'}
        </button>
      </div>
    </div>
  );
};
