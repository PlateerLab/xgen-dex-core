/**
 * 대화 목록과 시작 화면의 규칙: 목록 한 줄의 모양, 대화 기록 빠른 선택 항목, 시작 화면 입력창의 잠금,
 * 새 에이전트의 제공사·모델 기본값.
 *
 * vscode 모듈에 기대지 않는 순수한 부분만 여기 둔다(웹뷰 공급자에서 떼어 냄). 그래야 테스트가 직접 부른다.
 * 제목·꼬리표·[지워짐] 글은 @dex/protocol conversation-list 한 곳에서 온다. 웹뷰(plain JS)는 여기서
 * 만든 줄을 그대로 그릴 뿐 글을 따로 적지 않는다.
 */
import {
  CONVERSATION_TAG_LABELS,
  conversationAgentLabel,
  conversationDisplayTitle,
  conversationKey,
  conversationTagOf,
  conversationTitleFromMetadata,
  foldLegacyConversations,
  mergeConversationPage,
  touchConversation,
  type Agent,
  type AgentCreateOptions,
  type AgentCreateSetting,
  type Conversation,
} from '@dex/protocol';

/** 한 번에 받는 대화 수. */
export const CONVERSATION_PAGE_LIMIT = 40;

// ── 대화 목록 ─────────────────────────────────────────────────────────

/** 웹뷰가 그리는 목록 한 줄. 글은 전부 여기서 정해서 보낸다. */
export interface ConversationRow {
  key: string;
  workflowId: string;
  interactionId: string;
  /** 작게 보이는 에이전트 이름. 에이전트가 사라졌으면 [지워짐]. */
  agentLabel: string;
  agentDeleted: boolean;
  /** 일반 채팅이 아닐 때만(배포 · Teams · 스케줄 · 비교 · API · 테스트 · 캔버스). */
  tagLabel?: string;
  /** 대화 제목. 비어 있으면 "새 대화". */
  title: string;
  /** 지금 열려 있는 대화. */
  active: boolean;
}

export function conversationRow(c: Conversation, activeKey?: string): ConversationRow {
  const key = conversationKey(c);
  return {
    key,
    workflowId: c.workflowId,
    interactionId: c.interactionId,
    agentLabel: conversationAgentLabel(c),
    agentDeleted: c.agentDeleted === true,
    ...(c.tag ? { tagLabel: CONVERSATION_TAG_LABELS[c.tag] } : {}),
    title: conversationDisplayTitle(c),
    active: activeKey === key,
  };
}

export function conversationRows(list: Conversation[], activeKey?: string): ConversationRow[] {
  return list.map((c) => conversationRow(c, activeKey));
}

/** 목록 머리의 정리 버튼 글. */
export function purgeDeletedLabel(count: number): string {
  return `에이전트가 사라진 채팅 제거 (${count})`;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 엔진이 준 목록을 같은 모양으로 맞춘다.
 *
 * 새 엔진(conversationList)은 제목·꼬리표까지 채워 준다. 옛 dex-cli 의 history/conversations 는
 * 제목 없이 metadata 만 주므로, 서버와 같은 규칙(@dex/protocol)으로 제목과 꼬리표를 만들고 비교
 * 파생 스레드를 부모 줄로 접는다. 대화를 가리킬 수 없는 줄은 버린다.
 */
export function normalizeConversations(raw: unknown): Conversation[] {
  if (!Array.isArray(raw)) return [];
  const out: Conversation[] = [];
  let legacy = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Partial<Conversation>;
    const workflowId = text(r.workflowId);
    const interactionId = text(r.interactionId);
    if (!workflowId || !interactionId) continue;
    const metadata = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    const base = {
      id: typeof r.id === 'number' ? r.id : 0,
      interactionId,
      workflowId,
      workflowName: text(r.workflowName),
      interactionCount: typeof r.interactionCount === 'number' ? r.interactionCount : 0,
      metadata,
      createdAt: text(r.createdAt),
      updatedAt: text(r.updatedAt),
      agentDeleted: r.agentDeleted === true,
      agentOwnerId: typeof r.agentOwnerId === 'number' ? r.agentOwnerId : null,
      compare: Array.isArray(r.compare) ? r.compare : [],
    };
    if (typeof r.title === 'string') {
      out.push({ ...base, title: r.title, customTitle: r.customTitle === true, tag: r.tag ?? null });
      continue;
    }
    legacy = true;
    const { title, customTitle } = conversationTitleFromMetadata(metadata);
    out.push({ ...base, title, customTitle, tag: conversationTagOf(interactionId) });
  }
  return legacy ? foldLegacyConversations(out) : out;
}

