/**
 * 편집기 영역 — 편집기 묶음(최대 3개, 좌우로 나눔)마다 탭 줄과 편집기 하나.
 *
 * Monaco 편집기는 묶음마다 **하나**를 두고 탭을 바꿀 때 모델만 갈아 끼운다(편집기와 같은
 * 방식). 탭마다 스크롤·커서를 기억했다가 돌아오면 되살린다. 문서(모델)는 저장소가 들고
 * 있어 화면이 다시 그려져도 고친 내용과 되돌리기 기록이 남는다.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import type * as Monaco from 'monaco-editor';
import { FileIcon, Icon } from './icons';
import { useIde, useStore } from './hooks';
import { Empty, IconButton, SplitHandle, showMenu, type MenuEntry } from './primitives';
import { diskUri, modelUri, originalUri, stagedUri, type DiffSpec, type EditorGroup, type EditorTab } from '../store';
import { basename, dirname } from '../paths';
import { decodeText, formatBytes, imageMime } from '../text';
import { formatBinding } from '../keys';
import { STATUS_LABEL } from '../git-model';
import type { ThemeKind } from '../types';

export function EditorArea({ theme }: { theme: ThemeKind }) {
  const groups = useIde((s) => s.groups);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const ref = useRef<HTMLDivElement>(null);
  const total = groups.reduce((n, g) => n + (weights[g.id] ?? 1), 0);
  return (
    <div className="xide-editor-area" ref={ref}>
      {groups.map((g, i) => (
        <div key={g.id} className="xide-editor-group-wrap" style={{ flex: `${weights[g.id] ?? 1} 1 0` }}>
          {i > 0 ? (
            <SplitHandle
              axis="x"
              label="편집기 너비"
              value={Math.round(((weights[groups[i - 1].id] ?? 1) / total) * 1000)}
              min={150}
              max={850}
              onChange={(v) => {
                const a = groups[i - 1].id;
                const b = g.id;
                const pair = (weights[a] ?? 1) + (weights[b] ?? 1);
                const left = Math.max(0.15, Math.min(pair - 0.15, (v / 1000) * total));
                setWeights((w) => ({ ...w, [a]: left, [b]: pair - left }));
              }}
            />
          ) : null}
          <EditorGroupView group={g} index={i} theme={theme} />
        </div>
      ))}
    </div>
  );
}

function EditorGroupView({ group, index, theme }: { group: EditorGroup; index: number; theme: ThemeKind }) {
  const store = useStore();
  const activeGroup = useIde((s) => s.activeGroup);
  const tab = group.tabs.find((t) => t.id === group.activeId) ?? null;
  return (
    <section
      className={`xide-editor-group${activeGroup === group.id ? ' xide--focused' : ''}`}
      aria-label={`편집기 ${index + 1}`}
      onMouseDownCapture={() => store.setActiveGroup(group.id)}
      onFocusCapture={() => store.setActiveGroup(group.id)}
    >
      <TabBar group={group} />
      {tab ? <Breadcrumbs tab={tab} /> : null}
      <div className="xide-editor-body">
        {tab ? <TabContent key={tab.kind === 'diff' ? 'diff' : tab.kind === 'image' ? `img:${tab.path}` : 'code'} group={group} tab={tab} theme={theme} /> : <Welcome />}
      </div>
    </section>
  );
}

// ── 탭 줄 ─────────────────────────────────────────────────────────────

function TabBar({ group }: { group: EditorGroup }) {
  const store = useStore();
  const docs = useIde((s) => s.docs);
  const groupCount = useIde((s) => s.groups.length);
  const layout = useIde((s) => s.layout);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const names = useMemo(() => {
    const count = new Map<string, number>();
    for (const t of group.tabs) count.set(basename(t.path), (count.get(basename(t.path)) ?? 0) + 1);
    return count;
  }, [group.tabs]);

  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('.xide-tab.xide--active');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [group.activeId]);

  const tabMenu = (t: EditorTab, e: MouseEvent) =>
    showMenu(e, [
      { id: 'close', label: '닫기', keybinding: 'Mod+W', run: () => void store.closeTab(group.id, t.id) },
      { id: 'others', label: '다른 탭 닫기', run: () => void store.closeTabs(group.id, 'others', t.id) },
      { id: 'right', label: '오른쪽 탭 닫기', run: () => void store.closeTabs(group.id, 'right', t.id) },
      { id: 'saved', label: '저장된 탭 닫기', run: () => void store.closeTabs(group.id, 'saved') },
      { id: 'all', label: '모두 닫기', run: () => void store.closeTabs(group.id, 'all') },
      'separator',
      { id: 'copy', label: '경로 복사', run: () => void copyPath(store, t.path) },
      {
        id: 'reveal',
        label: '탐색기에서 보기',
        run: () => {
          store.reveal(t.path);
          store.showSideView('explorer');
        },
      },
      'separator',
      { id: 'pin', label: '고정', disabled: !t.preview, run: () => store.pinTab(group.id, t.id) },
      { id: 'split', label: '오른쪽으로 나누기', keybinding: 'Mod+\\', run: () => store.splitRight({ tabId: t.id }) },
    ]);

  const onDragStart = (t: EditorTab, e: DragEvent) => {
    e.dataTransfer.setData('application/x-xide-tab', JSON.stringify({ group: group.id, tab: t.id }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (i: number, e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('application/x-xide-tab')) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
  };
  const onDrop = (e: DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-xide-tab');
    const at = dropAt ?? group.tabs.length;
    setDropAt(null);
    if (!raw) return;
    e.preventDefault();
    const { group: from, tab } = JSON.parse(raw) as { group: string; tab: string };
    store.moveTab(from, tab, group.id, at);
  };

  const active = group.tabs.find((t) => t.id === group.activeId);
  const activeDoc = active ? docs[active.path] : undefined;

  return (
    <div className="xide-tabbar" onDragLeave={() => setDropAt(null)} onDrop={onDrop} onDragOver={(e) => onDragOver(group.tabs.length - 1, e)}>
      <div
        className="xide-tabs"
        ref={scroller}
        role="tablist"
        onWheel={(e) => {
          if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget && !store.getState().readonly) store.startCreate('', 'file');
        }}
      >
        {group.tabs.map((t, i) => {
          const doc = docs[t.path];
          const name = basename(t.path);
          const dup = (names.get(name) ?? 0) > 1;
          const dirty = t.kind === 'file' && !!doc?.dirty;
          const label =
            t.kind === 'diff'
              ? t.diff?.disk
                ? `${name} (디스크 ↔ 편집 중)`
                : `${name} (${t.diff?.staged ? '스테이지' : '작업 트리'})`
              : name;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === group.activeId}
              className={[
                'xide-tab',
                t.id === group.activeId ? 'xide--active' : '',
                t.preview ? 'xide--preview' : '',
                dirty ? 'xide--dirty' : '',
                dropAt === i ? 'xide--drop-before' : '',
                dropAt === i + 1 && i === group.tabs.length - 1 ? 'xide--drop-after' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={`${t.path}${t.kind === 'diff' && t.diff?.status ? ` · ${STATUS_LABEL[t.diff.status]}` : ''}`}
              draggable
              onDragStart={(e) => onDragStart(t, e)}
              onDragOver={(e) => {
                e.stopPropagation();
                onDragOver(i, e);
              }}
              onClick={() => store.activateTab(group.id, t.id)}
              onDoubleClick={() => store.pinTab(group.id, t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void store.closeTab(group.id, t.id);
                }
              }}
              onContextMenu={(e) => tabMenu(t, e)}
            >
              {t.kind === 'diff' ? <Icon name="split" className="xide-icon xide-tab-diff" /> : <FileIcon name={name} />}
              <span className="xide-tab-label">{label}</span>
              {dup ? <span className="xide-tab-dir">{dirname(t.path) || '/'}</span> : null}
              <button
                type="button"
                className="xide-tab-close"
                aria-label={dirty ? '저장하지 않은 변경이 있습니다. 닫기' : '닫기'}
                title={`닫기 (${formatBinding('Mod+W')})`}
                onClick={(e) => {
                  e.stopPropagation();
                  void store.closeTab(group.id, t.id);
                }}
              >
                <Icon name={dirty ? 'dot' : 'close'} className="xide-icon xide-tab-close-icon" />
                {dirty ? <Icon name="close" className="xide-icon xide-tab-close-hover" /> : null}
              </button>
            </div>
          );
        })}
      </div>
      <div className="xide-tabbar-actions">
        {active?.kind === 'diff' && active.diff && !active.diff.disk ? (
          <IconButton
            icon="go-to-file"
            label="파일 열기"
            onClick={() => void store.openFile(active.path, { preview: false, groupId: group.id })}
          />
        ) : null}
        {activeDoc?.dirty ? (
          <IconButton icon="check" label="저장" keybinding="Mod+S" onClick={() => void store.save(active!.path)} />
        ) : null}
        <IconButton
          icon="split"
          label="오른쪽으로 나누기"
          keybinding="Mod+\\"
          disabled={!active || groupCount >= 3}
          onClick={() => store.splitRight()}
        />
        <IconButton
          icon="more"
          label="더 보기"
          onClick={(e) =>
            showMenu(e, [
              { id: 'close-all', label: '모두 닫기', run: () => void store.closeTabs(group.id, 'all') },
              { id: 'close-saved', label: '저장된 탭 닫기', run: () => void store.closeTabs(group.id, 'saved') },
              'separator',
              { id: 'wrap', label: layout.wordWrap ? '줄 바꿈 끄기' : '줄 바꿈 켜기', keybinding: 'Alt+Z', run: () => store.setLayout({ wordWrap: !layout.wordWrap }) },
              { id: 'minimap', label: layout.minimap ? '미니맵 끄기' : '미니맵 켜기', run: () => store.setLayout({ minimap: !layout.minimap }) },
              { id: 'autosave', label: layout.autoSave ? '자동 저장 끄기' : '자동 저장 켜기', run: () => store.setLayout({ autoSave: !layout.autoSave }) },
            ] as MenuEntry[])
          }
        />
      </div>
    </div>
  );
}

async function copyPath(store: ReturnType<typeof useStore>, path: string) {
  const ok = (await store.host.copyText?.(path)) ?? (await navigator.clipboard?.writeText(path).then(() => true, () => false));
  store.notify(ok ? 'success' : 'error', ok ? '경로를 복사했습니다' : '복사하지 못했습니다');
}

function Breadcrumbs({ tab }: { tab: EditorTab }) {
  const store = useStore();
  const parts = tab.path.split('/');
  return (
    <div className="xide-breadcrumbs" aria-label="경로">
      {parts.map((p, i) => {
        const path = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span key={path} className="xide-crumb">
            <button
              type="button"
              onClick={() => {
                store.reveal(path);
                store.showSideView('explorer');
              }}
            >
              {last ? <FileIcon name={p} /> : null}
              {p}
            </button>
            {!last ? <Icon name="chevron-right" /> : null}
          </span>
        );
      })}
      {tab.kind === 'diff' && tab.diff ? (
        <span className="xide-crumb-note">
          {tab.diff.disk ? '왼쪽: 디스크의 지금 판 · 오른쪽: 편집 중인 판' : tab.diff.staged ? '왼쪽: 마지막 커밋 · 오른쪽: 스테이지' : '왼쪽: 스테이지 · 오른쪽: 작업 트리'}
        </span>
      ) : null}
    </div>
  );
}

function Welcome() {
  const store = useStore();
  const readonly = useIde((s) => s.readonly);
  const rows: [string, string, () => void][] = [
    ['파일 빨리 열기', 'Mod+P', () => store.openQuickOpen('files')],
    ['명령 보기', 'Mod+Shift+P', () => store.openQuickOpen('commands')],
    ['찾기', 'Mod+Shift+F', () => store.showSideView('search')],
    ['소스 제어', 'Mod+Shift+G', () => store.showSideView('scm')],
  ];
  if (!readonly) rows.push(['터미널', 'Mod+`', () => store.showTerminal()]);
  return (
    <div className="xide-welcome">
      <div className="xide-welcome-title">선택된 파일이 없습니다</div>
      <div className="xide-welcome-text">탐색기에서 파일을 고르거나 소스 제어에서 바뀐 파일을 누르세요.</div>
      <div className="xide-welcome-keys">
        {rows.map(([label, key, run]) => (
          <button key={label} type="button" onClick={run}>
            <span>{label}</span>
            <kbd>{formatBinding(key)}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 탭 내용 ───────────────────────────────────────────────────────────

function TabContent({ group, tab, theme }: { group: EditorGroup; tab: EditorTab; theme: ThemeKind }) {
  if (tab.kind === 'image') return <ImagePane path={tab.path} />;
  if (tab.kind === 'diff' && tab.diff) return <DiffPane group={group} tab={tab} diff={tab.diff} theme={theme} />;
  return <CodePane group={group} tab={tab} theme={theme} />;
}

function useMonaco(): { monaco: typeof Monaco | null; error: string | null } {
  const store = useStore();
  const ready = useIde((s) => s.monacoReady);
  const error = useIde((s) => s.monacoError);
  useEffect(() => {
    if (!ready) void store.loadMonaco().catch(() => undefined);
  }, [ready, store]);
  return { monaco: ready ? store.getMonaco() : null, error };
}

function editorOptions(layout: { fontSize: number; minimap: boolean; wordWrap: boolean }, readOnly: boolean): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
  return {
    automaticLayout: true,
    fontSize: layout.fontSize,
    fontFamily: "'JetBrains Mono', 'D2Coding', 'Fira Code', Menlo, Consolas, 'Liberation Mono', monospace",
    minimap: { enabled: layout.minimap },
    wordWrap: layout.wordWrap ? 'on' : 'off',
    readOnly,
    scrollBeyondLastLine: true,
    renderWhitespace: 'selection',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    fixedOverflowWidgets: true,
    tabSize: 2,
    detectIndentation: true,
    renderLineHighlight: 'all',
    unicodeHighlight: { ambiguousCharacters: false },
  };
}

function monacoTheme(theme: ThemeKind): string {
  return theme === 'light' ? 'vs' : 'vs-dark';
}

function CodePane({ group, tab, theme }: { group: EditorGroup; tab: EditorTab; theme: ThemeKind }) {
  const store = useStore();
  const { monaco, error } = useMonaco();
  const doc = useIde((s) => s.docs[tab.path]);
  const layout = useIde((s) => s.layout);
  const readonly = useIde((s) => s.readonly);
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownTab = useRef<string | null>(null);

  // 편집기를 만든다(묶음마다 하나).
  useEffect(() => {
    if (!monaco || !host.current) return;
    const editor = monaco.editor.create(host.current, { ...editorOptions(layout, readonly), model: null, theme: monacoTheme(theme) });
    editorRef.current = editor;
    store.editors.set(group.id, editor);
    const subs = [
      editor.onDidChangeCursorSelection(() => {
        const pos = editor.getPosition();
        const model = editor.getModel();
        if (!pos || !model) return;
        const sel = editor.getSelections() ?? [];
        const selected = sel.reduce((n, r) => n + (model.getValueInRange(r).length || 0), 0);
        store.setCursor({ line: pos.lineNumber, col: pos.column, selected });
      }),
      editor.onDidFocusEditorWidget(() => store.setActiveGroup(group.id)),
    ];
    return () => {
      if (shownTab.current) store.viewStates.set(`${group.id}:${shownTab.current}`, editor.saveViewState());
      subs.forEach((d) => d.dispose());
      if (store.editors.get(group.id) === editor) store.editors.delete(group.id);
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
      shownTab.current = null;
    };
    // 편집기는 한 번만 만든다 — 옵션은 아래 효과가 바꾼다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco, group.id]);

  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(layout, readonly));
  }, [layout.fontSize, layout.minimap, layout.wordWrap, readonly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    monaco?.editor.setTheme(monacoTheme(theme));
  }, [monaco, theme]);

  // 탭이 바뀌거나 문서가 준비되면 모델을 갈아 끼운다.
  useEffect(() => {
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = doc?.status === 'ready' ? monaco.editor.getModel(modelUri(monaco, store.host.workflowId, tab.path)) : null;
    if (shownTab.current && shownTab.current !== tab.id) {
      store.viewStates.set(`${group.id}:${shownTab.current}`, editor.saveViewState());
    }
    if (editor.getModel() !== model) {
      editor.setModel(model);
      if (model) {
        const vs = store.viewStates.get(`${group.id}:${tab.id}`) as Monaco.editor.ICodeEditorViewState | undefined;
        if (vs) editor.restoreViewState(vs);
        if (store.getState().activeGroup === group.id) editor.focus();
      }
    }
    shownTab.current = model ? tab.id : null;
    const want = store.pendingReveal;
    if (model && want && want.path === tab.path) {
      store.pendingReveal = null;
      const range = new monaco.Range(want.line, want.col, want.line, want.col + want.length);
      editor.setSelection(range);
      editor.revealRangeInCenterIfOutsideViewport(range);
      editor.focus();
    }
  });

  return (
    <div className="xide-code-pane">
      {doc?.diskChanged && doc.status === 'ready' ? <DiskChangedBar path={tab.path} deleted={!!doc.message} /> : null}
      <div className="xide-monaco" ref={host} style={{ display: doc?.status === 'ready' ? undefined : 'none' }} />
      {error ? <Empty icon="error">{error}</Empty> : null}
      {!error && (!doc || doc.status === 'loading' || !monaco) ? <div className="xide-pane-note">여는 중</div> : null}
      {doc?.status === 'binary' ? (
        <Empty icon="file">
          <p>텍스트 파일이 아니거나 UTF-8 이 아니라 편집기로 열지 않았습니다.</p>
          <div className="xide-empty-actions">
            <button type="button" className="xide-btn" onClick={() => void store.openFile(tab.path, { forceText: true, preview: false })}>
              그래도 열기
            </button>
            {store.host.download ? (
              <button type="button" className="xide-btn" onClick={() => void store.host.download?.(tab.path)}>
                내려받기
              </button>
            ) : null}
          </div>
        </Empty>
      ) : null}
      {doc?.status === 'too_large' ? (
        <Empty icon="warning">
          <p>파일이 너무 커서({formatBytes(doc.size)}) 편집기로 열 수 없습니다.</p>
          {store.host.download ? (
            <button type="button" className="xide-btn" onClick={() => void store.host.download?.(tab.path)}>
              내려받기
            </button>
          ) : null}
        </Empty>
      ) : null}
      {doc?.status === 'missing' || doc?.status === 'error' ? (
        <Empty icon="warning">
          <p>{doc.message ?? '파일을 열지 못했습니다'}</p>
          <button type="button" className="xide-btn" onClick={() => void store.ensureDoc(tab.path)}>
            다시 시도
          </button>
        </Empty>
      ) : null}
    </div>
  );
}

function DiskChangedBar({ path, deleted }: { path: string; deleted: boolean }) {
  const store = useStore();
  return (
    <div className="xide-banner warning" role="alert">
      <Icon name="warning" />
      <span>
        {deleted
          ? '이 파일이 디스크에서 지워졌습니다. 저장하면 다시 만들어집니다.'
          : '편집하는 사이 에이전트나 터미널이 이 파일을 바꿨습니다.'}
      </span>
      {!deleted ? (
        <>
          <button type="button" className="xide-btn" onClick={() => void store.openDiskCompare(path)}>
            비교
          </button>
          <button type="button" className="xide-btn" onClick={() => void store.reloadFromDisk(path, { discard: true })}>
            바뀐 판 불러오기
          </button>
        </>
      ) : null}
      <button type="button" className="xide-btn xide--danger" onClick={() => void store.save(path, { force: true })}>
        {deleted ? '다시 저장' : '내 판으로 덮어쓰기'}
      </button>
    </div>
  );
}

/** git 의 어떤 판(HEAD·스테이지)의 내용 — 없으면 빈 문자열(새 파일). */
async function gitText(store: ReturnType<typeof useStore>, diff: DiffSpec, ref: 'HEAD' | 'index'): Promise<string> {
  const out = await store.host.git<{ exists: boolean; content_b64?: string; too_large?: boolean }>({
    op: 'show',
    repo: diff.repo,
    path: diff.path,
    ref,
  });
  if (!out.exists || !out.content_b64) return '';
  if (out.too_large) return '(파일이 너무 커서 비교하지 않습니다)';
  const bin = atob(out.content_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return decodeText(bytes).text;
}

function setModelText(monaco: typeof Monaco, uri: Monaco.Uri, text: string, languageFrom: Monaco.Uri): Monaco.editor.ITextModel {
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== text) existing.setValue(text);
    return existing;
  }
  const lang = monaco.editor.getModel(languageFrom)?.getLanguageId();
  return monaco.editor.createModel(text, lang, uri);
}

