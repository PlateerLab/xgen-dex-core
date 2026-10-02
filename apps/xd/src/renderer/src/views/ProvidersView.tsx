/**
 * AI 제공자 — API 키 제공자(Anthropic·OpenAI·Gemini·로컬 서버)와 Claude Code·Codex.
 *
 * 연결 시험은 모델 목록을 받아 보는 것이다(키·주소가 맞으면 받는다). Claude Code·Codex 는 이 PC 에 있는 것을 찾고,
 * 없으면 설치하고, XD 에서 따로 로그인한다(사용자의 기존 로그인과 섞지 않는다).
 */
import React, { useEffect, useState } from 'react';
import type { CliEvent, CliState, LoginFlow } from '../../../main/cli/service';
import type { CliName } from '../../../main/cli/detect';
import type { AccountView } from '../../../main/xd-api';
import { xd } from '../bridge';
import { BASE_URL_KINDS, CLI_KINDS, errorText, KEYLESS_KINDS, KIND_LABEL, useData } from '../data';
import { CheckIcon, PlusIcon, RefreshIcon, TrashIcon } from '../dex';

type Probe = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; count: number } | { state: 'fail'; reason: string };

const probeText = (p: Probe): string =>
  p.state === 'busy' ? '확인하는 중…' : p.state === 'ok' ? `연결됨 · 모델 ${p.count}개` : p.state === 'fail' ? p.reason : '';

/** 모델 목록 실패의 까닭 → 한 문장. */
function failReason(error: string | undefined): string {
  const e = (error ?? '').toLowerCase();
  if (e.includes('401') || e.includes('403') || e.includes('api_key')) return '키가 맞지 않습니다.';
  if (e.includes('unreachable') || e.includes('timeout') || e.includes('connect')) return '서버에 닿지 않습니다.';
  if (e.includes('no models')) return '서버가 모델을 알려 주지 않습니다.';
  return '연결하지 못했습니다.';
}

