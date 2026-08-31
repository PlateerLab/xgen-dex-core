/**
 * Teams 라이브 스토어 — 순수 모델(`views/teams-store.ts`)과 브릿지(window.xgen)를
 * 잇는 유일한 지점. `session.ts` 와 같은 역할·같은 구조다.
 *
 * 화면 두 곳이 같은 상태를 본다:
 *   · 사이드바 `TeamsPanel`  — 방 목록, 안 읽음 배지
 *   · 메인 탭 `TeamsRoom`    — 한 방의 메시지
 * 그래서 상태를 컴포넌트가 아니라 여기(모듈 싱글턴)에 둔다. 방 탭을 닫았다 열어도
 * 메시지 캐시와 소켓 상태가 유지된다.
 *
 * 실시간 이벤트는 메인 프로세스가 하나의 채널로 밀어 주므로 구독도 한 번만 건다.
 */
import { useSyncExternalStore } from 'react';
import { xgen } from './bridge';
import type {
  TeamsAttachment,
  TeamsEvent,
  TeamsMember,
  TeamsMessage,
  TeamsRoom,
} from '../../core/index';
import {
  PENDING_PREFIX,
  applyEdit,
  applyReactions,
  dropPending,
  memberDepartureMessage,
  mergeMessages,
  removeDepartedMember,
  settlePending,
  shouldShowRoomRefreshLoading,
  sortRooms,
  unreadCount,
} from './views/teams-store';

/** 답장 대상 — 인용 미리보기에 필요한 만큼만. */
export interface ReplyTarget {
  id: string;
  senderName: string;
  content: string;
}

export interface SendOptions {
  replyTo?: ReplyTarget;
  attachments?: TeamsAttachment[];
}

/**
 * 첨부만 보낼 때 쓸 최소 본문. 서버가 빈 content 를 거절하기 때문인데, 기계적인
 * 자리표시자 대신 사람이 읽을 문장을 넣는다 — 방에 남는 것은 사용자의 말이다.
 */
function attachmentOnlyText(attachments: TeamsAttachment[]): string {
  const first = attachments[0]?.filename ?? '파일';
  return attachments.length > 1
    ? `파일 ${attachments.length}개를 공유했습니다 (${first} 외)`
    : `${first} 파일을 공유했습니다`;
}

/** 한 방의 화면 상태. */
export interface RoomState {
  messages: TeamsMessage[];
  members: TeamsMember[];
  membersLoading: boolean;
  membersError: string;
  /** 방 WebSocket 이 붙어 있는가 — 끊기면 배너를 띄운다. */
  connected: boolean;
  /** 최초 메시지 로드 중. */
  loading: boolean;
  /** 위로 스크롤해서 더 부를 게 남았는가. */
  hasMore: boolean;
  loadingMore: boolean;
  /** 지금 입력 중인 사람들 (본인 제외). userId → username. */
  typing: Record<number, string>;
  error: string;
}

export interface TeamsSnapshot {
  rooms: TeamsRoom[];
  loadingRooms: boolean;
  roomsError: string;
  byRoom: Record<string, RoomState>;
  /** 방별 안 읽은 메시지 수 — 서버가 세지 않아 여기서 계산한다. */
  unread: Record<string, number>;
  /** 알림을 끈 방 id. 서버에 음소거 API 가 없어 이 PC 설정이다. */
  mutedRooms: string[];
}

const PAGE_SIZE = 50;
const TYPING_TIMEOUT_MS = 6_000;

/** 서버 created_at 처럼 타임존 접미사 없는 로컬 시각. 새 안내가 대화 끝에 정렬된다. */
function localTimestamp(now = new Date()): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().replace(/Z$/, '');
}

function emptyRoom(): RoomState {
  return {
    messages: [],
    members: [],
    membersLoading: false,
    membersError: '',
    connected: false,
    loading: false,
    hasMore: true,
    loadingMore: false,
    typing: {},
    error: '',
  };
}

class TeamsLiveStore {
  private snapshot: TeamsSnapshot = {
    rooms: [],
    loadingRooms: false,
    roomsError: '',
    byRoom: {},
    unread: {},
    mutedRooms: [],
  };

