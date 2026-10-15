/**
 * 소스 제어 — 샌드박스 안의 git 을 편집기처럼 다룬다.
 *
 * 저장소가 어디에 있는지(GitHub·GitLab…), 누구 이름으로 커밋하는지, 어떤 로그인 정보를
 * 가지고 있는지를 함께 보여 준다. 그 정보는 샌드박스 HOME 에 있어 에이전트의 `git push`
 * 도 같은 것을 쓴다.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { FileIcon, Icon } from './icons';
import { useIde, useStore } from './hooks';
import { Empty, IconButton, showMenu, type MenuEntry } from './primitives';
import {
  PROVIDER_LABEL,
  STATUS_LABEL,
  STATUS_LETTER,
  changeCount,
  relativeTime,
  toWorkspacePath,
  type GitChange,
  type GitStatus,
} from '../git-model';
import { basename, dirname } from '../paths';
import { formatBinding, isMac } from '../keys';

export function ScmView() {
  const store = useStore();
  const git = useIde((s) => s.git);
  const readonly = useIde((s) => s.readonly);
  const [repo, setRepo] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => {
    if (!git.loaded && !git.loading) void store.refreshGit();
  }, [git.loaded, git.loading, store]);
  useEffect(() => {
    if (accountOpen && !git.account) void store.refreshAccount();
  }, [accountOpen, git.account, store]);

  const repos = git.repos;
  const active = repo != null && repos.includes(repo) ? repo : repos.includes('') ? '' : repos[0] ?? null;
  const status = active != null ? git.statuses[active] : undefined;

  const moreMenu = (e: MouseEvent): void => {
    const items: MenuEntry[] = [];
    if (status && !readonly) {
      items.push(
        { id: 'pull', label: '풀', run: () => void store.gitRun({ op: 'pull', repo: active }, '풀') },
        { id: 'pull-rebase', label: '풀 (리베이스)', run: () => void store.gitRun({ op: 'pull', repo: active, rebase: true }, '풀') },
        { id: 'push', label: '푸시', run: () => void store.gitRun({ op: 'push', repo: active }, '푸시') },
        { id: 'sync', label: '동기화', run: () => void store.gitRun({ op: 'sync', repo: active }, '동기화') },
        { id: 'fetch', label: '가져오기', run: () => void store.gitRun({ op: 'fetch', repo: active }, '가져오기') },
        'separator',
        { id: 'checkout', label: '브랜치 전환', run: () => store.openQuickOpen('branches') },
        { id: 'branch', label: '새 브랜치 만들기', run: () => void createBranch(store, active!) },
        'separator',
        { id: 'stash', label: '스태시', run: () => void store.gitRun({ op: 'stash', repo: active, action: 'push', include_untracked: true }, '스태시') },
        { id: 'stash-pop', label: '마지막 스태시 꺼내기', disabled: !status.stash_count, run: () => void store.gitRun({ op: 'stash', repo: active, action: 'pop', index: 0 }, '스태시 꺼내기') },
        'separator',
        { id: 'remote', label: '원격 추가', run: () => void addRemote(store, active!) },
      );
    }
    if (!readonly) {
      items.push(
        { id: 'clone', label: '저장소 복제', run: () => void cloneRepo(store) },
        { id: 'init', label: '저장소 초기화', run: () => void initRepo(store) },
        'separator',
      );
    }
    items.push({ id: 'account', label: '계정과 토큰', run: () => setAccountOpen(true) });
    showMenu(e, items);
  };

  return (
    <div className="xide-side-view xide-scm">
      <div className="xide-side-header">
        <span className="xide-side-title">소스 제어</span>
        <span className="xide-section-actions">
          {status && !readonly ? (
            <IconButton icon="check" label="커밋" onClick={() => void commit(store, active!, 'commit')} keybinding="Mod+Enter" />
          ) : null}
          <IconButton icon="refresh" label="새로 고침" onClick={() => void store.refreshGit()} />
          <IconButton icon="more" label="더 보기" onClick={moreMenu} />
        </span>
      </div>
      {git.busy ? (
        <div className="xide-progress" role="progressbar" aria-label={git.busy}>
          <span />
        </div>
      ) : null}
      <div className="xide-scm-body">
        {git.error ? <div className="xide-tree-note xide--error">{git.error.message}</div> : null}
        {!git.loaded ? <div className="xide-tree-note">불러오는 중</div> : null}
        {git.loaded && !repos.length && !git.error ? (
          <Empty icon="scm">
            <p>이 작업 공간에는 git 저장소가 없습니다.</p>
            {!readonly ? (
              <div className="xide-empty-actions">
                <button type="button" className="xide-btn xide--primary" onClick={() => void initRepo(store)}>
                  저장소 초기화
                </button>
                <button type="button" className="xide-btn" onClick={() => void cloneRepo(store)}>
                  저장소 복제
                </button>
              </div>
            ) : null}
          </Empty>
        ) : null}
        {repos.length > 1 ? (
          <label className="xide-scm-repo-select">
            <span>저장소</span>
            <select className="xide-input" value={active ?? ''} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r || '(작업 공간 루트)'} {changeCount(git.statuses[r]) ? `· ${changeCount(git.statuses[r])}` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {status ? <RepoPanel status={status} readonly={readonly} /> : null}
        <AccountSection open={accountOpen} onToggle={() => setAccountOpen((v) => !v)} readonly={readonly} />
      </div>
    </div>
  );
}

function RepoPanel({ status, readonly }: { status: GitStatus; readonly: boolean }) {
  const store = useStore();
  const message = useIde((s) => s.git.message[status.repo] ?? '');
  const busy = useIde((s) => s.git.busy);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLTextAreaElement>(null);
  const repo = status.repo;
  const remote = status.remotes.find((r) => r.name === 'origin') ?? status.remotes[0];
  const b = status.branch;
  const changes = useMemo(() => [...status.changes, ...status.untracked], [status.changes, status.untracked]);
  const nothing = !status.staged.length && !changes.length && !status.conflicts.length;

  const section = (id: string, title: string, items: GitChange[], kind: 'conflict' | 'staged' | 'changes') => {
    if (!items.length) return null;
    const open = !collapsed.has(id);
    const paths = items.map((c) => c.path);
    const untracked = items.filter((c) => c.status === 'untracked').map((c) => c.path);
    const tracked = items.filter((c) => c.status !== 'untracked').map((c) => c.path);
    return (
      <div className="xide-scm-section">
        <div
          className="xide-scm-section-head"
          onClick={() =>
            setCollapsed((cur) => {
              const next = new Set(cur);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="xide-scm-section-title">{title}</span>
          <span className="xide-row-actions" onClick={(e) => e.stopPropagation()}>
            {!readonly && kind === 'staged' ? (
              <IconButton icon="minus" label="모두 스테이지 취소" onClick={() => void store.gitRun({ op: 'unstage', repo, paths }, '스테이지 취소')} />
            ) : null}
            {!readonly && kind !== 'staged' ? (
              <>
                {kind === 'changes' ? (
                  <IconButton
                    icon="discard"
                    label="모두 되돌리기"
                    onClick={() => void discard(store, repo, tracked, untracked)}
                  />
                ) : null}
                <IconButton icon="plus" label="모두 스테이지" onClick={() => void store.gitRun({ op: 'stage', repo, paths }, '스테이지')} />
              </>
            ) : null}
          </span>
          <span className="xide-count">{items.length}</span>
        </div>
        {open
          ? items.map((c) => (
              <ChangeRow key={`${kind}:${c.path}`} change={c} repo={repo} staged={kind === 'staged'} readonly={readonly} />
            ))
          : null}
      </div>
    );
  };

  return (
    <div className="xide-scm-repo">
      <div className="xide-scm-remote">
        {remote ? (
          <>
            <span className={`xide-provider xide--${remote.provider}`}>{PROVIDER_LABEL[remote.provider]}</span>
            <span className="xide-scm-remote-path" title={remote.url || remote.push_url}>
              {remote.host}
              {remote.path ? `/${remote.path}` : ''}
            </span>
            {remote.web_url && store.host.openExternal ? (
              <IconButton icon="link-external" label="웹에서 열기" onClick={() => store.host.openExternal?.(remote.web_url)} />
            ) : null}
          </>
        ) : (
          <span className="xide-scm-remote-none">원격 저장소 없음</span>
        )}
      </div>
      <div className="xide-scm-branch">
        <button
          type="button"
          className="xide-link"
          disabled={readonly}
          title="브랜치 전환"
          onClick={() => store.openQuickOpen('branches')}
        >
          <Icon name="branch" /> {b.head || (b.oid ? b.oid.slice(0, 8) : '(아직 커밋 없음)')}
        </button>
        {b.upstream ? (
          <span className="xide-dim xide-scm-upstream" title={`추적: ${b.upstream}`}>
            ⇄ {b.upstream}
          </span>
        ) : null}
        {status.state ? <span className="xide-warn-chip">{STATE_LABEL[status.state]}</span> : null}
      </div>
      {!readonly ? (
        <div className="xide-scm-commit">
          <textarea
            ref={ref}
            className="xide-input"
            rows={Math.min(8, Math.max(1, message.split('\n').length))}
            value={message}
            placeholder={`커밋 메시지 (${formatBinding('Mod+Enter')})`}
            aria-label="커밋 메시지"
            onChange={(e) => store.setCommitMessage(repo, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
                e.preventDefault();
                void commit(store, repo, 'commit');
              }
            }}
          />
          <div className="xide-split-button">
            <button
              type="button"
              className="xide-btn xide--primary"
              disabled={!!busy || (nothing && !message)}
              onClick={() => void commit(store, repo, 'commit')}
            >
              <Icon name="check" /> 커밋
            </button>
            <button
              type="button"
              className="xide-btn xide--primary xide-split-more"
              aria-label="커밋 방식"
              disabled={!!busy}
              onClick={(e) =>
                showMenu(e, [
                  { id: 'commit', label: '커밋', run: () => void commit(store, repo, 'commit') },
                  { id: 'commit-all', label: '모두 커밋', run: () => void commit(store, repo, 'all') },
                  { id: 'amend', label: '마지막 커밋 수정', run: () => void commit(store, repo, 'amend') },
                  'separator',
                  { id: 'commit-push', label: '커밋 후 푸시', run: () => void commit(store, repo, 'push') },
                  { id: 'commit-sync', label: '커밋 후 동기화', run: () => void commit(store, repo, 'sync') },
                ])
              }
            >
              <Icon name="chevron-down" />
            </button>
          </div>
          {nothing && (b.ahead || b.behind) ? (
            <button
              type="button"
              className="xide-btn xide--full"
              disabled={!!busy}
              onClick={() => void store.gitRun({ op: 'sync', repo }, '동기화')}
            >
              <Icon name="sync" /> 변경 내용 동기화 {b.behind ? `↓${b.behind}` : ''} {b.ahead ? `↑${b.ahead}` : ''}
            </button>
          ) : null}
          {nothing && !b.upstream && b.head && remoteExists(status) ? (
            <button
              type="button"
              className="xide-btn xide--full"
              disabled={!!busy}
              onClick={() => void store.gitRun({ op: 'push', repo }, '푸시')}
            >
              <Icon name="cloud" /> 브랜치 게시
            </button>
          ) : null}
        </div>
      ) : null}
      {section('conflicts', '병합 변경', status.conflicts, 'conflict')}
      {section('staged', '스테이지된 변경', status.staged, 'staged')}
      {section('changes', '변경', changes, 'changes')}
      {nothing ? <div className="xide-tree-note">바뀐 파일이 없습니다.</div> : null}
      {status.last_commit ? (
        <div className="xide-scm-last" title={status.last_commit.hash}>
          <Icon name="commit" /> {status.last_commit.subject}
          <span className="xide-dim">
            {' '}
            · {status.last_commit.author} · {relativeTime(status.last_commit.time)}
          </span>
        </div>
      ) : null}
      {status.stash_count ? <StashSection repo={repo} count={status.stash_count} readonly={readonly} /> : null}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  merging: '병합 중',
  rebasing: '리베이스 중',
  cherry_picking: '체리픽 중',
};

function remoteExists(s: GitStatus): boolean {
  return s.remotes.length > 0;
}

const STATUS_CLASS: Record<string, string> = {
  modified: 'xide--git-modified',
  type_changed: 'xide--git-modified',
  added: 'xide--git-added',
  untracked: 'xide--git-untracked',
  deleted: 'xide--git-deleted',
  renamed: 'xide--git-renamed',
  copied: 'xide--git-added',
  unmerged: 'xide--git-conflict',
};

function ChangeRow({ change, repo, staged, readonly }: { change: GitChange; repo: string; staged: boolean; readonly: boolean }) {
  const store = useStore();
  const wsPath = toWorkspacePath(repo, change.path);
  const name = basename(change.path.replace(/\/$/, ''));
  const open = (preview: boolean) => {
    if (change.status === 'unmerged') {
      void store.openFile(wsPath, { preview });
      return;
    }
    store.openDiff({ repo, path: change.path, staged, status: change.status }, { preview });
  };
  const tracked = change.status !== 'untracked';
  const menu: MenuEntry[] = [
    { id: 'diff', label: '변경 내용 보기', run: () => open(false) },
    {
      id: 'file',
      label: '파일 열기',
      disabled: change.status === 'deleted' && !staged,
      run: () => void store.openFile(wsPath, { preview: false }),
    },
    'separator',
  ];
  if (!readonly) {
    if (staged) menu.push({ id: 'unstage', label: '스테이지 취소', run: () => void store.gitRun({ op: 'unstage', repo, paths: [change.path] }, '스테이지 취소') });
    else {
      menu.push({ id: 'stage', label: '스테이지', run: () => void store.gitRun({ op: 'stage', repo, paths: [change.path] }, '스테이지') });
      menu.push({
        id: 'discard',
        label: '변경 되돌리기',
        danger: true,
        run: () => void discard(store, repo, tracked ? [change.path] : [], tracked ? [] : [change.path]),
      });
    }
    menu.push('separator');
  }
  menu.push({ id: 'reveal', label: '탐색기에서 보기', run: () => {
    store.reveal(wsPath);
    store.showSideView('explorer');
  } });
  return (
    <div
      className={`xide-scm-change ${STATUS_CLASS[change.status] ?? ''}`}
      title={`${wsPath} · ${STATUS_LABEL[change.status]}${change.orig ? ` (${change.orig} 에서)` : ''}`}
      onClick={() => open(true)}
      onDoubleClick={() => open(false)}
      onContextMenu={(e) => showMenu(e, menu)}
    >
      <FileIcon name={name} />
      <span className={`xide-scm-change-name${change.status === 'deleted' ? ' xide--strike' : ''}`}>{name}</span>
      <span className="xide-scm-change-dir">{dirname(change.path)}</span>
      <span className="xide-row-actions" onClick={(e) => e.stopPropagation()}>
        {change.status !== 'deleted' || staged ? (
          <IconButton icon="go-to-file" label="파일 열기" onClick={() => void store.openFile(wsPath, { preview: false })} />
        ) : null}
        {!readonly && !staged ? (
          <IconButton
            icon="discard"
            label="변경 되돌리기"
            onClick={() => void discard(store, repo, tracked ? [change.path] : [], tracked ? [] : [change.path])}
          />
        ) : null}
        {!readonly ? (
          staged ? (
            <IconButton icon="minus" label="스테이지 취소" onClick={() => void store.gitRun({ op: 'unstage', repo, paths: [change.path] }, '스테이지 취소')} />
          ) : (
            <IconButton icon="plus" label="스테이지" onClick={() => void store.gitRun({ op: 'stage', repo, paths: [change.path] }, '스테이지')} />
          )
        ) : null}
      </span>
      <span className="xide-scm-letter">{STATUS_LETTER[change.status]}</span>
    </div>
  );
}

function StashSection({ repo, count, readonly }: { repo: string; count: number; readonly: boolean }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<{ ref: string; subject: string; time: number }[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void store.host
      .git<{ stashes: { ref: string; subject: string; time: number }[] }>({ op: 'stash', repo, action: 'list' })
      .then((r) => alive && setItems(r.stashes), () => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [open, count, repo, store]);
  return (
    <div className="xide-scm-section">
      <div className="xide-scm-section-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="xide-scm-section-title">스태시</span>
        <span className="xide-count">{count}</span>
      </div>
      {open
        ? (items ?? []).map((s, i) => (
            <div key={s.ref} className="xide-scm-change" title={s.ref}>
              <Icon name="stash" />
              <span className="xide-scm-change-name">{s.subject}</span>
              <span className="xide-scm-change-dir">{relativeTime(s.time)}</span>
              {!readonly ? (
                <span className="xide-row-actions">
                  <IconButton icon="arrow-up" label="꺼내기" onClick={() => void store.gitRun({ op: 'stash', repo, action: 'pop', index: i }, '스태시 꺼내기')} />
                  <IconButton icon="copy" label="적용(남겨 두기)" onClick={() => void store.gitRun({ op: 'stash', repo, action: 'apply', index: i }, '스태시 적용')} />
                  <IconButton
                    icon="trash"
                    label="버리기"
                    onClick={async () => {
                      if (await store.confirm('이 스태시를 버릴까요?', '되돌릴 수 없습니다.', '버리기', true)) {
                        void store.gitRun({ op: 'stash', repo, action: 'drop', index: i }, '스태시 버리기');
                      }
                    }}
                  />
                </span>
              ) : null}
            </div>
          ))
        : null}
    </div>
  );
}

function AccountSection({ open, onToggle, readonly }: { open: boolean; onToggle: () => void; readonly: boolean }) {
  const store = useStore();
  const account = useIde((s) => s.git.account);
  return (
    <div className="xide-scm-section xide-scm-account">
      <div className="xide-scm-section-head" onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="xide-scm-section-title">계정과 토큰</span>
      </div>
      {open ? (
        <div className="xide-scm-account-body">
          <div className="xide-kv">
            <span className="xide-dim">커밋 이름</span>
            <span>
              {account?.identity.name ? `${account.identity.name} <${account.identity.email}>` : '설정되지 않음'}
            </span>
            {!readonly ? (
              <button type="button" className="xide-link" onClick={() => void store.promptIdentity()}>
                변경
              </button>
            ) : null}
          </div>
          <div className="xide-dim xide-small">저장된 로그인 정보</div>
          {account?.credentials.stored.length ? (
            account.credentials.stored.map((c) => (
              <div key={`${c.host}:${c.username}`} className="xide-kv">
                <span className={`xide-provider xide--${c.provider}`}>{PROVIDER_LABEL[c.provider]}</span>
                <span>
                  {c.host} · {c.username || '(이름 없음)'}
                </span>
                {!readonly ? (
                  <IconButton icon="trash" label="토큰 지우기" onClick={() => void store.removeCredential(c.host, c.username)} />
                ) : null}
              </div>
            ))
          ) : (
            <div className="xide-small">없음. 푸시하려면 토큰을 등록하세요.</div>
          )}
          {!readonly ? (
            <button type="button" className="xide-btn" onClick={() => void store.promptCredential()}>
              <Icon name="key" /> 토큰 등록
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── 동작 ──────────────────────────────────────────────────────────────

type Store = ReturnType<typeof useStore>;

async function commit(store: Store, repo: string, mode: 'commit' | 'all' | 'amend' | 'push' | 'sync'): Promise<void> {
  const st = store.getState().git.statuses[repo];
  if (!st) return;
  const message = (store.getState().git.message[repo] ?? '').trim();
  let all = mode === 'all';
  const hasStaged = st.staged.length > 0;
  const hasChanges = st.changes.length + st.untracked.length > 0;
  if (mode !== 'amend' && !message) {
    store.notify('warning', '커밋 메시지를 입력하세요');
    return;
  }
  if (mode !== 'amend' && !hasStaged && !all) {
    if (!hasChanges) {
      store.notify('info', '커밋할 변경이 없습니다');
      return;
    }
    const ok = await store.confirm(
      '스테이지된 변경이 없습니다',
      '모든 변경을 스테이지하고 커밋할까요?',
      '모두 커밋',
    );
    if (!ok) return;
    all = true;
  }
  // 저장하지 않은 편집기 내용은 커밋에 들어가지 않는다 — 먼저 저장한다(편집기와 같은 순서).
  const dirty = Object.values(store.getState().docs).filter((d) => d.dirty);
  if (dirty.length) {
    const save = await store.confirm('저장하지 않은 파일이 있습니다', '커밋 전에 모두 저장할까요?', '저장하고 커밋');
    if (!save) return;
    await store.saveAll();
  }
  const out = await store.gitRun({ op: 'commit', repo, message, all, amend: mode === 'amend' }, '커밋');
  if (!out) return;
  store.setCommitMessage(repo, '');
  if (mode === 'push') await store.gitRun({ op: 'push', repo }, '푸시');
  if (mode === 'sync') await store.gitRun({ op: 'sync', repo }, '동기화');
}

async function discard(store: Store, repo: string, tracked: string[], untracked: string[]): Promise<void> {
  const n = tracked.length + untracked.length;
  if (!n) return;
  const label = n === 1 ? basename([...tracked, ...untracked][0]) : `${n}개 파일`;
  const msg = untracked.length
    ? '추적하지 않는 파일은 지워집니다. 되돌릴 수 없습니다.'
    : '변경 내용이 사라집니다. 되돌릴 수 없습니다.';
  const ok = await store.confirm(`${label} 의 변경을 되돌릴까요?`, msg, '되돌리기', true);
  if (!ok) return;
  await store.gitRun({ op: 'discard', repo, paths: tracked, untracked }, '되돌리기');
}

async function createBranch(store: Store, repo: string): Promise<void> {
  const name = await store.prompt('새 브랜치 이름', {
    placeholder: 'feature/my-change',
    ok: '만들기',
    validate: (v) => (/^[\w./-]+$/.test(v.trim()) && !v.includes('..') ? null : '브랜치 이름에 쓸 수 없는 문자가 있습니다'),
  });
  if (!name) return;
  await store.gitRun({ op: 'checkout', repo, ref: name.trim(), create: true }, '브랜치 만들기');
}

async function addRemote(store: Store, repo: string): Promise<void> {
  const r = await store.ask({
    title: '원격 추가',
    fields: [
      { id: 'name', label: '이름', value: 'origin' },
      { id: 'url', label: '주소', value: '', placeholder: 'https://github.com/owner/repo.git' },
    ],
    buttons: [
      { id: 'ok', label: '추가', primary: true },
      { id: 'cancel', label: '취소' },
    ],
  });
  if (r.button !== 'ok') return;
  await store.gitRun({ op: 'remote_add', repo, name: r.fields.name, url: r.fields.url }, '원격 추가');
}

async function cloneRepo(store: Store): Promise<void> {
  const r = await store.ask({
    title: '저장소 복제',
    message: '작업 공간 안의 새 폴더로 복제합니다. 비공개 저장소는 먼저 토큰을 등록하세요.',
    fields: [
      { id: 'url', label: '주소', value: '', placeholder: 'https://github.com/owner/repo.git' },
      { id: 'dir', label: '폴더 (비우면 저장소 이름)', value: '' },
    ],
    buttons: [
      { id: 'ok', label: '복제', primary: true },
      { id: 'cancel', label: '취소' },
    ],
  });
  if (r.button !== 'ok' || !r.fields.url.trim()) return;
  const out = await store.gitRun<{ repo: string }>({ op: 'clone', url: r.fields.url.trim(), dir: r.fields.dir.trim() || undefined }, '복제');
  if (out) {
    store.notify('success', `${out.repo} 에 복제했습니다`);
    store.reveal(out.repo);
  }
}

async function initRepo(store: Store): Promise<void> {
  const ok = await store.confirm('작업 공간을 git 저장소로 만들까요?', '작업 공간 루트에 저장소를 만듭니다(기본 브랜치 main).', '초기화');
  if (!ok) return;
  await store.gitRun({ op: 'init', repo: '' }, '초기화');
}

export { createBranch };
