import { DexError } from '@dex/engine';
import { parseAgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
import {
  emptyCanonicalTuiView,
  type CanonicalTuiSource,
  type CanonicalTuiView,
} from './canonical-types';

type Listener = (view: CanonicalTuiView) => void;
type OperationKind = 'read' | 'watch';

interface ActiveOperation {
  token: number;
  kind: OperationKind;
  control: AbortController;
  accepting: boolean;
  terminalUpdate: boolean;
}

const notices = {
  reading: '현재 공유 대화를 확인하고 있습니다.',
  watching: '실시간 연결을 시작하고 있습니다.',
  connected: '현재 공유 대화를 표시합니다.',
  reconnecting: '실시간 연결을 복구하고 있습니다.',
  stopped: '실시간 연결이 중지되었습니다.',
  empty: '현재 표시할 공유 대화가 없습니다.',
} as const;

const errors = {
  authentication: '인증이 필요합니다. 세션 상태를 확인하세요.',
  unavailable: '공유 대화를 확인할 수 없습니다.',
  invalid: '공유 대화 응답을 확인할 수 없습니다.',
} as const;

function cloneView(view: CanonicalTuiView): CanonicalTuiView {
  return {
    ...view,
    conversation: view.conversation === null
      ? null
      : parseAgentConversationView(view.conversation),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAuthenticationError(error: unknown): boolean {
  if (error instanceof DexError) return error.code === 'auth_required' || error.code === 'auth_invalid';
  return isRecord(error) && (error.code === 'auth_required' || error.code === 'auth_invalid');
}

/**
 * Read-only presentation boundary for the canonical conversation TUI.
 *
 * The controller owns cancellation and vault drain ordering. Ink only receives
 * parsed display values and cannot retain a mutable reference to controller state.
 */
export class CanonicalTuiController {
  private view: CanonicalTuiView = emptyCanonicalTuiView();
  private readonly listeners = new Set<Listener>();
  private generation = 0;
  private requested: OperationKind | null = null;
  private active: ActiveOperation | null = null;
  private draining: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly source: CanonicalTuiSource,
    private readonly userId: string,
  ) {}

  get state(): CanonicalTuiView {
    return cloneView(this.view);
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) {
      this.notify(listener);
      return () => {};
    }
    this.listeners.add(listener);
    this.notify(listener);
    return () => { this.listeners.delete(listener); };
  }

  async read(): Promise<boolean> {
    const token = this.claim('read');
    if (token === null) return false;
    this.publish({
      status: 'reading', busy: true, watching: false,
      conversation: null, hasMore: false, notice: notices.reading, error: '',
    });

    const previous = this.draining;
    const lifecycle = this.runRead(token, previous);
    this.draining = lifecycle.then(() => undefined, () => undefined);
    return lifecycle;
  }

  watch(): Promise<boolean> {
    const token = this.claim('watch');
    if (token === null) return Promise.resolve(false);
    this.publish({
      status: 'reading', busy: true, watching: true,
      conversation: null, hasMore: false, notice: notices.watching, error: '',
    });

    const previous = this.draining;
    let resolveStarted!: (started: boolean) => void;
    const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });
    const lifecycle = this.runWatch(token, previous, resolveStarted);
    this.draining = lifecycle.then(() => undefined, () => undefined);
    return started;
  }

  async stop(): Promise<void> {
    this.cancel(false);
    await this.draining;
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.cancel(true);
      this.listeners.clear();
    }
    await this.draining;
  }

  private claim(kind: OperationKind): number | null {
    if (this.disposed || this.requested === kind) return null;
    const token = ++this.generation;
    this.requested = kind;
    this.active?.control.abort();
    return token;
  }

  private cancel(dispose: boolean): void {
    if (dispose) this.disposed = true;
    ++this.generation;
    this.requested = null;
    if (this.active) {
      this.active.accepting = false;
      this.active.control.abort();
    }
    this.publish({
      status: 'stopped', busy: false, watching: false,
      conversation: null, hasMore: false, notice: notices.stopped, error: '',
    });
  }

  private valid(token: number, kind: OperationKind): boolean {
    return !this.disposed && token === this.generation && this.requested === kind;
  }

  private async runRead(token: number, previous: Promise<void>): Promise<boolean> {
    await previous;
    if (!this.valid(token, 'read')) return false;

    const operation: ActiveOperation = {
      token, kind: 'read', control: new AbortController(), accepting: true, terminalUpdate: false,
    };
    this.active = operation;
    let succeeded = false;
    try {
      const value: unknown = await this.source.read(operation.control.signal);
      operation.accepting = false;
      if (!this.valid(token, 'read') || operation.control.signal.aborted) return false;
      let conversation;
      let hasMore: boolean;
      try {
        if (!isRecord(value) || typeof value.has_more !== 'boolean' || !('conversation' in value)) {
          throw new TypeError('Invalid canonical display response');
        }
        conversation = parseAgentConversationView(value.conversation);
        hasMore = value.has_more;
      } catch {
        this.failClosed(token);
        return false;
      }
      if (!this.valid(token, 'read') || operation.control.signal.aborted) return false;
      this.publish({
        status: 'connected', busy: false, watching: false,
        conversation, hasMore,
        notice: conversation.snapshot === null ? notices.empty : notices.connected,
        error: '',
      });
      succeeded = true;
    } catch (error) {
      operation.accepting = false;
      if (this.valid(token, 'read') && !operation.control.signal.aborted) {
        this.fail(token, error);
      }
    } finally {
      if (!await this.settle(token)) succeeded = false;
      this.finish(operation);
    }
    return succeeded;
  }

  private async runWatch(
    token: number,
    previous: Promise<void>,
    resolveStarted: (started: boolean) => void,
  ): Promise<void> {
    await previous;
    if (!this.valid(token, 'watch')) {
      resolveStarted(false);
      return;
    }

    const operation: ActiveOperation = {
      token, kind: 'watch', control: new AbortController(), accepting: true, terminalUpdate: false,
    };
    this.active = operation;
    let started = false;
    try {
      let task: Promise<void>;
      try {
        task = this.source.watch(
          (value) => {
            try { this.update(operation, value as unknown); }
            catch { this.failClosed(operation.token); }
          },
          operation.control.signal,
        );
        started = true;
        resolveStarted(true);
      } catch (error) {
        resolveStarted(false);
        if (this.valid(token, 'watch') && !operation.control.signal.aborted) this.fail(token, error);
        return;
      }
      await task;
      operation.accepting = false;
      if (this.valid(token, 'watch') && !operation.control.signal.aborted && !operation.terminalUpdate) {
        this.publish({
          status: 'stopped', busy: false, watching: false,
          conversation: null, hasMore: false, notice: notices.stopped, error: '',
        });
      }
    } catch (error) {
      operation.accepting = false;
      if (this.valid(token, 'watch') && !operation.control.signal.aborted && !operation.terminalUpdate) {
        this.fail(token, error);
      }
    } finally {
      if (!started) resolveStarted(false);
      await this.settle(token);
      this.finish(operation);
    }
  }

  private update(operation: ActiveOperation, value: unknown): void {
    if (!operation.accepting || this.active !== operation || !this.valid(operation.token, 'watch')
      || operation.control.signal.aborted) return;
    if (!isRecord(value) || typeof value.type !== 'string' || value.user_id !== this.userId) {
      this.failClosed(operation.token);
      return;
    }

    if (value.type === 'reset') {
      this.publish({
        status: 'reading', busy: true, watching: true,
        conversation: null, hasMore: false, notice: notices.watching, error: '',
      });
      return;
    }
    if (value.type === 'conversation') {
      if (typeof value.source !== 'string' || !['snapshot', 'replay', 'recovered'].includes(value.source)
        || typeof value.has_more !== 'boolean' || !('conversation' in value)) {
        this.failClosed(operation.token);
        return;
      }
      try {
        const conversation = parseAgentConversationView(value.conversation);
        this.publish({
          status: 'connected', busy: false, watching: true,
          conversation, hasMore: value.has_more,
          notice: conversation.snapshot === null ? notices.empty : notices.connected,
          error: '',
        });
      } catch {
        this.failClosed(operation.token);
      }
      return;
    }
    if (value.type === 'reconnecting') {
      if (!Number.isSafeInteger(value.retry_in_ms) || (value.retry_in_ms as number) < 0
        || typeof value.reason !== 'string'
        || !['transport', 'server', 'timeout', 'busy'].includes(value.reason)) {
        this.failClosed(operation.token);
        return;
      }
      this.publish({
        status: 'reconnecting', busy: true, watching: true,
        conversation: null, hasMore: false, notice: notices.reconnecting, error: '',
      });
      return;
    }
    if (value.type === 'stopped') {
      if (typeof value.reason !== 'string'
        || !['cancelled', 'authentication', 'failed'].includes(value.reason)) {
        this.failClosed(operation.token);
        return;
      }
      operation.terminalUpdate = true;
      operation.accepting = false;
      operation.control.abort();
      const authentication = value.reason === 'authentication';
      this.publish({
        status: 'stopped', busy: false, watching: false,
        conversation: null, hasMore: false,
        notice: authentication ? '' : notices.stopped,
        error: authentication ? errors.authentication : value.reason === 'failed' ? errors.unavailable : '',
      });
      return;
    }
    this.failClosed(operation.token);
  }

  private fail(token: number, error: unknown): void {
    if (!this.valid(token, this.requested ?? 'read')) return;
    const authentication = isAuthenticationError(error);
    this.publish({
      status: 'stopped', busy: false, watching: false,
      conversation: null, hasMore: false, notice: '',
      error: authentication ? errors.authentication : errors.unavailable,
    });
  }

  private failClosed(token: number): void {
    if (token !== this.generation) return;
    if (this.active) {
      this.active.terminalUpdate = true;
      this.active.accepting = false;
      this.active.control.abort();
    }
    this.publish({
      status: 'stopped', busy: false, watching: false,
      conversation: null, hasMore: false, notice: '', error: errors.invalid,
    });
  }

  private async settle(token: number): Promise<boolean> {
    try {
      await this.source.settle();
      return true;
    } catch {
      if (token === this.generation && !this.disposed && !this.view.error) this.fail(token, null);
      return false;
    }
  }

  private finish(operation: ActiveOperation): void {
    operation.accepting = false;
    if (this.active === operation) this.active = null;
    if (operation.token === this.generation && this.requested === operation.kind) {
      this.requested = null;
    }
  }

  private publish(view: CanonicalTuiView): void {
    this.view = cloneView(view);
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: Listener): void {
    try { listener(cloneView(this.view)); } catch { /* A renderer cannot break lifecycle ownership. */ }
  }
}
