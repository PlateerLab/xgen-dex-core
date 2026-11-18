/**
 * MCP 카탈로그 — 관리자가 설치 명령 · 런타임 · 변수를 미리 정의해 둔 MCP 를 고르고,
 * 변수만 넣으면 Dexon 이 이 PC 에 설치 · 실행 · 에이전트 연결까지 한다.
 *
 * 화면: 검색 · 분류 · 카드 목록 → 상세(설치 안내 · 런타임 상태 · 변수 입력) → 단계별 진행
 * (런타임 확인 → 설치 → 설정 → 연결 테스트 → 완료). 실패하면 원인 · 해결 방법 · 로그.
 * 실제 설치는 메인 프로세스가 하고(네이티브 확인 창 포함), 이 화면은 값과 진행만 다룬다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { CatalogItem, CatalogValues, CatalogVariable } from '@dex/protocol/mcp-catalog';
import {
  catalogVariableOptions,
  isRequiredVariable,
  isSecretVariable,
  validateCatalogValues,
} from '@dex/protocol/mcp-catalog';
import type { RuntimePlan } from '@dex/engine/mcp-runtime-manager';
import type {
  CatalogInstallProgress,
  CatalogInstallResult,
  CatalogInstallStage,
} from '@dex/engine/mcp-catalog-install';
import { xgen, copyText } from '../bridge';
import type { McpServerConfig } from '../../../main/config';
import { Markdown } from './Markdown';
import { Selector } from './Selector';
import {
  CATALOG_STAGE_LABELS,
  catalogCategories,
  catalogErrorTitle,
  catalogInstallState,
  filterCatalog,
  formatBytes,
  initialCatalogValues,
  newJobId,
  runtimeBadge,
} from './mcp-catalog-model';

const STAGES: CatalogInstallStage[] = ['check', 'install', 'setup', 'test', 'done'];

type StepState = Partial<Pick<CatalogInstallProgress, 'status' | 'message' | 'percent' | 'lines'>>;

interface Job {
  id: string;
  mode: 'install' | 'update';
  steps: Partial<Record<CatalogInstallStage, StepState>>;
  current?: CatalogInstallStage;
  result?: CatalogInstallResult;
  startedAt: number;
}

const ItemIcon: React.FC<{ item: CatalogItem; size?: number }> = ({ item, size = 36 }) => {
  const [broken, setBroken] = useState(false);
  if (item.icon_url && !broken && /^https:\/\//.test(item.icon_url)) {
    return (
      <img
        className="mcp-cat-icon"
        src={item.icon_url}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className="mcp-cat-icon mcp-cat-icon-letter"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {(item.name || item.catalog_id).trim().charAt(0).toUpperCase()}
    </span>
  );
};

const StateBadge: React.FC<{ state: 'available' | 'installed' | 'update' }> = ({ state }) =>
  state === 'installed' ? (
    <span className="mcp-cat-state ok">설치됨</span>
  ) : state === 'update' ? (
    <span className="mcp-cat-state update">업데이트 있음</span>
  ) : null;

/** 런타임 상태 한 덩어리 — "Node 24 이상 필요 — 자동 설치" 와 받을 것 · 직접 할 일. */
const RuntimeStatus: React.FC<{
  plan: RuntimePlan | null;
  error?: string;
  onRecheck: () => void;
}> = ({ plan, error, onRecheck }) => {
  if (error) return <div className="mcp-cat-runtime warn small">런타임 확인 실패: {error}</div>;
  if (!plan) return <div className="mcp-cat-runtime small muted">런타임 확인 중…</div>;
  if (plan.ready) {
    return (
      <div className="mcp-cat-runtime ok small">
        <span className="mcp-dot ok" /> {plan.summary}
      </div>
    );
  }
  if (plan.manual) {
    return (
      <div className="mcp-cat-runtime warn small">
        <strong>{plan.manual.title}</strong>
        <div>{plan.manual.summary}</div>
        <ol className="mcp-cat-steps-manual">
          {plan.manual.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        <div className="row" style={{ gap: 8 }}>
          <button className="secondary" onClick={() => void xgen.openExternal(plan.manual!.url)}>
            설치 안내 열기
          </button>
          <button className="link" onClick={onRecheck}>
            다시 확인
          </button>
        </div>
      </div>
    );
  }
  if (plan.unsupported) {
    return (
      <div className="mcp-cat-runtime warn small">
        {plan.unsupported}{' '}
        <button className="link" onClick={onRecheck}>
          다시 확인
        </button>
      </div>
    );
  }
  return (
    <div className="mcp-cat-runtime pending small">
      <div>
        <span className="mcp-dot pending" /> {plan.summary}
      </div>
      <ul className="mcp-hints">
        {plan.downloads.map((d) => (
          <li key={d.component}>
            {d.label} {d.version} · {d.approximate ? '약 ' : ''}
            {formatBytes(d.size)} — 설치를 누르면 확인 창에서 받을 곳을 보여 드립니다
          </li>
        ))}
      </ul>
      <div className="muted">
        관리자 권한 없이 이 앱 폴더에만 설치하며, 다른 프로그램에는 영향이 없습니다.
      </div>
    </div>
  );
};

const VariableField: React.FC<{
  v: CatalogVariable;
  value: CatalogValues[string];
  error?: string;
  secretSaved: boolean;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}> = ({ v, value, error, secretSaved, disabled, onChange }) => {
  const label = (
    <span>
      {v.label || v.name}
      {isRequiredVariable(v) && v.type !== 'boolean' && (
        <span className="mcp-cat-required"> *</span>
      )}
      {!isRequiredVariable(v) && v.type !== 'boolean' && <span className="muted"> (선택)</span>}
    </span>
  );
  const hint = v.description ? <span className="small muted">{v.description}</span> : null;
  const err = error ? <span className="small notice-warn">{error}</span> : null;
  const text =
    typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  if (v.type === 'boolean') {
    return (
      <div className="field-row mcp-cat-bool">
        <span>
          {v.label || v.name}
          {hint && <span className="notification-event-hint small muted">{v.description}</span>}
        </span>
        <label className="switch">
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="track" />
        </label>
      </div>
    );
  }
  if (v.type === 'enum') {
    return (
      <div className="field">
        {label}
        <Selector
          value={text}
          onChange={(next) => onChange(String(next))}
          options={catalogVariableOptions(v).map((o) => ({
            value: o.value,
            label: o.label ?? o.value,
          }))}
          ariaLabel={v.label || v.name}
          disabled={disabled}
        />
        {hint}
        {err}
      </div>
    );
  }
  if (v.type === 'path') {
    return (
      <label className="field">
        {label}
        <div className="picker-row">
          <input
            value={text}
            disabled={disabled}
            placeholder={v.placeholder ?? ''}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
          />
          <button
            className="secondary"
            disabled={disabled}
            onClick={(e) => {
              e.preventDefault();
              void xgen.mcpCatalog
                .pickPath({ directory: true, title: v.label || v.name })
                .then((p) => {
                  if (p) onChange(p);
                });
            }}
          >
            찾아보기…
          </button>
        </div>
        {hint}
        {err}
      </label>
    );
  }
  const secret = isSecretVariable(v);
  return (
    <label className="field">
      {label}
      <input
        type={
          secret ? 'password' : v.type === 'number' ? 'number' : v.type === 'url' ? 'url' : 'text'
        }
        value={text}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        placeholder={
          secret && secretSaved ? '저장됨 — 비워 두면 그대로 씁니다' : (v.placeholder ?? '')
        }
        onChange={(e) => onChange(e.target.value)}
      />
      {hint}
      {secret && (
        <span className="small muted">
          이 PC 의 OS 키체인에만 암호화해 저장합니다. 서버로 보내지 않습니다.
        </span>
      )}
      {err}
    </label>
  );
};

const StepIcon: React.FC<{ status?: StepState['status']; active: boolean }> = ({
  status,
  active,
}) => {
  if (status === 'ok') return <span className="mcp-cat-step-icon ok">✓</span>;
  if (status === 'failed') return <span className="mcp-cat-step-icon failed">✕</span>;
  if (status === 'cancelled') return <span className="mcp-cat-step-icon failed">–</span>;
  if (status === 'skipped') return <span className="mcp-cat-step-icon skipped">–</span>;
  if (status === 'running' || active) return <span className="mcp-cat-step-icon running" />;
  return <span className="mcp-cat-step-icon" />;
};

const InstallProgress: React.FC<{
  job: Job;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}> = ({ job, onCancel, onRetry, onClose }) => {
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const r = job.result;
  const running = !r;
  return (
    <div className="mcp-cat-progress" role="status">
      <ol className="mcp-cat-steps">
        {STAGES.map((stage) => {
          const st = job.steps[stage];
          const active = running && job.current === stage;
          return (
            <li
              key={stage}
              className={`mcp-cat-step ${st?.status ?? (active ? 'running' : 'pending')}`}
            >
              <StepIcon status={st?.status} active={active} />
              <div className="mcp-cat-step-body">
                <div className="mcp-cat-step-label">{CATALOG_STAGE_LABELS[stage]}</div>
                {st?.message && <div className="small muted">{st.message}</div>}
                {active && typeof st?.percent === 'number' && (
                  <div className="mcp-cat-bar" aria-label={`${st.percent}%`}>
                    <span style={{ width: `${Math.max(2, Math.min(100, st.percent))}%` }} />
                  </div>
                )}
                {active && !!st?.lines?.length && (
                  <ul className="mcp-hints">
                    {st.lines.slice(-6).map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {r && r.ok && (
        <div className="small notice-ok mcp-cat-result">
          {job.mode === 'update' ? '업데이트했습니다' : '설치를 마쳤습니다'} · 서버{' '}
          <code>{r.serverName}</code> · 도구 {r.toolCount ?? 0}개. 에이전트가 다음 대화부터 이
          도구를 씁니다.
          {r.needsAuthorization && (
            <div className="notice-warn">
              이 서버는 OAuth 로그인이 필요합니다. [내 서버] 탭에서 이 서버의 [인가]를 눌러
              브라우저로 로그인하세요.
            </div>
          )}
        </div>
      )}
      {r && !r.ok && (
        <div className={`small mcp-cat-result ${r.cancelled ? 'muted' : 'error'}`}>
          <strong>{catalogErrorTitle(r.code)}</strong>
          {r.message && !r.cancelled && <div>{r.message}</div>}
          {!!r.hints?.length && (
            <ul className="mcp-hints">
              {r.hints.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        {running ? (
          <button className="secondary" onClick={onCancel}>
            취소
          </button>
        ) : (
          <>
            {!!r?.log?.length && (
              <button className="link" onClick={() => setShowLog((v) => !v)}>
                {showLog ? '로그 숨기기' : '로그 보기'}
              </button>
            )}
            {!r?.ok && r?.code !== 'validation' && (
              <button className="secondary" onClick={onRetry}>
                다시 시도
              </button>
            )}
            <button className={r?.ok ? 'primary' : 'secondary'} onClick={onClose}>
              {r?.ok ? '완료' : '닫기'}
            </button>
          </>
        )}
      </div>
      {showLog && r?.log && (
        <div className="mcp-cat-log">
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="link small"
              onClick={() =>
                void copyText(r.log.join('\n')).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? '복사됨' : '로그 복사'}
            </button>
          </div>
          <pre>{r.log.join('\n')}</pre>
        </div>
      )}
    </div>
  );
};

const CatalogDetail: React.FC<{
  item: CatalogItem;
  servers: McpServerConfig[];
  onBack: () => void;
  onInstalled: () => void;
}> = ({ item, servers, onBack, onInstalled }) => {
  const install = catalogInstallState(item, servers);
  const [mode, setMode] = useState<'install' | 'update'>('install');
  const [target, setTarget] = useState<string | null>(null);
  const [values, setValues] = useState<CatalogValues>(() => initialCatalogValues(item.spec));
  const [secretsSet, setSecretsSet] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<RuntimePlan | null>(null);
  const [planError, setPlanError] = useState<string | undefined>();
  const [job, setJob] = useState<Job | null>(null);
  const variables = item.spec.variables ?? [];

  const recheck = () => {
    setPlan(null);
    setPlanError(undefined);
    xgen.mcpCatalog
      .runtime(item.catalog_id)
      .then(setPlan)
      .catch((e) => setPlanError(String((e as Error)?.message ?? e)));
  };
  useEffect(recheck, [item.catalog_id]);

  useEffect(() => {
    const off = xgen.mcpCatalog.onProgress((p) => {
      setJob((j) => {
        if (!j || j.id !== p.jobId || j.result) return j;
        return {
          ...j,
          current: p.stage,
          steps: { ...j.steps, [p.stage]: { ...j.steps[p.stage], ...p } },
        };
      });
    });
    return off;
  }, []);

  const startUpdate = async (serverName: string) => {
    const stored = await xgen.mcpCatalog
      .stored(serverName)
      .catch(() => ({ values: {}, secretsSet: [] }));
    setMode('update');
    setTarget(serverName);
    setValues(initialCatalogValues(item.spec, stored.values));
    setSecretsSet(stored.secretsSet);
    setErrors({});
    setJob(null);
  };

  const run = async () => {
    const check = validateCatalogValues(item.spec, values, {
      keepSecrets: mode === 'update' ? secretsSet : [],
    });
    setErrors(check.errors);
    if (!check.ok) return;
    const id = newJobId();
    setJob({ id, mode, steps: {}, current: 'check', startedAt: Date.now() });
    let result: CatalogInstallResult;
    try {
      result = await xgen.mcpCatalog.install({
        jobId: id,
        catalogId: item.catalog_id,
        values,
        mode,
        serverName: mode === 'update' ? (target ?? undefined) : undefined,
      });
    } catch (e) {
      result = {
        ok: false,
        code: 'unexpected',
        message: String((e as Error)?.message ?? e).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          '',
        ),
        serverName: '',
        log: [],
      };
    }
    if (result.fieldErrors) setErrors(result.fieldErrors);
    setJob((j) => (j && j.id === id ? { ...j, result } : j));
    if (result.ok) {
      onInstalled();
      recheck();
    }
  };

  const running = !!job && !job.result;
  const blocked = !!plan?.manual || !!plan?.unsupported;
  const links = [
    item.homepage_url ? { label: '홈페이지', url: item.homepage_url } : null,
    item.docs_url ? { label: '문서', url: item.docs_url } : null,
  ].filter((x): x is { label: string; url: string } => !!x && /^https?:\/\//.test(x.url));

  return (
    <div className="mcp-cat-detail">
      <button className="link small" onClick={onBack} disabled={running}>
        ← 카탈로그
      </button>
      <div className="mcp-cat-detail-head">
        <ItemIcon item={item} size={44} />
        <div className="mcp-cat-detail-title">
          <div className="mcp-cat-name">
            {item.name} <StateBadge state={install.state} />
          </div>
          <div className="small muted">
            {[item.publisher, item.category, runtimeBadge(item.spec), `판 ${item.revision}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {links.length > 0 && (
            <div className="row small" style={{ gap: 10, marginTop: 2 }}>
              {links.map((l) => (
                <button key={l.url} className="link" onClick={() => void xgen.openExternal(l.url)}>
                  {l.label} ↗
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {item.description && <p className="small mcp-cat-desc">{item.description}</p>}

      {install.servers.length > 0 && (
        <div className="mcp-cat-installed small">
          {install.servers.map((s) => {
            const outdated = (s.catalog?.revision ?? 0) < item.revision;
            return (
              <div key={s.name} className="mcp-cat-installed-row">
                <span className={`mcp-dot ${s.enabled === false ? 'off' : 'ok'}`} />
                <code>{s.name}</code>
                <span className="muted">
                  판 {s.catalog?.revision}
                  {s.enabled === false ? ' · 꺼짐' : ''}
                </span>
                {outdated && (
                  <button
                    className="link"
                    disabled={running}
                    onClick={() => void startUpdate(s.name)}
                  >
                    업데이트(판 {item.revision})
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {item.install_guide && (
        <div className="mcp-cat-guide">
          <Markdown text={item.install_guide} />
        </div>
      )}

      <RuntimeStatus plan={plan} error={planError} onRecheck={recheck} />

      {!job || job.result?.code === 'validation' ? (
        <div className="mcp-form mcp-cat-form">
          {mode === 'update' && (
            <div className="small muted">
              <code>{target}</code> 를 판 {item.revision} 으로 업데이트합니다. 저장된 값을 채워
              두었습니다.{' '}
              <button
                className="link"
                onClick={() => {
                  setMode('install');
                  setTarget(null);
                  setValues(initialCatalogValues(item.spec));
                  setSecretsSet([]);
                }}
              >
                새로 설치로 바꾸기
              </button>
            </div>
          )}
          {variables.length === 0 && (
            <div className="small muted">입력할 값이 없습니다. 바로 설치할 수 있습니다.</div>
          )}
          {variables.map((v) => (
            <VariableField
              key={v.name}
              v={v}
              value={values[v.name]}
              error={errors[v.name]}
              secretSaved={mode === 'update' && secretsSet.includes(v.name)}
              disabled={running}
              onChange={(next) => {
                setValues((cur) => ({ ...cur, [v.name]: next }));
                setErrors((cur) => {
                  if (!cur[v.name]) return cur;
                  const rest = { ...cur };
                  delete rest[v.name];
                  return rest;
                });
              }}
            />
          ))}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6, gap: 8 }}>
            {install.state !== 'available' && mode === 'install' && (
              <span className="small muted">
                이미 설치돼 있습니다 — 다시 설치하면 새 이름으로 하나 더 만듭니다.
              </span>
            )}
            <button
              className="primary"
              disabled={running || blocked || !plan}
              onClick={() => void run()}
            >
              {mode === 'update' ? '업데이트' : '설치'}
            </button>
          </div>
        </div>
      ) : (
        <InstallProgress
          job={job}
          onCancel={() => void xgen.mcpCatalog.cancel(job.id)}
          onRetry={() => void run()}
          onClose={() => setJob(null)}
        />
      )}
    </div>
  );
};

export const McpCatalog: React.FC<{ servers: McpServerConfig[]; onInstalled: () => void }> = ({
  servers,
  onInstalled,
}) => {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = (force = false) => {
    setLoading(true);
    xgen.mcpCatalog
      .list(force)
      .then((r) => {
        setItems(r.items);
        setError(r.error);
        setStale(r.stale);
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), []);

  const categories = useMemo(() => catalogCategories(items), [items]);
  const shown = useMemo(() => filterCatalog(items, query, category), [items, query, category]);
  const current = items.find((i) => i.catalog_id === selected) ?? null;

  if (current) {
    return (
      <CatalogDetail
        item={current}
        servers={servers}
        onBack={() => setSelected(null)}
        onInstalled={onInstalled}
      />
    );
  }

  return (
    <div className="mcp-cat">
      <p className="small muted" style={{ margin: '0 0 8px' }}>
        관리자가 미리 설정해 둔 MCP 입니다. 필요한 값만 넣으면 Dexon 이 이 PC 에 설치하고 실행해
        에이전트에 연결합니다. Node · Python(uv) 이 없으면 함께 설치합니다.
      </p>
      <div className="row mcp-cat-toolbar">
        <input
          className="mcp-cat-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름 · 설명 · 태그로 찾기"
          aria-label="카탈로그 검색"
        />
        <button className="secondary" onClick={() => load(true)} disabled={loading}>
          {loading ? '불러오는 중…' : '새로 고침'}
        </button>
      </div>
      {categories.length > 1 && (
        <div className="row mcp-cat-chips">
          <button
            className={`chip ${category === null ? 'active' : ''}`}
            onClick={() => setCategory(null)}
          >
            전체
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={`chip ${category === c ? 'active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className={`small ${stale ? 'muted' : 'notice-warn'}`} style={{ margin: '6px 0' }}>
          {error}
          {stale ? ' 마지막으로 받은 목록을 보여 드립니다.' : ''}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="small muted pad">
          아직 게시된 카탈로그 항목이 없습니다. 관리자에게 문의하세요.
        </div>
      )}
      {items.length > 0 && shown.length === 0 && (
        <div className="small muted pad">찾는 항목이 없습니다.</div>
      )}
      <div className="mcp-cat-grid">
        {shown.map((item) => {
          const st = catalogInstallState(item, servers);
          return (
            <button
              key={item.catalog_id}
              className="mcp-cat-card"
              onClick={() => {
                setSelected(item.catalog_id);
                void xgen.mcpCatalog.viewed(item.catalog_id).catch(() => undefined);
              }}
            >
              <div className="mcp-cat-card-head">
                <ItemIcon item={item} />
                <div className="mcp-cat-card-title">
                  <div className="mcp-cat-name">{item.name}</div>
                  {item.publisher && <div className="small muted">{item.publisher}</div>}
                </div>
              </div>
              {item.description && (
                <div className="mcp-cat-card-desc small">{item.description}</div>
              )}
              <div className="mcp-cat-card-foot">
                <span className="mcp-badge">{runtimeBadge(item.spec)}</span>
                {item.category && <span className="small muted">{item.category}</span>}
                <StateBadge state={st.state} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
