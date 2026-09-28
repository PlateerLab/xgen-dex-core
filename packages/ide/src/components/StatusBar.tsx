/** 상태 표시줄 — 왼쪽은 브랜치·동기화, 오른쪽은 커서·들여쓰기·인코딩·줄 끝·언어. */
import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { useIde, useStore } from './hooks';
import { basename } from '../paths';
import type { Connection } from '../store';

export function StatusBar() {
  const store = useStore();
  const readonly = useIde((s) => s.readonly);
  const sessionError = useIde((s) => s.sessionError);
  const connection = useIde((s) => s.connection);
  const cursor = useIde((s) => s.cursor);
  const notice = useIde((s) => s.notice);
  const busy = useIde((s) => s.git.busy);
  const statuses = useIde((s) => s.git.statuses);
  const repos = useIde((s) => s.git.repos);
  const active = useIde((s) => {
    const g = s.groups.find((x) => x.id === s.activeGroup);
    return g?.tabs.find((t) => t.id === g.activeId) ?? null;
  });
  const doc = useIde((s) => (active ? s.docs[active.path] : undefined));
  const [visibleNotice, setVisibleNotice] = useState(notice);

  useEffect(() => {
    setVisibleNotice(notice);
    if (!notice) return;
    const t = setTimeout(() => setVisibleNotice(null), notice.kind === 'error' ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const repo = repos.includes('') ? '' : repos[0];
  const st = repo != null ? statuses[repo] : undefined;
  const model = active && doc?.status === 'ready' ? store.getModel(active.path) : null;
  const indent = model?.getOptions();
  const language = model?.getLanguageId();

  return (
    <footer className={`xide-status${readonly ? ' xide--readonly' : ''}`} role="status">
      <div className="xide-status-left">
        {/* 원격 표시(VS Code 의 왼쪽 끝) — 에이전트의 샌드박스에 붙어 있는가. 누르면 바로 다시 붙는다. */}
        <button
          type="button"
          className={`xide-status-item xide-status-remote xide--${connection}`}
          title={REMOTE_TITLE[connection](sessionError)}
          onClick={() => store.reconnect()}
        >
          {connection === 'connecting' || connection === 'retrying' ? (
            <span className="xide-spinner" aria-hidden />
          ) : (
            <span className="xide-status-dot" aria-hidden />
          )}
          {REMOTE_LABEL[connection]}
        </button>
        {st ? (
          <button
            type="button"
            className="xide-status-item"
            title="브랜치 전환"
            disabled={readonly}
            onClick={() => store.openQuickOpen('branches')}
          >
            <Icon name="branch" size={14} />
            {st.branch.head || st.branch.oid.slice(0, 8) || '커밋 없음'}
            {doc && Object.values(store.getState().docs).some((d) => d.dirty) ? '*' : ''}
          </button>
        ) : null}
        {st && (st.branch.ahead || st.branch.behind || st.branch.upstream) ? (
          <button
            type="button"
            className="xide-status-item"
            title="변경 내용 동기화(풀 후 푸시)"
            disabled={readonly || !!busy}
            onClick={() => void store.gitRun({ op: 'sync', repo }, '동기화')}
          >
            <Icon name="sync" size={14} className={`xide-icon${busy ? ' xide--spin' : ''}`} />
            {st.branch.behind ? ` ${st.branch.behind}↓` : ''}
            {st.branch.ahead ? ` ${st.branch.ahead}↑` : ''}
          </button>
        ) : null}
        {busy ? <span className="xide-status-item">{busy} 중</span> : null}
        {readonly ? (
          <span className="xide-status-item" title="고정된 에이전트는 보기만 합니다">
            <Icon name="lock" size={14} /> 읽기 전용
          </span>
        ) : null}
        {visibleNotice ? (
          <span className={`xide-status-item xide--notice xide--${visibleNotice.kind}`} title={visibleNotice.message}>
            <Icon name={visibleNotice.kind === 'error' ? 'error' : visibleNotice.kind === 'warning' ? 'warning' : visibleNotice.kind === 'success' ? 'check' : 'info'} size={14} />
            {visibleNotice.message}
          </span>
        ) : null}
      </div>
      <div className="xide-status-right">
        {cursor && model ? (
          <button type="button" className="xide-status-item" title="줄로 이동" onClick={() => store.openQuickOpen('line')}>
            줄 {cursor.line}, 열 {cursor.col}
            {cursor.selected ? ` (${cursor.selected}자 선택)` : ''}
          </button>
        ) : null}
        {indent ? (
          <span className="xide-status-item" title="들여쓰기">
            {indent.insertSpaces ? `공백: ${indent.tabSize}` : `탭 크기: ${indent.tabSize}`}
          </span>
        ) : null}
        {doc?.status === 'ready' ? <span className="xide-status-item">{doc.bom ? 'UTF-8 BOM' : 'UTF-8'}</span> : null}
        {doc?.status === 'ready' && model ? (
          <button
            type="button"
            className="xide-status-item"
            title="줄 끝 바꾸기"
            disabled={readonly}
            onClick={() => {
              const monaco = store.getMonaco();
              if (!monaco || !active) return;
              const next = doc.eol === 'LF' ? 'CRLF' : 'LF';
              model.pushEOL(next === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
              store.setDocEol(active.path, next);
            }}
          >
            {doc.eol}
          </button>
        ) : null}
        {language ? <span className="xide-status-item">{languageLabel(language)}</span> : null}
        {active && active.kind === 'image' ? <span className="xide-status-item">{basename(active.path)}</span> : null}
      </div>
    </footer>
  );
}

const REMOTE_LABEL: Record<Connection, string> = {
  connecting: '샌드박스 연결 중',
  online: '샌드박스',
  retrying: '다시 연결하는 중',
  blocked: '샌드박스를 열 수 없음',
};

const REMOTE_TITLE: Record<Connection, (reason: string | null) => string> = {
  connecting: () => '에이전트의 샌드박스에 연결하고 있습니다',
  online: () => '에이전트의 샌드박스에 연결되어 있습니다. 누르면 다시 연결합니다',
  retrying: (reason) => `${reason ?? '서버에 잠시 닿지 않습니다'}. 스스로 다시 연결하며, 누르면 바로 시도합니다`,
  blocked: (reason) => reason ?? '샌드박스를 열 수 없습니다',
};

const LANGUAGE_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  json: 'JSON',
  markdown: 'Markdown',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  shell: 'Shell Script',
  yaml: 'YAML',
  plaintext: '일반 텍스트',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  sql: 'SQL',
  xml: 'XML',
  dockerfile: 'Dockerfile',
  cpp: 'C++',
  c: 'C',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  kotlin: 'Kotlin',
};

function languageLabel(id: string): string {
  return LANGUAGE_LABEL[id] ?? id;
}