  private listeners = new Set<() => void>();
  private lastReadAt: Record<string, string> = {};
  /** 알림을 끈 방. 서버에 음소거 API 가 없어 이 PC 가 기억한다. */
  private muted = new Set<string>();
  private myUserId = '';
  /** 화면에 떠 있는(= 읽고 있는) 방. 이 방의 메시지는 안 읽음으로 세지 않는다. */
  private activeRoomId: string | null = null;
  private wired = false;
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 늦게 끝난 목록 요청이 더 최신 결과를 덮지 못하게 하는 순번. */
  private roomsRequestId = 0;
  /** 빈 배열도 서버에서 확인된 정상 결과인지 구분한다. */
  private hasLoadedRooms = false;
  /** 계정 전환 뒤 이전 계정의 비동기 응답을 버리기 위한 세대. */
  private generation = 0;
  private memberRequestIds = new Map<string, number>();
  private memberNoticeSequence = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TeamsSnapshot => this.snapshot;

  private emit(next: Partial<TeamsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private patchRoom(roomId: string, patch: Partial<RoomState>): void {
    const current = this.snapshot.byRoom[roomId] ?? emptyRoom();
    const room = { ...current, ...patch };
    this.emit({ byRoom: { ...this.snapshot.byRoom, [roomId]: room } });
  }

  private recount(roomId: string): void {
    const room = this.snapshot.byRoom[roomId];
    if (!room) return;
    const count =
      this.activeRoomId === roomId
        ? 0
        : unreadCount(room.messages, this.lastReadAt[roomId], this.myUserId);
    if (this.snapshot.unread[roomId] === count) return;
    this.emit({ unread: { ...this.snapshot.unread, [roomId]: count } });
  }

  /**
   * 로그인 직후 1회. 사용자 id 와 저장된 열람 시각을 넘겨받고 실시간 구독을 건다.
   * 여러 번 불려도 구독은 한 번만 걸린다 (React StrictMode 이중 마운트 대비).
   */
  init(
    myUserId: string,
    lastReadAt: Record<string, string> | undefined,
    prefs?: { mutedRooms?: string[]; notifications?: boolean },
  ): void {
    this.myUserId = myUserId;
    if (lastReadAt) this.lastReadAt = { ...lastReadAt };
    this.muted = new Set(prefs?.mutedRooms ?? []);
    this.emit({ mutedRooms: [...this.muted] });
    if (this.wired) return;
    this.wired = true;
    xgen.teams.onEvent((event) => this.onEvent(event));
  }

  /** 계정이 바뀌거나 로그아웃 — 남의 방 상태가 남지 않도록 전부 비운다. */
  reset(): void {
    this.generation += 1;
    this.roomsRequestId += 1;
    this.hasLoadedRooms = false;
    this.memberRequestIds.clear();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    // ⚠ 저장 디바운스도 반드시 끈다. 남겨 두면 계정을 바꾼 직후 **비워진**
    // lastReadAt 이 800ms 뒤에 저장되어, 이전 계정의 열람 기록이 통째로
    // 지워진다 (로그아웃 직전에 방을 봤다면 재현된다).
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.activeRoomId = null;
    this.lastReadAt = {};
    this.muted = new Set();
    this.emit({
      rooms: [],
      loadingRooms: false,
      roomsError: '',
      byRoom: {},
      unread: {},
      mutedRooms: [],
    });
  }

  async loadRooms(options: { background?: boolean } = {}): Promise<void> {
    const requestId = ++this.roomsRequestId;
    const generation = this.generation;
    const showLoading = shouldShowRoomRefreshLoading(
      options.background === true,
      this.hasLoadedRooms,
    );
    if (showLoading) this.emit({ loadingRooms: true, roomsError: '' });
    try {
      const rooms = await xgen.teams.rooms();
      if (generation !== this.generation || requestId !== this.roomsRequestId) return;
      this.hasLoadedRooms = true;
      this.emit({ rooms: sortRooms(rooms), loadingRooms: false });
      for (const room of rooms) this.recount(room.id);
    } catch (e) {
      if (generation !== this.generation || requestId !== this.roomsRequestId) return;
      this.emit({
        loadingRooms: false,
        roomsError: e instanceof Error ? e.message : '대화 목록을 불러오지 못했습니다.',
      });
    }
  }

  /**
   * 방 탭을 연다 — 방 소켓을 붙이고 최근 메시지를 불러온다.
   * 이미 캐시가 있으면 목록을 비우지 않고 갱신만 한다 ("열 때마다 빈 화면"을 피한다).
   */
  async openRoom(roomId: string): Promise<void> {
    if (!roomId) return;
    const known = this.snapshot.byRoom[roomId];
    if (!known) this.patchRoom(roomId, emptyRoom());
    void xgen.teams.watch(roomId);
    void this.refreshMembers(roomId);
    if (known && known.messages.length > 0) {
      void this.refreshMessages(roomId);
      return;
    }
    await this.loadInitial(roomId);
  }

  /**
   * 방의 최근 한 페이지를 처음 불러온다. 방 탭을 여는 경로와 컨텍스트를 준비하는
   * 경로가 같은 코드를 써야 "탭에서는 30건이 보이는데 봉투에는 5건만 실리는"
   * 어긋남이 생기지 않는다.
   */
  private async loadInitial(roomId: string): Promise<void> {
    this.patchRoom(roomId, { loading: true, error: '' });
    try {
      const messages = await xgen.teams.messages(roomId);
      this.patchRoom(roomId, {
        messages: mergeMessages([], messages),
        loading: false,
        hasMore: messages.length >= PAGE_SIZE,
      });
      this.recount(roomId);
    } catch (e) {
      this.patchRoom(roomId, {
        loading: false,
        error: e instanceof Error ? e.message : '메시지를 불러오지 못했습니다.',
      });
    }
  }

  /**
   * 적어도 `want` 건이 캐시에 있도록 채운다 — Agent 컨텍스트 봉투가 "최근 N건"
   * 을 약속하려면 그 N 건이 실제로 있어야 한다.
   *
   * 페이지를 무한정 돌지 않는다. 방이 그만큼 짧으면 `hasMore` 가 꺼지고, 그래도
   * 안 끝나는 경우를 대비해 횟수 상한을 둔다 — 봉투 하나 만들자고 서버를
   * 스무 번 부르는 상황을 만들지 않는다.
   */
  async ensureMessages(roomId: string, want: number): Promise<void> {
    if (!roomId || want <= 0) return;
    const have = (): number => this.snapshot.byRoom[roomId]?.messages.length ?? 0;
    if (!this.snapshot.byRoom[roomId]) this.patchRoom(roomId, emptyRoom());
    if (have() === 0) await this.loadInitial(roomId);
    const maxPages = Math.ceil(want / PAGE_SIZE) + 1;
    for (let i = 0; i < maxPages && have() < want; i += 1) {
      if (!this.snapshot.byRoom[roomId]?.hasMore) break;
      const before = have();
      await this.loadOlder(roomId);
      if (have() === before) break; // 더 안 늘면 서버에 남은 게 없다
    }
  }

  /** 소켓이 끊겨 있던 동안 놓친 메시지를 조용히 메운다. */
  private async refreshMessages(roomId: string): Promise<void> {
    try {
      const messages = await xgen.teams.messages(roomId);
      const room = this.snapshot.byRoom[roomId] ?? emptyRoom();
      this.patchRoom(roomId, { messages: mergeMessages(room.messages, messages) });
      this.recount(roomId);
    } catch {
      /* 조용히 실패 — 이미 보이는 메시지는 그대로 둔다 */
    }
  }

  closeRoom(roomId: string): void {
    void xgen.teams.unwatch(roomId);
    if (this.activeRoomId === roomId) this.activeRoomId = null;
  }

  /** 위로 스크롤 — 가장 오래된 메시지보다 더 과거를 불러온다. */
  async loadOlder(roomId: string): Promise<void> {
    const room = this.snapshot.byRoom[roomId];
    if (!room || room.loadingMore || !room.hasMore) return;
    const oldest = room.messages[0];
    if (!oldest) return;
    this.patchRoom(roomId, { loadingMore: true });
    try {
      const older = await xgen.teams.messages(roomId, oldest.createdAt);
      const fresh = older.filter((m) => !room.messages.some((existing) => existing.id === m.id));
      this.patchRoom(roomId, {
        messages: mergeMessages(room.messages, fresh),
        loadingMore: false,
        hasMore: fresh.length > 0 && older.length >= PAGE_SIZE,
      });
    } catch {
      this.patchRoom(roomId, { loadingMore: false });
    }
  }

  /** 멤버 목록을 다시 읽는다. 초대 직후와 멤버 변경 WS 이벤트가 같은 경로를 쓴다. */
  async refreshMembers(roomId: string): Promise<void> {
    const requestId = (this.memberRequestIds.get(roomId) ?? 0) + 1;
    const generation = this.generation;
    this.memberRequestIds.set(roomId, requestId);
    this.patchRoom(roomId, { membersLoading: true, membersError: '' });
    try {
      const members = await xgen.teams.members(roomId);
      if (generation !== this.generation || this.memberRequestIds.get(roomId) !== requestId) return;
      const current = this.snapshot.byRoom[roomId] ?? emptyRoom();
      const liveIds = new Set(members.map((member) => member.userId));
      const departed = current.members.filter((member) => !liveIds.has(member.userId));
      let messages = current.messages;
      for (const member of departed) {
        messages = mergeMessages(messages, [this.departureNotice(roomId, member)]);
      }
      this.patchRoom(roomId, { members, messages, membersLoading: false });
    } catch (e) {
      if (generation !== this.generation || this.memberRequestIds.get(roomId) !== requestId) return;
      this.patchRoom(roomId, {
        membersLoading: false,
        membersError: e instanceof Error ? e.message : '멤버 목록을 불러오지 못했습니다.',
      });
    }
  }

  private departureNotice(roomId: string, member: TeamsMember, occurredAt?: string): TeamsMessage {
    this.memberNoticeSequence += 1;
    return memberDepartureMessage(
      roomId,
      member,
      occurredAt || localTimestamp(),
      `${Date.now()}:${this.memberNoticeSequence}`,
    );
  }

  /**
   * 전송 — 낙관적으로 먼저 그리고, 서버 확정본으로 교체한다.
   * 실패하면 임시 메시지를 걷어내고 사유를 방 에러로 올린다 (입력 내용은 화면이 복구).
   */
  async send(
    roomId: string,
    content: string,
    myName: string,
    opts?: SendOptions,
  ): Promise<boolean> {
    const text = content.trim();
    const attachments = opts?.attachments ?? [];
    // 첨부만 있고 본문이 없으면 서버가 거절한다 (content 는 min_length=1).
    // 파일만 올리는 것도 정당한 행동이므로 여기서 최소 본문을 만들어 준다.
    const body = text || (attachments.length > 0 ? attachmentOnlyText(attachments) : '');
    if (!body) return false;
    const pendingId = `${PENDING_PREFIX}${Date.now()}`;
    const replied = opts?.replyTo;
    const optimistic: TeamsMessage = {
      id: pendingId,
      roomId,
      senderType: 'user',
      senderId: this.myUserId,
      senderName: myName,
      content: body,
      createdAt: new Date().toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
      // 답장 인용은 서버가 확정본에 채워 주지만, 낙관적 줄에서도 보여야 사용자가
      // "어디에 답한 건지" 를 전송 순간에 확인할 수 있다.
      replyToId: replied?.id,
      replyToSenderName: replied?.senderName,
      replyToContent: replied?.content,
    };
    const room = this.snapshot.byRoom[roomId] ?? emptyRoom();
    this.patchRoom(roomId, { messages: mergeMessages(room.messages, [optimistic]), error: '' });
    void xgen.teams.typing(roomId, false);
    try {
      const settled = await xgen.teams.send(
        roomId,
        body,
        replied?.id,
        attachments.length > 0 ? attachments : undefined,
      );
      const now = this.snapshot.byRoom[roomId] ?? emptyRoom();
      this.patchRoom(roomId, { messages: settlePending(now.messages, pendingId, settled) });
      this.touchRoomOrder(roomId, settled.createdAt);
      return true;
    } catch (e) {
      const now = this.snapshot.byRoom[roomId] ?? emptyRoom();
      this.patchRoom(roomId, {
        messages: dropPending(now.messages, pendingId),
        error: e instanceof Error ? e.message : '메시지를 보내지 못했습니다.',
      });
      return false;
    }
  }

  /**
   * 본인 메시지 편집. 서버가 `message_updated` 를 broadcast 하지만, 누른 사람의
   * 화면은 그 왕복을 기다리지 않고 즉시 반영한다.
   */
  async edit(roomId: string, messageId: string, content: string): Promise<boolean> {
    const text = content.trim();
    if (!text) return false;
    try {
      const updated = await xgen.teams.edit(roomId, messageId, text);
      const room = this.snapshot.byRoom[roomId] ?? emptyRoom();
      // 응답을 통째로 병합하지 않는다 — 서버의 PATCH 응답에는 답장 스냅샷이
      // 없어서(원본 행 그대로) 인용이 지워진다. 본문만 패치한다.
      this.patchRoom(roomId, {
        messages: applyEdit(room.messages, messageId, updated?.content ?? text, updated?.editedAt),
      });
      return true;
    } catch (e) {
      this.patchRoom(roomId, {
        error: e instanceof Error ? e.message : '메시지를 수정하지 못했습니다.',
      });
      return false;
    }
  }

  /**
   * 방 나가기. 성공하면 목록과 캐시에서 **완전히** 지운다 — 남겨 두면 더 이상
   * 멤버가 아닌 방의 옛 메시지가 화면에 남고, 안 읽음 배지까지 계속 센다.
   */
  async leave(roomId: string): Promise<boolean> {
    try {
      await xgen.teams.leaveRoom(roomId);
    } catch (e) {
      this.patchRoom(roomId, {
        error: e instanceof Error ? e.message : '대화방을 나가지 못했습니다.',
      });
      return false;
    }
    this.forget(roomId);
    return true;
  }

  /**
   * 방을 목록·캐시·안 읽음에서 **완전히** 지운다 (나가기/삭제 공통).
   * 남겨 두면 더 이상 멤버가 아닌 방의 옛 메시지가 화면에 남고 배지까지 계속 센다.
   */
  private forget(roomId: string): void {
    if (this.activeRoomId === roomId) this.activeRoomId = null;
    // 진행 중인 멤버 조회가 끝나며 지운 방 상태를 다시 만들지 못하게 무효화한다.
    this.memberRequestIds.set(roomId, (this.memberRequestIds.get(roomId) ?? 0) + 1);
    delete this.lastReadAt[roomId];
    this.muted.delete(roomId);
    const mutedRooms = [...this.muted];
    const byRoom = { ...this.snapshot.byRoom };
    delete byRoom[roomId];
    const unread = { ...this.snapshot.unread };
    delete unread[roomId];
    this.emit({
      rooms: this.snapshot.rooms.filter((r) => r.id !== roomId),
      byRoom,
      unread,
      mutedRooms,
    });
  }

  /** 파일 고르기 → 업로드. 경로는 메인에만 있고 여기로 넘어오지 않는다. */
  async pickAttachments(roomId: string): Promise<TeamsAttachment[]> {
    try {
      return await xgen.teams.pickAndUpload(roomId);
    } catch (e) {
      this.patchRoom(roomId, {
        error: e instanceof Error ? e.message : '파일을 올리지 못했습니다.',
      });
      return [];
    }
  }

  /** 이 방의 알림이 꺼져 있는가. */
  isMuted(roomId: string): boolean {
    return this.muted.has(roomId);
  }

  /** 방 알림 켜기/끄기. 서버에 API 가 없어 이 PC 설정으로만 남는다. */
  toggleMute(roomId: string): void {
    if (this.muted.has(roomId)) this.muted.delete(roomId);
    else this.muted.add(roomId);
    const mutedRooms = [...this.muted];
    void xgen.teams.savePrefs({ mutedRooms });
    this.emit({ mutedRooms });
  }

  /** 방 이름 바꾸기. 성공하면 목록과 열린 탭 제목이 함께 갱신된다. */
  async rename(roomId: string, name: string): Promise<boolean> {
    const next = name.trim();
    if (!next) return false;
    try {
      await xgen.teams.updateRoom(roomId, { name: next });
    } catch (e) {
      this.patchRoom(roomId, {
        error: e instanceof Error ? e.message : '이름을 바꾸지 못했습니다.',
      });
      return false;
    }
    this.emit({
      rooms: sortRooms(
        this.snapshot.rooms.map((r) => (r.id === roomId ? { ...r, name: next } : r)),
      ),
    });
    return true;
  }

  async toggleReaction(roomId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const reactions = await xgen.teams.react(roomId, messageId, emoji);
      const room = this.snapshot.byRoom[roomId] ?? emptyRoom();
      this.patchRoom(roomId, { messages: applyReactions(room.messages, messageId, reactions) });
    } catch {
      /* WS reaction_update 가 곧 정답을 준다 */
    }
  }