/** 목록에 아직 없는 대화의 자리표시 줄(창을 다시 켰을 때 되살린 대화, 방금 시작한 대화). */
export function conversationStub(input: {
  workflowId: string;
  workflowName: string;
  interactionId: string;
  interactionCount?: number;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}): Conversation {
  return {
    id: 0,
    interactionId: input.interactionId,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    interactionCount: input.interactionCount ?? 0,
    metadata: {},
    createdAt: input.createdAt ?? '',
    updatedAt: input.updatedAt ?? '',
    title: input.title ?? '',
    customTitle: false,
    tag: conversationTagOf(input.interactionId),
    agentDeleted: false,
    agentOwnerId: null,
    compare: [],
  };
}

/**
 * 이 대화에서 방금 말했다: 목록 맨 위로. 목록에 없던 대화(방금 시작한 새 대화)면 첫 메시지를
 * 제목으로 한 줄을 만들어 맨 위에 둔다(서버와 같은 제목 규칙). `created` 는 새로 만든 줄인가.
 */
export function touchAfterSend(
  list: Conversation[],
  input: { workflowId: string; workflowName: string; interactionId: string; text: string; now: string },
): { list: Conversation[]; created: boolean } {
  const key = conversationKey(input);
  const known = list.find((c) => conversationKey(c) === key);
  if (known) {
    const touched = touchConversation(list, {
      ...known,
      updatedAt: input.now,
      interactionCount: known.interactionCount + 1,
    });
    return { list: touched.list, created: false };
  }
  const stub = conversationStub({
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    interactionId: input.interactionId,
    interactionCount: 1,
    title: conversationTitleFromMetadata({ first_message: input.text }).title,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return { list: [stub, ...list], created: true };
}

/**
 * 첫 쪽을 다시 받았을 때의 목록.
 *
 * - 첫 쪽만 받아 둔 상태면 받은 쪽으로 바꾼다. 다만 이 창에서 방금 시작해 서버 목록에 아직 없는
 *   대화(`localKeys`)는 지우지 않고 맨 위에 둔다.
 * - 뒤쪽까지 받아 둔 상태면 첫 쪽만 새 값으로 바꾸고 뒤쪽은 지킨다(@dex/protocol 규칙).
 */
export function applyFirstPage(
  current: Conversation[],
  page: Conversation[],
  options: { pagesLoaded: number; localKeys: ReadonlySet<string> },
): Conversation[] {
  if (options.pagesLoaded > 1) return mergeConversationPage(current, page, 'head');
  const pageKeys = new Set(page.map(conversationKey));
  const local = current.filter((c) => options.localKeys.has(conversationKey(c)) && !pageKeys.has(conversationKey(c)));
  return [...local, ...page];
}

/** 대화 기록 빠른 선택의 한 항목: 제목, 그 옆에 에이전트 · 꼬리표 · 시각. */
export function historyPickItem(
  c: Conversation,
  formatTime: (iso: string) => string,
): { label: string; description: string } {
  const stamp = c.updatedAt && Number.isFinite(Date.parse(c.updatedAt)) ? formatTime(c.updatedAt) : '';
  const parts = [conversationAgentLabel(c), c.tag ? CONVERSATION_TAG_LABELS[c.tag] : '', stamp].filter(Boolean);
  return { label: conversationDisplayTitle(c), description: parts.join(' · ') };
}

// ── 시작 화면 ─────────────────────────────────────────────────────────

export const START_TEXT = {
  newAgent: '새 에이전트로 시작',
  pickAgent: '에이전트 선택',
  nameRequired: '에이전트 이름을 먼저 입력해 주세요.',
  nameTaken: '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.',
  agentRequired: '에이전트를 먼저 골라 주세요.',
  checkingName: '이름을 확인하는 중입니다.',
  optionsLoading: '모델 목록을 불러오는 중입니다.',
  optionsFailed: '모델 목록을 불러오지 못했습니다.',
  creating: '에이전트를 만드는 중입니다.',
  createFailed: '에이전트를 만들지 못했습니다.',
} as const;

/** 에이전트 선택 상자의 항목. 값이 빈 글이면 "새 에이전트로 시작"(만들 수 없는 엔진이면 고르라는 자리). */
export function startAgentChoices(
  agents: Array<Pick<Agent, 'workflowId' | 'workflowName'>>,
  canCreate: boolean,
): Array<{ value: string; label: string }> {
  return [
    { value: '', label: canCreate ? START_TEXT.newAgent : START_TEXT.pickAgent },
    ...agents.map((agent) => ({ value: agent.workflowId, label: agent.workflowName || agent.workflowId })),
  ];
}

export interface StartLockInput {
  /** 엔진이 에이전트를 만들 수 있는가(agentCreate). */
  canCreate: boolean;
  /** 고른 에이전트. 빈 글이면 새 에이전트. */
  agentId: string;
  /** 고른 에이전트가 목록에 있는가. */
  agentExists: boolean;
  name: string;
  /** 마지막으로 답을 받은 이름 검사. */
  nameCheck?: { name: string; taken: boolean };
  /** 제공사·모델 목록을 받았는가. */
  optionsReady: boolean;
  optionsFailed?: boolean;
  /** 만드는 중. */
  busy: boolean;
}

export type StartLockReason = 'busy' | 'agent' | 'name' | 'taken' | 'options' | 'checking';

export interface StartLock {
  canSend: boolean;
  reason?: StartLockReason;
  /** 잠긴 채 보내려 할 때 보일 글. */
  message?: string;
}

/**
 * 시작 화면의 입력창은 보낼 수 있을 때까지 잠긴다.
 *
 * - 있는 에이전트: 골랐으면 보낼 수 있다.
 * - 새 에이전트: 이름이 있고, 그 이름이 겹치지 않는다고 답을 받았고, 제공사·모델 목록이 있어야 한다.
 *   이름 검사의 답을 기다리는 동안(`checking`)도 잠겨 보이지만, 보내기를 누르면 어차피 한 번 더
 *   묻고 만들므로 보내기 자체는 막지 않는다({@link startSendBlocked}).
 */
export function startComposerLock(input: StartLockInput): StartLock {
  if (input.busy) return { canSend: false, reason: 'busy', message: START_TEXT.creating };
  if (input.agentId) {
    return input.agentExists ? { canSend: true } : { canSend: false, reason: 'agent', message: START_TEXT.agentRequired };
  }
  if (!input.canCreate) return { canSend: false, reason: 'agent', message: START_TEXT.agentRequired };
  const name = input.name.trim();
  if (!name) return { canSend: false, reason: 'name', message: START_TEXT.nameRequired };
  if (input.nameCheck?.name === name && input.nameCheck.taken) {
    return { canSend: false, reason: 'taken', message: START_TEXT.nameTaken };
  }
  if (!input.optionsReady) {
    return {
      canSend: false,
      reason: 'options',
      message: input.optionsFailed ? START_TEXT.optionsFailed : START_TEXT.optionsLoading,
    };
  }
  if (input.nameCheck?.name !== name) return { canSend: false, reason: 'checking', message: START_TEXT.checkingName };
  return { canSend: true };
}

/** 보내기를 눌렀을 때 막는가. 이름 검사의 답을 기다리는 중이면 막지 않는다(보내면서 다시 묻는다). */
export function startSendBlocked(lock: StartLock): boolean {
  return !lock.canSend && lock.reason !== 'checking';
}

/** 시작 화면이 그리는 제공사·모델·세부 설정. 기본값은 미리 정해 둔다. */
export interface StartCreateOptions {
  providers: Array<{
    value: string;
    label: string;
    models: Array<{ value: string; label: string }>;
    /** 이 제공사를 고르면 처음 잡히는 모델(목록에 있다). 모델이 없으면 빈 글. */
    defaultModel: string;
  }>;
  /** 처음 잡히는 제공사(목록에 있다). 제공사가 없으면 빈 글. */
  defaultProvider: string;
  /** 세부 설정. 자주 손대는 것부터. */
  settings: AgentCreateSetting[];
}

/** [세부 설정] 안의 차례: 자주 손대는 것부터(데스크톱 새 에이전트 화면과 같다). */
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

/**
 * 서버가 준 만들기 선택지 → 화면이 그릴 모양. 기본 제공사는 서버의 defaultProvider(없으면 첫 제공사),
 * 기본 모델은 제공사의 defaultModel(없으면 첫 모델)이다. 기본 모델이 목록에 없으면 맨 앞에 넣어
 * 고를 수 있게 한다.
 */
export function prepareCreateOptions(options: AgentCreateOptions): StartCreateOptions {
  const providers = (options.providers ?? [])
    .filter((p) => p && p.value)
    .map((p) => {
      const models = (p.models ?? []).filter((m) => m && m.value);
      const wanted = p.defaultModel?.trim() ?? '';
      const withDefault = wanted && !models.some((m) => m.value === wanted) ? [{ value: wanted, label: wanted }, ...models] : models;
      return {
        value: p.value,
        label: p.label || p.value,
        models: withDefault,
        defaultModel: wanted || withDefault[0]?.value || '',
      };
    });
  const defaultProvider = providers.some((p) => p.value === options.defaultProvider)
    ? options.defaultProvider
    : (providers[0]?.value ?? '');
  const rank = (id: string): number => {
    const i = ADVANCED_ORDER.indexOf(id);
    return i === -1 ? ADVANCED_ORDER.length : i;
  };
  const settings = [...(options.settings ?? [])].filter((s) => s && s.id).sort((a, b) => rank(a.id) - rank(b.id));
  return { providers, defaultProvider, settings };
}

/**
 * 웹뷰가 보낸 세부 설정 값 → 서버로 보낼 값. 목록에 있는 칸만, 칸의 타입대로 맞춘다(BOOL 은 참거짓,
 * INT·FLOAT 는 숫자, 선택지가 있으면 그 안의 값). 빈 칸은 보내지 않아 서버 기본값이 쓰인다.
 * 손댄 칸이 없으면 undefined.
 */
export function sanitizeCreateSettings(
  settings: AgentCreateSetting[],
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const setting of settings) {
    if (!Object.prototype.hasOwnProperty.call(values, setting.id)) continue;
    const value = coerceSetting(setting, values[setting.id]);
    if (value !== undefined) out[setting.id] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function coerceSetting(setting: AgentCreateSetting, value: unknown): unknown {
  const type = (setting.type || '').toUpperCase();
  if (type === 'BOOL' || type === 'BOOLEAN') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (setting.options && setting.options.length > 0) {
    const picked = String(value);
    return setting.options.some((option) => String(option.value) === picked) ? picked : undefined;
  }
  if (type === 'INT' || type === 'INTEGER' || type === 'FLOAT' || type === 'NUMBER') {
    if (typeof value === 'string' && !value.trim()) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return type === 'INT' || type === 'INTEGER' ? Math.trunc(number) : number;
  }
  const str = typeof value === 'string' ? value : String(value);
  return str.trim() ? str : undefined;
}

/** 방금 만든 에이전트. 목록을 다시 받기 전까지 이 모양으로 쓴다. */
export function createdAgent(created: { workflowId: string; workflowName: string }, now: string): Agent {
  return {
    id: 0,
    workflowId: created.workflowId,
    workflowName: created.workflowName,
    nodeCount: 1,
    isShared: false,
    isDeployed: false,
    isCompleted: true,
    description: '',
    username: '',
    fullName: '',
    createdAt: now,
    updatedAt: now,
    hasAgentGeny: true,
  };
}
