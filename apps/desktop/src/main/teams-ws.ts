/**
 * teams-ws — XGEN Teams 실시간 소켓 (메인 프로세스 전용).
 *
 * 왜 메인 프로세스인가:
 *   Teams WS 는 게이트웨이가 주입한 `X-User-Id` 헤더로 사용자를 식별하고
 *   (xgen-workflow `ws_controller._extract_user`), 게이트웨이는 핸드셰이크의
 *   `Authorization: Bearer` 를 그 헤더로 바꿔 준다 (`proxy.rs`). 그런데 브라우저
 *   `WebSocket` 생성자는 헤더를 실을 수 없다 — 웹 프론트가 쿠키에 의존하는 이유다.
 *   커넥터는 쿠키가 없으므로 `ws` 패키지로 헤더를 직접 실어야 하고, 그건 메인
 *   프로세스에서만 가능하다. 렌더러는 IPC 로 정규화된 이벤트만 받는다.
 *
 * 소켓은 두 종류다:
 *   · 방 소켓  `/api/teams/ws/{roomId}` — 열려 있는 방 탭마다 하나. 메시지/리액션/
 *     타이핑/접속상태가 여기로 온다.
 *   · 사용자 소켓 `/api/teams/ws/user` — 로그인 동안 하나. 보고 있지 않은 방의
 *     새 메시지 알림(`message_notify`)과 초대/강퇴가 여기로 온다.
 *
 * 재연결·백오프·토큰 자가치유는 워크스페이스 동기화 소켓(`sync-transport.ts`)의
 * 검증된 형태를 그대로 따른다. 특히 `unexpected-response` 처리를 빼면 토큰이
 * 회전된 뒤 **폐기된 토큰으로 영원히 재시도**하는 상태에 갇힌다(실기 사례).
 */
import WebSocket from 'ws';
import { safeMapMessage, mapTeamsReactions } from '@dex/protocol/teams';
import type { TeamsEvent } from '@dex/protocol/types';
import { xgenWebSocketTlsOptions } from './connection-security';

/** 방 소켓이 유휴일 때 서버에 보내는 ping 주기. 서버는 pong 으로 답한다. */
const HEARTBEAT_MS = 25_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

export interface TeamsSocketDeps {
  /** 게이트웨이 origin (http/https). ws/wss 로 바꿔 쓴다. */
  baseUrl: () => string;
  /** 라이브 액세스 토큰 — keychain 이 아니라 회전이 반영된 값이어야 한다. */
  token: () => Promise<string>;
  /** 401/403 자가치유. 새 토큰을 돌려주면 즉시 재접속한다. null = 재로그인 대상. */
  refreshAuth: () => Promise<string | null>;
  /** 사설 CA 를 신뢰하도록 설정된 서버인지. */
  allowPrivateCertificate: () => boolean;
  /** 정규화된 이벤트를 렌더러로 밀어 준다. */
  emit: (event: TeamsEvent) => void;
}

/** 한 소켓의 수명 — 방 소켓과 사용자 소켓이 공유하는 재연결 기계. */
class Socket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = RETRY_MIN_MS;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly path: string,
    private readonly deps: TeamsSocketDeps,
    private readonly onFrame: (frame: Record<string, unknown>) => void,
    private readonly onState?: (connected: boolean) => void,
  ) {}

  start(): void {
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  /** 렌더러가 타이핑 상태 같은 걸 올려 보낼 때. 끊겨 있으면 조용히 버린다. */
  send(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      const base = this.deps.baseUrl().replace(/^http/, 'ws');
      const token = await this.deps.token();
      if (!token) throw new Error('no access token');
      ws = new WebSocket(`${base}${this.path}`, {
        headers: { Authorization: `Bearer ${token}` },
        ...xgenWebSocketTlsOptions(this.deps.allowPrivateCertificate()),
      });
    } catch {
      // 토큰/키체인 문제로 시작조차 못 해도 재연결 루프는 살아 있어야 한다.
      this.onState?.(false);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      // 연결이 몇 초 **버틴 뒤에만** 백오프를 리셋한다. 받자마자 끊는 서버
      // (만료 인증)를 상대로 백오프가 무력해지는 것을 막는다.
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) this.retryMs = RETRY_MIN_MS;
      }, 5_000);
      this.onState?.(true);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.send({ type: 'ping' });
      }, HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      try {
        const frame: unknown = JSON.parse(String(raw));
        if (frame && typeof frame === 'object') this.onFrame(frame as Record<string, unknown>);
      } catch {
        /* 깨진 프레임은 무시 — 연결은 유지한다 */
      }
    });

    let retried = false;
    const scheduleRetryOnce = (): void => {
      if (retried) return;
      retried = true;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.onState?.(false);
      this.scheduleRetry();
    };

    // 핸드셰이크가 401/403 으로 거절됐다 = 토큰 회전/세션 회수. refresh 로 토큰을
    // 갈아끼운 뒤 재시도한다. 이 리스너가 없으면 'error' 로만 떨어져 폐기된
    // 토큰으로 무한 재시도한다.
    ws.on('unexpected-response', (_req, res) => {
      const status = res?.statusCode ?? 0;
      try {
        res?.resume?.();
      } catch {
        /* drain */
      }
      const heal =
        status === 401 || status === 403
          ? Promise.resolve(this.deps.refreshAuth()).catch(() => null)
          : Promise.resolve(null);
      void heal.then((fresh) => {
        if (fresh) this.retryMs = RETRY_MIN_MS;
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        scheduleRetryOnce();
      });
    });
    ws.on('close', scheduleRetryOnce);
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    });
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    setTimeout(() => void this.connect(), delay);
  }
}

