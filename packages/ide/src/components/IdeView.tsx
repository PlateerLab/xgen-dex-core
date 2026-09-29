/**
 * IDE 보기의 뿌리 — 왼쪽 활동 막대·사이드바, 가운데 편집기·터미널, 오른쪽 에이전트 채팅.
 *
 * 채팅은 호스트가 넘긴다(`chat`). IDE 는 그 자리를 비워 두고 폭만 관리한다 — 채팅은 채팅
 * 화면 그대로 돌고, 에이전트는 평소처럼 자기 샌드박스에서 일한다.
 *
 * 단축키는 편집기의 것을 따른다. 다만 입력하는 자리(터미널·입력 칸)에서는 셸과 입력이 쓰는
 * 키를 빼앗지 않는다 — 터미널에서 Ctrl+W 는 단어 지우기지 탭 닫기가 아니다.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ActivityBar, type SideView } from './ActivityBar';
import { Explorer } from './Explorer';
import { SearchView } from './SearchView';
import { ScmView, createBranch } from './ScmView';
import { EditorArea } from './EditorArea';
import { TerminalPanel } from './TerminalPanel';
import { ConnectionBar, IdeToast } from './Notices';
import { QuickOpen } from './QuickOpen';
import { DialogHost, MenuHost, SplitHandle } from './primitives';
import { StoreContext, focusHome, rememberFocus, useIde, useStore } from './hooks';
import type { IdeCommand, IdeStore } from '../store';
import type { ThemeKind } from '../types';
import { ChordMatcher } from '../keys';
import { BASE_VIEW_META } from '../activity';

export interface IdeViewProps {
  store: IdeStore;
  /** 오른쪽 칸 — 에이전트 채팅. */
  chat?: ReactNode;
  theme?: ThemeKind;
  /** 사이드바에 보기를 더한다(확장 자리). */
  extraViews?: SideView[];
  /**
   * IDE 안의 활동 막대를 그리는가(기본 true). 호스트가 자기 앱 사이드바에 IDE 단추를 그리면
   * (`useIdeActivity`·`pressIdeActivity`) 끈다 — 데스크톱 앱이 그렇다.
   */
  activityBar?: boolean;
  className?: string;
}

