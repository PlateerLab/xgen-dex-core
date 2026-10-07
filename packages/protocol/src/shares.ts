/**
 * 공유: 앱 공유와 채팅 공유가 함께 쓰는 공개 범위·문구, 그리고 채팅 공유 API(/api/chat/shares).
 *
 * 공개 범위는 둘이다.
 *   users   XGEN 사용자에게 공유: 로그인한 사람만 연다. 로그인하지 않았으면 웹이 로그인 화면으로 보냈다가
 *           로그인이 끝나면 그 링크로 되돌린다.
 *   public  모두에게 공유: 링크를 아는 누구나 로그인 없이 연다.
 *
 * 채팅 공유는 대화를 **그 시점까지** 얼린 링크다. 대화가 그대로면 공유 창을 다시 열어도 같은 링크이고,
 * 턴이 늘면 다시 공유할 때 새 링크가 만들어진다(앞 링크는 그 시점 그대로 남는다). 같은 링크에서 범위·
 * 선택(작업 과정·파일 공개)을 바꾸면 그 링크가 바뀐다. 공유된 화면은 웹(/share/chat/<token>)이 그린다.
 *
 * 문구는 데스크톱·모바일·웹이 같은 말을 하도록 여기 한 곳에 둔다.
 */
import type { HttpClient } from './client';

export type ShareAudience = 'users' | 'public';

export const SHARE_AUDIENCES: readonly ShareAudience[] = ['users', 'public'];

/** 서버가 모르는 값을 주면 users(더 좁은 쪽)로 읽는다. */
export function toShareAudience(value: unknown): ShareAudience {
  return value === 'public' ? 'public' : 'users';
}

