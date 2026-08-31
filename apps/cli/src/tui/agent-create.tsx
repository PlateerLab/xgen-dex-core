import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentCreateOptions, AgentCreateSetting } from '@dex/engine';
import { publicError } from '@dex/engine';
import type { TuiEngine } from './model';
import { ImeTextInput } from './ime-text-input';

/**
 * 새 에이전트 — 이름과 모델, 그리고 [세부설정].
 *
 * 여기서 만드는 것은 그래프가 아니라 **에이전트 하나**다. Agent XGeny 는 캔버스 노드
 * 하나로 완결된다 — 도구도 기억도 위임도 자기진화도 그 안에 있다. 그래서 묻는 것은
 * 이름과 모델뿐이고, 나머지는 만들어진 뒤 **에이전트와 대화하며** 에이전트가 스스로
 * 붙인다.
 *
 * 목록을 여기 적어 두지 않는다. 서버가 노드에서 읽어 내려 주고 화면은 받은 대로
 * 그린다 — 같은 화면이 웹과 커넥터에도 있어서, 세 곳이 각자 적어 두면 노드가 바뀔
 * 때마다 조용히 낡는다.
 */

interface Field {
  key: string;
  label: string;
  /** 글자를 치는 칸인가, 골라 넘기는 칸인가. */
  kind: 'text' | 'choice' | 'toggle';
  choices?: Array<{ value: string; label: string }>;
  hint?: string;
}

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

function advancedFields(settings: AgentCreateSetting[]): Field[] {
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

export function AgentCreateScreen(props: {
  engine: TuiEngine;
  profile: string;
  onCreated: (agent: { workflowId: string; workflowName: string }) => void;
  onCancel: () => void;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
}): React.ReactNode {
  const [options, setOptions] = useState<AgentCreateOptions | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [cursor, setCursor] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    props.engine
      .agentCreateOptions(props.profile)
      .then((data) => {
        if (cancelled) return;
        const provider =
          data.providers.find((p) => p.value === data.defaultProvider)?.value ??
          data.providers[0]?.value ??
          '';
        const info = data.providers.find((p) => p.value === provider);
        setOptions(data);
        // 설정마다 제 기본값을 심어 둔다. `defaults` 만 쓰면 거기 없는 칸(창의성 등)이
        // 빈칸으로 보이고, 사용자는 값이 없는 줄 안다.
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
  }, [props.engine, props.profile]);

  const providerInfo = useMemo(
    () => options?.providers.find((p) => p.value === values.provider),
    [options, values.provider],
  );

  const fields: Field[] = useMemo(() => {
    if (!options) return [];
    const base: Field[] = [
      { key: 'name', label: '이름', kind: 'text', hint: '예: 영업 리서치 도우미' },
      {
        key: 'provider',
        label: 'AI 제공사',
        kind: 'choice',
        choices: options.providers.map((p) => ({ value: p.value, label: p.label })),
      },
      { key: 'model', label: '모델', kind: 'choice', choices: providerInfo?.models ?? [] },
    ];
    return advanced ? [...base, ...advancedFields(options.settings)] : base;
  }, [options, providerInfo, advanced]);

  const active = fields[cursor];
  const name = String(values.name ?? '').trim();

  const setValue = (key: string, value: unknown): void => {
    setValues((prev) => {
      if (key !== 'provider') return { ...prev, [key]: value };
      // 모델은 제공사에 딸린 것이다. 그대로 두면 OpenAI 모델 이름으로 Anthropic 을
      // 부르는 에이전트가 만들어진다.
      const info = options?.providers.find((p) => p.value === value);
      return { ...prev, provider: value, model: info?.defaultModel || info?.models[0]?.value || '' };
    });
  };

  const cycle = (field: Field, step: 1 | -1): void => {
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

  const submit = async (): Promise<void> => {
    if (!name || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // 이름·제공사·모델은 따로 실려 간다. 설정에 겹쳐 보내면 같은 값이 두 벌이 된다.
      const { name: _n, provider: _p, model: _m, ...settings } = values;
      const created = await props.engine.createAgent(
        {
          name,
          provider: String(values.provider ?? ''),
          model: String(values.model ?? ''),
          settings,
        },
        props.profile,
      );
      props.onCreated(created);
    } catch (err) {
      setError(publicError(err).message);
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    // 글자 칸에 있을 때도 이 핸들러는 살아 있어야 한다. 통째로 꺼 두면 이름을 치는
    // 동안 ↑↓ 로 내려갈 수도, Tab 으로 세부설정을 펼칠 수도, Esc 로 나갈 수도 없다.
    // 대신 **글자 칸이 쓰는 키는 건드리지 않는다** — ←→ 는 글자 사이를 오가고,
    // Enter 는 입력 위젯의 onSubmit 이 이미 만든다.
    const onText = active?.kind === 'text';

    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.tab) {
      setAdvanced((v) => !v);
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(fields.length - 1, c + 1));
      return;
    }
    if (!active || onText) return;

    if (key.leftArrow) cycle(active, -1);
    else if (key.rightArrow) cycle(active, 1);
    else if (input === ' ' && !key.ctrl && !key.meta) cycle(active, 1);
    else if (key.return) void submit();
  });

  if (loadError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{loadError}</Text>
        <Text dimColor>Esc 로 돌아갑니다.</Text>
      </Box>
    );
  }
  if (!options) {
    return (
      <Box padding={1}>
        <Text dimColor>불러오는 중...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>새 에이전트</Text>
      <Text dimColor wrap="truncate-end">
        이름과 모델만 정하면 됩니다. 도구·기억·자기진화는 이미 안에 있습니다.
      </Text>
      <Box height={1} />
      {fields.map((field, index) => {
        const focused = index === cursor;
        const raw = values[field.key];
        const shown =
          field.kind === 'toggle'
            ? raw
              ? '켬'
              : '끔'
            : field.kind === 'choice'
              ? (field.choices?.find((c) => c.value === String(raw ?? ''))?.label ??
                String(raw ?? ''))
              : String(raw ?? '');
        return (
          <Box key={field.key}>
            <Box width={24} flexShrink={0}>
              <Text color={focused ? 'cyan' : undefined} wrap="truncate-end">
                {focused ? '›' : ' '} {field.label}
              </Text>
            </Box>
            {field.kind === 'text' && focused ? (
              <ImeTextInput
                value={String(raw ?? '')}
                onChange={(v) => setValue(field.key, v)}
                onSubmit={() => void submit()}
                focus
                placeholder={field.hint ?? ''}
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
      })}
      <Box height={1} />
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor wrap="truncate-end">
        {busy
          ? '만드는 중...'
          : `↑↓ 이동 · ←→ 고르기 · Tab ${advanced ? '세부설정 접기' : '세부설정'} · Enter 만들기 · Esc 취소`}
      </Text>
    </Box>
  );
}
