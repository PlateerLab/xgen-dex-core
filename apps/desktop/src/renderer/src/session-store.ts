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
} from '../../core/index';
import { stripBrowserContext, type BrowserSelectionResult } from '../../core/browser';
import { stripTeamsContext } from '../../core/teams-bridge';
import { xgen } from './bridge';

/** One rendered chat message (mirrors the old Chat.Msg shape). */
export interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolEvent[];
  citations?: Citation[];
  streaming?: boolean;
  error?: boolean;
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
  ): { cancel: () => void };
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
  /** Download one server-issued XGeny history reference into a renderer preview URL. */
  historyImage?: (
    workflowId: string,
    attachment: HistoryAttachment,
  ) => Promise<ChatImageAttachment | null>;
  /** Release renderer resources created by historyImage (normally a blob: URL). */
  releaseHistoryImage?: (previewUrl: string) => void;
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
  tools: ToolEvent[];
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

/** A session is worth keeping (listed, preserved on switch) once it has content
 *  or a live stream. A brand-new empty session is a throwaway. */
export function isKeepable(s: SessionState): boolean {
  return s.streaming || s.messages.length > 0;
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
      error: null,
      unseen: false,
      createdAt: t,
      updatedAt: t,
    });
    this.rt.set(iid, { cancel: null, tools: [], citations: [], historyImageUrls: new Set() });
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
      error: null,
      unseen: false,
      createdAt: t,
      updatedAt: t,
    });
    this.rt.set(interactionId, {
      cancel: null,
      tools: [],
      citations: [],
      historyImageUrls: new Set(),
    });
    this._active = interactionId;
    this.emit();
    void this.loadHistory(interactionId, agent, workflowName);
    return interactionId;
  }

  private async loadHistory(key: string, agent: Agent, name?: string): Promise<void> {
    const loadedUrls: string[] = [];
    try {
      const turns = await this.transport.historyTurns(
        agent.workflowId,
        key,
        name ?? agent.workflowName,
      );
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
    if (!s || !rt || s.streaming || (!text.trim() && attached.length === 0)) return;
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
    };

    if (multimodal && s.agent.hasAgentGeny && this.transport.uploadWorkspaceImage) {
      let cancelled = false;
      rt.cancel = () => {
        cancelled = true;
      };
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
        nl.text = nl.text + (nl.text ? '\n\n' : '') + `⚠️ ${ev.detail}`;
        nl.error = true;
      }
      let streaming = s.streaming;
      let error = s.error;
      let unseen = s.unseen;
      if (ev.kind === 'end' || ev.kind === 'error') {
        streaming = false;
        nl.streaming = false;
        if (ev.kind === 'error') error = ev.detail;
        // 이 세션이 지금 포커스된 탭이 아니면 결과를 아직 못 본 것 — 탭 강제 전환 대신
        // 점(dot)으로만 알린다. 포그라운드에서 끝났으면 이미 화면에 보이므로 표시 안 함.
        unseen = this._active !== key;
      }
      messages[messages.length - 1] = nl;
      return { ...s, messages, streaming, error, unseen, updatedAt: this.now() };
    });
    if (ev.kind === 'end' || ev.kind === 'error') rt.cancel = null;
    this.emit();
  }

  /** Stop the in-flight turn on `key` (the transcript so far is kept). */
  stop(key: string): void {
    const rt = this.rt.get(key);
    rt?.cancel?.();
    if (rt) rt.cancel = null;
    this.patch(key, (s) => {
      const messages = s.messages.slice();
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') messages[messages.length - 1] = { ...last, streaming: false };
      return { ...s, messages, streaming: false, updatedAt: this.now() };
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
      rt.cancel?.();
      this.releaseHistoryImages(key);
    }
    this.map.clear();
    this.rt.clear();
    this._active = null;
    this.emit();
  }
}
