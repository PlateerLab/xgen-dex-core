/**
 * SessionStore — the connector's multi-session runtime, lifted OUT of the React
 * tree so a conversation's live connection survives view switches.
 *
 * Why this exists
 * ───────────────
 * Chat streaming runs in the **main process**, keyed by a `streamId`; each
 * ChatEvent is pushed back to the renderer (see main/index.ts chatStart). The
 * stream keeps running as long as the window lives — it is NOT tied to any React
 * component. Previously the Chat component owned the messages + stream handle and
 * cancelled the stream whenever the open session changed, so switching agents
 * killed an in-flight answer and wiped its transcript.
 *
 * This store holds every open session at once:
 *   · switching the foreground session never cancels another session's stream,
 *   · a background turn keeps accumulating text/tool/citation events into its
 *     transcript, so returning to it shows the completed (or still-streaming) answer,
 *   · only an explicit 채팅 종료 (endChat) or the window closing tears a stream down.
 *
 * The class is framework-agnostic (no Electron/React imports) and takes its
 * transport by injection, so the whole lifecycle is unit-testable. The renderer
 * wires the real bridge + a React subscription in `session.ts`.
 */
import type {
  Agent,
  ChatEvent,
  ChatRequest,
  Citation,
  HistoryAttachment,
  ToolEvent,
  XgenErrorInfo,
} from '@dex/protocol';
import { INTERRUPTED_NOTE, describeStreamError } from '@dex/protocol';
import { stripBrowserContext, type BrowserSelectionResult } from '@dex/protocol/browser';
import { stripTeamsContext } from '@dex/protocol/teams-bridge';
import { xgen } from './bridge';

/**
 * 복원한 대화의 자리표시 에이전트.
 *
 * 저장된 탭이 아는 것은 `workflowId` 와 이름뿐이다 — 에이전트 목록을 기다렸다가
 * 대화를 되살리면, 목록 조회가 느리거나 실패한 동안 진행 중인 실행이 화면에서
 * 사라진다. 실행을 되찾는 데 필요한 것은 그 둘뿐이므로 나머지는 비워 둔다.
 */
const EMPTY_AGENT: Agent = {
  id: 0,
  workflowId: '',
  workflowName: '',
  nodeCount: 0,
  isShared: false,
  isDeployed: false,
  isCompleted: true,
  workflowType: 'canvas',
  description: '',
  username: '',
  fullName: '',
  createdAt: '',
  updatedAt: '',
};

/** One rendered chat message (mirrors the old Chat.Msg shape). */
export interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolEvent[];
  citations?: Citation[];
  streaming?: boolean;
  error?: boolean;
  /** 실패의 사용자용 형태(코드·제목·안내·원문). 화면은 이것을 그린다. */
  errorInfo?: XgenErrorInfo;
  /** 사용자가 [정지]로 끊은 턴. 실패가 아니라 **중단**이라 다르게 표시한다. */
  interrupted?: boolean;
  /** 이 메시지와 함께 보낸 화면 캡처 — 무엇을 찍었는지(창 이름). */
  screenshot?: { sourceName: string; width: number; height: number };
  /** 사용자가 붙였거나 이력에서 복원한 그림. 미리보기 URL은 열린 세션에서만 보관한다. */
  images?: ChatImageAttachment[];
  /** 이 턴에 함께 보낸 브라우저 요소/영역의 감사용 요약. */
  browserSelections?: Array<{
    id: string;
    title: string;
    url: string;
    kind: 'element' | 'region';
    elementCount: number;
  }>;
  /** 이 턴의 실행 환경(커넥터 전용 status 이벤트) — 이 PC / 서버 sandbox / 차단(blocked). */
  surface?: 'connector_local' | 'server_sandbox' | 'blocked';
  /** 서버 폴백 사유·차단 사유·로컬 안내(동기화 미완료 등) — 있으면 배지 옆에 표시. */
  surfaceNote?: string;
  /**
   * 이 말풍선은 **다른 곳에서 도는 턴의 진행분**이다 — 우리가 받은 스트림이
   * 아니라 서버 버퍼의 스냅샷이라, 새 스냅샷이 올 때마다 통째로 덮어쓴다.
   * 턴이 끝나면 완결 턴이 이 자리를 대신한다.
   */
  remotePartial?: boolean;
}