export function IdeView({ store, chat, theme = 'dark', extraViews, activityBar = true, className }: IdeViewProps) {
  useEffect(() => {
    store.startOnce();
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <IdeLayout chat={chat} theme={theme} extraViews={extraViews} activityBar={activityBar} className={className} />
    </StoreContext.Provider>
  );
}

const RENDER: Record<string, () => ReactElement> = {
  explorer: () => <Explorer />,
  search: () => <SearchView />,
  scm: () => <ScmView />,
};

const BASE_VIEWS: SideView[] = BASE_VIEW_META.map((v) => ({ ...v, render: RENDER[v.id] }));

/** 입력하는 자리에서도 IDE 가 받는 명령 — 셸·입력 칸이 쓰지 않는 조합만. */
const ALWAYS = new Set([
  'quickOpen',
  'palette',
  'palette.f1',
  'save',
  'saveAll',
  'togglePanel',
  'toggleTerminal',
  'newTerminal',
  'toggleSidebar',
  'showExplorer',
  'showSearch',
  'showScm',
  'focusGroup1',
  'focusGroup2',
  'focusGroup3',
  'nextTab',
  'prevTab',
  'nextTab.alt',
  'prevTab.alt',
  'toggleChat',
]);

function IdeLayout({
  chat,
  theme,
  extraViews,
  activityBar,
  className,
}: {
  chat?: ReactNode;
  theme: ThemeKind;
  extraViews?: SideView[];
  activityBar: boolean;
  className?: string;
}) {
  const store = useStore();
  const layout = useIde((s) => s.layout);
  const readonly = useIde((s) => s.readonly);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    focusHome(store).root = root.current;
  }, [store]);
  const [termFocus, setTermFocus] = useState(0);
  const views = useMemo(() => [...BASE_VIEWS, ...(extraViews ?? [])], [extraViews]);
  const side = views.find((v) => v.id === layout.sideView) ?? null;

  const commands = useMemo<IdeCommand[]>(() => buildCommands(store, () => setTermFocus((n) => n + 1)), [store]);
  useEffect(() => {
    store.commands = commands;
  }, [store, commands]);

  const matcher = useMemo(() => {
    const table: Record<string, string> = {};
    for (const c of commands) if (c.keybinding) table[c.id] = c.keybinding;
    return new ChordMatcher(table);
  }, [commands]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const s = store.getState();
      if (s.dialog || s.quickOpen) return; // 대화 상자·빠른 열기가 스스로 받는다
      const target = e.target as HTMLElement | null;
      const inTerminal = !!target?.closest('.xide-term-host');
      const inMonaco = !!target?.closest('.monaco-editor');
      const inInput = !inMonaco && !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const hit = matcher.feed(e);
      if (!hit) return;
      if (hit === 'pending') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if ((inTerminal || inInput) && !ALWAYS.has(hit)) return;
      const cmd = commands.find((c) => c.id === hit);
      if (!cmd || (cmd.when && !cmd.when(s))) return;
      e.preventDefault();
      e.stopPropagation();
      void cmd.run();
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [store, matcher, commands]);

  // 창을 다시 보면 열어 둔 파일이 바깥에서 바뀌었는지 본다. 연결된 폴더는 다른 프로그램이 바꿨을
  // 수 있으니 펼쳐 둔 목록도 다시 읽는다.
  useEffect(() => {
    const onFocus = () => {
      void store.checkDisk('all');
      if (store.getState().folders.roots.length) void store.refreshFolders();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [store]);

  const panelShown = layout.panelOpen && !readonly;
  return (
    <div
      ref={root}
      className={`xide-root xide-theme-${theme}${className ? ` ${className}` : ''}`}
      data-theme={theme}
      // 빈 자리를 눌러도 초점이 IDE 안에 머문다 — 단축키는 IDE 뿌리에서 받는다.
      tabIndex={-1}
      onFocus={(e) => rememberFocus(store, e.target)}
      onDragOver={(e) => {
        // 떨어뜨릴 자리가 아닌 곳에 파일을 놓아 브라우저가 파일을 여는 것을 막는다.
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
    >
      <div className="xide-main">
        {activityBar ? <ActivityBar extraViews={extraViews} chat={!!chat} /> : null}
        {side ? (
          <>
            <aside className="xide-sidebar" style={{ width: layout.sideWidth }} aria-label={side.title}>
              {side.render()}
            </aside>
            <SplitHandle
              axis="x"
              label="사이드바 너비"
              value={layout.sideWidth}
              min={170}
              max={700}
              onChange={(v) => store.setLayout({ sideWidth: v })}
              onDoubleClick={() => store.setLayout({ sideWidth: 260 })}
            />
          </>
        ) : null}
        <div className="xide-center">
          <ConnectionBar />
          {!(panelShown && layout.panelMaximized) ? <EditorArea theme={theme} /> : null}
          {panelShown ? (
            <>
              {!layout.panelMaximized ? (
                <SplitHandle
                  axis="y"
                  label="터미널 높이"
                  value={layout.panelHeight}
                  min={80}
                  max={1200}
                  invert
                  onChange={(v) => store.setLayout({ panelHeight: v })}
                  onDoubleClick={() => store.setLayout({ panelMaximized: true })}
                />
              ) : null}
              <div
                className="xide-panel-wrap"
                style={layout.panelMaximized ? { flex: '1 1 auto' } : { height: layout.panelHeight }}
              >
                <TerminalPanel theme={theme} onFocusRequest={termFocus} />
              </div>
            </>
          ) : null}
          {/* 알림은 편집 영역 오른쪽 아래 — 채팅 칸의 입력창을 가리지 않는다. */}
          <IdeToast />
        </div>
        {chat ? (
          <>
            {layout.chatOpen ? (
              <SplitHandle
                axis="x"
                label="채팅 너비"
                value={layout.chatWidth}
                min={300}
                max={900}
                invert
                onChange={(v) => store.setLayout({ chatWidth: v })}
                onDoubleClick={() => store.setLayout({ chatWidth: 400 })}
              />
            ) : null}
            {/* 닫아도 채팅은 그대로 둔다(입력 중인 글·스크롤·흐르는 답이 살아 있게) — 감추기만 한다. */}
            <aside
              className="xide-chat"
              style={{ width: layout.chatWidth, display: layout.chatOpen ? undefined : 'none' }}
              aria-label="에이전트 채팅"
              aria-hidden={!layout.chatOpen}
            >
              {chat}
            </aside>
          </>
        ) : null}
      </div>
      <QuickOpen />
      <DialogHost />
      <MenuHost />
    </div>
  );
}

function editorAction(store: IdeStore, id: string): void {
  const ed = store.editors.get(store.getState().activeGroup);
  void ed?.getAction(id)?.run();
  ed?.focus();
}

function buildCommands(store: IdeStore, focusTerminal: () => void): IdeCommand[] {
  const activePath = () => {
    const t = store.activeTab();
    return t && t.kind !== 'diff' ? t.path : null;
  };
  const writable = (s: ReturnType<IdeStore['getState']>) => !s.readonly;
  const repo = () => {
    const repos = store.getState().git.repos;
    return repos.includes('') ? '' : repos[0];
  };
  const hasRepo = (s: ReturnType<IdeStore['getState']>) => s.git.repos.length > 0 && !s.readonly;
  return [
    { id: 'quickOpen', title: '파일 빨리 열기', category: '보기', keybinding: 'Mod+P', run: () => store.openQuickOpen('files') },
    { id: 'palette', title: '명령 보기', category: '보기', keybinding: 'Mod+Shift+P', run: () => store.openQuickOpen('commands') },
    { id: 'palette.f1', title: '명령 보기', category: '보기', keybinding: 'F1', run: () => store.openQuickOpen('commands') },
    {
      id: 'save',
      title: '저장',
      category: '파일',
      keybinding: 'Mod+S',
      when: writable,
      run: () => {
        const p = activePath() ?? store.activeTab()?.path;
        if (p && store.getState().docs[p]) void store.save(p);
      },
    },
    { id: 'saveAll', title: '모두 저장', category: '파일', keybinding: 'Mod+Alt+S', when: writable, run: () => void store.saveAll() },
    {
      id: 'revert',
      title: '디스크 판으로 되돌리기',
      category: '파일',
      when: writable,
      run: async () => {
        const p = activePath();
        if (!p || !store.getState().docs[p]?.dirty) return;
        if (await store.confirm('변경을 버릴까요?', '저장하지 않은 변경이 사라집니다.', '되돌리기', true)) {
          await store.reloadFromDisk(p, { discard: true });
        }
      },
    },
    {
      id: 'compareSaved',
      title: '저장된 판과 비교',
      category: '파일',
      run: () => {
        const p = activePath();
        if (p) void store.openDiskCompare(p);
      },
    },
    { id: 'newFile', title: '새 파일', category: '파일', keybinding: 'Mod+Alt+N', when: writable, run: () => store.startCreate('', 'file') },
    { id: 'newFolder', title: '새 폴더', category: '파일', when: writable, run: () => store.startCreate('', 'dir') },
    {
      id: 'closeEditor',
      title: '편집기 닫기',
      category: '보기',
      keybinding: 'Mod+W',
      run: () => {
        const g = store.activeGroup();
        if (g.activeId) void store.closeTab(g.id, g.activeId);
      },
    },
    {
      id: 'closeEditor.alt',
      title: '편집기 닫기',
      category: '보기',
      keybinding: 'Mod+F4',
      run: () => {
        const g = store.activeGroup();
        if (g.activeId) void store.closeTab(g.id, g.activeId);
      },
    },
    { id: 'closeAll', title: '모든 편집기 닫기', category: '보기', run: () => void store.closeAllGroups() },
    { id: 'reopen', title: '닫은 편집기 다시 열기', category: '보기', keybinding: 'Mod+Shift+T', run: () => store.reopenClosedTab() },
    { id: 'nextTab', title: '다음 편집기', category: '보기', keybinding: 'Mod+PageDown', run: () => store.cycleTab(1) },
    { id: 'prevTab', title: '이전 편집기', category: '보기', keybinding: 'Mod+PageUp', run: () => store.cycleTab(-1) },
    { id: 'nextTab.alt', title: '다음 편집기', category: '보기', keybinding: 'Mod+Alt+ArrowRight', run: () => store.cycleTab(1) },
    { id: 'prevTab.alt', title: '이전 편집기', category: '보기', keybinding: 'Mod+Alt+ArrowLeft', run: () => store.cycleTab(-1) },
    { id: 'split', title: '편집기 오른쪽으로 나누기', category: '보기', keybinding: 'Mod+\\', run: () => void store.splitRight() },
    { id: 'focusGroup1', title: '첫째 편집기로', category: '보기', keybinding: 'Mod+1', run: () => store.focusGroup(0) },
    { id: 'focusGroup2', title: '둘째 편집기로', category: '보기', keybinding: 'Mod+2', run: () => store.focusGroup(1) },
    { id: 'focusGroup3', title: '셋째 편집기로', category: '보기', keybinding: 'Mod+3', run: () => store.focusGroup(2) },
    {
      id: 'toggleSidebar',
      title: '사이드바 보이기·숨기기',
      category: '보기',
      keybinding: 'Mod+B',
      run: () => store.setLayout({ sideView: store.getState().layout.sideView ? null : 'explorer' }),
    },
    { id: 'showExplorer', title: '탐색기', category: '보기', keybinding: 'Mod+Shift+E', run: () => store.showSideView('explorer') },
    {
      id: 'showSearch',
      title: '파일에서 찾기',
      category: '찾기',
      keybinding: 'Mod+Shift+F',
      run: () => {
        const ed = store.editors.get(store.getState().activeGroup);
        const sel = ed?.getSelection();
        const text = sel && !sel.isEmpty() ? ed?.getModel()?.getValueInRange(sel) : '';
        if (text && !text.includes('\n')) store.setSearch({ query: text });
        store.showSideView('search');
      },
    },
    {
      id: 'replaceInFiles',
      title: '파일에서 바꾸기',
      category: '찾기',
      keybinding: 'Mod+Shift+H',
      when: writable,
      run: () => {
        store.setSearch({ showReplace: true });
        store.showSideView('search');
      },
    },
    { id: 'showScm', title: '소스 제어', category: '보기', keybinding: 'Mod+Shift+G', run: () => store.showSideView('scm') },
    { id: 'togglePanel', title: '패널 보이기·숨기기', category: '보기', keybinding: 'Mod+J', when: writable, run: () => store.togglePanel() },
    {
      id: 'toggleTerminal',
      title: '터미널 보이기·숨기기',
      category: '터미널',
      keybinding: 'Mod+`',
      when: writable,
      run: () => {
        const open = store.getState().layout.panelOpen;
        if (open) store.setLayout({ panelOpen: false, panelMaximized: false });
        else {
          store.showTerminal();
          focusTerminal();
        }
      },
    },
    {
      id: 'newTerminal',
      title: '새 터미널',
      category: '터미널',
      keybinding: 'Mod+Shift+`',
      when: writable,
      run: () => {
        store.showTerminal(true);
        focusTerminal();
      },
    },
    {
      id: 'toggleChat',
      title: '에이전트 채팅 보이기·숨기기',
      category: '보기',
      keybinding: 'Mod+Alt+I',
      run: () => store.setLayout({ chatOpen: !store.getState().layout.chatOpen }),
    },
    { id: 'gotoLine', title: '줄로 이동', category: '이동', keybinding: 'Mod+G', run: () => store.openQuickOpen('line') },
    {
      id: 'changeEol',
      title: '줄 끝 바꾸기 (LF ↔ CRLF)',
      category: '파일',
      when: writable,
      run: () => {
        const p = activePath();
        const doc = p ? store.getState().docs[p] : undefined;
        const model = p ? store.getModel(p) : null;
        const monaco = store.getMonaco();
        if (!p || !doc || doc.status !== 'ready' || !model || !monaco) return;
        const next = doc.eol === 'LF' ? 'CRLF' : 'LF';
        model.pushEOL(next === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        store.setDocEol(p, next);
        store.notify('info', `줄 끝을 ${next} 로 바꿨습니다`);
      },
    },
    { id: 'reconnect', title: '샌드박스에 다시 연결', category: '보기', run: () => store.reconnect() },
    {
      id: 'reveal',
      title: '탐색기에서 지금 파일 보기',
      category: '보기',
      run: () => {
        const p = activePath();
        if (p) {
          store.reveal(p);
          store.showSideView('explorer');
        }
      },
    },
    { id: 'collapseExplorer', title: '탐색기 모두 접기', category: '보기', run: () => store.collapseAll() },
    { id: 'refreshExplorer', title: '탐색기 새로 고침', category: '보기', run: () => void store.refreshFiles() },
    {
      id: 'copyPath',
      title: '지금 파일 경로 복사',
      category: '파일',
      run: async () => {
        const p = activePath();
        if (!p) return;
        const ok = (await store.host.copyText?.(p)) ?? (await navigator.clipboard?.writeText(p).then(() => true, () => false));
        store.notify(ok ? 'success' : 'error', ok ? '경로를 복사했습니다' : '복사하지 못했습니다');
      },
    },
    { id: 'format', title: '문서 서식', category: '편집', run: () => editorAction(store, 'editor.action.formatDocument') },
    { id: 'wrap', title: '줄 바꿈 켜기·끄기', category: '보기', keybinding: 'Alt+Z', run: () => store.setLayout({ wordWrap: !store.getState().layout.wordWrap }) },
    { id: 'minimap', title: '미니맵 켜기·끄기', category: '보기', run: () => store.setLayout({ minimap: !store.getState().layout.minimap }) },
    { id: 'autoSave', title: '자동 저장 켜기·끄기', category: '파일', when: writable, run: () => store.setLayout({ autoSave: !store.getState().layout.autoSave }) },
    { id: 'zoomIn', title: '글자 크게', category: '보기', keybinding: 'Mod+=', run: () => store.setLayout({ fontSize: Math.min(28, store.getState().layout.fontSize + 1) }) },
    { id: 'zoomOut', title: '글자 작게', category: '보기', keybinding: 'Mod+-', run: () => store.setLayout({ fontSize: Math.max(9, store.getState().layout.fontSize - 1) }) },
    { id: 'zoomReset', title: '글자 크기 되돌리기', category: '보기', keybinding: 'Mod+0', run: () => store.setLayout({ fontSize: 13 }) },
    // git
    { id: 'git.refresh', title: '새로 고침', category: 'Git', run: () => void store.refreshGit() },
    { id: 'git.pull', title: '풀', category: 'Git', when: hasRepo, run: () => void store.gitRun({ op: 'pull', repo: repo() }, '풀') },
    { id: 'git.push', title: '푸시', category: 'Git', when: hasRepo, run: () => void store.gitRun({ op: 'push', repo: repo() }, '푸시') },
    { id: 'git.sync', title: '동기화', category: 'Git', when: hasRepo, run: () => void store.gitRun({ op: 'sync', repo: repo() }, '동기화') },
    { id: 'git.fetch', title: '가져오기', category: 'Git', when: hasRepo, run: () => void store.gitRun({ op: 'fetch', repo: repo() }, '가져오기') },
    { id: 'git.checkout', title: '브랜치 전환', category: 'Git', when: hasRepo, run: () => store.openQuickOpen('branches') },
    { id: 'git.branch', title: '새 브랜치 만들기', category: 'Git', when: hasRepo, run: () => void createBranch(store, repo() ?? '') },
    {
      id: 'git.stash',
      title: '스태시',
      category: 'Git',
      when: hasRepo,
      run: () => void store.gitRun({ op: 'stash', repo: repo(), action: 'push', include_untracked: true }, '스태시'),
    },
    {
      id: 'git.stashPop',
      title: '마지막 스태시 꺼내기',
      category: 'Git',
      when: hasRepo,
      run: () => void store.gitRun({ op: 'stash', repo: repo(), action: 'pop', index: 0 }, '스태시 꺼내기'),
    },
    { id: 'git.identity', title: '커밋할 이름과 메일', category: 'Git', when: writable, run: () => void store.promptIdentity() },
    { id: 'git.token', title: '원격 저장소 토큰 등록', category: 'Git', when: writable, run: () => void store.promptCredential() },
  ];
}
