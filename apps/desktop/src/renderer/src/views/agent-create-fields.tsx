/**
 * 새 에이전트의 칸: 이름과 모델, 그리고 [세부설정] (시작 화면이 쓴다).
 *
 * 여기서 만드는 것은 그래프가 아니라 **에이전트 하나**다. Agent Geny 는 캔버스 노드
 * 하나로 완결된다. 도구도 기억도 위임도 자기진화도 그 안에 있다. 그래서 물어야 할 것은
 * "무엇을 연결할까"가 아니라 "이름이 무엇이고 어떤 모델로 생각하는가" 뿐이다.
 *
 * 프로바이더·모델·설정 목록을 여기 적어 두지 않는다. 노드에는 파라미터가 28개 있고
 * 같은 화면이 웹과 CLI 에도 있다. 세 곳이 각자 적어 두면 노드가 바뀔 때마다 세 곳이
 * 조용히 낡는다. 서버가 노드에서 읽어 내려 주고, 화면은 받은 대로 그린다.
 */
import type { AgentCreateSetting } from '@dex/protocol';

/** [세부설정] 안의 차례: 자주 손대는 것부터. */
export const ADVANCED_ORDER = [
  'system_prompt',
  'temperature',
  'max_tokens',
  'max_iterations',
  'context_window',
  'tool_exposure',
  'enable_builtin_tools',
  'enable_self_evolution',
  'enable_memory',
  'enable_compaction',
  'streaming',
  'base_url',
];

/** 마지막에 고른 제공사·모델. 매번 다시 고르지 않게 이 PC 에 기억한다(없으면 서버 기본값). */
const PICK_KEY = 'dex.agentCreate.lastPick';

export function readPick(): { provider?: string; model?: string } {
  try {
    const raw = window.localStorage.getItem(PICK_KEY);
    return raw ? (JSON.parse(raw) as { provider?: string; model?: string }) : {};
  } catch {
    return {};
  }
}

export function writePick(provider: string, model: string): void {
  try {
    window.localStorage.setItem(PICK_KEY, JSON.stringify({ provider, model }));
  } catch {
    // 기억만 못 할 뿐 만드는 데는 지장이 없다
  }
}

export function ordered(settings: AgentCreateSetting[]): AgentCreateSetting[] {
  const rank = (id: string) => {
    const i = ADVANCED_ORDER.indexOf(id);
    return i === -1 ? ADVANCED_ORDER.length : i;
  };
  return [...settings].sort((a, b) => rank(a.id) - rank(b.id));
}

/** 설정 하나: 노드가 선언한 타입대로 그린다. */
export function SettingField({
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
