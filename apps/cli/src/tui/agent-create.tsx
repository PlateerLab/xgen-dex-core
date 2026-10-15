import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentCreateOptions, AgentCreateSetting, CreateAgentInput } from '@dex/engine';
import { publicError } from '@dex/engine';
import type { TuiEngine } from './model';
import { ImeTextInput } from './ime-text-input';

/**
 * 새 에이전트의 칸들: 이름과 모델, 그리고 [세부설정].
 *
 * 여기서 만드는 것은 그래프가 아니라 **에이전트 하나**다. Agent Geny 는 캔버스 노드
 * 하나로 완결된다(도구도 기억도 위임도 자기진화도 그 안에 있다). 그래서 묻는 것은
 * 이름과 모델뿐이고, 나머지는 만들어진 뒤 **에이전트와 대화하며** 에이전트가 스스로
 * 붙인다.
 *
 * 따로 있던 만들기 화면은 시작 화면([새 에이전트로 시작])으로 들어갔다(2026-10-09).
 * 이 파일은 그 칸들의 규칙(불러오기·기본값·제공사에 딸린 모델)만 갖는다.
 *
 * 목록을 여기 적어 두지 않는다. 서버가 노드에서 읽어 내려 주고 화면은 받은 대로
 * 그린다. 같은 화면이 웹과 커넥터에도 있어서, 세 곳이 각자 적어 두면 노드가 바뀔
 * 때마다 조용히 낡는다.
 */

export interface AgentField {
  key: string;
  label: string;
  /** 글자를 치는 칸인가, 골라 넘기는 칸인가. */
  kind: 'text' | 'choice' | 'toggle';
  choices?: Array<{ value: string; label: string }>;
  hint?: string;
}