/** Public, immutable-per-change snapshot of one open session. */
export interface SessionState {
  /** Stable identity — equals interactionId. */
  key: string;
  agent: Agent;
  interactionId: string;
  /** Opened from history (이어보기) rather than started fresh. */
  resume: boolean;
  loadingHistory: boolean;
  historyLoaded: boolean;
  messages: ChatMsg[];
  /** A turn is actively streaming (the connector is live). */
  streaming: boolean;
  /**
   * 이 창이 아니라 **다른 곳**(웹·모바일·VSCode·CLI)에서 시작한 턴이 이 대화에서
   * 돌고 있는가.
   *
   * 서버 실행은 연결이 아니라 대화에 매여 있다 — 앱을 껐다 켜거나 화면이 잠겨도
   * 계속 돈다. 그 사실을 모르면 여기서는 끝난 대화처럼 보이고, 그 위에 새 턴을
   * 보내 같은 대화에서 두 실행이 겹친다. `streaming` 과 함께 [진행 중] 을 그리되,
   * 토큰은 흐르지 않는다 — 서버는 진행 중인 턴을 재전송하지 않고 완결된 턴만
   * 히스토리에 남기므로, 끝나면 폴링이 그 답을 받아 온다.
   */
  remote: boolean;
  error: string | null;
  /**
   * A turn finished (성공/에러) while this session was **not** the focused tab,
   * and the user hasn't looked at it since — drives the tab-bar dot (탭 강제
   * 전환 대신 상태만 표시). Cleared by setActive(key). Never true while streaming.
   */
  unseen: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * 커넥터 로컬 세션의 idle 임계 — 이 시간(30분) 넘게 활동이 없으면 로컬 데몬이
 * 세션을 정리(evict)한다(사이드카 armIdle 기본값과 동일). 넘으면 '삭제 예정'.
 */
export const CONNECTOR_SESSION_IDLE_MS = 30 * 60_000;

export type SessionDotState = 'active' | 'idle' | 'error';

/**
 * '진행 중인 대화' 상태 점 색을 정하는 단일 판정:
 *   - error(빨강): 마지막 턴이 실패로 끝난 세션(새 턴 시작 전까지 유지).
 *   - active(초록): 스트리밍 중이거나 최근 활동이 있어 데몬에 살아 있는 세션.
 *   - idle(회색): 활동이 없어 idle 임계를 넘긴 세션 — 곧 정리(삭제) 대상.
 * ``now`` 를 인자로 받아(테스트 가능) idle 경과를 계산한다.
 */
export function sessionDotState(s: SessionState, now: number): SessionDotState {
  if (s.error) return 'error';
  if (s.streaming) return 'active';
  if (now - s.updatedAt >= CONNECTOR_SESSION_IDLE_MS) return 'idle';
  return 'active';
}

/** The whole store as one immutable snapshot for useSyncExternalStore. */
export interface StoreSnapshot {
  /** Insertion order. */
  sessions: SessionState[];
  activeKey: string | null;
}

/** A screen capture attached to an outgoing message. */
export interface OutgoingShot {
  dataUrl?: string;
  sourceName?: string;
  width?: number;
  height?: number;
}

/** 작성기 또는 이력에 속한 그림 한 장. dataUrl은 data: 또는 renderer blob: URL이다. */
export interface ChatImageAttachment {
  dataUrl: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

/** Injected transport — the renderer passes the real xgen bridge. */
export interface SessionTransport {
  stream(
    req: ChatRequest,
    onEvent: (e: ChatEvent) => void,
    context?: { browserSelections?: BrowserSelectionResult[] },
  ): {
    /** 이 스트림을 그만 본다 — 서버 실행은 계속된다. */
    cancel: () => void;
    /** 사람이 누른 [정지] — 서버 실행도 멈춘다. */
    stop?: (interactionId: string) => Promise<unknown>;
  };
  uploadWorkspaceImage?: (request: {
    workflowId: string;
    interactionId: string;
    attachmentId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }) => Promise<{
    workspace_path?: string;
    size?: number;
    sha256?: string;
    status?: 'pending_approval';
  }>;
  historyTurns(
    workflowId: string,
    interactionId: string,
    name?: string,
  ): Promise<Array<{ input: string; output: string; attachments?: HistoryAttachment[] }>>;
  /**
   * 지난 턴 + **지금 도는 턴이 있는가** — 창을 연 첫 순간의 상태.
   *
   * 이후의 변화는 대화 소켓이 알려 준다(setRemoteRunning). 첫 페인트까지 소켓을
   * 기다리면 그 사이 작성기가 열려 있어, 이미 도는 턴 위에 새 턴을 얹을 수 있다.
   * 없으면 historyTurns 로 물러난다(구버전 preload) — 진행 중을 복원하지 못할 뿐이다.
   */
  historySnapshot?: (
    workflowId: string,
    interactionId: string,
    name?: string,
  ) => Promise<{
    turns: Array<{ input: string; output: string; attachments?: HistoryAttachment[] }>;
    running: boolean;
  }>;
  /** 스트림을 쥐고 있지 않은 대화의 [정지] — 다른 기기에서 시작한 턴. */
  stopChat?: (interactionId: string) => Promise<unknown>;
  /** Download one server-issued XGeny history reference into a renderer preview URL. */
  historyImage?: (
    workflowId: string,
    attachment: HistoryAttachment,
  ) => Promise<ChatImageAttachment | null>;
  /** Release renderer resources created by historyImage (normally a blob: URL). */
  releaseHistoryImage?: (previewUrl: string) => void;
  /** 대화 소켓 감시 시작/중지 — 서버 주입 턴(트리거 반응)의 실시간 수신.
   *  세션이 열릴 때 붙고 닫힐 때 떨어진다. 미구현(테스트)이면 no-op. */
  watchConversation?: (workflowId: string, workflowName: string, interactionId: string) => void;
  unwatchConversation?: (interactionId: string) => void;
}

function imageBytes(dataUrl: string): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl);
  if (!match) throw new Error('지원하지 않는 이미지 형식입니다.');
  const binary = atob(match[2].replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { mimeType: match[1].toLowerCase(), bytes };
}

/** Per-session mutable runtime kept out of the public snapshot. */
interface Runtime {
  cancel: (() => void) | null;
  /** 사람이 누른 [정지] 를 서버에 전하는 길 (stream 핸들이 준다). */
  stopServer: ((interactionId: string) => Promise<unknown>) | null;
  tools: ToolEvent[];
  /** 대화 소켓으로 이미 반영한 외부 턴의 io_id — push 중복 방지. */
  externalIoSeen?: Set<number>;
  citations: Citation[];
  historyImageUrls: Set<string>;
}

export function newInteractionId(workflowId: string, now: number): string {
  return `conn-${workflowId}-${now}`;
}

/** Dedupe-merge citations by fileName#page (mirrors the old Chat helper). */
export function mergeCitations(into: Citation[], add?: Citation[]): Citation[] {
  if (!add?.length) return into;
  const seen = new Set(into.map((c) => `${c.fileName ?? ''}#${c.pageNumber ?? ''}`));
  const out = [...into];
  for (const c of add) {
    const k = `${c.fileName ?? ''}#${c.pageNumber ?? ''}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * A session is worth keeping (listed, preserved on switch) once it has content
 * or a live stream. A brand-new empty session is a throwaway.
 *
 * 내용도 스트림도 없지만 **버리면 안 되는** 두 경우를 함께 본다:
 *
 * - `remote` — 다른 곳에서 시작한 턴이 이 대화에서 돌고 있다. 토큰은 이 창으로
 *   흐르지 않으므로 `streaming` 은 거짓이지만, 실행은 살아 있다. 버리면 [정지]
 *   버튼째로 사라지고, 사용자는 멈출 수단을 잃는다.
 * - `resume && !historyLoaded` — 되살리는 중이다. 히스토리가 도착하기 전의 몇
 *   백 ms 를 "빈 세션" 으로 읽으면 탭이 떴다가 사라진다.
 */
export function isKeepable(s: SessionState): boolean {
  if (s.streaming || s.messages.length > 0) return true;
  if (s.remote) return true;
  return s.resume && !s.historyLoaded;
}

/** Open sessions, most-recently-active first. */
export function openSessions(all: SessionState[]): SessionState[] {
  return all.filter(isKeepable).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Open sessions for one agent, most-recently-active first. */
export function agentSessions(all: SessionState[], workflowId: string): SessionState[] {
  return openSessions(all).filter((s) => s.agent.workflowId === workflowId);
}

export class SessionStore {
  private map = new Map<string, SessionState>();
  private rt = new Map<string, Runtime>();
  private _active: string | null = null;
  private listeners = new Set<() => void>();
  private snap: StoreSnapshot = { sessions: [], activeKey: null };

  constructor(
    private transport: SessionTransport,
    private now: () => number = () => Date.now(),
  ) {}

  // ── useSyncExternalStore contract (stable arrow refs) ──────────────
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): StoreSnapshot => this.snap;

  private emit(): void {
    // Rebuild the snapshot only here → getSnapshot returns a stable reference
    // between mutations (required by useSyncExternalStore).
    this.snap = { sessions: [...this.map.values()], activeKey: this._active };
    for (const l of this.listeners) l();
  }

  private patch(key: string, updater: (s: SessionState) => SessionState): void {
    const s = this.map.get(key);
    if (!s) return;
    this.map.set(key, updater(s));
  }

  get activeKey(): string | null {
    return this._active;
  }

  active(): SessionState | null {
    return this._active ? (this.map.get(this._active) ?? null) : null;
  }

  get(key: string): SessionState | null {
    return this.map.get(key) ?? null;
  }

  // ── Opening sessions ───────────────────────────────────────────────

  /**
   * Start (or reuse) a fresh conversation with `agent` and focus it. If the
   * current session is already an empty, non-resumed chat with the same agent
   * we reuse it — pressing 새 대화 twice shouldn't pile up blank sessions.
   */
  openNew(agent: Agent): string {
    const cur = this._active ? this.map.get(this._active) : null;
    if (
      cur &&
      cur.agent.workflowId === agent.workflowId &&
      !cur.resume &&
      !cur.streaming &&
      cur.messages.length === 0
    ) {
      return cur.key;
    }
    this.gcActiveIfEmpty();
    const t = this.now();
    const iid = newInteractionId(agent.workflowId, t);
    this.map.set(iid, {
      key: iid,
      agent,
      interactionId: iid,
      resume: false,
      loadingHistory: false,
      historyLoaded: true,
      messages: [],
      streaming: false,
      remote: false,
      error: null,
      unseen: false,
      createdAt: t,
      updatedAt: t,
    });
    this.rt.set(iid, {
      cancel: null,
      stopServer: null,
      tools: [],
      citations: [],
      historyImageUrls: new Set(),
    });
    this.transport.watchConversation?.(agent.workflowId, agent.workflowName || agent.workflowId, iid);
    this._active = iid;
    this.emit();
    return iid;
  }

  /**
   * Reopen a past conversation (이어보기). If it is already open we simply focus
   * it — keeping any in-flight stream — otherwise we create it and load history.
   */
  openResume(agent: Agent, interactionId: string, workflowName?: string): string {
    if (this.map.has(interactionId)) {
      this.setActive(interactionId);
      return interactionId;
    }
    this.gcActiveIfEmpty();
    this.spawnResume(agent, interactionId, workflowName, true);
    return interactionId;
  }

  /**
   * 앱을 껐다 켠 뒤, 저장된 워크스페이스 탭에 남아 있던 대화를 되살린다.
   *
   * 왜 필요한가. 서버 실행은 **연결이 아니라 대화**에 매여 있다 — 커넥터를
   * 실수로 닫아도 턴은 계속 돈다. 그런데 다시 켰을 때 그 대화가 열려 있지
   * 않으면, 창은 아무것도 모른 채 빈 화면을 그리고 [정지] 버튼도 없다. 사용자
   * 입장에서는 실행이 사라진 것과 구분되지 않는다.
   *
   * :meth:`openResume` 과 하는 일은 같지만 두 가지가 다르다:
   *
   * 1. **포커스를 옮기지 않는다.** 복원은 사용자가 한 행동이 아니다. 저장된
   *    활성 탭이 그대로 활성이어야 한다(여럿을 되살리면 마지막 것이 포커스를
   *    가로챈다).
   * 2. **이미 열린 것은 건드리지 않는다.** 재진입해도 스트림이 끊기지 않는다.
   *
   * 되살린 세션은 곧바로 대화 소켓을 구독하고 히스토리를 읽는다 — 그 두 길이
   * `running` 을 실어 오므로([진행 중]·[정지]), 상태는 스스로 제자리를 찾는다.
   */
  restore(entries: { workflowId: string; workflowName?: string; interactionId: string }[]): void {
    let added = false;
    for (const entry of entries) {
      if (!entry.interactionId || !entry.workflowId) continue;
      if (this.map.has(entry.interactionId)) continue;
      const agent = {
        ...EMPTY_AGENT,
        workflowId: entry.workflowId,
        workflowName: entry.workflowName || entry.workflowId,
      };
      this.spawnResume(agent, entry.interactionId, entry.workflowName, false);
      added = true;
    }
    if (added) this.emit();
  }

  /** openResume / restore 의 공통 몸통. `focus` 만이 둘을 가른다. */
  private spawnResume(
    agent: Agent,
    interactionId: string,
    workflowName: string | undefined,
    focus: boolean,
  ): void {
    const t = this.now();
    this.map.set(interactionId, {
      key: interactionId,
      agent,
      interactionId,
      resume: true,
      loadingHistory: true,
      historyLoaded: false,
      messages: [],
      streaming: false,
      remote: false,
      error: null,
      unseen: false,
      createdAt: t,
      updatedAt: t,
    });
    this.rt.set(interactionId, {
      cancel: null,
      stopServer: null,
      tools: [],
      citations: [],
      historyImageUrls: new Set(),
    });
    this.transport.watchConversation?.(
      agent.workflowId,
      workflowName || agent.workflowName || agent.workflowId,
      interactionId,
    );
    if (focus) {
      this._active = interactionId;
      this.emit();
    }
    void this.loadHistory(interactionId, agent, workflowName);
  }

  private async loadHistory(key: string, agent: Agent, name?: string): Promise<void> {
    const loadedUrls: string[] = [];
    try {
      // 지난 턴만이 아니라 **지금 도는 턴이 있는가**도 함께 읽는다. 웹·모바일·
      // VSCode·CLI 에서 시작한 턴이 아직 돌고 있으면 이 창도 [진행 중] 이어야
      // 하고, 그 위에 새 턴을 얹어서는 안 된다.
      const snapshot = this.transport.historySnapshot
        ? await this.transport.historySnapshot(agent.workflowId, key, name ?? agent.workflowName)
        : {
            turns: await this.transport.historyTurns(
              agent.workflowId,
              key,
              name ?? agent.workflowName,
            ),
            running: false,
          };
      const turns = snapshot.turns;
      const msgs: ChatMsg[] = [];
      for (const tn of turns) {
        // 최종 방어: text 는 무조건 문자열이어야 렌더가 안전하다 (transport 가
        // 이미 문자열화하지만, 다른 주입 경로가 생겨도 여기서 못 뚫게 한다).
        // 봉투는 **두 겹**일 수 있다 — 브라우저 컨텍스트와 Teams 컨텍스트가 같은
        // 턴에 붙는다. 붙인 순서(teams → browser)의 역순으로 벗긴다.
        const input = stripTeamsContext(
          stripBrowserContext(
            typeof tn.input === 'string' ? tn.input : tn.input == null ? '' : String(tn.input),
          ),
        );
        const output =
          typeof tn.output === 'string' ? tn.output : tn.output == null ? '' : String(tn.output);
        const images: ChatImageAttachment[] = [];
        if (this.transport.historyImage) {
          for (const attachment of tn.attachments ?? []) {
            if (attachment.type !== 'picture') continue;
            try {
              const image = await this.transport.historyImage(agent.workflowId, attachment);
              if (!image) continue;
              const runtime = this.rt.get(key);
              if (!runtime) {
                this.transport.releaseHistoryImage?.(image.dataUrl);
                continue;
              }
              runtime.historyImageUrls.add(image.dataUrl);
              loadedUrls.push(image.dataUrl);
              images.push(image);
            } catch {
              // A deleted/expired image must not prevent the text transcript or
              // the other attachments in this conversation from reopening.
            }
          }
        }
        if (input || images.length > 0) {
          msgs.push({ role: 'user', text: input, images: images.length > 0 ? images : undefined });
        }
        if (output) msgs.push({ role: 'assistant', text: output });
      }
      // Only overwrite the transcript if a live turn hasn't started meanwhile.
      const current = this.map.get(key);
      if (!current || current.streaming || current.messages.length > 0) {
        this.releaseLoadedHistoryUrls(key, loadedUrls);
        this.patch(key, (s) => ({ ...s, loadingHistory: false, historyLoaded: true }));
      } else {
        this.patch(key, (s) => ({
          ...s,
          messages: msgs,
          loadingHistory: false,
          historyLoaded: true,
          remote: snapshot.running,
          updatedAt: this.now(),
        }));
      }
    } catch {
      this.releaseLoadedHistoryUrls(key, loadedUrls);
      this.patch(key, (s) => ({ ...s, loadingHistory: false, historyLoaded: true }));
    }
    this.emit();
  }

  private releaseLoadedHistoryUrls(key: string, urls: Iterable<string>): void {
    const runtime = this.rt.get(key);
    for (const url of urls) {
      runtime?.historyImageUrls.delete(url);
      try {
        this.transport.releaseHistoryImage?.(url);
      } catch {
        /* best-effort renderer resource cleanup */
      }
    }
  }

  private releaseHistoryImages(key: string): void {
    const runtime = this.rt.get(key);
    if (!runtime) return;
    this.releaseLoadedHistoryUrls(key, [...runtime.historyImageUrls]);
  }

  // ── Focus / GC ─────────────────────────────────────────────────────

  setActive(key: string | null): void {
    if (this._active === key) return;
    const prev = this._active;
    this._active = key;
    if (key) this.patch(key, (s) => (s.unseen ? { ...s, unseen: false } : s));
    if (prev && prev !== key) this.gcIfEmpty(prev);
    this.emit();
  }

  private gcActiveIfEmpty(): void {
    if (this._active) this.gcIfEmpty(this._active);
  }

  /** Drop a throwaway (no messages, not streaming, not mid-load) session. */
  private gcIfEmpty(key: string): void {
    const s = this.map.get(key);
    if (!s) return;
    if (!s.streaming && !s.loadingHistory && s.messages.length === 0) {
      this.rt.get(key)?.cancel?.();
      this.releaseHistoryImages(key);
      this.transport.unwatchConversation?.(key);
      this.rt.delete(key);
      this.map.delete(key);
      if (this._active === key) this._active = null;
    }
  }

  // ── Sending / streaming ────────────────────────────────────────────

  /** Send a turn on `key`. Safe to call for a non-focused session. */
  send(
    key: string,
    text: string,
    shot?: OutgoingShot | null,
    images: ChatImageAttachment[] = [],
    browserSelections: BrowserSelectionResult[] = [],
  ): void {
    const s = this.map.get(key);
    const rt = this.rt.get(key);
    // 작성기 경계에서도 검사하지만 스토어는 외부 주입/오래된 렌더러를 믿지 않는다.
    // SVG·임의 data URL 은 모델 입력과 <img> 미리보기에 싣지 않는다.
    const attached = images.filter((image) =>
      /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(image.dataUrl),
    );
    // s.remote — 다른 곳에서 시작한 턴이 아직 돈다. 그 위에 얹으면 같은 대화에서
    // 두 실행이 겹치고, 두 답이 서로를 덮어쓴다. 멈추려면 [정지] 를 눌러야 한다.
    if (!s || !rt || s.streaming || s.remote || (!text.trim() && attached.length === 0)) return;
    rt.tools = [];
    rt.citations = [];
    const userMsg: ChatMsg = {
      role: 'user',
      text,
      images: attached.length > 0 ? attached : undefined,
      browserSelections:
        browserSelections.length > 0
          ? browserSelections.map((selection) => ({
              id: selection.id,
              title: selection.title,
              url: selection.url,
              kind: selection.kind,
              elementCount: selection.elements.length,
            }))
          : undefined,
      screenshot: shot
        ? {
            sourceName: shot.sourceName ?? '화면',
            width: shot.width ?? 0,
            height: shot.height ?? 0,
          }
        : undefined,
    };
    const asst: ChatMsg = {
      role: 'assistant',
      text: '',
      tools: [],
      citations: [],
      streaming: true,
    };
    this.patch(key, (st) => ({
      ...st,
      messages: [...st.messages, userMsg, asst],
      streaming: true,
      error: null,
      unseen: false,
      updatedAt: this.now(),
    }));
    this.emit();
    const multimodal = attached.length > 0 || !!shot?.dataUrl;
    const content: unknown[] = [{ type: 'text', text }];
    for (const image of attached) {
      content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    }
    if (shot?.dataUrl) {
      content.push({ type: 'image_url', image_url: { url: shot.dataUrl } });
    }
    const input: ChatRequest['input'] = multimodal ? content : text;
    const startStream = (preparedInput: ChatRequest['input']): void => {
      const current = this.map.get(key);
      if (!current?.streaming) return;
      const handle = this.transport.stream(
        {
          workflowId: s.agent.workflowId,
          workflowName: s.agent.workflowName,
          input: preparedInput,
          interactionId: s.interactionId,
        },
        (ev) => this.onEvent(key, ev),
        { browserSelections },
      );
      rt.cancel = handle.cancel;
      // 사람이 [정지] 를 누르면 이 길로 서버까지 닿는다. abort 만으로는 멈추지
      // 않는다 — 서버는 연결 끊김을 더 이상 취소로 읽지 않는다.
      rt.stopServer = handle.stop ?? null;
    };

    if (multimodal && s.agent.hasAgentGeny && this.transport.uploadWorkspaceImage) {
      let cancelled = false;
      rt.cancel = () => {
        cancelled = true;
      };
      // 업로드 단계에서는 아직 서버 실행이 없다 — 스트림이 열리면 위에서 채운다.
      rt.stopServer = null;
      const pending = [
        ...attached.map((image) => ({
          dataUrl: image.dataUrl,
          name: image.name,
        })),
        ...(shot?.dataUrl
          ? [{ dataUrl: shot.dataUrl, name: `${shot.sourceName || 'screen'}.png` }]
          : []),
      ];
      void Promise.all(
        pending.map(async (image, index) => {
          const decoded = imageBytes(image.dataUrl);
          if (decoded.bytes.byteLength > 20 * 1024 * 1024) {
            throw new Error('XGeny 이미지 한 장은 20MiB를 넘을 수 없습니다.');
          }
          const attachmentId = `conn-${s.interactionId}-${index + 1}`;
          const result = await this.transport.uploadWorkspaceImage!({
            workflowId: s.agent.workflowId,
            interactionId: s.interactionId,
            attachmentId,
            name: image.name || `image-${index + 1}.png`,
            mimeType: decoded.mimeType,
            bytes: decoded.bytes,
          });
          if (result.status === 'pending_approval') {
            throw new Error('이미지 업로드가 승인 대기 중입니다. 승인 후 다시 시도해 주세요.');
          }
          if (!result.workspace_path) throw new Error('Workspace 업로드 경로가 없습니다.');
          return {
            kind: 'image',
            attachment_id: attachmentId,
            name: image.name,
            mime_type: decoded.mimeType,
            size: result.size ?? decoded.bytes.byteLength,
            sha256: result.sha256,
            workspace_path: result.workspace_path,
          };
        }),
      )
        .then((attachments) => {
          if (cancelled) return;
          startStream({ input_str: text, attachments });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          this.onEvent(key, {
            kind: 'error',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    startStream(input);
  }

  private onEvent(key: string, ev: ChatEvent): void {
    const rt = this.rt.get(key);
    if (!rt) return;
    this.patch(key, (s) => {
      const messages = s.messages.slice();
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') return s;
      const nl: ChatMsg = { ...last };
      if (ev.kind === 'text') nl.text = nl.text + ev.content;
      else if (ev.kind === 'status') {
        nl.surface = ev.surface;
        // server_sandbox: 폴백 사유(reason 이 사람이 읽는 문장). blocked: 차단 메시지(detail).
        // connector_local: 로컬 안내(detail — 동기화 미완료 등)만.
        nl.surfaceNote =
          ev.surface === 'server_sandbox'
            ? (ev.reason ?? ev.detail)
            : ev.surface === 'blocked'
              ? (ev.detail ?? ev.reason)
              : ev.detail;
      } else if (ev.kind === 'summary' && !nl.text) nl.text = ev.text;
      else if (ev.kind === 'tool') {
        rt.tools = [...rt.tools, ev.event];
        nl.tools = rt.tools;
        rt.citations = mergeCitations(rt.citations, ev.event.citations);
        nl.citations = rt.citations;
      } else if (ev.kind === 'error') {
        // 본문에 원문을 붙이지 않는다 — `stream … → 502` 를 사용자에게 그대로
        // 보이던 자리다. 코드·제목·안내는 errorInfo 로 넘기고 화면이 구조를
        // 갖춰 그린다(원문은 그 안에서 [자세히]로 펼친다).
        nl.errorInfo = ev.info ?? describeStreamError(ev.detail);
        nl.error = true;
      }
      let streaming = s.streaming;
      let error = s.error;
      let unseen = s.unseen;
      let remote = s.remote;
      if (ev.kind === 'detached') {
        // 스트림이 끊겼을 뿐, **그 턴은 서버에서 계속 돈다.** 여기서 끝난 것으로
        // 표시하면 받다 만 조각이 최종 답이 되고, 실제 답은 다음 새로고침까지
        // 아무 데도 안 보인다 — 2026-09-08 의 76분짜리 턴이 그렇게 사라졌다.
        //
        // 스트림 소유권만 내려놓고 '다른 곳에서 진행 중' 으로 넘긴다. 그 상태를
        // 지켜보는 것은 이미 붙어 있는 대화 소켓이고(setRemoteRunning /
        // applyExternalTurn), 완결된 턴이 오면 그때 답이 채워진다.
        streaming = false;
        remote = true;
        nl.streaming = false;
        nl.surfaceNote = '연결이 끊겼습니다 — 서버에서 계속 진행 중입니다.';
      }
      if (ev.kind === 'end' || ev.kind === 'error') {
        streaming = false;
        nl.streaming = false;
        if (ev.kind === 'error') error = (ev.info ?? describeStreamError(ev.detail)).title;
        // 이 세션이 지금 포커스된 탭이 아니면 결과를 아직 못 본 것 — 탭 강제 전환 대신
        // 점(dot)으로만 알린다. 포그라운드에서 끝났으면 이미 화면에 보이므로 표시 안 함.
        unseen = this._active !== key;
      }
      messages[messages.length - 1] = nl;
      return { ...s, messages, streaming, remote, error, unseen, updatedAt: this.now() };
    });
    if (ev.kind === 'end' || ev.kind === 'error' || ev.kind === 'detached') {
      rt.cancel = null;
      // 분리된 턴을 멈추는 길은 남겨 둔다 — [정지] 는 스트림이 아니라 대화를 향한다.
      if (ev.kind !== 'detached') rt.stopServer = null;
    }
    this.emit();
  }

  /**
   * 사람이 누른 [정지] — 스트림에서 손을 떼고 **서버 실행도** 멈춘다.
   * (여기까지 쌓인 대화는 그대로 둔다.)
   *
   * abort 만 하던 시절의 전제는 "연결을 끊으면 서버가 멈춘다" 였다. 서버는 더
   * 이상 그렇게 읽지 않는다 — 그렇게 읽던 탓에 화면 잠금·절전·기기 이동이 곧
   * 실행 중단이었고, 사용자는 [정지] 를 누른 적이 없었다. 그래서 이제 정지는
   * 연결이 아니라 **대화**를 향해야 하고, 그 길이 여기다. 부르지 않으면 버려진
   * 턴이 끝까지 돌아 이 대화에 답을 적는다.
   */
  stop(key: string): void {
    const rt = this.rt.get(key);
    const interactionId = this.map.get(key)?.interactionId ?? key;
    const stopServer = rt?.stopServer ?? this.transport.stopChat ?? null;
    rt?.cancel?.();
    if (rt) {
      rt.cancel = null;
      rt.stopServer = null;
    }
    // 서버에 닿지 못해도 화면은 멈춘 것으로 둔다 — 되돌리면 사용자가 누른
    // 버튼이 되살아나는 것처럼 보인다.
    if (stopServer) void Promise.resolve(stopServer(interactionId)).catch(() => undefined);
    this.patch(key, (s) => {
      const messages = s.messages.slice();
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        // 중단은 실패가 아니다 — 지금까지 받은 글은 그대로 두고 **중단됐다는
        // 사실만** 남긴다. 한 글자도 못 받고 끊긴 턴은 예전에 빈 말풍선으로
        // 남아 "아무 일도 없었던 것" 처럼 보였다(사용자 보고). 그 자리에는
        // 중단 문구를 세운다.
        messages[messages.length - 1] = {
          ...last,
          streaming: false,
          interrupted: true,
          // 본문 자리에는 **서버가 기록에 남기는 그 글**을 쓴다 — 대화를 다시
          // 열면 히스토리가 같은 문장을 돌려주므로 설명이 바뀌지 않는다.
          text: last.text || INTERRUPTED_NOTE,
        };
      }
      return { ...s, messages, streaming: false, remote: false, updatedAt: this.now() };
    });
    this.emit();
  }

  /**
   * 이 대화에 **다른 곳에서 시작한 턴**이 도는가 — 대화 소켓이 알려 준다.
   *
   * 서버 실행은 연결이 아니라 대화에 매여 있어서, 웹이나 다른 기기에서 시작한
   * 턴이 이 창을 켠 순간에도 돌고 있을 수 있다. 그 사실을 모르면 여기서는 끝난
   * 대화처럼 보이고, 그 위에 새 턴을 보내 같은 대화에서 둘이 겹친다.
   *
   * 폴링하지 않는 이유: 소켓이 구독 확립과 재연결마다 이 값을 다시 보고하므로,
   * 끊겼다 붙는 것만으로 상태가 스스로 맞춰진다.
   *
   * ``live`` — 돌고 있는 턴의 **여기까지**. 예전에는 이 자리가 비어 있었고
   * (서버가 진행 중인 턴을 어디에도 남기지 않았다), 그래서 다시 켠 창은
   * "진행 중" 표시와 **빈 말풍선**을 함께 보여 줬다. 이제 서버가 짧게 사는
   * 버퍼(turn_stream)에 진행분을 남기고 구독 확립 때 실어 준다.
   *
   * 스냅샷은 재연결·하트비트마다 **처음부터 다시** 오므로 이어붙이면 같은 글이
   * 여러 번 쌓인다. 전용 말풍선 하나를 두고 매번 덮어쓴다. 턴이 끝나면 완결
   * 턴 push(applyExternalTurn)가 이 자리를 대신한다.
   */
  setRemoteRunning(
    key: string,
    running: boolean,
    live?: { text?: string } | null,
  ): void {
    const s = this.map.get(key);
    if (!s) return;
    // 이 창이 스트림을 쥐고 있으면 그 턴은 '다른 곳' 이 아니다 — 진행분도
    // 우리 스트림이 이미 그리고 있으므로 덮어쓰면 안 된다.
    const next = running && !s.streaming;
    const partial = next && typeof live?.text === 'string' ? live.text : '';
    const hadPartial = s.messages[s.messages.length - 1]?.remotePartial === true;
    if (s.remote === next && !partial && !hadPartial) return;
    this.patch(key, (cur) => {
      const messages = [...cur.messages];
      const last = messages[messages.length - 1];
      if (partial) {
        if (last?.remotePartial) {
          if (last.text === partial) return { ...cur, remote: next };
          messages[messages.length - 1] = { ...last, text: partial };
        } else {
          messages.push({
            role: 'assistant', text: partial, streaming: true, remotePartial: true,
            surfaceNote: '다른 곳에서 시작한 응답이 진행 중입니다.',
          });
        }
      } else if (!next && last?.remotePartial) {
        // 턴이 끝났다 — 완결 턴이 곧 온다. 진행분 말풍선은 놓는다.
        messages.pop();
      }
      return { ...cur, messages, remote: next, updatedAt: this.now() };
    });
    this.emit();
  }


  /**
   * **다른 화면**(웹 탭·다른 기기)이 돌리는 턴을 이 창에 그대로 그린다.
   *
   * 무엇이 없었나: 같은 대화를 앱과 웹에 나란히 열어 두고 한 쪽에서 말을 걸면,
   * 다른 쪽에는 **턴이 끝날 때까지 아무것도** 나타나지 않았다. 상대가 무엇을
   * 물었는지조차 완결 뒤에야 알 수 있었고, 그것도 최대 10초 뒤였다.
   *
   * ``setRemoteRunning`` 과 자리를 나눈다: 그쪽은 **다시 켰을 때** 이미 돌던
   * 턴의 스냅샷(매번 통째로 덮어쓴다)이고, 이쪽은 **지금 일어나는 일**의
   * 흐름(토큰마다 이어붙인다)이다. 둘 다 같은 말풍선(`remotePartial`)을 쓰므로
   * 어느 쪽이 먼저 와도 화면은 하나로 보인다.
   *
   * 이 창이 스트림을 쥐고 있으면 손대지 않는다 — 그 턴은 '다른 곳' 이 아니다.
   * (서버도 표식(origin_id)으로 자기 턴의 전파를 되돌려 보내지 않지만, 화면이
   * 그 사실에만 기대면 표식이 빠진 날 조용히 글이 두 번 그려진다.)
   */
  applyPeerEvent(event: {
    kind: 'started' | 'exec' | 'ended' | 'gap';
    interactionId: string;
    input?: string;
    output?: string;
    event?: string;
    data?: unknown;
  }): void {
    const key = event.interactionId;
    const s = this.map.get(key);
    if (!s || s.streaming) return;
    // 구멍(gap)은 여기서 따로 메우지 않는다 — 종료 프레임이 **완결 본문**을
    // 통째로 싣고 오므로 마지막에는 반드시 맞는다.
    if (event.kind === 'gap') return;

    if (event.kind === 'started') {
      this.patch(key, (cur) => ({
        ...cur,
        messages: [
          ...cur.messages,
          { role: 'user', text: String(event.input ?? '') },
          {
            role: 'assistant', text: '', streaming: true, remotePartial: true,
            surfaceNote: '다른 곳에서 시작한 응답이 진행 중입니다.',
          },
        ],
        remote: true,
        updatedAt: this.now(),
      }));
      this.emit();
      return;
    }

    if (event.kind === 'exec') {
      // 본문 토큰만 이어붙인다. 진행 이벤트(도구·노드)는 이 창의 활동 표시가
      // 자기 턴에서만 의미가 있으므로 여기서는 흘리지 않는다.
      const d = event.data as { type?: string; content?: unknown } | undefined;
      if (event.event !== 'message' || d?.type !== 'data') return;
      const text = typeof d.content === 'string' ? d.content : '';
      if (!text) return;
      this.patch(key, (cur) => {
        const messages = [...cur.messages];
        const last = messages[messages.length - 1];
        if (!last?.remotePartial) return cur;
        messages[messages.length - 1] = { ...last, text: (last.text || '') + text };
        return { ...cur, messages, updatedAt: this.now() };
      });
      this.emit();
      return;
    }

    // 종료 — 완결 본문으로 덮어쓴다. 중간에 한두 조각을 놓쳤어도 마지막이 맞는다.
    this.patch(key, (cur) => {
      const messages = [...cur.messages];
      const last = messages[messages.length - 1];
      if (last?.remotePartial) {
        messages[messages.length - 1] = {
          ...last,
          text: String(event.output ?? last.text ?? ''),
          streaming: false,
          remotePartial: false,
          surfaceNote: undefined,
        };
      }
      return { ...cur, messages, remote: false, updatedAt: this.now() };
    });
    this.emit();
  }

  /** 채팅 종료 — cancel any stream and forget the session entirely. */
  endChat(key: string): void {
    // '진행 중 대화' 삭제 → 서버 세션 RAM(executor + 라우팅)을 완전 정리(evict). best-effort:
    // 서버 응답을 기다리지 않고, 미도달/미인증이어도 로컬 삭제는 계속한다. 이력은 보존
    // (지난 대화는 '이전 대화'에 남는다). 로컬 데몬은 공유라 여기서 내리지 않는다(30분 idle).
    const s = this.map.get(key);
    if (s?.agent?.workflowId && s.interactionId) {
      try {
        void xgen?.chat?.endSession?.(s.agent.workflowId, s.interactionId);
      } catch {
        /* 서버 미도달 — 로컬 삭제는 계속 */
      }
    }
    this.rt.get(key)?.cancel?.();
    this.releaseHistoryImages(key);
    this.transport.unwatchConversation?.(key);
    this.rt.delete(key);
    this.map.delete(key);
    if (this._active === key) {
      const rest = [...this.map.values()]
        .filter(isKeepable)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      this._active = rest[0]?.key ?? null;
    }
    this.emit();
  }

  /** Tear everything down (logout / auth failure). */
  reset(): void {
    for (const [key, rt] of this.rt.entries()) {
      // 로그아웃·인증 실패는 [정지] 가 아니다 — 스트림만 놓고 서버 실행은 둔다.
      rt.cancel?.();
      this.releaseHistoryImages(key);
      this.transport.unwatchConversation?.(key);
    }
    this.map.clear();
    this.rt.clear();
    this._active = null;
    this.emit();
  }

  /**
   * 대화 소켓이 push 한 **서버 주입 턴**(Job/sub-agent 트리거의 반응)을 열린
   * 세션에 실시간 반영한다 — 이게 없으면 새로고침해야 보였다.
   *
   * 완결 턴만 온다(서버가 진행 중 반응 턴을 보류). 자기 자신이 보낸 사용자
   * 턴도 push 로 오지만(source='user') 그건 SSE 스트림이 이미 그렸으므로
   * 트리거 턴(source='subagent_report')만 집는다. io_id 로 중복을 막는다.
   */
  applyExternalTurn(turn: {
    interactionId: string;
    ioId: number;
    input: string;
    output: string;
    source: string;
  }): void {
    const s = this.map.get(turn.interactionId);
    const rt = this.rt.get(turn.interactionId);
    if (!s || !rt) return;
    /**
     * 어떤 턴을 받아 그리는가.
     *
     * - `subagent_report` — 서버가 세션에 주입한 반응 턴. 어느 스트림에도 실리지
     *   않으므로 여기서만 화면에 닿는다.
     * - 그 밖(`user` 등) — 보통은 **우리 스트림이 이미 그렸다.** 다만 다른
     *   기기에서 시작한 턴(`remote`)은 이 창이 그린 적이 없다 — 그것까지 버리면
     *   웹에서 보낸 질문이 앱에서는 영영 안 보인다.
     */
    const mine = !s.remote;
    if (turn.source !== 'subagent_report' && mine) return;
    if (!turn.output) return; // 미완결 — 완결 push 를 기다린다
    rt.externalIoSeen = rt.externalIoSeen ?? new Set<number>();
    if (turn.ioId && rt.externalIoSeen.has(turn.ioId)) return;
    if (turn.ioId) rt.externalIoSeen.add(turn.ioId);
    s.messages = [
      ...s.messages,
      { role: 'user', text: turn.input },
      { role: 'assistant', text: turn.output },
    ];
    s.updatedAt = this.now();
    // 다른 곳에서 돌던 턴이 끝났다 — 답이 여기 도착했으니 [진행 중] 을 내린다.
    if (s.remote) s.remote = false;
    if (this._active !== turn.interactionId) s.unseen = true;
    this.emit();
  }
}
