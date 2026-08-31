/**
 * XGEN Teams — 사람 사이의 대화 (`/api/teams/*`).
 *
 * 서버는 xgen-workflow 의 teams 모듈이고, 게이트웨이 `services.yaml` 이
 * `teams` 를 workflow-service 로 라우팅한다 — 커넥터가 이미 쓰는 base URL 과
 * 인증(Bearer)이 그대로 통한다. 별도 서버 작업은 필요 없다.
 *
 * 이 파일의 유일한 책임: 서버의 snake_case 응답을 커넥터 타입으로 옮기는 것.
 * 렌더러도 메인 프로세스도 raw 응답을 보지 않는다 — 서버 스키마가 흔들려도
 * 고칠 곳이 여기 하나로 유지된다.
 *
 * 실시간(WebSocket)은 여기 없다. 브라우저 WebSocket 은 핸드셰이크에 헤더를
 * 실을 수 없어 인증이 불가능하므로, WS 는 메인 프로세스 전용
 * (`src/main/teams-ws.ts`)이다.
 */
import { HttpClient } from './client';
import type {
  TeamsAttachment,
  TeamsMember,
  TeamsMessage,
  TeamsReaction,
  TeamsRoom,
  TeamsRouterMode,
  TeamsSenderType,
  TeamsUser,
} from './types';

/** 서버 공통 응답 봉투 — 모든 teams 엔드포인트가 `{success, data}` 로 돌려준다. */
interface Envelope<T> {
  success?: boolean;
  data?: T;
}

type Raw = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : v === null || v === undefined ? fallback : String(v);
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function normalizeRouterMode(v: unknown): TeamsRouterMode {
  const raw = str(v, 'hybrid');
  if (raw === 'chat' || raw === 'manual' || raw === 'hybrid' || raw === 'auto') return raw;
  return 'hybrid';
}

function normalizeSenderType(v: unknown): TeamsSenderType {
  const raw = str(v, 'user');
  if (raw === 'agent' || raw === 'router' || raw === 'system') return raw;
  return 'user';
}

export function mapRoom(raw: unknown): TeamsRoom {
  const r = (raw ?? {}) as Raw;
  return {
    id: str(r.id),
    name: str(r.name, '이름 없는 대화'),
    description: str(r.description) || undefined,
    routerMode: normalizeRouterMode(r.router_mode),
    isDirect: Boolean(r.is_direct),
    createdAt: str(r.created_at),
    createdBy: num(r.created_by),
    lastMessageAt: str(r.last_message_at) || undefined,
  };
}

function mapMember(raw: unknown): TeamsMember {
  const m = (raw ?? {}) as Raw;
  const role = str(m.role, 'member');
  return {
    userId: num(m.user_id),
    username: str(m.username) || `User-${num(m.user_id)}`,
    fullName: str(m.full_name) || str(m.name) || undefined,
    role: role === 'owner' || role === 'admin' ? role : 'member',
    isOnline: Boolean(m.is_online),
    joinedAt: str(m.joined_at),
  };
}

/** 멤버 목록에서 현재 사용자를 제외한 1:1 상대의 표시 이름을 찾는다. */
export function directRoomNameForViewer(
  room: TeamsRoom,
  members: TeamsMember[],
  viewerUserId: string,
): string {
  if (!room.isDirect || !viewerUserId) return room.name;
  const other = members.find((member) => String(member.userId) !== viewerUserId);
  return other ? other.fullName || other.username || room.name : room.name;
}

/**
 * 리액션 집계. 서버는 `[{emoji, count, user_ids, usernames}]` 로 내려준다.
 * "내가 눌렀는가" 는 userIds 로 렌더러가 판정한다 — 서버가 그 필드를 주지 않고,
 * 로그인 사용자 id 는 렌더러가 이미 알고 있다.
 */
function mapReactions(raw: unknown): TeamsReaction[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((item) => {
    const r = (item ?? {}) as Raw;
    return {
      emoji: str(r.emoji),
      count: num(r.count),
      userIds: Array.isArray(r.user_ids) ? r.user_ids.map((x) => num(x)) : [],
    };
  });
}