/** [세부설정] 안의 차례: 자주 손대는 것부터. */
const ADVANCED_ORDER = [
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

function advancedFieldsOf(settings: AgentCreateSetting[]): AgentField[] {
  const rank = (id: string) => {
    const i = ADVANCED_ORDER.indexOf(id);
    return i === -1 ? ADVANCED_ORDER.length : i;
  };
  return [...settings]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((setting) => {
      const type = (setting.type || '').toUpperCase();
      if (type === 'BOOL') return { key: setting.id, label: setting.label, kind: 'toggle' as const };
      if (setting.options && setting.options.length > 0) {
        return {
          key: setting.id,
          label: setting.label,
          kind: 'choice' as const,
          choices: setting.options,
        };
      }
      return { key: setting.id, label: setting.label, kind: 'text' as const };
    });
}

export interface AgentForm {
  options?: AgentCreateOptions;
  loadError?: string;
  values: Record<string, unknown>;
  /** 이름 · AI 제공사 · 모델. */
  baseFields: AgentField[];
  /** [세부설정] 칸들. */
  advancedFields: AgentField[];
  /** 앞뒤 공백을 뗀 이름. */
  name: string;
  setValue: (key: string, value: unknown) => void;
  cycle: (field: AgentField, step: 1 | -1) => void;
  /** 서버에 보낼 모양. 이름·제공사·모델은 따로 실려 간다(설정에 겹쳐 보내면 같은 값이 두 벌이 된다). */
  input: () => CreateAgentInput;
}

export function useAgentForm(engine: TuiEngine, profile: string): AgentForm {
  const [options, setOptions] = useState<AgentCreateOptions | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    let cancelled = false;
    engine
      .agentCreateOptions(profile)
      .then((data) => {
        if (cancelled) return;
        const provider =
          data.providers.find((p) => p.value === data.defaultProvider)?.value ??
          data.providers[0]?.value ??
          '';
        const info = data.providers.find((p) => p.value === provider);
        setOptions(data);
        // 설정마다 제 기본값을 심어 둔다. `defaults` 만 쓰면 거기 없는 칸(창의성 등)이
        // 빈칸으로 보이고, 사용자는 값이 없는 줄 안다. 이미 적은 이름은 지키지 않는다:
        // 이 칸들은 불러온 뒤에야 보인다.
        const seeded: Record<string, unknown> = {};
        for (const setting of data.settings) seeded[setting.id] = setting.default;
        setValues({
          ...seeded,
          ...data.defaults,
          name: '',
          provider,
          model: info?.defaultModel || info?.models[0]?.value || '',
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(publicError(err).message);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, profile]);

  const providerInfo = useMemo(
    () => options?.providers.find((p) => p.value === values.provider),
    [options, values.provider],
  );

  const baseFields: AgentField[] = useMemo(() => {
    if (!options) return [];
    return [
      { key: 'name', label: '이름', kind: 'text', hint: '예: 영업 리서치 도우미' },
      {
        key: 'provider',
        label: 'AI 제공사',
        kind: 'choice',
        choices: options.providers.map((p) => ({ value: p.value, label: p.label })),
      },
      { key: 'model', label: '모델', kind: 'choice', choices: providerInfo?.models ?? [] },
    ];
  }, [options, providerInfo]);

  const advancedFields = useMemo(() => (options ? advancedFieldsOf(options.settings) : []), [options]);

  const setValue = (key: string, value: unknown): void => {
    setValues((prev) => {
      if (key !== 'provider') return { ...prev, [key]: value };
      // 모델은 제공사에 딸린 것이다. 그대로 두면 OpenAI 모델 이름으로 Anthropic 을
      // 부르는 에이전트가 만들어진다.
      const info = options?.providers.find((p) => p.value === value);
      return { ...prev, provider: value, model: info?.defaultModel || info?.models[0]?.value || '' };
    });
  };

  const cycle = (field: AgentField, step: 1 | -1): void => {
    if (field.kind === 'toggle') {
      setValue(field.key, !values[field.key]);
      return;
    }
    const choices = field.choices ?? [];
    if (choices.length === 0) return;
    const at = Math.max(0, choices.findIndex((c) => c.value === String(values[field.key] ?? '')));
    const next = (at + step + choices.length) % choices.length;
    setValue(field.key, choices[next]!.value);
  };

  const name = String(values.name ?? '').trim();

  const input = (): CreateAgentInput => {
    const { name: _n, provider: _p, model: _m, ...settings } = values;
    return {
      name,
      provider: String(values.provider ?? ''),
      model: String(values.model ?? ''),
      settings,
    };
  };

  return { options, loadError, values, baseFields, advancedFields, name, setValue, cycle, input };
}

/** 칸에 보일 값: 켬/끔, 고른 것의 이름, 적은 글. */
export function shownValue(field: AgentField, raw: unknown): string {
  if (field.kind === 'toggle') return raw ? '켬' : '끔';
  if (field.kind === 'choice') {
    return field.choices?.find((c) => c.value === String(raw ?? ''))?.label ?? String(raw ?? '');
  }
  return String(raw ?? '');
}

export const FIELD_LABEL_WIDTH = 24;

/** 한 칸: 왼쪽 이름, 오른쪽 값(글자 칸이 골라져 있으면 입력 칸). */
export function AgentFieldRow(props: {
  field: AgentField;
  value: unknown;
  focused: boolean;
  /** 이 칸이 키를 받는가(화면이 가려졌거나 다른 곳에 있으면 아니다). */
  active: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  nativeIme?: boolean;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
}): React.ReactNode {
  const { field, focused } = props;
  const shown = shownValue(field, props.value);
  return (
    <Box>
      <Box width={FIELD_LABEL_WIDTH} flexShrink={0}>
        <Text color={focused ? 'cyan' : undefined} wrap="truncate-end">
          {focused ? '›' : ' '} {field.label}
        </Text>
      </Box>
      {field.kind === 'text' && focused ? (
        <ImeTextInput
          value={String(props.value ?? '')}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          focus={props.active}
          placeholder={field.hint ?? ''}
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
      ) : (
        <Text dimColor={!focused} wrap="truncate-end">
          {field.kind === 'text' ? shown || field.hint || '' : `‹ ${shown} ›`}
        </Text>
      )}
    </Box>
  );
}