const AccountRow: React.FC<{ account: AccountView; onChanged: () => void }> = ({ account, onChanged }) => {
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [editKey, setEditKey] = useState(false);
  const [key, setKey] = useState('');
  const test = async () => {
    setProbe({ state: 'busy' });
    try {
      const res = await xd.models.list(account.id);
      setProbe(res.ok ? { state: 'ok', count: res.models.length } : { state: 'fail', reason: failReason(res.error) });
    } catch (e) {
      setProbe({ state: 'fail', reason: errorText(e, '연결하지 못했습니다.') });
    }
  };
  const [error, setError] = useState('');
  return (
    <div className="xd-account">
      <div className="xd-account-main">
        <strong>{account.label}</strong>
        <span className="muted small">
          {KIND_LABEL[account.kind] ?? account.kind}
          {account.baseUrl ? ` · ${account.baseUrl}` : ''}
          {!KEYLESS_KINDS.has(account.kind) ? (account.hasSecret ? ' · 키 있음' : ' · 키 없음') : ''}
        </span>
        {probe.state !== 'idle' && <span className={`xd-probe ${probe.state}`}>{probeText(probe)}</span>}
      </div>
      <div className="xd-account-actions">
        <button type="button" className="secondary" disabled={probe.state === 'busy'} onClick={() => void test()}>
          연결 확인
        </button>
        {!KEYLESS_KINDS.has(account.kind) && (
          <button type="button" className="secondary" onClick={() => setEditKey((v) => !v)}>
            키 바꾸기
          </button>
        )}
        <button
          type="button"
          className="icon-btn sm"
          aria-label="제공자 지우기"
          onClick={() => {
            if (!window.confirm(`이 제공자를 쓰던 에이전트는 제공자를 다시 골라야 하는데, ${account.label} 을(를) 지울까요?`)) return;
            setError('');
            xd.accounts
              .remove(account.id)
              .then(onChanged)
              .catch((e) => setError(errorText(e, '지우지 못했습니다.')));
          }}
        >
          <TrashIcon size={14} />
        </button>
      </div>
      {editKey && (
        <div className="xd-account-key">
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="새 API 키" aria-label="새 API 키" />
          <button
            type="button"
            className="primary"
            disabled={!key.trim()}
            onClick={() => {
              setError('');
              xd.accounts
                .setSecret(account.id, key.trim())
                .then(() => {
                  setKey('');
                  setEditKey(false);
                  onChanged();
                })
                .catch((e) => setError(errorText(e, '키를 저장하지 못했습니다.')));
            }}
          >
            저장
          </button>
        </div>
      )}
      {error && (
        <p className="voice-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

const AddAccount: React.FC<{ kinds: string[]; keyNote: string; onDone: () => void }> = ({ kinds, keyNote, onDone }) => {
  const apiKinds = kinds.filter((k) => !CLI_KINDS.has(k));
  const [kind, setKind] = useState(apiKinds[0] ?? 'anthropic');
  const [label, setLabel] = useState(KIND_LABEL[apiKinds[0] ?? 'anthropic'] ?? '');
  const [baseUrl, setBaseUrl] = useState(BASE_URL_KINDS[apiKinds[0] ?? ''] ?? '');
  const [secret, setSecret] = useState('');
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [error, setError] = useState('');
  const urlField = kind in BASE_URL_KINDS;
  const keyField = !KEYLESS_KINDS.has(kind) || kind === 'openai_compatible';

  const pick = (k: string) => {
    setKind(k);
    setLabel(KIND_LABEL[k] ?? k);
    setBaseUrl(BASE_URL_KINDS[k] ?? '');
    // 다른 제공자의 키가 따라가지 않게.
    setSecret('');
    setProbe({ state: 'idle' });
    setError('');
  };
  const test = async () => {
    setProbe({ state: 'busy' });
    try {
      const res = await xd.models.probe({ kind, baseUrl: urlField ? baseUrl : null, secret: secret || null });
      setProbe(res.ok ? { state: 'ok', count: res.models.length } : { state: 'fail', reason: failReason(res.error) });
    } catch (e) {
      setProbe({ state: 'fail', reason: errorText(e, '연결하지 못했습니다.') });
    }
  };
  const save = async () => {
    setError('');
    try {
      await xd.accounts.create({ kind, label, baseUrl: urlField ? baseUrl : null, ...(secret ? { secret } : {}) });
      onDone();
    } catch (e) {
      setError(errorText(e, '제공자를 추가하지 못했습니다.'));
    }
  };
  return (
    <div className="xd-add">
      <h4>제공자 추가</h4>
      <div className="xd-kind-picker" role="radiogroup" aria-label="제공자 종류">
        {apiKinds.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={k === kind} className={`chip${k === kind ? ' active' : ''}`} onClick={() => pick(k)}>
            {KIND_LABEL[k] ?? k}
          </button>
        ))}
      </div>
      <label className="field">
        <span>이름</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      {urlField && (
        <label className="field">
          <span>서버 주소</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8000/v1" />
        </label>
      )}
      {keyField && (
        <label className="field">
          <span>{KEYLESS_KINDS.has(kind) ? 'API 키(필요할 때만)' : 'API 키'}</span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={keyNote} />
        </label>
      )}
      {probe.state !== 'idle' && <p className={`xd-probe ${probe.state}`}>{probeText(probe)}</p>}
      {error && (
        <div className="voice-error small" role="alert">
          {error}
        </div>
      )}
      <div className="xd-actions">
        <button type="button" className="secondary" disabled={probe.state === 'busy'} onClick={() => void test()}>
          연결 확인
        </button>
        <button type="button" className="primary" disabled={!label.trim() || (keyField && !KEYLESS_KINDS.has(kind) && !secret.trim()) || (urlField && !baseUrl.trim())} onClick={() => void save()}>
          추가
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          취소
        </button>
      </div>
    </div>
  );
};

const CLI_LABEL: Record<CliName, string> = { claude: 'Claude Code', codex: 'Codex' };
const CLI_KIND: Record<CliName, string> = { claude: 'claude_code', codex: 'codex' };

type LoginView = { phase: 'idle' } | ({ phase: 'running' } & LoginFlow) | { phase: 'failed'; reason: string };

const LOGIN_FAIL: Record<string, string> = {
  invalid_code: '코드가 맞지 않아 다시 로그인해야 합니다.',
  timeout: '로그인 시간이 지나 다시 로그인해야 합니다.',
  not_logged_in: '로그인이 끝나지 않아 다시 로그인해야 합니다.',
};

/**
 * Claude Code·Codex 한 칸. 설치·로그인의 진행은 main 이 들고 있다 — 이 화면을 떠났다 돌아와도 상태(받는 중·로그인
 * 주소·코드)를 다시 받아 이어 보인다. 로그인이 끝나면 main 이 그 CLI 의 계정을 만든다(하나만).
 */
const CliPanel: React.FC<{ name: CliName; accounts: AccountView[]; onAccounts: () => void }> = ({ name, accounts, onAccounts }) => {
  const [state, setState] = useState<CliState | null>(null);
  const [installing, setInstalling] = useState<{ received: number; total: number } | null>(null);
  const [login, setLogin] = useState<LoginView>({ phase: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const refresh = (seed = false) =>
      xd.cli
        .state(name)
        .then((s) => {
          if (!alive) return;
          setState(s);
          if (seed) {
            // 떠났다 돌아온 화면 — 도는 설치·로그인을 이어 보인다.
            if (s.installing) setInstalling(s.installing);
            if (s.loginFlow) setLogin({ phase: 'running', ...s.loginFlow });
          }
        })
        .catch((e) => alive && setError(errorText(e, '상태를 확인하지 못했습니다.')));
    void refresh(true);
    const off = xd.onCliEvent((event: CliEvent) => {
      if (event.cli !== name) return;
      if (event.type === 'install_progress') setInstalling({ received: event.received, total: event.total });
      else if (event.type === 'install_done') {
        setInstalling(null);
        if (!event.ok) setError(errorText(new Error(event.error), '설치하지 못했습니다.'));
        void refresh();
      } else {
        const ev = event.event;
        if (ev.type === 'url') setLogin((l) => ({ ...(l.phase === 'running' ? l : {}), phase: 'running', url: ev.url }));
        else if (ev.type === 'code') setLogin((l) => ({ ...(l.phase === 'running' ? l : {}), phase: 'running', code: ev.code }));
        else if (ev.type === 'needs_code') setLogin((l) => ({ ...(l.phase === 'running' ? l : {}), phase: 'running', needsCode: true }));
        else if (ev.type === 'done') {
          // 사용자가 [그만두기]를 눌렀으면 알릴 것이 없다.
          setLogin(ev.ok || ev.error === 'cancelled' ? { phase: 'idle' } : { phase: 'failed', reason: LOGIN_FAIL[ev.error] ?? '로그인하지 못했습니다.' });
          setCode('');
          void refresh();
        }
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [name]);

  const refresh = () =>
    xd.cli
      .state(name)
      .then(setState)
      .catch((e) => setError(errorText(e, '상태를 확인하지 못했습니다.')));

  const install = () => {
    setError('');
    setInstalling({ received: 0, total: 0 });
    // 끝은 install_done 사건으로 받는다(실패 문구도 거기서).
    xd.cli.install(name).catch(() => undefined);
  };

  const startLogin = () => {
    setError('');
    setLogin({ phase: 'running' });
    xd.cli.login(name).catch((e) => setLogin({ phase: 'failed', reason: errorText(e, '로그인을 시작하지 못했습니다.') }));
  };

  const installed = state?.installed ?? null;
  const loggedIn = !!state?.login?.loggedIn;
  const hasAccount = accounts.some((a) => a.kind === CLI_KIND[name]);
  const pct = installing && installing.total ? Math.round((installing.received / installing.total) * 100) : null;

  return (
    <div className="xd-card xd-cli">
      <div className="xd-cli-head">
        <h3>{CLI_LABEL[name]}</h3>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="다시 확인"
          onClick={() =>
            void xd.cli
              .detect(name)
              .then(refresh)
              .catch((e) => setError(errorText(e, '상태를 확인하지 못했습니다.')))
          }
        >
          <RefreshIcon size={14} />
        </button>
      </div>
      {!state ? (
        <p className="muted small">확인하는 중…</p>
      ) : (
        <>
          <p className="xd-cli-line">
            {installed ? (
              <>
                <CheckIcon size={13} /> 설치됨{installed.version ? ` · ${installed.version}` : ''}
                <span className="muted small"> · {installed.source === 'xd' ? 'XD 가 설치함' : '이 PC 에 있던 것'}</span>
              </>
            ) : (
              <span className="muted">이 PC 에 설치되어 있지 않습니다.</span>
            )}
          </p>
          {installing ? (
            <div className="xd-progress" role="progressbar" aria-valuenow={pct ?? undefined}>
              <span style={{ width: `${pct ?? 5}%` }} />
              <em>{pct === null ? '받는 중…' : `받는 중 ${pct}%`}</em>
            </div>
          ) : (
            <div className="xd-actions">
              <button type="button" className={installed ? 'secondary' : 'primary'} onClick={install}>
                {installed ? '최신 판으로 업데이트' : '설치'}
              </button>
            </div>
          )}
          {installed && (
            <div className="xd-cli-login">
              <p className="xd-cli-line">
                {loggedIn ? (
                  <>
                    <CheckIcon size={13} /> 로그인됨{state.login?.email ? ` · ${state.login.email}` : ''}
                  </>
                ) : (
                  <span className="muted">XD 에서 아직 로그인하지 않았습니다.</span>
                )}
              </p>
              {login.phase === 'running' ? (
                <div className="xd-login-flow">
                  {login.url && (
                    <button type="button" className="secondary" onClick={() => void xd.openExternal(login.url!)}>
                      브라우저에서 로그인 열기
                    </button>
                  )}
                  {login.code && (
                    <p className="xd-device-code">
                      이 코드를 입력하세요 <strong>{login.code}</strong>
                    </p>
                  )}
                  {login.needsCode && (
                    <div className="xd-account-key">
                      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="로그인을 마친 뒤 보이는 코드를 붙여 넣으세요" aria-label="로그인 코드" />
                      <button
                        type="button"
                        className="primary"
                        disabled={!code.trim()}
                        onClick={() => xd.cli.loginCode(name, code.trim()).catch((e) => setError(errorText(e, '코드를 보내지 못했습니다.')))}
                      >
                        확인
                      </button>
                    </div>
                  )}
                  {!login.url && <p className="muted small">로그인 주소를 받는 중…</p>}
                  <button type="button" className="secondary" onClick={() => void xd.cli.loginCancel(name)}>
                    그만두기
                  </button>
                </div>
              ) : (
                <div className="xd-actions">
                  {loggedIn && !hasAccount && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() =>
                        xd.cli
                          .useAccount(name)
                          .then(onAccounts)
                          .catch((e) => setError(errorText(e, '계정을 만들지 못했습니다.')))
                      }
                    >
                      에이전트에서 쓰기
                    </button>
                  )}
                  {loggedIn ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        xd.cli
                          .logout(name)
                          .then(refresh)
                          .catch((e) => setError(errorText(e, '로그아웃하지 못했습니다.')))
                      }
                    >
                      로그아웃
                    </button>
                  ) : (
                    <button type="button" className="primary" onClick={startLogin}>
                      로그인
                    </button>
                  )}
                </div>
              )}
              {login.phase === 'failed' && (
                <p className="voice-error small" role="alert">
                  {login.reason}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p className="voice-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export const ProvidersView: React.FC = () => {
  const { accounts, kinds, reloadAccounts } = useData();
  const [adding, setAdding] = useState(false);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  useEffect(() => {
    xd.accounts
      .secretsStatus()
      .then((s) => setEncrypted(s.encrypted))
      .catch(() => setEncrypted(false));
  }, []);
  const apiAccounts = accounts.filter((a) => !CLI_KINDS.has(a.kind));
  // 암호화를 쓸 수 없는 PC 도 있다(설정에서 자세히) — 그때 "암호화" 라고 말하지 않는다.
  const keyNote = encrypted ? '키는 이 PC 에만 암호화해 둡니다' : '키는 이 PC 에만 둡니다';
  return (
    <div className="xd-page">
      <div className="xd-page-head">
        <h2>AI 제공자</h2>
        <p className="muted small">에이전트가 쓸 모델을 연결하고, {encrypted ? '키는 이 PC 에만 암호화해 둡니다.' : '키는 이 PC 에만 둡니다.'}</p>
      </div>

      <section className="xd-card">
        <div className="xd-cli-head">
          <h3>API 키 · 로컬 서버</h3>
          {!adding && (
            <button type="button" className="secondary xd-inline-btn" onClick={() => setAdding(true)}>
              <PlusIcon size={13} /> 제공자 추가
            </button>
          )}
        </div>
        {apiAccounts.length === 0 && !adding && <p className="muted small">아직 연결한 제공자가 없습니다.</p>}
        {apiAccounts.map((a) => (
          <AccountRow key={a.id} account={a} onChanged={() => void reloadAccounts()} />
        ))}
        {adding && (
          <AddAccount
            kinds={kinds}
            keyNote={keyNote}
            onDone={() => {
              setAdding(false);
              void reloadAccounts();
            }}
          />
        )}
      </section>

      <CliPanel name="claude" accounts={accounts} onAccounts={() => void reloadAccounts()} />
      <CliPanel name="codex" accounts={accounts} onAccounts={() => void reloadAccounts()} />
    </div>
  );
};
