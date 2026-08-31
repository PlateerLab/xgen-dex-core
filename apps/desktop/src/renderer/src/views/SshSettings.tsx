/**
 * SSH 설정 탭 — 개인별 서버 목록. 웹 마이페이지 [SSH 연동 설정] 과 **같은 저장소**다.
 *
 * 동기화 코드가 없는 것이 설계다: 양쪽 다 서버의 `/api/agentflow/user-ssh` 를
 * 직접 읽고 쓴다. 로컬 사본을 두면 웹에서 지운 서버가 여기 남고, 그 둘을 맞추는
 * 규칙은 결국 사용자가 지운 것을 되살린다.
 *
 * 비밀번호와 개인키는 서버에서 내려오지 않는다 — 화면이 아는 것은 "설정됨" 뿐이다.
 * 그래서 쓰기는 부분 수정이다: 손대지 않은 자격증명은 키 자체를 보내지 않아
 * 유지되고, [지우기]로만 지워진다. 설명만 고치려던 저장이 접속을 끊으면 안 된다.
 *
 * 접속을 여는 주체는 이 PC 가 아니라 **XGEN 서버**다 (에이전트가 거기서 돌기
 * 때문). 그래서 [연결 테스트]도 서버가 대신 다이얼한다 — 이 PC 에서 닿는지는
 * 에이전트에게 아무 의미가 없다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { xgen } from '../bridge';
import { SettingsSection } from './SettingsSection';
import type { SshConfig, SshServer, SshServerInput, SshTestResult } from '@dex/protocol';

const EMPTY: SshConfig = {
  enabled: false,
  servers: [],
  limits: { max_servers: 50, max_jump_depth: 8 },
};

interface Draft {
  /** 편집 대상의 원래 이름. 새로 만들 때는 null. */
  original: string | null;
  name: string;
  host: string;
  port: string;
  username: string;
  description: string;
  strictHostKey: boolean;
  enabled: boolean;
  jump: string[];
  /** undefined = 손대지 않음(유지). '' = 지움. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
}

function draftFrom(server: SshServer | null): Draft {
  if (!server) {
    return {
      original: null, name: '', host: '', port: '22', username: '', description: '',
      strictHostKey: false, enabled: true, jump: [],
      hasPassword: false, hasPrivateKey: false, hasPassphrase: false,
    };
  }
  return {
    original: server.name,
    name: server.name,
    host: server.host,
    port: String(server.port ?? 22),
    username: server.username,
    description: server.description ?? '',
    strictHostKey: !!server.strict_host_key,
    enabled: !!server.enabled,
    jump: [...(server.jump_via ?? [])],
    hasPassword: !!server.has_password,
    hasPrivateKey: !!server.has_private_key,
    hasPassphrase: !!server.has_passphrase,
  };
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    // ApiError 는 서버 detail 을 body 로 싣는다 — 그 문장이 사용자가 읽어야 할 것이다.
    const body = (e as { body?: string }).body;
    if (body) {
      try {
        const parsed = JSON.parse(body) as { detail?: string };
        if (parsed?.detail) return parsed.detail;
      } catch {
        /* body 가 JSON 이 아니면 아래 message 로 */
      }
    }
    return e.message;
  }
  return String(e);
}

/** 자격증명 한 칸 — "저장돼 있음"과 "지금 입력 중"을 구분해서 보여 준다. */
const SecretField: React.FC<{
  label: string;
  stored: boolean;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  multiline?: boolean;
  placeholder?: string;
}> = ({ label, stored, value, onChange, multiline, placeholder }) => {
  const editing = value !== undefined;
  return (
    <div className="field">
      <div className="ssh-secret-head">
        <span>{label}</span>
        <span className="srv-badge">{stored ? '설정됨' : '미설정'}</span>
        <button type="button" className="link" onClick={() => onChange(editing ? undefined : '')}>
          {editing ? '취소' : stored ? '변경' : '입력'}
        </button>
      </div>
      {editing &&
        (multiline ? (
          <textarea
            value={value}
            rows={5}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            type="password"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        ))}
      {editing && stored && (
        <span className="small muted">비워 두고 저장하면 기존 값이 지워집니다.</span>
      )}
    </div>
  );
};