  /**
   * 방을 보고 있다고 표시 — 배지를 0 으로 내리고 열람 시각을 저장한다.
   *
   * 저장하는 값은 **반드시 서버가 준 created_at 문자열**이어야 한다. 서버 시각은
   * 타임존 없는 로컬 표기라(`2026-08-21T10:00:00`), 여기서 `new Date().toISOString()`
   * (UTC + 'Z')을 섞어 넣으면 문자열 비교가 뒤집혀 이미 읽은 메시지가 안 읽음으로
   * 잡힌다. 메시지가 아직 없으면 아무것도 기록하지 않는다 — 셀 것도 없다.
   */
  markRead(roomId: string): void {
    this.activeRoomId = roomId;
    const room = this.snapshot.byRoom[roomId];
    const newest = room?.messages[room.messages.length - 1];
    if (newest) this.lastReadAt[roomId] = newest.createdAt;
    this.recount(roomId);
    if (newest) this.persistLastRead();
  }

  /** 저장은 디바운스 — 메시지가 쏟아질 때 config 를 매번 쓰지 않는다. */
  private persistLastRead(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void xgen.teams.savePrefs({ lastReadAt: { ...this.lastReadAt } });
    }, 800);
  }

  /** 새 메시지가 온 방을 목록 위로 올린다 (서버를 다시 부르지 않는다). */
  private touchRoomOrder(roomId: string, at: string): void {
    const rooms = this.snapshot.rooms.map((room) =>
      room.id === roomId ? { ...room, lastMessageAt: at } : room,
    );
    this.emit({ rooms: sortRooms(rooms) });
  }

  private onEvent(event: TeamsEvent): void {
    switch (event.kind) {
      case 'status':
        this.patchRoom(event.roomId, { connected: event.connected });
        // 끊겼다 붙는 동안 놓친 메시지를 메운다 — 재연결의 핵심.
        if (event.connected && this.snapshot.byRoom[event.roomId]) {
          void this.refreshMessages(event.roomId);
        }
        return;
      case 'message':
      case 'notify': {
        const known = this.snapshot.byRoom[event.roomId];
        // 방을 한 번도 연 적이 없어도 상태를 만들어 둔다 — 그러지 않으면 안 읽음이
        // 계산되지 않아 **배지가 영영 뜨지 않는다** (열어 본 방만 배지가 생기는 버그).
        this.patchRoom(event.roomId, {
          messages: mergeMessages(known?.messages ?? [], [event.message]),
        });
        this.touchRoomOrder(event.roomId, event.message.createdAt);
        if (this.activeRoomId === event.roomId) {
          // 보고 있는 방이면 읽은 것으로 친다.
          this.lastReadAt[event.roomId] = event.message.createdAt;
          this.persistLastRead();
        }
        this.recount(event.roomId);
        // 목록에 없는 방에서 알림이 왔다 = 방금 초대됐다 — 목록을 다시 부른다.
        if (!this.snapshot.rooms.some((r) => r.id === event.roomId)) void this.loadRooms();
        // 서버는 멤버 추가/퇴장을 시스템 메시지로도 broadcast 한다. 전용 멤버
        // 이벤트를 보내지 않는 서버 버전에서도 열린 방의 인원수가 즉시 맞는다.
        if (event.kind === 'message' && event.message.senderType === 'system') {
          void this.refreshMembers(event.roomId);
        }
        return;
      }
      case 'message_edited': {
        const room = this.snapshot.byRoom[event.roomId];
        if (!room) return;
        this.patchRoom(event.roomId, {
          messages: applyEdit(room.messages, event.messageId, event.content, event.editedAt),
        });
        return;
      }
      case 'reactions': {
        const room = this.snapshot.byRoom[event.roomId];
        if (!room) return;
        this.patchRoom(event.roomId, {
          messages: applyReactions(room.messages, event.messageId, event.reactions),
        });
        return;
      }
      case 'typing': {
        if (String(event.userId) === this.myUserId) return;
        const room = this.snapshot.byRoom[event.roomId] ?? emptyRoom();
        const typing = { ...room.typing };
        const key = `${event.roomId}:${event.userId}`;
        const timer = this.typingTimers.get(key);
        if (timer) clearTimeout(timer);
        if (event.typing) {
          typing[event.userId] = event.username || `User-${event.userId}`;
          // 서버가 "그만 침" 을 못 보내도 표시가 영원히 남지 않게 스스로 지운다.
          this.typingTimers.set(
            key,
            setTimeout(() => {
              this.typingTimers.delete(key);
              const current = this.snapshot.byRoom[event.roomId];
              if (!current) return;
              const next = { ...current.typing };
              delete next[event.userId];
              this.patchRoom(event.roomId, { typing: next });
            }, TYPING_TIMEOUT_MS),
          );
        } else {
          delete typing[event.userId];
          this.typingTimers.delete(key);
        }
        this.patchRoom(event.roomId, { typing });
        return;
      }
      case 'presence': {
        const room = this.snapshot.byRoom[event.roomId];
        if (!room) return;
        const online = new Set(event.onlineUserIds);
        this.patchRoom(event.roomId, {
          members: room.members.map((m) => ({ ...m, isOnline: online.has(m.userId) })),
        });
        return;
      }
      case 'members_changed': {
        const room = this.snapshot.byRoom[event.roomId];
        if (room && event.change === 'left') {
          const { members, departed } = removeDepartedMember(
            room.members,
            event.userId,
            event.username,
          );
          if (departed) {
            const typing = { ...room.typing };
            delete typing[departed.userId];
            const typingKey = `${event.roomId}:${departed.userId}`;
            const typingTimer = this.typingTimers.get(typingKey);
            if (typingTimer) clearTimeout(typingTimer);
            this.typingTimers.delete(typingKey);
            this.patchRoom(event.roomId, {
              members,
              typing,
              messages: mergeMessages(room.messages, [
                this.departureNotice(event.roomId, departed, event.occurredAt),
              ]),
            });
          }
        }
        // 즉시 반영 뒤 REST 결과로 최종 정합성을 맞춘다. ID 없는 구형 이벤트도
        // 이 조회의 전후 차이로 퇴장자를 찾아 같은 안내를 만든다.
        if (this.snapshot.byRoom[event.roomId]) void this.refreshMembers(event.roomId);
        return;
      }
      case 'rooms_changed':
        if (event.reason === 'removed' && event.roomId) {
          // 삭제/강퇴/나가기는 목록 REST 왕복을 기다리지 않고 즉시 걷는다.
          // 이어지는 조회는 이벤트 오인이나 서버 버전 차이를 보정하는 재검증이다.
          this.forget(event.roomId);
        }
        void this.loadRooms({ background: true });
        if (event.roomId && this.snapshot.byRoom[event.roomId]) {
          void this.refreshMembers(event.roomId);
        }
        return;
    }
  }
}

export const teamsStore = new TeamsLiveStore();

/** 컴포넌트를 Teams 상태 전체에 구독시킨다. */
export function useTeams(): TeamsSnapshot {
  return useSyncExternalStore(teamsStore.subscribe, teamsStore.getSnapshot, teamsStore.getSnapshot);
}
