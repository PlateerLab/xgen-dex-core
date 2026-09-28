/**
 * 아래 패널 — 터미널. 에이전트 샌드박스 안의 셸이다(설치한 것은 에이전트와 같은 자리에 남는다).
 *
 * 패널을 닫아도 셸은 산다. 다시 열면 같은 셸로 이어지고, 앱을 다시 켜도 서버에 살아 있는
 * 셸이면 최근 출력부터 이어진다.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { useIde, useStore } from './hooks';
import { IconButton, showMenu } from './primitives';
import { ensureTerminalView, TerminalView } from '../terminal';
import type { ThemeKind } from '../types';

export function TerminalPanel({ theme, onFocusRequest }: { theme: ThemeKind; onFocusRequest?: number }) {
  const store = useStore();
  const terminals = useIde((s) => s.terminals);
  const active = useIde((s) => s.activeTerminal);
  const maximized = useIde((s) => s.layout.panelMaximized);
  const fontSize = useIde((s) => s.layout.fontSize);
  const readonly = useIde((s) => s.readonly);
  const body = useRef<HTMLDivElement>(null);
  const current = terminals.find((t) => t.id === active) ?? terminals[terminals.length - 1] ?? null;

  // 보이는 터미널을 이 자리에 붙인다(다른 것은 떼어 두되 살려 둔다).
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const host = body.current;
    if (!host || !current) return;
    let alive = true;
    let attached: TerminalView | null = null;
    for (const [id, rt] of store.terminalRuntimes) {
      if (id !== current.id && rt instanceof TerminalView) rt.detach();
    }
    ensureTerminalView(store, current.id, current.cwd, theme).then(
      (view) => {
        if (!alive || !view) return;
        attached = view;
        view.attach(host, true);
        setLoadError(null);
      },
      () => alive && setLoadError('터미널을 불러오지 못했습니다'),
    );
    return () => {
      alive = false;
      attached?.detach();
    };
  }, [current?.id, store]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (onFocusRequest && current) (store.terminalRuntimes.get(current.id) as TerminalView | undefined)?.focus();
  }, [onFocusRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const rt of store.terminalRuntimes.values()) {
      if (rt instanceof TerminalView) {
        rt.setTheme(theme);
        rt.setFontSize(fontSize);
      }
    }
  }, [theme, fontSize, store]);

  // 패널 크기가 바뀌면 셸의 행·열을 맞춘다.
  useEffect(() => {
    const host = body.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = store.getState().activeTerminal;
        const view = id ? store.terminalRuntimes.get(id) : undefined;
        if (view instanceof TerminalView) view.fit();
      });
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [store]);

  // 첫 터미널 — 패널을 열었는데 하나도 없으면 연다.
  useEffect(() => {
    if (!terminals.length && !readonly) store.addTerminal();
  }, [terminals.length, readonly, store]);

  const view = current ? (store.terminalRuntimes.get(current.id) as TerminalView | undefined) : undefined;

  return (
    <div className="xide-panel" role="region" aria-label="터미널">
      <div className="xide-panel-header">
        <span className="xide-panel-tab xide--active">터미널</span>
        <div className="xide-terms" role="tablist" aria-label="터미널 목록">
          {terminals.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === current?.id}
              className={`xide-term-tab${t.id === current?.id ? ' xide--active' : ''} xide--${t.status}`}
              title={t.cwd ? `${t.title} · ${t.cwd}` : t.title}
              onClick={() => store.setActiveTerminal(t.id)}
              onAuxClick={(e) => e.button === 1 && void store.killTerminal(t.id)}
              onContextMenu={(e) =>
                showMenu(e, [
                  { id: 'rename', label: '이름 바꾸기', run: () => void renameTerminal(store, t.id, t.title) },
                  { id: 'clear', label: '화면 지우기', run: () => (store.terminalRuntimes.get(t.id) as TerminalView | undefined)?.clear() },
                  { id: 'restart', label: '다시 시작', run: () => (store.terminalRuntimes.get(t.id) as TerminalView | undefined)?.restart() },
                  'separator',
                  { id: 'kill', label: '닫기', danger: true, run: () => void store.killTerminal(t.id) },
                ])
              }
            >
              <Icon name="terminal" />
              <span>{t.title}</span>
              {t.status === 'reconnecting' || t.status === 'connecting' ? <span className="xide-spinner" aria-label="연결 중" /> : null}
              <button
                type="button"
                className="xide-term-close"
                aria-label={`${t.title} 닫기`}
                onClick={(e) => {
                  e.stopPropagation();
                  void store.killTerminal(t.id);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <span className="xide-spacer" />
        {!readonly ? <IconButton icon="plus" label="새 터미널" keybinding="Mod+Shift+`" onClick={() => store.addTerminal()} /> : null}
        {current ? <IconButton icon="trash" label="터미널 닫기" onClick={() => void store.killTerminal(current.id)} /> : null}
        <IconButton
          icon={maximized ? 'restore' : 'maximize'}
          label={maximized ? '패널 크기 되돌리기' : '패널 크게'}
          onClick={() => store.setLayout({ panelMaximized: !maximized })}
        />
        <IconButton icon="close" label="패널 닫기" keybinding="Mod+J" onClick={() => store.setLayout({ panelOpen: false, panelMaximized: false })} />
      </div>
      <div className="xide-panel-body">
        <div className="xide-term-body" ref={body} onClick={() => view?.focus()} />
        {current && (current.status === 'error' || current.status === 'exited') ? (
          <div className="xide-term-overlay">
            <span>{current.status === 'exited' ? '셸이 끝났습니다.' : current.message ?? '연결이 끊겼습니다.'}</span>
            <button type="button" className="xide-btn xide--primary" onClick={() => view?.restart()}>
              {current.status === 'exited' ? '다시 시작' : '다시 연결'}
            </button>
          </div>
        ) : null}
        {!current && readonly ? <div className="xide-pane-note">고정된 에이전트에서는 터미널을 쓸 수 없습니다.</div> : null}
        {loadError ? <div className="xide-pane-note">{loadError}</div> : null}
      </div>
    </div>
  );
}

async function renameTerminal(store: ReturnType<typeof useStore>, id: string, title: string) {
  const name = await store.prompt('터미널 이름', { value: title, ok: '바꾸기' });
  if (name?.trim()) store.setTerminal(id, { title: name.trim() });
}
