/**
 * 새 에이전트 — 이름과 모델, 그리고 [세부설정].
 *
 * 여기서 만드는 것은 그래프가 아니라 **에이전트 하나**다. Agent XGeny 는 캔버스 노드
 * 하나로 완결된다 — 도구도 기억도 위임도 자기진화도 그 안에 있다. 그래서 이 화면이
 * 물어야 할 것은 "무엇을 연결할까"가 아니라 "이름이 무엇이고 어떤 모델로 생각하는가"
 * 뿐이고, 나머지는 만들어진 뒤 **에이전트와 대화하며** 에이전트가 스스로 붙인다.
 *
 * 프로바이더·모델·설정 목록을 여기 적어 두지 않는다. 노드에는 파라미터가 28개 있고
 * 같은 화면이 웹과 CLI 에도 있다. 세 곳이 각자 적어 두면 노드가 바뀔 때마다 세 곳이
 * 조용히 낡는다. 서버가 노드에서 읽어 내려 주고, 화면은 받은 대로 그린다.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentCreateOptions, AgentCreateSetting } from '@dex/protocol';
import { xgen } from '../bridge';

/** [세부설정] 안의 차례 — 자주 손대는 것부터. */
const ADVANCED_ORDER = [
  'system_prompt',
  'temperature',
  'max_tokens',
  'max_iterations',
  'context_window',
  'tool_exposure',
  'enable_builtin_tools',
  'enable_self_evolution',
  'enable_delegation',
  'enable_memory',
  'enable_compaction',
  'streaming',
  'base_url',
];

function ordered(settings: AgentCreateSetting[]): AgentCreateSetting[] {
  const rank = (id: string) => {
    const i = ADVANCED_ORDER.indexOf(id);
    return i === -1 ? ADVANCED_ORDER.length : i;
  };
  return [...settings].sort((a, b) => rank(a.id) - rank(b.id));
}

export interface AgentCreateProps {
  /** 만들어진 에이전트 — 곧바로 대화를 연다. */
  onCreated: (agent: { workflowId: string; workflowName: string }) => void;
  onClose: () => void;
}

export function AgentCreate({ onCreated, onClose }: AgentCreateProps) {
  const [options, setOptions] = useState<AgentCreateOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void xgen.agents
      .createOptions()
      .then((data) => {
        if (cancelled) return;
        setOptions(data);
        const first =
          data.providers.find((p) => p.value === data.defaultProvider) ?? data.providers[0];
        if (first) {
          setProvider(first.value);
          setModel(first.defaultModel || first.models[0]?.value || '');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = useMemo(
    () => options?.providers.find((p) => p.value === provider) ?? null,
    [options, provider],
  );

  const changeProvider = useCallback(
    (next: string) => {
      setProvider(next);
      // 모델은 프로바이더에 딸린 것이다. 그대로 두면 OpenAI 모델 이름으로
      // Anthropic 을 부르는 에이전트가 만들어진다.
      const info = options?.providers.find((p) => p.value === next);
      setModel(info?.defaultModel || info?.models[0]?.value || '');
    },
    [options],
  );

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('에이전트 이름을 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await xgen.agents.create({ name: trimmed, provider, model, settings });
      onCreated(created);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [name, provider, model, settings, onCreated]);

  const valueOf = (setting: AgentCreateSetting) =>
    Object.prototype.hasOwnProperty.call(settings, setting.id)
      ? settings[setting.id]
      : setting.default;

  if (loadError) {
    return (
      <div className="agent-create">
        <p className="error">{loadError}</p>
        <button className="secondary" onClick={onClose}>
          닫기
        </button>
      </div>
    );
  }

  return (
    <div className="agent-create">
      <header>
        <h1>새 에이전트</h1>
        <p className="muted">
          이름과 모델만 정하면 됩니다. 도구·기억·자기진화는 이미 안에 있고, 나머지는 만든 뒤
          에이전트와 대화하며 채워 나갑니다.
        </p>
      </header>

      <label className="field">
        <span>에이전트 이름</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 영업 리서치 도우미"
          autoFocus
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>AI 제공사</span>
          <select value={provider} onChange={(e) => changeProvider(e.target.value)} disabled={!options}>
            {(options?.providers ?? []).map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>모델</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!current}>
            {(current?.models ?? []).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button className="link" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
        {advanced ? '▾' : '▸'} 세부설정
      </button>

      {advanced && options && (
        <div className="advanced">
          {ordered(options.settings).map((setting) => (
            <SettingField
              key={setting.id}
              setting={setting}
              value={valueOf(setting)}
              onChange={(v) => setSettings((prev) => ({ ...prev, [setting.id]: v }))}
            />
          ))}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button className="primary" onClick={() => void submit()} disabled={busy || !options || !name.trim()}>
          {busy ? '만드는 중…' : '다음'}
        </button>
        <button className="secondary" onClick={onClose}>
          취소
        </button>
      </div>
    </div>
  );
}

/** 설정 하나 — 노드가 선언한 타입대로 그린다. */
function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: AgentCreateSetting;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const type = (setting.type || '').toUpperCase();

  if (type === 'BOOL') {
    return (
      <label className="switch-field">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <b>{setting.label}</b>
          {setting.description && <small>{setting.description}</small>}
        </span>
      </label>
    );
  }

  if (setting.options && setting.options.length > 0) {
    return (
      <label className="field">
        <span>{setting.label}</span>
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {setting.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {setting.description && <small>{setting.description}</small>}
      </label>
    );
  }

  const numeric = type === 'INT' || type === 'FLOAT' || type === 'NUMBER';
  // 시스템 프롬프트는 한 줄로 받으면 쓸 수가 없다.
  const multiline = setting.id === 'system_prompt';

  return (
    <label className="field">
      <span>{setting.label}</span>
      {multiline ? (
        <textarea rows={5} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          type={numeric ? 'number' : 'text'}
          value={value === null || value === undefined ? '' : String(value)}
          min={setting.min}
          max={setting.max}
          step={setting.step}
          onChange={(e) =>
            onChange(numeric ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)
          }
        />
      )}
      {setting.description && <small>{setting.description}</small>}
    </label>
  );
}