/** 서버가 준 경로(`/share/...`) → 그 서버의 절대 주소. */
export function shareLinkUrl(serverBase: string, path: string): string {
  if (!path) return '';
  return `${String(serverBase || '').replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 앱 공유 창의 문구(웹 [앱 공유] 창과 같은 말). */
export const APP_SHARE_TEXT = {
  title: '앱 공유',
  intro: '앱 화면과 그 안의 데이터가 보입니다. 공유를 켜면 [앱 스토어]에도 나옵니다.',
  audience: '공개 범위',
  users: {
    title: 'XGEN 사용자에게 공유',
    hint: 'XGEN의 유저만 볼 수 있습니다.',
  },
  public: {
    title: '모두에게 공유',
    hint: '링크를 아는 사람은 누구나 로그인 없이 엽니다.',
  },
  link: '공유 링크',
  linkKept: '범위를 바꿔도 링크는 그대로입니다.',
  create: '링크 만들기',
  created: '공유 링크를 만들고 복사했습니다',
  createdNoCopy: '공유 링크를 만들었습니다',
  audienceChanged: '공개 범위를 바꿨습니다. 링크는 그대로입니다',
  copy: '링크 복사',
  copied: '복사됨',
  open: '새 창으로 열기',
  stop: '공유 중지',
  stopAsk: '공유를 중지할까요? 이미 나간 링크는 되살아나지 않습니다.',
  stopDone: '공유를 중지했습니다',
  cancel: '취소',
  close: '닫기',
  loading: '불러오는 중…',
  notReady: '열리지 않는 앱은 공유할 수 없습니다.',
  shareSettings: '공유 설정',
  /** 옛 서버는 범위를 모른다(그때는 모두에게 공개였다). 고른 범위와 실제가 다르면 사실대로 말한다. */
  /** 공유 중인데 링크를 다시 받지 못했다(옛 서버 등). 새로 만들면 옛 링크가 끊기므로 중지만 둔다. */
  linkLost: '공유 중이지만 링크를 다시 받지 못했습니다. 공유를 중지했다가 다시 만들 수 있습니다.',
  audienceUnsupported: '이 서버는 공개 범위를 고를 수 없어 모두에게 공유되었습니다. 필요하면 공유를 중지하세요.',
} as const;

/** 채팅 공유 창의 문구(웹 [채팅 공유] 창과 같은 말). */
export const CHAT_SHARE_TEXT = {
  button: '공유',
  buttonTitle: '지금까지의 대화를 링크로 공유합니다',
  title: '채팅 공유',
  intro: (turns: number) =>
    `지금까지 나눈 대화 ${turns}턴을 이 시점 그대로 공유합니다. 이어서 나누는 대화는 이 링크에 담기지 않습니다.`,
  empty: '아직 끝난 대화가 없어 공유할 것이 없습니다.',
  running: '지금 답하고 있는 턴은 끝난 뒤에 공유에 담깁니다. 지금 만들면 그 앞까지만 담깁니다.',
  audience: '공개 범위',
  users: {
    title: 'XGEN 사용자에게 공유',
    hint: 'XGEN의 유저만 볼 수 있습니다.',
  },
  public: {
    title: '모두에게 공유',
    hint: '링크를 아는 사람은 누구나 로그인 없이 봅니다.',
  },
  contents: '함께 공유할 것',
  process: { title: '작업 과정 공개', hint: '답마다 에이전트가 거친 단계(도구 호출과 결과)를 보여 줍니다.' },
  files: {
    title: '파일 공개',
    hint: '첨부한 파일, 답의 다운로드, 에이전트가 만든 파일을 공유한 그 판으로 받을 수 있습니다.',
  },
  link: '공유 링크',
  linkHint:
    '범위나 공유할 것을 바꿔도 링크는 그대로입니다. 대화가 이어지면 다시 공유할 때 새 링크가 만들어집니다.',
  create: '링크 만들기',
  creating: '만드는 중…',
  apply: '바꾼 내용 반영',
  created: '공유 링크를 만들고 복사했습니다',
  createdNoCopy: '공유 링크를 만들었습니다',
  updated: '공유 링크에 반영했습니다. 링크는 그대로입니다',
  copy: '링크 복사',
  copied: '복사됨',
  open: '새 창으로 열기',
  stop: '공유 중지',
  stopAsk: '이 링크의 공유를 중지할까요? 이미 나간 링크는 되살아나지 않습니다.',
  stopDone: '공유를 중지했습니다',
  previous: (count: number) => `앞 시점의 링크 ${count}개`,
  previousRow: (turns: number, audience: ShareAudience, when: string) =>
    `${turns}턴까지 · ${audience === 'public' ? '모두' : 'XGEN 사용자'}${when ? ` · ${when}` : ''}`,
  cancel: '취소',
  close: '닫기',
  loading: '불러오는 중…',
  loadError: '공유 상태를 불러오지 못했습니다',
} as const;

/** 주인이 보는 채팅 공유 링크 하나. */
export interface ChatShareLink {
  token: string;
  /** 공유 화면 경로(`/share/chat/<token>`). 앞에 서버 주소를 붙이면 링크다(shareLinkUrl). */
  path: string;
  audience: ShareAudience;
  include_process: boolean;
  include_files: boolean;
  last_io_id: number | null;
  turn_count: number;
  title: string;
  created_at: string | null;
}

/** 채팅 공유 창이 여는 상태. */
export interface ChatShareState {
  /** 지금 공유하면 담기는 시점(끝난 마지막 턴). 끝난 턴이 없으면 last_io_id 가 null. */
  checkpoint: { last_io_id: number | null; turn_count: number };
  /** 도는 턴이 있는가. 그 턴은 끝나야 공유에 담긴다. */
  running: boolean;
  /** 지금 시점의 링크. 없으면 null. */
  share: ChatShareLink | null;
  /** 이 대화에서 앞 시점에 만든 살아 있는 링크들(최근 것부터). */
  previous: ChatShareLink[];
}

export interface ChatShareInput {
  workflowId: string;
  interactionId: string;
  audience: ShareAudience;
  includeProcess: boolean;
  includeFiles: boolean;
}

const CHAT_SHARES_BASE = '/api/chat/shares';

function toLink(raw: Partial<ChatShareLink> | null | undefined): ChatShareLink | null {
  if (!raw || !raw.token) return null;
  return {
    token: String(raw.token),
    path: String(raw.path ?? `/share/chat/${raw.token}`),
    audience: toShareAudience(raw.audience),
    include_process: raw.include_process !== false,
    include_files: raw.include_files !== false,
    last_io_id: typeof raw.last_io_id === 'number' ? raw.last_io_id : null,
    turn_count: Number(raw.turn_count ?? 0) || 0,
    title: String(raw.title ?? ''),
    created_at: raw.created_at ? String(raw.created_at) : null,
  };
}

export class ChatSharesApi {
  constructor(private http: HttpClient) {}

  /** 공유 창이 여는 상태(지금 시점·그 링크·앞 링크들). 대화의 주인만 읽는다. */
  async state(workflowId: string, interactionId: string): Promise<ChatShareState> {
    const params = new URLSearchParams({ workflow_id: workflowId, interaction_id: interactionId });
    const res = await this.http.get<Partial<ChatShareState> & { share?: Partial<ChatShareLink> | null; previous?: Partial<ChatShareLink>[] }>(
      `${CHAT_SHARES_BASE}/state?${params}`,
    );
    return {
      checkpoint: {
        last_io_id: typeof res?.checkpoint?.last_io_id === 'number' ? res.checkpoint.last_io_id : null,
        turn_count: Number(res?.checkpoint?.turn_count ?? 0) || 0,
      },
      running: Boolean(res?.running),
      share: toLink(res?.share ?? null),
      previous: (res?.previous ?? []).map((p) => toLink(p)).filter((p): p is ChatShareLink => p !== null),
    };
  }

  /** 지금 시점의 링크를 만들거나(이미 있으면 그 링크) 범위·선택을 바꾼다. */
  async create(input: ChatShareInput): Promise<{ share: ChatShareLink; reused: boolean }> {
    // 파일을 얼리는 데 시간이 걸린다(첨부·다운로드·만든 파일을 복사한다).
    const res = await this.http.post<{ share?: Partial<ChatShareLink>; reused?: boolean }>(CHAT_SHARES_BASE, {
      workflow_id: input.workflowId,
      interaction_id: input.interactionId,
      audience: input.audience,
      include_process: input.includeProcess,
      include_files: input.includeFiles,
    }, { timeoutMs: 120_000 });
    const share = toLink(res?.share ?? null);
    if (!share) throw new Error('공유 링크를 만들지 못했습니다');
    return { share, reused: Boolean(res?.reused) };
  }

  /** 링크를 끊는다. 끊은 링크는 되살아나지 않는다. */
  async revoke(token: string): Promise<void> {
    await this.http.del(`${CHAT_SHARES_BASE}/${encodeURIComponent(token)}`);
  }
}
