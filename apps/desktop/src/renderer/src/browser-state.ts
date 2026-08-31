import { useSyncExternalStore } from 'react';
import type { BrowserSelectionResult, BrowserState } from '@dex/protocol/browser';
import { prependBrowserContext } from '@dex/protocol/browser';
import type { ChatRequest } from '@dex/protocol/types';
import { xgen } from './bridge';

const EMPTY: BrowserState = { enabled: false, pages: [], activeByWorkflow: {}, popupRequests: [] };

class BrowserStateStore {
  private snapshot: BrowserState = EMPTY;
  private listeners = new Set<() => void>();
  private started = false;
  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    void xgen.browser
      .state()
      .then((state) => this.set(state))
      .catch(() => undefined);
    this.unsubscribe = xgen.browser.onState((state) => this.set(state));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    this.set(EMPTY);
  }

  private set(state: BrowserState): void {
    this.snapshot = { ...state, popupRequests: state.popupRequests ?? [] };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.start();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BrowserState => this.snapshot;

  contextualize(request: ChatRequest, selections: BrowserSelectionResult[] = []): ChatRequest {
    const decorate = (text: string) =>
      prependBrowserContext(text, request.workflowId, this.snapshot, selections);
    if (typeof request.input === 'string') return { ...request, input: decorate(request.input) };
    if (Array.isArray(request.input)) {
      let applied = false;
      const input = request.input.map((block) => {
        if (
          !applied &&
          block &&
          typeof block === 'object' &&
          (block as Record<string, unknown>).type === 'text' &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          applied = true;
          return {
            ...(block as Record<string, unknown>),
            text: decorate(String((block as Record<string, unknown>).text)),
          };
        }
        return block;
      });
      return applied ? { ...request, input } : request;
    }
    if (
      request.input &&
      typeof request.input === 'object' &&
      typeof (request.input as Record<string, unknown>).input_str === 'string'
    ) {
      return {
        ...request,
        input: {
          ...(request.input as Record<string, unknown>),
          input_str: decorate(String((request.input as Record<string, unknown>).input_str)),
        },
      };
    }
    return request;
  }
}

export const browserStateStore = new BrowserStateStore();

export function useBrowserState(): BrowserState {
  return useSyncExternalStore(
    browserStateStore.subscribe,
    browserStateStore.getSnapshot,
    browserStateStore.getSnapshot,
  );
}