/**
 * 열린 방 소켓 + 사용자 소켓을 관리한다.
 *
 * 렌더러는 방 탭을 열 때 `openRoom`, 닫을 때 `closeRoom` 을 부른다. 방마다
 * 소켓을 하나만 유지하고, 같은 방을 두 번 열어도 소켓은 하나다 (참조 계수 없이
 * "열린 방 집합" 으로 관리 — 같은 방을 두 탭에 띄우는 건 이 앱에서 불가능하다).
 */
export class TeamsSocketHub {
  private rooms = new Map<string, Socket>();
  private userSocket: Socket | null = null;
  private deps: TeamsSocketDeps | null = null;

  configure(deps: TeamsSocketDeps): void {
    this.deps = deps;
  }

  /** 로그인 후 호출 — 사용자 소켓을 띄운다. */
  startUserSocket(): void {
    if (!this.deps || this.userSocket) return;
    const deps = this.deps;
    this.userSocket = new Socket(
      '/api/teams/ws/user',
      deps,
      (frame) => handleUserFrame(frame, deps.emit),
      (connected) => {
        // 재연결된 동안 초대/강퇴 이벤트를 놓쳤을 수 있다. 연결이 살아난 즉시
        // REST 목록을 한 번 맞추면 사용자가 수동 새로고침할 필요가 없다.
        if (connected) deps.emit({ kind: 'rooms_changed', roomId: '', reason: 'updated' });
      },
    );
    this.userSocket.start();
  }

  /** 로그아웃 / 계정 전환 — 모든 소켓을 접는다. */
  stopAll(): void {
    for (const socket of this.rooms.values()) socket.stop();
    this.rooms.clear();
    this.userSocket?.stop();
    this.userSocket = null;
  }

  openRoom(roomId: string): void {
    if (!this.deps || !roomId || this.rooms.has(roomId)) return;
    const deps = this.deps;
    const socket = new Socket(
      `/api/teams/ws/${encodeURIComponent(roomId)}`,
      deps,
      (frame) => handleRoomFrame(roomId, frame, deps.emit),
      (connected) => deps.emit({ kind: 'status', roomId, connected }),
    );
    this.rooms.set(roomId, socket);
    socket.start();
  }

  closeRoom(roomId: string): void {
    const socket = this.rooms.get(roomId);
    if (!socket) return;
    socket.stop();
    this.rooms.delete(roomId);
  }

  /**
   * 타이핑 표시. 서버(`ws_controller`)가 받는 이름은 `typing_start` / `typing_stop`
   * 둘뿐이다 — 다른 이름으로 보내면 조용히 무시된다.
   */
  sendTyping(roomId: string, typing: boolean): void {
    this.rooms.get(roomId)?.send({ type: typing ? 'typing_start' : 'typing_stop' });
  }
}

/** 사용자 소켓 프레임 → 방 목록/알림 이벤트. 서버 버전별 별칭도 함께 받는다. */
export function handleUserFrame(
  frame: Record<string, unknown>,
  emit: (event: TeamsEvent) => void,
): void {
  const type = String(frame.type ?? frame.event ?? '');
  if (type === 'message_notify') {
    const message = safeMapMessage(frame.message);
    const roomId = String(frame.room_id ?? message?.roomId ?? '');
    if (message && roomId) emit({ kind: 'notify', roomId, message });
    return;
  }

  const nestedRoom =
    frame.room && typeof frame.room === 'object'
      ? (frame.room as Record<string, unknown>)
      : undefined;
  const roomId = String(frame.room_id ?? frame.roomId ?? nestedRoom?.id ?? '');
  if (
    type === 'room_invited' ||
    type === 'room_added' ||
    type === 'room_joined' ||
    type === 'room_created'
  ) {
    emit({ kind: 'rooms_changed', roomId, reason: 'invited' });
    return;
  }
  if (
    type === 'room_kicked' ||
    type === 'room_removed' ||
    type === 'room_left' ||
    type === 'room_deleted' ||
    type === 'room_destroyed' ||
    type === 'room_archived'
  ) {
    emit({ kind: 'rooms_changed', roomId, reason: 'removed' });
    return;
  }
  if (type === 'room_updated') {
    emit({ kind: 'rooms_changed', roomId, reason: 'updated' });
  }
}

