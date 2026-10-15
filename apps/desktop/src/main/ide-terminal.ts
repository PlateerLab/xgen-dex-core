/**
 * ide-terminal — 채팅 [IDE] 의 터미널 소켓 (메인 프로세스 전용).
 *
 * 렌더러는 CSP 로 소켓을 직접 열지 못하고, 게이트웨이는 핸드셰이크의
 * `Authorization: Bearer` 로 사용자를 안다 — 헤더를 실을 수 있는 곳은 메인뿐이다
 * (Teams 소켓과 같은 이유, `teams-ws.ts`).
 *
 * 여기는 **이어 주기만** 한다. 다시 붙는 일은 렌더러의 터미널이 한다: 셸은 서버에 살아 있고
 * 같은 터미널 id 로 다시 붙으면 최근 출력부터 이어지므로, 소켓 하나의 수명은 짧아도 된다.
 * 다만 토큰 회전으로 핸드셰이크가 401/403 을 맞으면 여기서 한 번 갱신하고 다시 연다 —
 * 그렇지 않으면 렌더러는 그것을 "서버가 거절했다" 로 읽고 멈춘다.
 */
import WebSocket from 'ws';
import type { WebContents } from 'electron';
import { ideTerminalSocketPath } from '@dex/protocol';
import { xgenWebSocketTlsOptions } from '@dex/engine/connection-security';

export interface IdeTerminalDeps {
  baseUrl: () => string;
  token: () => Promise<string>;
  refreshAuth: () => Promise<string | null>;
  allowPrivateCertificate: () => boolean;
}

export type IdeTerminalEvent =
  | { socket: string; type: 'frame'; frame: Record<string, unknown> }
  | { socket: string; type: 'close'; code: number; reason: string };

interface Entry {
  ws: WebSocket | null;
  sender: WebContents;
  closed: boolean;
}

const FRAME_MAX = 2 * 1024 * 1024;

export class IdeTerminalHub {
  private readonly sockets = new Map<string, Entry>();

  constructor(
    private readonly deps: () => IdeTerminalDeps | null,
    private readonly emit: (sender: WebContents, event: IdeTerminalEvent) => void,
  ) {}

  open(
    sender: WebContents,
    socket: string,
    workflowId: string,
    termId: string,
    options: { rows: number; cols: number; cwd?: string },
  ): void {
    this.close(socket);
    const entry: Entry = { ws: null, sender, closed: false };
    this.sockets.set(socket, entry);
    sender.once('destroyed', () => this.close(socket));
    void this.connect(socket, entry, workflowId, termId, options, false);
  }

  private async connect(
    socket: string,
    entry: Entry,
    workflowId: string,
    termId: string,
    options: { rows: number; cols: number; cwd?: string },
    healed: boolean,
  ): Promise<void> {
    const deps = this.deps();
    if (!deps) {
      this.finish(socket, entry, 1011, '로그인이 필요합니다');
      return;
    }
    let ws: WebSocket;
    try {
      const base = deps.baseUrl().replace(/\/+$/, '').replace(/^http/, 'ws');
      if (!base) throw new Error('서버 주소가 없습니다');
      const token = await deps.token();
      if (!token) throw new Error('로그인이 필요합니다');
      if (entry.closed) return;
      ws = new WebSocket(`${base}${ideTerminalSocketPath(workflowId, termId, options)}`, {
        headers: { Authorization: `Bearer ${token}` },
        maxPayload: FRAME_MAX,
        ...xgenWebSocketTlsOptions(deps.allowPrivateCertificate()),
      });
    } catch (err) {
      this.finish(socket, entry, 1011, err instanceof Error ? err.message : '연결하지 못했습니다');
      return;
    }
    entry.ws = ws;
    let settled = false;

    ws.on('message', (raw) => {
      if (entry.closed) return;
      try {
        const frame: unknown = JSON.parse(String(raw));
        if (frame && typeof frame === 'object') {
          this.emit(entry.sender, {
            socket,
            type: 'frame',
            frame: frame as Record<string, unknown>,
          });
        }
      } catch {
        /* 깨진 프레임은 버린다 — 연결은 유지한다 */
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const status = res?.statusCode ?? 0;
      try {
        res?.resume?.();
      } catch {
        /* drain */
      }
      settled = true;
      if ((status === 401 || status === 403) && !healed) {
        void Promise.resolve(deps.refreshAuth())
          .catch(() => null)
          .then((fresh) => {
            if (entry.closed) return;
            if (fresh) void this.connect(socket, entry, workflowId, termId, options, true);
            else this.finish(socket, entry, 4401, '로그인이 필요합니다');
          });
        return;
      }
      this.finish(
        socket,
        entry,
        status === 403 ? 4403 : 1011,
        `서버가 연결을 거절했습니다 (${status})`,
      );
    });

    ws.on('close', (code, reason) => {
      if (settled) return;
      settled = true;
      this.finish(socket, entry, code || 1006, reason?.toString() || '');
    });

    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      if (!settled && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CLOSING) {
        settled = true;
        this.finish(socket, entry, 1006, '연결이 끊겼습니다');
      }
    });
  }

  private finish(socket: string, entry: Entry, code: number, reason: string): void {
    if (this.sockets.get(socket) !== entry) return;
    this.sockets.delete(socket);
    if (entry.closed) return;
    entry.closed = true;
    if (!entry.sender.isDestroyed())
      this.emit(entry.sender, { socket, type: 'close', code, reason });
  }

  send(socket: string, frame: unknown): void {
    const ws = this.sockets.get(socket)?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(frame);
    if (text.length > FRAME_MAX) return;
    try {
      ws.send(text);
    } catch {
      /* 끊긴 소켓 — close 이벤트가 알린다 */
    }
  }

  close(socket: string): void {
    const entry = this.sockets.get(socket);
    if (!entry) return;
    entry.closed = true;
    this.sockets.delete(socket);
    try {
      entry.ws?.close(1000);
    } catch {
      /* already gone */
    }
  }

  /** 로그아웃·서버 바꿈 — 다른 계정의 셸을 물고 있지 않게 모두 닫는다. */
  closeAll(): void {
    for (const socket of [...this.sockets.keys()]) this.close(socket);
  }
}