function DiffPane({ group, tab, diff, theme }: { group: EditorGroup; tab: EditorTab; diff: DiffSpec; theme: ThemeKind }) {
  const store = useStore();
  const { monaco, error } = useMonaco();
  const doc = useIde((s) => s.docs[tab.path]);
  const statuses = useIde((s) => s.git.statuses);
  const layout = useIde((s) => s.layout);
  const readonly = useIde((s) => s.readonly);
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const [inline, setInline] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!monaco || !host.current) return;
    const editor = monaco.editor.createDiffEditor(host.current, {
      ...editorOptions(layout, readonly),
      renderSideBySide: !inline,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      enableSplitViewResizing: true,
      renderOverviewRuler: true,
    });
    editorRef.current = editor;
    return () => {
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
    };
  }, [monaco]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    editorRef.current?.updateOptions({ ...editorOptions(layout, readonly), renderSideBySide: !inline });
  }, [inline, layout.fontSize, layout.minimap, layout.wordWrap, readonly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    monaco?.editor.setTheme(monacoTheme(theme));
  }, [monaco, theme]);

  // 양쪽 모델을 준비한다. git 상태가 바뀌면(스테이지·커밋) 원래 쪽을 다시 읽는다.
  useEffect(() => {
    if (!monaco || !editorRef.current) return;
    let alive = true;
    const wf = store.host.workflowId;
    const workUri = modelUri(monaco, wf, tab.path);
    (async () => {
      try {
        let original: Monaco.editor.ITextModel;
        let modified: Monaco.editor.ITextModel;
        if (diff.disk) {
          original = monaco.editor.getModel(diskUri(monaco, wf, tab.path))!;
          if (!doc || doc.status !== 'ready') return;
          modified = monaco.editor.getModel(workUri)!;
        } else if (diff.staged) {
          const [head, index] = await Promise.all([gitText(store, diff, 'HEAD'), gitText(store, diff, 'index')]);
          if (!alive) return;
          original = setModelText(monaco, originalUri(monaco, wf, diff), head, workUri);
          modified = setModelText(monaco, stagedUri(monaco, wf, diff), diff.status === 'deleted' ? '' : index, workUri);
        } else {
          const base = diff.status === 'untracked' ? '' : await gitText(store, diff, 'index');
          if (!alive) return;
          original = setModelText(monaco, originalUri(monaco, wf, diff), base, workUri);
          if (diff.status === 'deleted') {
            modified = setModelText(monaco, monaco.Uri.from({ scheme: 'xide-empty', path: `/xgen/${wf}/${tab.path}` }), '', workUri);
          } else {
            if (!doc || doc.status !== 'ready') return;
            modified = monaco.editor.getModel(workUri)!;
          }
        }
        if (!alive || !editorRef.current || !original || !modified) return;
        const cur = editorRef.current.getModel();
        if (cur?.original !== original || cur?.modified !== modified) {
          editorRef.current.setModel({ original, modified });
        }
        editorRef.current.getModifiedEditor().updateOptions({ readOnly: readonly || diff.staged || diff.status === 'deleted' });
        setReady(true);
        setLoadError(null);
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : '비교할 내용을 읽지 못했습니다');
      }
    })();
    return () => {
      alive = false;
    };
  }, [monaco, diff, doc?.status, statuses, tab.path, store, readonly]);

  useEffect(() => {
    const ed = editorRef.current?.getModifiedEditor();
    if (!ed) return;
    const sub = ed.onDidChangeCursorPosition((e) => store.setCursor({ line: e.position.lineNumber, col: e.position.column, selected: 0 }));
    return () => sub.dispose();
  }, [ready, store]);

  const status = diff.repo != null ? statuses[diff.repo] : undefined;
  const stillChanged =
    !diff.disk &&
    !!status &&
    (diff.staged ? status.staged : [...status.changes, ...status.untracked]).some((c) => c.path === diff.path);

  return (
    <div className="xide-code-pane">
      <div className="xide-diff-toolbar">
        <span className="xide-dim">
          {diff.disk ? '디스크 판과 편집 중인 판' : `${STATUS_LABEL[diff.status ?? 'modified']} · ${diff.staged ? '스테이지된 변경' : '작업 트리 변경'}`}
        </span>
        <span className="xide-spacer" />
        {!readonly && !diff.disk && stillChanged ? (
          diff.staged ? (
            <button type="button" className="xide-btn" onClick={() => void store.gitRun({ op: 'unstage', repo: diff.repo, paths: [diff.path] }, '스테이지 취소')}>
              <Icon name="minus" /> 스테이지 취소
            </button>
          ) : (
            <button type="button" className="xide-btn" onClick={() => void store.gitRun({ op: 'stage', repo: diff.repo, paths: [diff.path] }, '스테이지')}>
              <Icon name="plus" /> 스테이지
            </button>
          )
        ) : null}
        {diff.disk ? (
          <>
            <button type="button" className="xide-btn" onClick={() => void store.reloadFromDisk(tab.path, { discard: true }).then(() => store.closeTab(group.id, tab.id, { force: true }))}>
              디스크 판 쓰기
            </button>
            <button type="button" className="xide-btn xide--primary" onClick={() => void store.save(tab.path, { force: true }).then((ok) => ok && store.closeTab(group.id, tab.id, { force: true }))}>
              편집 중인 판으로 저장
            </button>
          </>
        ) : null}
        <IconButton icon="layout-sidebar" label={inline ? '나란히 보기' : '한 줄로 보기'} active={inline} onClick={() => setInline((v) => !v)} />
        <IconButton icon="arrow-up" label="이전 변경" onClick={() => editorRef.current?.goToDiff?.('previous')} />
        <IconButton icon="arrow-down" label="다음 변경" onClick={() => editorRef.current?.goToDiff?.('next')} />
      </div>
      <div className="xide-monaco" ref={host} />
      {error || loadError ? <Empty icon="error">{error ?? loadError}</Empty> : null}
      {!ready && !error && !loadError ? <div className="xide-pane-note">비교할 내용을 읽는 중</div> : null}
    </div>
  );
}

