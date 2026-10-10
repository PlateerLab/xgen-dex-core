import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { publicError } from '@dex/engine';
import type { Agent } from '@dex/engine';
import type { TuiEngine } from './model';
import { AgentFieldRow, FIELD_LABEL_WIDTH, useAgentForm, type AgentField } from './agent-create';
import { Composer } from './components';
import { windowRows } from './conversation-list';
import { ImeTextInput } from './ime-text-input';

/**
 * 시작 화면 (2026-10-09): [＋ 새 채팅] 과 Ctrl+N 이 여는 자리.
 *
 * 예전에는 에이전트를 먼저 고르고(목록), 그 에이전트의 갈림길(새 대화 / 이어가기)을 거쳐야
 * 대화가 열렸고, 에이전트를 만드는 일은 따로 있는 화면이었다. 이제는 웹과 같이 한 화면에서
 * 시작한다: 에이전트를 고르고(맨 앞이자 기본은 [새 에이전트로 시작]) 첫 말을 적어 보낸다.
 *
 * 새 에이전트면 이름이 있어야 하고 이미 있는 이름이면 안 된다. 그때까지 입력창은 잠겨 있다
 * (글은 칠 수 있고, 보내면 무엇이 모자란지 알린다). 이름은 적는 대로 서버에 묻고(잠깐 멈췄을
 * 때만), 만들기 직전에 한 번 더 묻는다. 보내면 에이전트를 세우고, 그 에이전트와 새 대화를 열어
 * 적은 글을 첫 말로 보낸다.
 */

export const START_HEADING = '오늘은 무엇을 해볼까요?';
export const NEW_AGENT_CHOICE = '새 에이전트로 시작';
export const NAME_REQUIRED = '에이전트 이름을 먼저 입력해 주세요.';
export const NAME_TAKEN = '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.';
/** 이름을 적는 동안 묻는 간격: 글자마다 묻지 않고 잠깐 멈췄을 때만. */
export const NAME_CHECK_MS = 300;

const AGENT_ROW = '\u0000agent';
const ADVANCED_ROW = '\u0000advanced';
const COMPOSER_ROW = '\u0000composer';
const PICKER_VISIBLE = 8;

export interface AgentRef {
  workflowId: string;
  workflowName: string;
}

/** 지금 적힌 이름에 대해 서버가 한 답. `unknown` 은 묻지 못했다(보낼 때 다시 묻는다). */
type NameState = 'empty' | 'checking' | 'free' | 'taken' | 'unknown';