/** 점프 경로 — 필드가 아니라 **사슬**로 보여 준다. 지금 무엇을 만드는지 보이게. */
const JumpEditor: React.FC<{
  value: string[];
  onChange: (next: string[]) => void;
  candidates: string[];
  target: string;
}> = ({ value, onChange, candidates, target }) => {
  const remaining = candidates.filter((c) => !value.includes(c));
  return (
    <div className="ssh-jump">
      <div className="ssh-chain" style={{ marginBottom: 10 }}>
        <span className="ssh-chip muted">XGEN 서버</span>
        {value.map((hop) => (
          <React.Fragment key={hop}>
            <span className="ssh-arrow">→</span>
            <span className="ssh-chip">{hop}</span>
          </React.Fragment>
        ))}
        <span className="ssh-arrow">→</span>
        <span className="ssh-chip target">{target || '…'}</span>
      </div>

      {value.map((hop, i) => (
        <div className="ssh-hop-row" key={hop}>
          <span className="ssh-hop-num">{i + 1}</span>
          <span className="ssh-hop-name">{hop}</span>
          <button
            type="button" className="link" disabled={i === 0}
            onClick={() => {
              const next = [...value];
              [next[i - 1], next[i]] = [next[i], next[i - 1]];
              onChange(next);
            }}
          >
            ↑
          </button>
          <button
            type="button" className="link" disabled={i === value.length - 1}
            onClick={() => {
              const next = [...value];
              [next[i], next[i + 1]] = [next[i + 1], next[i]];
              onChange(next);
            }}
          >
            ↓
          </button>
          <button type="button" className="link" onClick={() => onChange(value.filter((h) => h !== hop))}>
            제거
          </button>
        </div>
      ))}

      {candidates.length === 0 ? (
        <p className="settings-hint">먼저 다른 서버를 등록하면 경유지로 지정할 수 있습니다.</p>
      ) : (
        <select
          value=""
          disabled={remaining.length === 0}
          onChange={(e) => {
            if (e.target.value) onChange([...value, e.target.value]);
            e.currentTarget.value = '';
          }}
        >
          <option value="">경유지 추가…</option>
          {remaining.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      )}
    </div>
  );
};

export const SshSettings: React.FC = () => {
  const [config, setConfig] = useState<SshConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [rowError, setRowError] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SshTestResult>>({});

  const load = useCallback(async () => {
    try {
      setConfig(await xgen.ssh.getConfig());
      setLoadError('');
    } catch (e) {
      setLoadError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(
    () => config.servers.map((s) => s.name).filter((n) => n !== draft?.original),
    [config.servers, draft?.original],
  );

  const save = async () => {
    if (!draft) return;
    const body: SshServerInput = {
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: Number(draft.port) || 22,
      username: draft.username.trim(),
      description: draft.description,
      strict_host_key: draft.strictHostKey,
      enabled: draft.enabled,
      jump_via: draft.jump,
    };
    // 손대지 않은 자격증명은 키 자체를 보내지 않는다 — 서버가 기존 값을 유지한다.
    if (draft.password !== undefined) body.password = draft.password;
    if (draft.privateKey !== undefined) body.private_key = draft.privateKey;
    if (draft.passphrase !== undefined) body.passphrase = draft.passphrase;

    setSaving(true);
    setSaveError('');
    try {
      if (draft.original === null) await xgen.ssh.createServer(body);
      else await xgen.ssh.updateServer(draft.original, body);
      setDraft(null);
      await load();
    } catch (e) {
      setSaveError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (server: SshServer) => {
    if (!window.confirm(`'${server.name}' 서버를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setRowError('');
    try {
      setConfig(await xgen.ssh.deleteServer(server.name));
    } catch (e) {
      // 다른 서버의 경유지면 서버가 의존 서버 이름을 붙여 거절한다.
      setRowError(errText(e));
    }
  };

  const test = async (server: SshServer) => {
    setTesting(server.name);
    try {
      const result = await xgen.ssh.testServer(server.name);
      setResults((p) => ({ ...p, [server.name]: result }));
    } catch (e) {
      setResults((p) => ({ ...p, [server.name]: { success: false, error: errText(e) } }));
    } finally {
      setTesting(null);
    }
  };

  const toggleServer = async (server: SshServer, enabled: boolean) => {
    setRowError('');
    try {
      await xgen.ssh.updateServer(server.name, { enabled });
      await load();
    } catch (e) {
      setRowError(errText(e));
    }
  };

  const canSave =
    !!draft &&
    draft.name.trim() !== '' &&
    draft.host.trim() !== '' &&
    draft.username.trim() !== '' &&
    (draft.hasPassword || draft.hasPrivateKey || !!draft.password || !!draft.privateKey);

  if (loading) return <p className="settings-hint">불러오는 중…</p>;
  if (loadError) return <p className="small notice-warn">{loadError}</p>;

  return (
    <>
      <SettingsSection title="SSH 연동">
        <div className="field-row">
          <span>
            SSH 연동 사용
            <span className="small muted" style={{ marginLeft: 8 }}>
              Agent 가 아래 서버에 접속해 명령을 실행합니다
            </span>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={async (e) => {
                try {
                  setConfig(await xgen.ssh.setEnabled(e.target.checked));
                } catch (err) {
                  setRowError(errText(err));
                }
              }}
            />
            <span className="track" />
          </label>
        </div>
        <p className="settings-hint">
          이 설정은 XGEN 계정에 저장되어 웹 마이페이지 [SSH 연동 설정] 과 같은 것을 가리킵니다.
          어느 쪽에서 바꾸든 양쪽에 반영됩니다. 접속은 이 PC 가 아니라 Agent 가 도는 XGEN
          서버에서 이루어집니다.
        </p>
        {config.enabled && config.servers.length === 0 && (
          <p className="small notice-warn">등록된 서버가 없어 켜도 사용할 수 없습니다.</p>
        )}
      </SettingsSection>

      <SettingsSection plain title="서버">
        {rowError && <p className="small notice-warn">{rowError}</p>}
        <div className="srv-list">
          {config.servers.length === 0 && (
            <div className="muted small pad">등록된 서버가 없습니다.</div>
          )}
          {config.servers.map((server) => {
            const result = results[server.name];
            return (
              <div className="srv-row" key={server.name}>
                <label
                  className="switch small-switch"
                  title={server.enabled ? '사용' : '사용 안 함 (다른 서버의 경유지로는 계속 쓰입니다)'}
                >
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={(e) => void toggleServer(server, e.target.checked)}
                  />
                  <span className="track" />
                </label>

                <div className="srv-row-body">
                  <div className="srv-row-name">
                    {server.name}
                    <span className="srv-badge">{server.auth}</span>
                    {!server.enabled && <span className="srv-badge">경유 전용</span>}
                    {server.description && (
                      <span className="small muted">{server.description}</span>
                    )}
                  </div>

                  <div className="srv-row-addr">
                    {server.username}@{server.host}:{server.port}
                  </div>

                  {/* 경유 경로 — 이 서버에만 있는 정보다. 주소만 보면 왜 안 되는지
                      알 수 없으므로, 실제 다이얼 순서를 그대로 그린다. */}
                  {server.jump_via.length > 0 && (
                    <div className="srv-row-path">
                      <span className="ssh-chip muted">XGEN 서버</span>
                      {server.jump_via.map((hop) => (
                        <React.Fragment key={hop}>
                          <span className="ssh-arrow">→</span>
                          <span className="ssh-chip">{hop}</span>
                        </React.Fragment>
                      ))}
                      <span className="ssh-arrow">→</span>
                      <span className="ssh-chip target">{server.name}</span>
                    </div>
                  )}

                  {result && (
                    <div className={`small mcp-test-result ${result.success ? 'notice-ok' : 'notice-warn'}`}>
                      {result.success
                        ? `접속 성공 (${Math.round(result.latency_ms ?? 0)}ms)`
                        : `접속 실패 — ${result.error ?? ''}`}
                    </div>
                  )}
                </div>

                <div className="srv-row-actions">
                  <button
                    type="button" className="link"
                    disabled={testing === server.name}
                    onClick={() => void test(server)}
                  >
                    {testing === server.name ? '접속 중…' : '테스트'}
                  </button>
                  <button type="button" className="link" onClick={() => setDraft(draftFrom(server))}>
                    편집
                  </button>
                  <button type="button" className="link" onClick={() => void remove(server)}>
                    삭제
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <button
            type="button"
            className="secondary"
            disabled={config.servers.length >= config.limits.max_servers}
            onClick={() => { setSaveError(''); setDraft(draftFrom(null)); }}
          >
            + 서버 추가
          </button>
          {config.servers.length >= config.limits.max_servers && (
            <span className="small muted">
              최대 {config.limits.max_servers}대까지 등록할 수 있습니다.
            </span>
          )}
        </div>
      </SettingsSection>

      {draft && (
        <div className="modal-backdrop" onClick={() => setDraft(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{draft.original === null ? '서버 추가' : '서버 편집'}</h2>
              <button className="link" onClick={() => setDraft(null)}>닫기</button>
            </div>
            <div>
              <label className="field">
                <span>이름 <span className="small muted">Agent 가 이 이름으로 지목합니다</span></span>
                <input
                  value={draft.name}
                  placeholder="prod-web"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>호스트</span>
                <input
                  value={draft.host}
                  placeholder="10.0.0.5 또는 server.example.com"
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                />
              </label>
              <div className="ssh-two-col">
                <label className="field">
                  <span>계정</span>
                  <input
                    value={draft.username}
                    placeholder="ubuntu"
                    onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>포트</span>
                  <input
                    value={draft.port}
                    inputMode="numeric"
                    onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                  />
                </label>
              </div>
              <label className="field">
                <span>설명 <span className="small muted">(선택 — Agent 가 함께 읽습니다)</span></span>
                <input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>

              <div className="ssh-form-section">
              <h3 className="settings-group-title">인증</h3>
              <p className="settings-hint">
                비밀번호나 개인키 중 하나는 반드시 필요합니다. 둘 다 넣으면 키로 접속하고
                비밀번호는 sudo 에 쓰입니다.
              </p>
              <SecretField
                label="비밀번호"
                stored={draft.hasPassword}
                value={draft.password}
                onChange={(v) => setDraft({ ...draft, password: v })}
              />
              <SecretField
                label="개인키"
                multiline
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                stored={draft.hasPrivateKey}
                value={draft.privateKey}
                onChange={(v) => setDraft({ ...draft, privateKey: v })}
              />
              <SecretField
                label="키 암호"
                stored={draft.hasPassphrase}
                value={draft.passphrase}
                onChange={(v) => setDraft({ ...draft, passphrase: v })}
              />

              </div>

              <div className="ssh-form-section">
              <h3 className="settings-group-title">점프 경로</h3>
              <p className="settings-hint">
                이 서버에 바로 닿지 않을 때, 거쳐 갈 서버를 순서대로 지정합니다.
                등록된 다른 서버를 골라 씁니다.
              </p>
              <JumpEditor
                value={draft.jump}
                onChange={(next) => setDraft({ ...draft, jump: next })}
                candidates={candidates}
                target={draft.name.trim()}
              />

              </div>

              <div className="ssh-form-section">
              <h3 className="settings-group-title">고급</h3>
              <div className="field-row">
                <span>
                  호스트 키 검증
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    새로 만든 서버는 대개 꺼 둡니다
                  </span>
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={draft.strictHostKey}
                    onChange={(e) => setDraft({ ...draft, strictHostKey: e.target.checked })}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="field-row">
                <span>
                  이 서버 사용
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    끄면 Agent 에게 보이지 않지만 다른 서버의 경유지로는 계속 쓰입니다
                  </span>
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  />
                  <span className="track" />
                </label>
              </div>

              </div>

              {saveError && <p className="small notice-warn">{saveError}</p>}

              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                <button className="link" onClick={() => setDraft(null)}>취소</button>
                <button className="primary" disabled={!canSave || saving} onClick={() => void save()}>
                  {saving ? '저장 중…' : '저장'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
