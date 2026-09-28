/**
 * ide-watch — 채팅 [IDE] 가 스토리지 변경을 곧바로 알게 하는 소켓 (메인 프로세스 전용).
 *
 * 에이전트의 스토리지가 바뀌면(터미널에서 만든 파일·다른 기기·웹) 서버가 workspace 소켓으로
 * `changed` 를 민다. IDE 는 그것을 받아 탐색기·열린 파일·소스 제어를 다시 읽는다 — 없으면
 * 30초마다 목록을 다시 읽는 수밖에 없어, 터미널에서 만든 파일이 한참 뒤에야 보였다.
 *
 * 이 연결은 **구경꾼**이다: 첫 프레임으로 `{type:'hello', data:{observer:true}}` 를 보내야 서버가
 * 알림을 보내고, 기기 목록(클라우드 [연결])에도 남지 않는다(웹의 openAppChangeSocket 과 같다).
 * 렌더러는 CSP 로 소켓을 못 열어 main 이 Bearer 로 연다(ide-terminal 과 같은 이유).
 */
import WebSocket from 'ws';
import type { WebContents } from 'electron';
import { workspaceChangeSocketPath } from '@dex/protocol';
import { xgenWebSocketTlsOptions } from '@dex/engine/connection-security';
import type { IdeTerminalDeps } from './ide-terminal';

interface Watch {
  sender: WebContents;
  workflowId: string;
  ws: WebSocket | null;
  closed: boolean;
  attempts: number;
  retry: ReturnType<typeof setTimeout> | null;
  healed: boolean;
}

export class IdeWatchHub {
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly deps: () => IdeTerminalDeps | null,
    private readonly emit: (sender: WebContents, key: string) => void,
  ) {}

  watch(sender: WebContents, key: string, workflowId: string): void {
    this.unwatch(key);
    const w: Watch = { sender, workflowId, ws: null, closed: false, attempts: 0, retry: null, healed: false };
    this.watches.set(key, w);
    sender.once('destroyed', () => this.unwatch(key));
    void this.connect(key, w);
  }

  private async connect(key: string, w: Watch): Promise<void> {
    if (w.closed) return;
    const deps = this.deps();
    if (!deps) return; // 로그아웃 — 다시 로그인하면 IDE 가 새로 붙는다
    let ws: WebSocket;
    try {
      const base = deps.baseUrl().replace(/\/+$/, '').replace(/^http/, 'ws');
      const token = await deps.token();
      if (!base || !token || w.closed) return;
      ws = new WebSocket(`${base}${workspaceChangeSocketPath(w.workflowId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        ...xgenWebSocketTlsOptions(deps.allowPrivateCertificate()),
      });
    } catch {
      this.again(key, w);
      return;
    }
    w.ws = ws;
    ws.on('open', () => {
      w.attempts = 0;
      w.healed = false;
      try {
        ws.send(JSON.stringify({ type: 'hello', data: { observer: true } }));
      } catch {
        /* 닫혔다 — close 가 다시 붙인다 */
      }
    });
    ws.on('message', (raw) => {
      if (w.closed) return;
      try {
        if ((JSON.parse(String(raw)) as { type?: string })?.type === 'changed' && !w.sender.isDestroyed()) {
          this.emit(w.sender, key);
        }
      } catch {
        /* 모르는 프레임 */
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      const status = res?.statusCode ?? 0;
      try {
        res?.resume?.();
      } catch {
        /* drain */
      }
      w.ws = null;
      // 토큰 회전으로 막혔으면 한 번 갱신해 다시 연다. 권한·대상 문제는 다시 붙어도 같다.
      if ((status === 401 || status === 403) && !w.healed) {
        w.healed = true;
        void Promise.resolve(deps.refreshAuth())
          .catch(() => null)
          .then((fresh) => {
            if (fresh && !w.closed) void this.connect(key, w);
          });
        return;
      }
      if (status >= 500 || status === 0) this.again(key, w);
    });
    ws.on('close', (code) => {
      if (w.ws !== ws) return;
      w.ws = null;
      if (code >= 4400 && code < 4500) return; // 서버가 거절했다(권한·대상) — 다시 붙어도 같다
      this.again(key, w);
    });
    ws.on('error', () => {
      /* close 가 뒤따른다 */
    });
  }

  private again(key: string, w: Watch): void {
    if (w.closed || this.watches.get(key) !== w) return;
    w.attempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(w.attempts, 5));
    w.retry = setTimeout(() => void this.connect(key, w), delay);
  }

  unwatch(key: string): void {
    const w = this.watches.get(key);
    if (!w) return;
    this.watches.delete(key);
    w.closed = true;
    if (w.retry) clearTimeout(w.retry);
    try {
      w.ws?.close(1000);
    } catch {
      /* already gone */
    }
  }

  /** 로그아웃·서버 바꿈 — 다른 계정의 알림을 물고 있지 않게 모두 닫는다. */
  closeAll(): void {
    for (const key of [...this.watches.keys()]) this.unwatch(key);
  }
}
