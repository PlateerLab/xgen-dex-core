import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { CurrentUser } from '../../../core/index';
import { XgenWordmark } from '../brand/Logo';
import { EyeIcon, EyeOffIcon } from '../brand/icons';

export const Login: React.FC<{
  serverUrl: string;
  ssoEnabled: boolean;
  onLoggedIn: (u: CurrentUser) => void;
  onChangeServer: () => void;
}> = ({ serverUrl, ssoEnabled, onLoggedIn, onChangeServer }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 저장 실패 경고 + 보류된 사용자: 화면 전환 전에 반드시 사용자에게 보인다.
  const [warn, setWarn] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<CurrentUser | null>(null);

  // Prefill the remembered email + auto-login checkbox (password is never echoed).
  useEffect(() => {
    xgen.auth
      .loginPrefill()
      .then((p) => {
        if (p.email) setEmail(p.email);
        setRemember(!!p.autoLogin);
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    if (!email || !password) {
      setError('이메일과 비밀번호를 입력하세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user, tokenPersisted, credsPersisted, error } = await xgen.auth.login(
        email,
        password,
        remember,
      );
      // main 이 실패 사유를 구조화해 돌려준다 — IPC 예외 원문이 화면에 새지 않는다.
      if (!user) throw new Error(error || '이메일 또는 비밀번호가 올바르지 않습니다.');
      // 저장 실패 표면화 (무음 금지, geny-connector saved===false 동형):
      // 로그인은 됐지만 세션이 이 실행에만 유지된다 — 리눅스 키링 부재 등.
      // 화면 전환으로 경고가 묻히지 않게 [계속] 확인 후 진입한다.
      if (tokenPersisted === false) {
        setWarn(
          '로그인은 되었지만 보안 저장소(키체인)를 사용할 수 없어 세션이 저장되지 않았습니다. ' +
            '앱을 재시작하면 다시 로그인해야 합니다. (Linux: gnome-keyring 등 키링 서비스와 libsecret 설치 필요)',
        );
        setPendingUser(user);
        return;
      }
      if (remember && credsPersisted === false) {
        setWarn('자동 로그인 정보를 저장하지 못했습니다 — 보안 저장소(키체인)를 확인하세요.');
        setPendingUser(user);
        return;
      }
      onLoggedIn(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : '로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const submitSso = async () => {
    setSsoBusy(true);
    setError(null);
    try {
      const { user, tokenPersisted } = await xgen.auth.ssoLogin();
      if (tokenPersisted === false) {
        setWarn(
          'SSO 로그인은 되었지만 보안 저장소를 사용할 수 없어 앱을 재시작하면 다시 로그인해야 합니다.',
        );
        setPendingUser(user);
        return;
      }
      onLoggedIn(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SSO 로그인에 실패했습니다.');
    } finally {
      setSsoBusy(false);
    }
  };

  const host = serverUrl.replace(/^https?:\/\//, '');

  return (
    <div className="auth-shell">
      <div className="auth-bg" />
      <div className="card">
        <div className="card-brand">
          <XgenWordmark height={34} variant="color" title="XGEN" />
          <span className="sub">Agentic AI Platform</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>이메일</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              autoFocus
            />
          </label>
          <label className="field">
            <span>비밀번호</span>
            <div className="pw-field">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button
                type="button"
                className="pw-toggle"
                tabIndex={-1}
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? '비밀번호 숨기기' : '비밀번호 표시'}
              >
                {showPw ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </label>

          <label className="remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>자동 로그인</span>
          </label>

          {error && (
            <div className="alert-error" role="alert">
              <span aria-hidden>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          {warn && pendingUser && (
            <div className="alert-error" role="alert">
              <span aria-hidden>🔐</span>
              <span>{warn}</span>
            </div>
          )}

          {warn && pendingUser ? (
            <button type="button" className="primary" onClick={() => onLoggedIn(pendingUser)}>
              확인하고 계속
            </button>
          ) : (
            <button type="submit" className="primary" disabled={busy || ssoBusy}>
              {busy ? '로그인 중…' : '로그인'}
            </button>
          )}
        </form>

        {ssoEnabled && !pendingUser && (
          <>
            <div className="auth-divider">
              <span>또는</span>
            </div>
            <button
              type="button"
              className="secondary sso-login-button"
              disabled={busy || ssoBusy}
              onClick={() => void submitSso()}
            >
              {ssoBusy ? 'SSO 인증 중…' : 'SSO 로그인'}
            </button>
          </>
        )}

        <div className="auth-foot">
          <span className="server-pill">
            연결됨: <code>{host}</code>
          </span>
          <button className="link" onClick={onChangeServer}>
            서버 변경
          </button>
        </div>
      </div>
    </div>
  );
};