/**
 * 첨부 메타. 저장 키(storage_key)가 다운로드 주소의 마지막 조각이다.
 *
 * `extracted_text` 는 **버리지 않는다**. 서버는 업로드 때 추출한 본문을 돌려주고,
 * 메시지를 보낼 때 그 값을 같이 실어야만 에이전트가 첨부 내용을 본다
 * (`message_controller` 가 워크플로우 입력에 prepend 한다). 여기서 흘리면
 * 파일은 붙는데 내용은 사라진다.
 */
function mapAttachment(raw: unknown): TeamsAttachment {
  const a = (raw ?? {}) as Raw;
  const extracted = str(a.extracted_text) || str(a.extractedText);
  return {
    id: str(a.id),
    filename:
      str(a.original_filename) || str(a.display_name) || str(a.name) || str(a.filename, 'file'),
    mime: str(a.mime, 'application/octet-stream'),
    size: num(a.size),
    storageKey: str(a.storage_key) || str(a.storageKey),
    extractedText: extracted || undefined,
    truncated: Boolean(a.truncated) || undefined,
  };
}

/**
 * 첨부 목록은 JSONB 컬럼이라 배열로도, JSON 문자열로도 도착한다 (드라이버/경로에
 * 따라 다름). 양쪽 모두 받아 준다.
 *
 * **추출 본문(extractedText)은 여기서 버린다.** 서버는 문서에서 뽑은 본문을
 * 첨부 메타에 실어 보내는데(상한 50만 자), 그건 **보낼 때** 서버로 되돌려주기
 * 위한 값이지 화면이 쓰는 값이 아니다. 받은 메시지마다 들고 있으면 문서가 몇 개만
 * 붙어도 방 하나가 수 MB 를 물고 앉아 있게 되고, 그 방을 닫기 전까지 놓지 않는다.
 * 업로드 응답 경로(`uploadAttachment`)는 `mapAttachment` 를 직접 쓰므로 그쪽은
 * 그대로 유지된다.
 */
function mapAttachments(raw: unknown): TeamsAttachment[] | undefined {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  if (arr.length === 0) return undefined;
  return arr.map((item) => {
    const { extractedText: _drop, ...meta } = mapAttachment(item);
    return meta;
  });
}

/**
 * 발신자 표시 이름. 서버가 빈 문자열이나 누락을 보내는 경우가 있어
 * (message_controller 주석의 실기 사례) 타입별 기본값으로 보정한다.
 */
function senderName(raw: unknown, type: TeamsSenderType, senderId: string): string {
  const name = str(raw).trim();
  if (name) return name;
  if (type === 'system') return '시스템';
  if (type === 'agent') return 'Agent';
  return senderId ? `User-${senderId}` : '알 수 없음';
}

export function mapMessage(raw: unknown): TeamsMessage {
  const m = (raw ?? {}) as Raw;
  const type = normalizeSenderType(m.sender_type);
  const senderId = str(m.sender_id);
  return {
    id: str(m.id),
    roomId: str(m.room_id),
    senderType: type,
    senderId,
    senderName: senderName(m.sender_name, type, senderId),
    content: str(m.content),
    createdAt: str(m.created_at),
    reactions: mapReactions(m.reactions),
    attachments: mapAttachments(m.attachments),
    replyToId: str(m.reply_to_id) || undefined,
    replyToSenderName: str(m.reply_to_sender_name) || undefined,
    replyToContent: str(m.reply_to_content) || undefined,
    isEdited: Boolean(m.is_edited),
    editedAt: str(m.edited_at) || undefined,
  };
}

/** WS 프레임/REST 응답 어디서 온 메시지든 같은 함수로 통과시킨다. 실패는 null. */
export function safeMapMessage(raw: unknown): TeamsMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  try {
    const mapped = mapMessage(raw);
    return mapped.id ? mapped : null;
  } catch {
    return null;
  }
}

export { mapReactions as mapTeamsReactions };

/**
 * 첨부로 올릴 수 있는 확장자 — 서버 `attachment_controller.ALLOWED_EXTENSIONS`
 * 와 **반드시 같아야 한다**. 다르면 사용자가 고를 수는 있는데 서버가 415 로
 * 거절하는, 이유를 알 수 없는 실패가 된다.
 */
export const TEAMS_ATTACHMENT_EXTENSIONS = [
  // 문서
  'pdf',
  'doc',
  'docx',
  'hwp',
  'hwpx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'rtf',
  // 텍스트/데이터
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  // 이미지 (OCR 없이 메타만 붙는다)
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'svg',
] as const;

