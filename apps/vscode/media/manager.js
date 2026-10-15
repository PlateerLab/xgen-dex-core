(function () {
  // 채팅 기록 관리 탭. 줄과 글은 확장이 정해서 보낸다(conversation-manager.ts). 여기서는 그리고, 누른 것을 알린다.
  // 쥐고 있는 것은 칸에 적는 글(검색어, 이름 바꾸기)뿐이다. 문자열 HTML 없이 노드로 만든다.
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** 에이전트가 사라진 대화의 표시(@dex/protocol DELETED_AGENT_LABEL 과 같은 글). */
  const DELETED_AGENT_LABEL = '지워짐';
  const icon = (paths, size) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  };
  const elements = {
    refresh: byId('manager-refresh'),
    kind: byId('manager-kind'),
    query: byId('manager-query'),
    searchIcon: byId('manager-search-icon'),
    purge: byId('manager-purge'),
    all: byId('manager-all'),
    total: byId('manager-total'),
    selected: byId('manager-selected'),
    selectedLabel: byId('manager-selected-label'),
    deleteSelected: byId('manager-delete'),
    notice: byId('manager-notice'),
    list: byId('manager-list'),
  };
  let state;
  let kindsKey = '';
  let listSignature = '';
  let composing = false;
  /** 이름을 바꾸는 줄과 그 칸의 글. */
  let editingKey = null;
  let draft = '';
  let renameCancelled = false;
  /** 줄을 다시 그리는 동안 빠지는 칸의 blur 는 이름 바꾸기가 아니다. */
  let rebuilding = false;

  function post(type, extra) {
    vscode.postMessage({ type, ...(extra || {}) });
  }

  function button(label, className, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
  }

  function titleElement(row) {
    const title = document.createElement('span');
    title.className = 'manager-row-title';
    title.textContent = row.title;
    title.title = row.title;
    return title;
  }

  /**
   * 이름 칸을 닫는다. 목록을 통째로 다시 그리지 않고 그 칸만 제목으로 바꾼다: 다른 버튼을 눌러 칸이 닫힐 때
   * 목록을 새로 만들면 누른 버튼이 사라져 그 누름이 먹히지 않는다. 새 제목은 확장이 다음 상태로 보낸다.
   */
  function finishRename(row, input) {
    if (editingKey !== row.key) return;
    editingKey = null;
    listSignature = '';
    if (!renameCancelled) post('rename', { key: row.key, title: draft });
    input.replaceWith(titleElement(row));
  }

  function renameInput(row) {
    const input = document.createElement('input');
    input.className = 'manager-rename';
    input.type = 'text';
    input.maxLength = 200;
    input.value = draft;
    input.setAttribute('aria-label', '대화 이름');
    input.addEventListener('input', () => {
      draft = input.value;
    });
    input.addEventListener('compositionstart', () => {
      composing = true;
    });
    input.addEventListener('compositionend', () => {
      composing = false;
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || composing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renameCancelled = true;
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      if (!rebuilding) finishRename(row, input);
    });
    return input;
  }

  function rowElement(row) {
    const item = document.createElement('div');
    item.className = `manager-row${row.checked ? ' selected' : ''}`;
    item.setAttribute('role', 'listitem');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!row.checked;
    check.disabled = !!state.busy;
    check.setAttribute('aria-label', row.title);
    check.addEventListener('change', () => post('toggle', { key: row.key }));
    const main = document.createElement('div');
    main.className = 'manager-main';
    main.append(editingKey === row.key ? renameInput(row) : titleElement(row));
    const agent = document.createElement('span');
    agent.className = 'manager-row-agent';
    if (row.agentDeleted) {
      const deleted = document.createElement('span');
      deleted.className = 'manager-tag deleted';
      deleted.textContent = DELETED_AGENT_LABEL;
      agent.append(deleted);
    } else {
      const name = document.createElement('span');
      name.className = 'manager-agent-name';
      name.textContent = row.agentName;
      agent.append(name);
    }
    if (row.tagLabel) {
      const tag = document.createElement('span');
      tag.className = 'manager-tag';
      tag.textContent = row.tagLabel;
      agent.append(tag);
    }
    main.append(agent);
    const when = document.createElement('span');
    when.className = 'manager-when';
    when.textContent = row.day;
    const actions = document.createElement('span');
    actions.className = 'manager-actions';
    const open = button(row.openLabel, 'manager-button', () => post('open', { key: row.key }));
    const rename = button('이름 바꾸기', 'manager-button', () => {
      editingKey = row.key;
      draft = row.draft;
      renameCancelled = false;
      renderList();
    });
    const remove = button('삭제', 'manager-button danger', () => post('delete', { key: row.key }));
    for (const node of [open, rename, remove]) node.disabled = !!state.busy;
    actions.append(open, rename, remove);
    item.append(check, main, when, actions);
    return item;
  }

  function renderList() {
    if (!state) return;
    // 이름을 바꾸던 줄이 사라졌으면 칸도 닫는다.
    if (editingKey && !state.rows.some((row) => row.key === editingKey)) editingKey = null;
    const signature = JSON.stringify([state.rows, state.busy, state.error, state.status, state.more, state.searchMore, editingKey]);
    if (signature === listSignature) return;
    listSignature = signature;
    const children = [];
    if (state.error) {
      const error = document.createElement('div');
      error.className = 'manager-error';
      error.append(document.createTextNode(`${state.error} `));
      error.append(button('다시 시도', 'manager-link', () => post('refresh')));
      children.push(error);
    } else if (state.status) {
      const status = document.createElement('div');
      status.className = 'manager-muted manager-pad';
      status.textContent = state.status;
      children.push(status);
    } else {
      for (const row of state.rows) children.push(rowElement(row));
    }
    if (state.more) {
      const more = document.createElement('div');
      more.className = 'manager-more';
      const node = button(state.more.label, 'manager-button', () => post('more'));
      node.disabled = !!state.more.disabled;
      more.append(node);
      children.push(more);
    }
    if (state.searchMore) {
      const note = document.createElement('div');
      note.className = 'manager-muted manager-pad';
      note.textContent = state.searchMore;
      children.push(note);
    }
    rebuilding = true;
    elements.list.replaceChildren(...children);
    rebuilding = false;
    const editing = elements.list.querySelector('.manager-rename');
    if (editing) {
      editing.focus();
      editing.select();
    }
  }

  function render() {
    if (!state) return;
    const key = JSON.stringify(state.kinds);
    if (key !== kindsKey) {
      kindsKey = key;
      elements.kind.replaceChildren(
        ...state.kinds.map((kind) => {
          const option = document.createElement('option');
          option.value = kind.value;
          option.textContent = kind.label;
          return option;
        }),
      );
    }
    if (elements.kind.value !== state.kind) elements.kind.value = state.kind;
    elements.purge.textContent = state.purge.label;
    elements.purge.disabled = !!state.purge.disabled;
    elements.purge.title = state.purge.title || '';
    elements.all.checked = !!state.allSelected;
    elements.all.disabled = !state.canSelectAll;
    elements.total.textContent = state.total || '';
    elements.total.classList.toggle('hidden', !state.total);
    elements.selected.classList.toggle('hidden', !state.selectedLabel);
    elements.selectedLabel.textContent = state.selectedLabel || '';
    elements.deleteSelected.disabled = !!state.busy;
    elements.notice.textContent = state.notice || '';
    elements.notice.classList.toggle('hidden', !state.notice);
    renderList();
  }

  elements.searchIcon.append(icon(['M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M13.5 13.5l-3.3-3.3'], 15));
  elements.refresh.addEventListener('click', () => post('refresh'));
  elements.kind.addEventListener('change', () => post('kind', { kind: elements.kind.value }));
  elements.query.addEventListener('input', () => post('query', { query: elements.query.value }));
  elements.purge.addEventListener('click', () => post('purge'));
  elements.all.addEventListener('change', () => post('toggleAll'));
  elements.deleteSelected.addEventListener('click', () => post('deleteSelected'));
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'state') return;
    state = event.data.state;
    render();
  });
  post('ready');
})();