function ImagePane({ path }: { path: string }) {
  const store = useStore();
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ bytes: number; w?: number; h?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const version = useIde((s) => s.files.find((f) => f.path === path)?.modifiedAt ?? '');
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    store.host.readRaw(path).then(
      (bytes) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageMime(path) }));
        setUrl(objectUrl);
        setSize({ bytes: bytes.length });
        setError(null);
      },
      (err) => alive && setError(err instanceof Error ? err.message : '그림을 읽지 못했습니다'),
    );
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, version, store]);
  if (error) return <Empty icon="error">{error}</Empty>;
  if (!url) return <div className="xide-pane-note">여는 중</div>;
  return (
    <div className={`xide-image-pane${zoom === 'fit' ? ' xide--fit' : ''}`}>
      <div className="xide-image-scroll" onClick={() => setZoom((z) => (z === 'fit' ? 1 : 'fit'))}>
        <img
          src={url}
          alt={basename(path)}
          style={zoom === 'fit' ? undefined : { width: size?.w ? size.w * zoom : undefined }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setSize((s) => ({ bytes: s?.bytes ?? 0, w: img.naturalWidth, h: img.naturalHeight }));
          }}
        />
      </div>
      <div className="xide-image-info">
        {size?.w ? `${size.w} × ${size.h}` : ''} {size ? `· ${formatBytes(size.bytes)}` : ''} · {zoom === 'fit' ? '창에 맞춤' : '원래 크기'}
      </div>
    </div>
  );
}