/**
 * 방 소켓 프레임 → 커넥터 이벤트. 모르는 프레임은 조용히 버린다.
 *
 * 단위 테스트를 위해 내보낸다 (`test/teams-ws-frames.test.ts`) — 이 매핑이
 * 틀려도 앱은 조용히 동작하는 것처럼 보이기 때문에 눈으로 잡히지 않는다.
 * 실제로 `message_updated` 를 통째로 버리고 있었다.
 */
export function handleRoomFrame(
  roomId: string,
  frame: Record<string, unknown>,
  emit: (event: TeamsEvent) => void,
): void {
  const type = String(frame.type ?? '');
  switch (type) {
    case 'message_new': {
      const message = safeMapMessage(frame.message);
      if (message) emit({ kind: 'message', roomId, message });
      return;
    }
    case 'message_updated': {
      // ⚠ 서버는 **전체 메시지를 보내지 않는다** — `{message_id, content, edited_at}`
      // 뿐이다(message_controller.edit_message). 예전에는 `frame.message` 를
      // 찾다가 undefined 를 받아 이 프레임을 조용히 버렸고, 그래서 **남이 고친
      // 메시지가 새로고침 전까지 반영되지 않았다.**
      //
      // 혹시 서버가 나중에 전체 메시지를 함께 실어 주더라도 받아들인다 — 그때는
      // content 를 그쪽에서 읽는다.
      const full = safeMapMessage(frame.message);
      const messageId = String(frame.message_id ?? full?.id ?? '');
      if (!messageId) return;
      const content = full ? full.content : String(frame.content ?? '');
      emit({
        kind: 'message_edited',
        roomId,
        messageId,
        content,
        editedAt: String(frame.edited_at ?? full?.editedAt ?? '') || undefined,
      });
      return;
    }
    case 'reaction_update': {
      const messageId = String(frame.message_id ?? '');
      if (!messageId) return;
      emit({
        kind: 'reactions',
        roomId,
        messageId,
        reactions: mapTeamsReactions(frame.reactions) ?? [],
      });
      return;
    }
    case 'typing_update': {
      // 서버는 항상 단건 토글을 보낸다: {user_id, username, is_typing}.
      emit({
        kind: 'typing',
        roomId,
        userId: Number(frame.user_id ?? 0),
        username: String(frame.username ?? ''),
        typing: Boolean(frame.is_typing),
      });
      return;
    }
    case 'presence_update': {
      // `Number.isFinite` 만으로는 부족하다 — `Number(null)`, `Number('')`,
      // `Number([])` 이 모두 0 이라 쓰레기 값이 **사용자 id 0** 으로 들어온다.
      // 사용자 id 는 양의 정수이므로 그것만 받는다.
      const ids = Array.isArray(frame.online_user_ids)
        ? frame.online_user_ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      emit({ kind: 'presence', roomId, onlineUserIds: ids });
      return;
    }
    case 'member_added':
    case 'member_joined': {
      emit({ kind: 'members_changed', roomId, change: 'joined', ...memberChangeOf(frame) });
      return;
    }
    case 'member_removed':
    case 'member_left': {
      emit({ kind: 'members_changed', roomId, change: 'left', ...memberChangeOf(frame) });
      return;
    }
    case 'members_updated': {
      emit({ kind: 'members_changed', roomId, change: 'updated' });
      return;
    }
    case 'room_updated': {
      emit({ kind: 'rooms_changed', roomId });
      // 일부 서버 버전은 멤버 추가/제거도 room_updated 로만 알린다.
      emit({ kind: 'members_changed', roomId });
      return;
    }
    case 'room_deleted':
    case 'room_destroyed':
    case 'room_archived': {
      // 서버 버전에 따라 사용자 소켓 대신 방 소켓으로 삭제를 알리기도 한다.
      emit({ kind: 'rooms_changed', roomId, reason: 'removed' });
      return;
    }
    default:
      // pong 등 — 무시.
      return;
  }
}

/** 멤버 이벤트는 서버 버전에 따라 사용자 정보가 최상위 또는 member/user 안에 온다. */
function memberChangeOf(frame: Record<string, unknown>): {
  userId?: number;
  username?: string;
  occurredAt?: string;
} {
  const member =
    frame.member && typeof frame.member === 'object'
      ? (frame.member as Record<string, unknown>)
      : undefined;
  const user =
    frame.user && typeof frame.user === 'object'
      ? (frame.user as Record<string, unknown>)
      : undefined;
  const rawId = frame.user_id ?? member?.user_id ?? member?.id ?? user?.user_id ?? user?.id;
  const parsedId = Number(rawId);
  const userId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : undefined;
  const username = String(
    frame.username ??
      member?.username ??
      member?.user_name ??
      user?.username ??
      user?.user_name ??
      '',
  ).trim();
  const occurredAt = String(frame.created_at ?? frame.occurred_at ?? frame.timestamp ?? '').trim();
  return {
    userId,
    username: username || undefined,
    occurredAt: occurredAt || undefined,
  };
}
