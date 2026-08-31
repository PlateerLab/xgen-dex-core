import { useSyncExternalStore } from 'react';
import type { BrowserSelectionResult } from '../../core/browser';

const EMPTY: BrowserSelectionResult[] = [];
const MAX_SELECTIONS_PER_TURN = 5;

class BrowserSelectionStore {
  private selections = new Map<string, BrowserSelectionResult[]>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get(sessionKey: string): BrowserSelectionResult[] {
    return this.selections.get(sessionKey) ?? EMPTY;
  }

  stage(sessionKey: string, selection: BrowserSelectionResult): void {
    const current = this.get(sessionKey).filter((item) => item.id !== selection.id);
    this.selections.set(sessionKey, [...current, selection].slice(-MAX_SELECTIONS_PER_TURN));
    this.emit();
  }

  restore(sessionKey: string, selections: BrowserSelectionResult[]): void {
    if (!selections.length) return;
    const incoming = new Set(selections.map((selection) => selection.id));
    const current = this.get(sessionKey).filter((selection) => !incoming.has(selection.id));
    this.selections.set(sessionKey, [...selections, ...current].slice(0, MAX_SELECTIONS_PER_TURN));
    this.emit();
  }

  remove(sessionKey: string, selectionId: string): void {
    const current = this.get(sessionKey);
    const next = current.filter((selection) => selection.id !== selectionId);
    if (next.length === current.length) return;
    if (next.length) this.selections.set(sessionKey, next);
    else this.selections.delete(sessionKey);
    this.emit();
  }

  clear(sessionKey: string): void {
    if (!this.selections.delete(sessionKey)) return;
    this.emit();
  }

  forgetSession(sessionKey: string): void {
    this.clear(sessionKey);
  }

  reset(): void {
    if (!this.selections.size) return;
    this.selections.clear();
    this.emit();
  }
}

export const browserSelectionStore = new BrowserSelectionStore();

export function useBrowserSelections(sessionKey: string): BrowserSelectionResult[] {
  return useSyncExternalStore(
    browserSelectionStore.subscribe,
    () => browserSelectionStore.get(sessionKey),
    () => browserSelectionStore.get(sessionKey),
  );
}