export function StartScreen(props: {
  engine: TuiEngine;
  profile: string;
  agents: Agent[];
  /** 이 화면이 키를 받는가. */
  focused: boolean;
  /** 이 화면이 쓸 높이. 칸이 많으면(세부설정) 커서 둘레만 보인다. 없으면 다 그린다. */
  height?: number;
  nativeIme?: boolean;
  hangulMode: boolean;
  onHangulModeChange: (enabled: boolean) => void;
  /** 에이전트 고르기 목록이 열려 있는 동안 대시보드는 키를 놓는다(Esc 가 두 곳에서 듣지 않게). */
  onCapture?: (capturing: boolean) => void;
  /** 고른 있는 에이전트가 바뀌었다(새 에이전트면 undefined). 대시보드가 그 모델을 읽는다(Ctrl+O). */
  onAgentChange?: (agent: AgentRef | undefined) => void;
  /**
   * 미리 골라 둘 에이전트([＋ 이 에이전트로 새 채팅]·[다른 에이전트]). nonce 가 바뀔 때마다 다시 고르고, 적던 첫 말은
   * 그대로 둔다. 고를 수 없는 에이전트(목록에 없다)면 평소대로 시작한다.
   */
  preselect?: { workflowId: string; nonce: number };
  /** 고른 에이전트의 지금 모델("제공자: 모델"). Ctrl+O 로 바꾼다. */
  modelLabel?: string;
  /** 새 에이전트를 세웠다(목록에 넣으라고). */
  onCreated?: (agent: AgentRef) => void;
  /** 이 에이전트와 새 대화를 열고 `text` 를 첫 말로 보낸다. */
  onStart: (agent: AgentRef, text: string) => void;
}): React.ReactNode {
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const form = useAgentForm(props.engine, props.profile);
  const preselected =
    props.preselect && props.agents.some((agent) => agent.workflowId === props.preselect?.workflowId)
      ? props.preselect.workflowId
      : '';
  /** 고른 에이전트. 빈 글이면 [새 에이전트로 시작]. */
  const [choice, setChoice] = useState(preselected);
  const [cursorKey, setCursorKey] = useState(preselected ? COMPOSER_ROW : 'name');
  const [advanced, setAdvanced] = useState(false);
  const [message, setMessage] = useState('');
  const [nameState, setNameState] = useState<NameState>('empty');
  /** 잠긴 채로 보내려 했다: 무엇이 모자란지 보여 준다. */
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [picker, setPicker] = useState<{ query: string; cursor: number }>();

  const chosen = choice ? props.agents.find((agent) => agent.workflowId === choice) : undefined;
  const isNew = !chosen;
  const name = form.name;

  useEffect(() => {
    if (!isNew || !name) {
      setNameState('empty');
      return undefined;
    }
    setNameState('checking');
    let current = true;
    const timer = setTimeout(() => {
      props.engine
        .agentNameTaken(name, props.profile)
        .then((taken) => {
          if (current) setNameState(taken ? 'taken' : 'free');
        })
        .catch(() => {
          if (current) setNameState('unknown');
        });
    }, NAME_CHECK_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [isNew, name, props.engine, props.profile]);

  /** 입력창이 잠긴 까닭. 없으면 보낼 수 있다. */
  const lockReason = ((): string | undefined => {
    if (!isNew) return undefined;
    if (form.loadError) return form.loadError;
    if (!form.options) return '불러오는 중...';
    if (!name) return NAME_REQUIRED;
    if (nameState === 'taken') return NAME_TAKEN;
    if (nameState === 'checking' || nameState === 'empty') return '이름을 확인하는 중...';
    return undefined;
  })();

  useEffect(() => {
    if (!lockReason) setTried(false);
  }, [lockReason]);

  const formRows: AgentField[] = isNew && form.options ? form.baseFields : [];
  const extraRows: AgentField[] = isNew && form.options && advanced ? form.advancedFields : [];
  const rowKeys = [
    AGENT_ROW,
    ...formRows.map((field) => field.key),
    ...(isNew && form.options ? [ADVANCED_ROW] : []),
    ...extraRows.map((field) => field.key),
    COMPOSER_ROW,
  ];
  // 아직 없는 칸(불러오기 전의 이름 칸)을 가리키면 입력창에 둔다. 칸이 생기면 그리로 간다.
  const at = rowKeys.includes(cursorKey) ? cursorKey : COMPOSER_ROW;
  const activeField = [...formRows, ...extraRows].find((field) => field.key === at);

  const pickerItems = useMemo(() => {
    const query = (picker?.query ?? '').trim().toLowerCase();
    const all = [
      { id: '', label: NEW_AGENT_CHOICE },
      ...props.agents.map((agent) => ({ id: agent.workflowId, label: agent.workflowName })),
    ];
    return query ? all.filter((item) => item.label.toLowerCase().includes(query)) : all;
  }, [picker?.query, props.agents]);

  useEffect(() => {
    latest.current.onAgentChange?.(
      chosen ? { workflowId: chosen.workflowId, workflowName: chosen.workflowName } : undefined,
    );
  }, [chosen?.workflowId, chosen?.workflowName]);

  const capturing = picker !== undefined;
  useEffect(() => {
    latest.current.onCapture?.(capturing);
    return () => latest.current.onCapture?.(false);
  }, [capturing]);

  const choose = (id: string): void => {
    setChoice(id);
    setTried(false);
    setError(undefined);
    setPicker(undefined);
    // 있는 에이전트면 바로 첫 말을, 새 에이전트면 이름부터.
    setCursorKey(id ? COMPOSER_ROW : 'name');
  };

  // 이미 떠 있는 시작 화면에 에이전트를 골라 들어왔다. 처음 그릴 때는 위에서 이미 골라 두었다.
  const preselectSeen = useRef(props.preselect?.nonce);
  useEffect(() => {
    const wanted = props.preselect;
    if (!wanted || wanted.nonce === preselectSeen.current) return;
    preselectSeen.current = wanted.nonce;
    if (props.agents.some((agent) => agent.workflowId === wanted.workflowId)) choose(wanted.workflowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.preselect?.nonce]);

  const cycleAgent = (step: 1 | -1): void => {
    const ids = ['', ...props.agents.map((agent) => agent.workflowId)];
    const index = Math.max(0, ids.indexOf(chosen?.workflowId ?? ''));
    setChoice(ids[(index + step + ids.length) % ids.length] ?? '');
    setTried(false);
    setError(undefined);
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    const text = message.trim();
    if (lockReason) {
      setTried(true);
      return;
    }
    if (!text) return;
    setError(undefined);
    if (chosen) {
      latest.current.onStart({ workflowId: chosen.workflowId, workflowName: chosen.workflowName }, text);
      return;
    }
    setBusy('이름을 확인하는 중...');
    try {
      // 적는 동안 받은 답은 그 사이 낡았을 수 있다. 만들기 직전에 한 번 더 묻는다.
      if (await props.engine.agentNameTaken(name, props.profile)) {
        if (alive.current) {
          setNameState('taken');
          setTried(true);
        }
        return;
      }
      if (alive.current) setBusy('에이전트를 만드는 중...');
      const created = await props.engine.createAgent(form.input(), props.profile);
      latest.current.onCreated?.(created);
      // 그 사이 다른 대화로 옮겼으면 거기를 덮지 않는다. 에이전트는 이미 목록에 들어갔다.
      if (alive.current) latest.current.onStart(created, text);
    } catch (reason) {
      if (alive.current) setError(publicError(reason).message);
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  useInput(
    (input, key) => {
      if (picker) {
        if (key.escape) setPicker(undefined);
        else if (key.upArrow) setPicker({ ...picker, cursor: Math.max(0, picker.cursor - 1) });
        else if (key.downArrow) {
          setPicker({ ...picker, cursor: Math.min(Math.max(0, pickerItems.length - 1), picker.cursor + 1) });
        }
        // Enter 는 검색 칸이 받는다(onSubmit).
        return;
      }
      if (busy) return;
      const index = rowKeys.indexOf(at);
      if (key.upArrow) {
        setCursorKey(rowKeys[Math.max(0, index - 1)] ?? at);
        return;
      }
      if (key.downArrow) {
        setCursorKey(rowKeys[Math.min(rowKeys.length - 1, index + 1)] ?? at);
        return;
      }
      // 글자 칸과 입력창은 ←→·Enter 를 스스로 쓴다.
      if (at === COMPOSER_ROW || activeField?.kind === 'text') return;
      const space = input === ' ' && !key.ctrl && !key.meta;
      if (at === AGENT_ROW) {
        if (key.leftArrow) cycleAgent(-1);
        else if (key.rightArrow) cycleAgent(1);
        else if (key.return || space) {
          const ids = ['', ...props.agents.map((agent) => agent.workflowId)];
          setPicker({ query: '', cursor: Math.max(0, ids.indexOf(chosen?.workflowId ?? '')) });
        }
        return;
      }
      if (at === ADVANCED_ROW) {
        if (key.leftArrow || key.rightArrow || key.return || space) setAdvanced((value) => !value);
        return;
      }
      if (!activeField) return;
      if (key.leftArrow) form.cycle(activeField, -1);
      else if (key.rightArrow || space) form.cycle(activeField, 1);
      else if (key.return) setCursorKey(COMPOSER_ROW);
    },
    { isActive: props.focused },
  );

  const formKeys = rowKeys.filter((key) => key !== COMPOSER_ROW);
  const heights = formKeys.map((key) => (key === 'name' && nameState === 'taken' ? 2 : 1));
  // 칸 자리 = 높이 - (테두리 2 + 제목 1 + 빈 줄 1 + 알림 1 + 입력창 3 + 안내 1).
  const budget = props.height ? Math.max(3, props.height - 9) : heights.reduce((sum, h) => sum + h, 0);
  const [start, end] = windowRows(heights, Math.max(0, formKeys.indexOf(at)), budget);
  const fieldOf = (key: string): AgentField | undefined =>
    [...formRows, ...extraRows].find((field) => field.key === key);

  const rowView = (key: string): React.ReactNode => {
    const focused = key === at;
    const mark = focused ? '›' : ' ';
    if (key === AGENT_ROW) {
      return (
        <Box key={key}>
          <Box width={FIELD_LABEL_WIDTH} flexShrink={0}>
            <Text color={focused ? 'cyan' : undefined}>{mark} 에이전트</Text>
          </Box>
          {/* 한 줄로 그려야 좁을 때 끝(모델)부터 잘린다. 따로 두면 고른 이름이 먼저 잘린다. */}
          <Text wrap="truncate-end">
            <Text dimColor={!focused}>‹ {chosen?.workflowName ?? NEW_AGENT_CHOICE} ›</Text>
            {chosen && props.modelLabel ? (
              <>
                <Text color="magenta"> · {props.modelLabel}</Text>
                <Text dimColor> Ctrl+O</Text>
              </>
            ) : null}
          </Text>
        </Box>
      );
    }
    if (key === ADVANCED_ROW) {
      return (
        <Box key={key}>
          <Box width={FIELD_LABEL_WIDTH} flexShrink={0}>
            <Text color={focused ? 'cyan' : undefined}>{mark} 세부설정</Text>
          </Box>
          <Text dimColor={!focused}>‹ {advanced ? '접기' : '펼치기'} ›</Text>
        </Box>
      );
    }
    const field = fieldOf(key);
    if (!field) return null;
    return (
      <Box key={key} flexDirection="column">
        <AgentFieldRow
          field={field}
          value={form.values[field.key]}
          focused={focused}
          active={props.focused && focused && !busy}
          onChange={(value) => form.setValue(field.key, value)}
          onSubmit={() => setCursorKey(COMPOSER_ROW)}
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
        {field.key === 'name' && nameState === 'taken' ? (
          // 칸 이름 폭만큼 들이면 좁은 화면에서 문장이 잘린다. 조금만 들이고 접어서라도 다 보인다.
          <Box paddingLeft={2}>
            <Text color="red">{NAME_TAKEN}</Text>
          </Box>
        ) : null}
      </Box>
    );
  };

  const pickerStart = Math.max(0, Math.min((picker?.cursor ?? 0) - Math.floor(PICKER_VISIBLE / 2), pickerItems.length - PICKER_VISIBLE));
  const pickerView = picker ? (
    <Box flexDirection="column">
      <Box>
        <Box width={FIELD_LABEL_WIDTH} flexShrink={0}>
          <Text color="cyan">› 에이전트 찾기</Text>
        </Box>
        <ImeTextInput
          value={picker.query}
          onChange={(query) => setPicker((current) => (current ? { query, cursor: 0 } : current))}
          onSubmit={() => {
            const item = pickerItems[picker.cursor];
            if (item) choose(item.id);
          }}
          focus={props.focused}
          nativeIme={props.nativeIme}
          hangulMode={props.hangulMode}
          onHangulModeChange={props.onHangulModeChange}
        />
      </Box>
      {pickerItems.slice(pickerStart, pickerStart + PICKER_VISIBLE).map((item, offset) => {
        const index = pickerStart + offset;
        const active = index === picker.cursor;
        const current = item.id === (chosen?.workflowId ?? '');
        return (
          <Text key={item.id || '\u0000new'} color={active ? 'cyan' : undefined} wrap="truncate-end">
            {active ? '›' : ' '} {current ? '●' : '○'} {item.label}
          </Text>
        );
      })}
      {pickerItems.length === 0 ? <Text dimColor>맞는 에이전트가 없습니다.</Text> : null}
    </Box>
  ) : null;

  const shownLock = tried && lockReason && lockReason !== NAME_TAKEN ? lockReason : undefined;
  const hint = picker
    ? '↑↓ 이동 · Enter 고르기 · Esc 닫기'
    : at === COMPOSER_ROW
      ? 'Enter 보내기 · ↑ 위 칸 · Esc 목록'
      : at === AGENT_ROW
        ? '←→ 고르기 · Enter 찾기 · ↑↓ 이동'
        : activeField?.kind === 'text'
          ? 'Enter 입력창으로 · ↑↓ 이동'
          : '←→ 고르기 · ↑↓ 이동';

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={props.focused ? 'cyan' : 'blue'}
        paddingX={1}
      >
        <Text bold>{START_HEADING}</Text>
        <Box height={1} />
        {pickerView ?? (
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {formKeys.slice(start, end).map(rowView)}
            {isNew && form.loadError ? <Text color="red">{form.loadError}</Text> : null}
            {isNew && !form.options && !form.loadError ? <Text dimColor>불러오는 중...</Text> : null}
          </Box>
        )}
      </Box>
      {error ? (
        <Text color="red" wrap="truncate-end">
          {error}
        </Text>
      ) : shownLock ? (
        <Text color="yellow" wrap="truncate-end">
          {shownLock}
        </Text>
      ) : null}
      <Composer
        value={message}
        onChange={setMessage}
        onSubmit={() => void submit()}
        focused={props.focused && at === COMPOSER_ROW && !picker}
        disabled={!!busy}
        disabledText={busy}
        locked={!!lockReason}
        nativeIme={props.nativeIme === true}
        hangulMode={props.hangulMode}
        onHangulModeChange={props.onHangulModeChange}
      />
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );
}