/** 서버 업로드 상한. 넘으면 413 이므로 올리기 전에 여기서 막는다. */
export const TEAMS_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 올릴 수 없는 파일이면 사용자에게 보여줄 이유를, 올릴 수 있으면 null.
 * 서버에 던져 보고 실패를 번역하는 대신 미리 판정한다 — 50MB 를 다 올린 뒤에
 * 거절당하는 것이 가장 나쁜 경험이다.
 */
export function teamsAttachmentRejectReason(filename: string, size: number): string | null {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (!ext || !(TEAMS_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `${filename}: 올릴 수 없는 형식입니다 (${ext ? `.${ext}` : '확장자 없음'}).`;
  }
  if (size > TEAMS_ATTACHMENT_MAX_BYTES) {
    return `${filename}: 파일이 너무 큽니다 (최대 ${Math.floor(
      TEAMS_ATTACHMENT_MAX_BYTES / 1024 / 1024,
    )}MB).`;
  }
  return null;
}

export interface CreateRoomOptions {
  name: string;
  description?: string;
  /**
   * 기본값 'chat' — 사람끼리만 대화. 커넥터의 1차 목표가 그것이고, 에이전트를
   * 붙일 때는 나중에 방 설정에서 모드를 올리면 된다 (서버가 이미 지원).
   */
  routerMode?: TeamsRouterMode;
}

export class TeamsApi {
  constructor(private http: HttpClient) {}

  // ── 방 ───────────────────────────────────────────────────

  /** 내가 속한 방 전체. 최근 메시지 순 정렬은 호출자(렌더러 store)가 한다. */
  async listRooms(viewerUserId?: string): Promise<TeamsRoom[]> {
    const res = await this.http.get<Envelope<unknown[]>>('/api/teams/rooms/list');
    const rooms = (res.data ?? []).map(mapRoom);
    if (!viewerUserId) return rooms;

    // 서버의 DM room.name 은 방을 만든 사람이 넘긴 target_name 이라 모든 참가자에게
    // 같은 값으로 보인다. 각 1:1 방의 멤버를 기준으로 **나를 제외한 사람**의 이름을
    // 계산해야 A 화면에는 B, B 화면에는 A 로 보인다. 한 방 조회가 실패해도 전체
    // 목록을 버리지 않고 서버 이름으로 물러난다.
    return Promise.all(
      rooms.map(async (room) => {
        if (!room.isDirect) return room;
        try {
          const members = await this.listMembers(room.id);
          return { ...room, name: directRoomNameForViewer(room, members, viewerUserId) };
        } catch {
          return room;
        }
      }),
    );
  }

  async getRoom(roomId: string): Promise<TeamsRoom | null> {
    const res = await this.http.get<Envelope<unknown>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}`,
    );
    return res.data ? mapRoom(res.data) : null;
  }

  async createRoom(opts: CreateRoomOptions): Promise<TeamsRoom> {
    const res = await this.http.post<Envelope<unknown>>('/api/teams/rooms/create', {
      name: opts.name,
      description: opts.description ?? null,
      router_mode: opts.routerMode ?? 'chat',
    });
    return mapRoom(res.data);
  }

  /**
   * 1:1 대화 — 이미 있으면 그 방을, 없으면 새로 만들어 돌려준다.
   * 서버가 `dm:u{min}:u{max}` 키로 중복을 막으므로 클라이언트가 찾을 필요가 없다.
   */
  async openDirectMessage(userId: number, username?: string): Promise<TeamsRoom> {
    const res = await this.http.post<Envelope<{ room?: unknown; room_id?: string }>>(
      '/api/teams/rooms/dm/lookup-or-create',
      {
        target_type: 'user',
        target_id: String(userId),
        target_name: username ?? null,
        target_description: null,
        target_color: null,
      },
    );
    return mapRoom(res.data?.room);
  }

  /**
   * 방 정보 수정 (이름·설명). 서버는 **멤버 전원**에게 허용한다(방장 전용이 아니다).
   *
   * ⚠ 서버가 이 변경을 broadcast 하지 않는다 — 다른 클라이언트는 새로고침 전까지
   * 옛 이름을 본다. 우리 화면만 즉시 갱신할 수 있다.
   */
  async updateRoom(
    roomId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<TeamsRoom | null> {
    const res = await this.http.put<Envelope<unknown>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}`,
      {
        // 서버는 null 을 "변경 없음" 으로 읽는다. 보내지 않을 값은 넣지 않는다.
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      },
    );
    return res.data ? mapRoom(res.data) : null;
  }

  /** 마지막 멤버의 나가기를 빈 방 정리로 바꿀 때만 쓰는 내부 경로. */
  private async deleteRoom(roomId: string): Promise<void> {
    await this.http.del(`/api/teams/rooms/${encodeURIComponent(roomId)}`);
  }

  /**
   * 사용자가 보는 방 종료 동작은 항상 "나가기" 하나다. 마지막 멤버라면 빈 방을
   * 남기지 않도록 내부적으로 방을 정리한다. 멤버 조회나 정리 권한이 없는 구버전
   * 서버에서는 기존 leave API 로 폴백해 사용자가 방에 갇히지 않게 한다.
   */
  async leaveRoom(roomId: string): Promise<void> {
    let lastMember = false;
    try {
      lastMember = (await this.listMembers(roomId)).length <= 1;
    } catch {
      // 멤버 조회를 지원하지 않는 서버에서도 나가기는 계속 가능해야 한다.
    }

    if (lastMember) {
      try {
        await this.deleteRoom(roomId);
        return;
      } catch {
        // 방장 권한/서버 버전 차이로 자동 정리가 안 되면 일반 나가기로 폴백한다.
      }
    }
    await this.http.post(`/api/teams/rooms/${encodeURIComponent(roomId)}/leave`);
  }

  // ── 멤버 ─────────────────────────────────────────────────

  async listMembers(roomId: string): Promise<TeamsMember[]> {
    const res = await this.http.get<Envelope<unknown[]>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/members`,
    );
    return (res.data ?? []).map(mapMember);
  }

  async addMember(roomId: string, userId: number): Promise<void> {
    await this.http.post(`/api/teams/rooms/${encodeURIComponent(roomId)}/members`, {
      user_id: userId,
      role: 'member',
      force_override: false,
    });
  }

  /** 초대 대상 검색. 빈 질의는 서버를 부르지 않는다. */
  async searchUsers(query: string, limit = 20): Promise<TeamsUser[]> {
    const q = query.trim();
    if (!q) return [];
    const params = new URLSearchParams({ q, limit: String(limit) });
    const res = await this.http.get<Envelope<unknown[]>>(`/api/teams/users/search?${params}`);
    return (res.data ?? []).map((item) => {
      const u = (item ?? {}) as Raw;
      const id = num(u.id);
      return {
        id,
        username: str(u.username) || str(u.user_name) || `user_${id}`,
        fullName: str(u.full_name) || str(u.name) || undefined,
        email: str(u.email) || undefined,
      };
    });
  }

  // ── 메시지 ───────────────────────────────────────────────

  /**
   * 메시지 조회 (커서 페이지네이션). `before` 는 더 과거를 부르는 커서이고,
   * 서버는 **최신순**으로 돌려주므로 시간 오름차순 정렬은 호출자가 한다
   * (렌더러 store 의 mergeMessages 가 담당).
   */
  async listMessages(
    roomId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<TeamsMessage[]> {
    const params = new URLSearchParams({ limit: String(opts?.limit ?? 50) });
    if (opts?.before) params.set('before', opts.before);
    const res = await this.http.get<Envelope<unknown[]>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
    );
    return (res.data ?? []).flatMap((raw) => {
      const mapped = safeMapMessage(raw);
      return mapped ? [mapped] : [];
    });
  }

  /**
   * 메시지 전송. 응답의 `data.message` 가 서버가 확정한 메시지다 —
   * 낙관적으로 그려 둔 임시 메시지를 이것으로 교체한다.
   *
   * 라우팅 결과(`data.routing`)는 에이전트 실행용이라 1차 범위에서는 버린다.
   * router_mode='chat' 방에서는 서버가 애초에 에이전트를 부르지 않는다.
   */
  async sendMessage(
    roomId: string,
    content: string,
    opts?: { replyToId?: string; attachments?: TeamsAttachment[] },
  ): Promise<TeamsMessage> {
    const res = await this.http.post<Envelope<{ message?: unknown }>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content,
        mentioned_agent_ids: null,
        attachments: opts?.attachments?.length
          ? opts.attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mime: a.mime,
              size: a.size,
              storage_key: a.storageKey,
              // 업로드 응답을 그대로 되돌려준다 — null 로 덮으면 첨부 내용이 사라진다.
              extracted_text: a.extractedText ?? null,
              truncated: a.truncated ?? false,
            }))
          : null,
        discussion_max_rounds: null,
        reply_to_id: opts?.replyToId ?? null,
      },
    );
    const mapped = safeMapMessage(res.data?.message);
    if (!mapped) throw new Error('메시지를 보냈지만 서버 응답을 해석하지 못했습니다.');
    return mapped;
  }

  /** 본인 메시지 편집. 서버가 `message_updated` 를 broadcast 한다. */
  async editMessage(
    roomId: string,
    messageId: string,
    content: string,
  ): Promise<TeamsMessage | null> {
    const res = await this.http.patch<Envelope<unknown>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
      { content },
    );
    return safeMapMessage(res.data);
  }

  // ── 첨부 ─────────────────────────────────────────────────

  /**
   * 첨부 업로드 → 메타. 이 메타를 `sendMessage` 의 `attachments` 로 넘겨야
   * 실제로 메시지에 붙는다 (업로드만으로는 방에 나타나지 않는다).
   *
   * 서버가 같은 요청 안에서 문서 본문까지 추출해 `extracted_text` 로 돌려주므로
   * 응답을 통째로 들고 다닌다 — 그래야 나중에 에이전트가 그 파일의 내용을 본다.
   * 상한은 서버 기준 50MB, 허용 확장자는 `attachment_controller.ALLOWED_EXTENSIONS`.
   */
  async uploadAttachment(
    roomId: string,
    bytes: Uint8Array,
    filename: string,
    mime?: string,
  ): Promise<TeamsAttachment> {
    const form = new FormData();
    // Uint8Array 가 더 큰 버퍼 위의 뷰일 수 있다(IPC 를 건너온 경우) — 정확히 이
    // 파일의 바이트만 담기도록 독립 ArrayBuffer 로 복사한다 (아바타 업로드와 같은 이유).
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    form.append('file', new Blob([buf], mime ? { type: mime } : undefined), filename);
    const res = await this.http.upload<Envelope<unknown>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/attachments/upload`,
      form,
      // 50MB 까지 받는 엔드포인트라 기본 타임아웃으로는 큰 파일이 끊긴다.
      { timeoutMs: 300_000 },
    );
    const mapped = mapAttachment(res.data);
    if (!mapped.storageKey) throw new Error('첨부를 올렸지만 서버 응답을 해석하지 못했습니다.');
    // 서버는 저장 이름(storage_key)만 확정하고 표시 이름은 요청의 것을 그대로
    // 되돌려준다. 응답에서 못 읽었다면 우리가 보낸 이름이 정답이다.
    return { ...mapped, filename: mapped.filename || filename };
  }

  /**
   * 첨부 원본 바이트. 다운로드 주소에 `filename` 을 함께 넘겨야 서버가
   * Content-Disposition 에 실제 이름을 실어 준다 (안 넘기면 `att-xxx.docx` 로 떨어진다).
   */
  async downloadAttachment(
    roomId: string,
    attachment: Pick<TeamsAttachment, 'storageKey' | 'filename'>,
  ): Promise<Uint8Array> {
    const params = attachment.filename
      ? `?filename=${encodeURIComponent(attachment.filename)}`
      : '';
    const { bytes } = await this.http.getBinary(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(
        attachment.storageKey,
      )}${params}`,
    );
    return bytes;
  }

  /**
   * 이모지 리액션 토글. 서버가 집계 전체를 돌려주고 동시에 `reaction_update` 를
   * broadcast 하므로, 반환값은 즉시 반영용 보조다.
   */
  async toggleReaction(roomId: string, messageId: string, emoji: string): Promise<TeamsReaction[]> {
    const res = await this.http.post<Envelope<{ reactions?: unknown }>>(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji },
    );
    return mapReactions(res.data?.reactions) ?? [];
  }
}
