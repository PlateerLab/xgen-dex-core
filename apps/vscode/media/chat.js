(function () {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  // 아이콘은 SVG 로 그린다(글자 기호는 글꼴마다 모양이 달라진다). 문자열 HTML 없이 노드로 만든다.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    copy: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'],
    check: ['M3.5 8.5l3 3 6-7'],
    chevron: ['M4.5 6.5l3.5 3.5 3.5-3.5'],
    model: ['M5 5h6v6H5z', 'M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2'],
    thinking: ['M6 12h4M6.7 14h2.6', 'M8 2a4 4 0 0 0-2.4 7.2c.3.2.4.5.4.8v.5h4V10c0-.3.1-.6.4-.8A4 4 0 0 0 8 2z'],
    pencil: ['M10.5 3l2.5 2.5L6 12.5H3.5V10z', 'M9 4.5l2.5 2.5'],
    trash: ['M3 4.5h10', 'M6.5 4.5V3h3v1.5', 'M4.5 4.5l.6 8.5h5.8l.6-8.5'],
    search: ['M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M13.5 13.5l-3.3-3.3'],
    more: ['M3 8h1', 'M7.5 8h1', 'M12 8h1'],
  };
  /** 에이전트가 사라진 대화의 표시(@dex/protocol DELETED_AGENT_LABEL 과 같은 글). */
  const DELETED_AGENT_LABEL = '지워짐';
  const icon = (name, size = 14) => {
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
    for (const d of ICON_PATHS[name] || []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  };
  /** 경로의 마지막 이름 — Windows·POSIX 구분자 모두. */
  const folderName = (path) => {
    const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path || '');
  };
  const elements = {
    screens: {
      loading: byId('loading-screen'),
      gate: byId('gate-screen'),
      conversations: byId('conversations-screen'),
      start: byId('start-screen'),
      chat: byId('chat-screen'),
      settings: byId('settings-screen'),
    },
    gateIcon: byId('gate-icon'),
    gateTitle: byId('gate-title'),
    gateDescription: byId('gate-description'),
    gateConnection: byId('gate-connection'),
    gatePrimary: byId('gate-primary'),
    gateSettings: byId('gate-settings'),
    listConnection: byId('list-connection'),
    listRefresh: byId('list-refresh'),
    listSettings: byId('list-settings'),
    accountAvatar: byId('account-avatar'),
    accountName: byId('account-name'),
    listContent: byId('list-content'),
    listNew: byId('list-new'),
    listSearch: byId('list-search'),
    listMenu: byId('list-menu'),
    listMenuPanel: byId('list-menu-panel'),
    listPurge: byId('list-purge'),
    conversationList: byId('conversation-list'),
    listStatus: byId('list-status'),
    listMore: byId('list-more'),
    startBack: byId('start-back'),
    startConnection: byId('start-connection'),
    startSettings: byId('start-settings'),
    startAgent: byId('start-agent'),
    startCreate: byId('start-create'),
    startName: byId('start-name'),
    startNameError: byId('start-name-error'),
    startProvider: byId('start-provider'),
    startModel: byId('start-model'),
    startAdvanced: byId('start-advanced'),
    startSettingsFields: byId('start-settings-fields'),
    startMessage: byId('start-message'),
    startMessageText: byId('start-message-text'),
    startInput: byId('start-input'),
    startSend: byId('start-send'),
    chatBack: byId('chat-back'),
    chatTitle: byId('chat-title'),
    chatNew: byId('chat-new'),
    chatReadonly: byId('chat-readonly'),
    chatComposer: byId('chat-composer'),
    agentName: byId('agent-name'),
    agentDescription: byId('agent-description'),
    agentScope: byId('agent-scope'),
    agentStatus: byId('agent-status'),
    agentFolders: byId('agent-folders'),
    agentId: byId('agent-id'),
    chatSettings: byId('chat-settings'),
    messages: byId('messages'),
    status: byId('status'),
    statusText: byId('status-text'),
    input: byId('input'),
    attachments: byId('attachments'),
    attach: byId('attach'),
    modelChip: byId('model-chip'),
    modelIcon: byId('model-icon'),
    modelLabel: byId('model-label'),
    modelChevron: byId('model-chevron'),
    thinkingChip: byId('thinking-chip'),
    thinkingIcon: byId('thinking-icon'),
    thinkingLabel: byId('thinking-label'),
    thinkingChevron: byId('thinking-chevron'),
    send: byId('send'),
    cancel: byId('cancel'),
    settingsBack: byId('settings-back'),
    settingsRefresh: byId('settings-refresh'),
    accountState: byId('account-state'),
    settingsAvatar: byId('settings-avatar'),
    settingsUsername: byId('settings-username'),
    settingsUserId: byId('settings-user-id'),
    settingsRoles: byId('settings-roles'),
    accountAction: byId('account-action'),
    connectionName: byId('connection-name'),
    connectionHost: byId('connection-host'),
    connectionUrl: byId('connection-url'),
    editConnection: byId('edit-connection'),
    addProfile: byId('add-profile'),
    profilesList: byId('profiles-list'),
    localToolsState: byId('local-tools-state'),
    localToolsDescription: byId('local-tools-description'),
    localToolsFolders: byId('local-tools-folders'),
    localToolsDangerous: byId('local-tools-dangerous'),
    localToolsMessage: byId('local-tools-message'),
    saveLocalTools: byId('save-local-tools'),
    engineDescription: byId('engine-description'),
    showOutput: byId('show-output'),
    extensionSettings: byId('extension-settings'),
    restartEngine: byId('restart-engine'),
  };
  let state = {
    screen: 'loading',
    profiles: [],
    agents: [],
    messages: [],
    conversations: [],
    running: false,
    refreshing: true,
    readOnly: false,
    localToolsSaving: false,
  };
  let composing = false;
  let previousAgentId;
  let gateAction = 'refresh';
  let localToolsDirty = false;
  let wasLocalToolsSaving = false;

  function post(type, extra) {
    vscode.postMessage({ type, ...(extra || {}) });
  }

  function textInitials(value) {
    const text = String(value || '?').trim();
    return text ? text.slice(0, 1).toLocaleUpperCase() : '?';
  }

  function hostOf(value) {
    try {
      return new URL(value).host;
    } catch {
      return value || '';
    }
  }

  function showScreen(name) {
    for (const [key, element] of Object.entries(elements.screens)) element.classList.toggle('hidden', key !== name);
  }

  function send() {
    const text = elements.input.value.trim();
    if ((!text && !(state.attachments || []).length) || state.running || !state.agent || state.readOnly) return;
    post('send', { text });
    elements.input.value = '';
  }

  function renderAttachments() {
    elements.attachments.replaceChildren();
    for (const item of state.attachments || []) {
      const chip = document.createElement('span');
      chip.className = 'chat-attachment-chip';
      chip.textContent = `📎 ${item.name}`;
      chip.title = `${item.name} · ${item.mime_type} · ${item.size} bytes`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `${item.name} 첨부 취소`);
      remove.addEventListener('click', () => post('removeAttachment', { id: item.attachment_id }));
      chip.append(remove);
      elements.attachments.append(chip);
    }
    elements.attachments.classList.toggle('hidden', !(state.attachments || []).length);
  }

  /**
   * 복사 버튼 — 아이콘만, 늘 보인다. 이름은 마우스를 올리면 뜨는 말풍선(data-tip)으로.
   * 브라우저 기본 title 말풍선은 VS Code 테마를 따르지 않아 쓰지 않는다.
   */
  function copyButton(text, label) {
    const button = document.createElement('button');
    button.className = 'copy-button';
    button.type = 'button';
    button.dataset.tip = label;
    button.setAttribute('aria-label', label);
    button.append(icon('copy', 13));
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.replaceChildren(icon('check', 13));
        button.dataset.tip = '복사했습니다';
      } catch {
        button.dataset.tip = '복사하지 못했습니다';
      }
      window.setTimeout(() => {
        button.replaceChildren(icon('copy', 13));
        button.dataset.tip = label;
      }, 1200);
    });
    return button;
  }

  function appendInlineText(parent, text) {
    const parts = text.split(/(`[^`\n]+`)/g);
    for (const part of parts) {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        const code = document.createElement('code');
        code.className = 'inline-code';
        code.textContent = part.slice(1, -1);
        parent.append(code);
      } else {
        parent.append(document.createTextNode(part));
      }
    }
  }

  function codeBlock(language, codeText) {
    const block = document.createElement('div');
    block.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    const languageLabel = document.createElement('span');
    languageLabel.textContent = language || 'code';
    header.append(languageLabel, copyButton(codeText, '코드 복사'));
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = codeText;
    pre.append(code);
    block.append(header, pre);
    return block;
  }

  function renderRichText(container, text) {
    const lines = text.split('\n');
    let paragraph = [];
    let list;
    let listOrdered = false;
    let inCode = false;
    let codeLanguage = '';
    let codeLines = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      const node = document.createElement('p');
      appendInlineText(node, paragraph.join('\n'));
      container.append(node);
      paragraph = [];
    }

    function flushList() {
      if (!list) return;
      container.append(list);
      list = undefined;
    }

    function flushCode() {
      container.append(codeBlock(codeLanguage, codeLines.join('\n')));
      codeLines = [];
      codeLanguage = '';
    }

    for (const line of lines) {
      const fence = line.match(/^```\s*([^\s]*)/);
      if (fence) {
        flushParagraph();
        flushList();
        if (inCode) flushCode();
        else codeLanguage = fence[1] || '';
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading) {
        flushParagraph();
        flushList();
        const node = document.createElement(`h${heading[1].length + 1}`);
        appendInlineText(node, heading[2]);
        container.append(node);
        continue;
      }
      const unordered = line.match(/^\s*[-*]\s+(.+)/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)/);
      if (unordered || ordered) {
        flushParagraph();
        const orderedItem = !!ordered;
        if (!list || listOrdered !== orderedItem) {
          flushList();
          list = document.createElement(orderedItem ? 'ol' : 'ul');
          listOrdered = orderedItem;
        }
        const item = document.createElement('li');
        appendInlineText(item, (unordered || ordered)[1]);
        list.append(item);
        continue;
      }
      const quote = line.match(/^>\s?(.*)/);
      if (quote) {
        flushParagraph();
        flushList();
        const node = document.createElement('blockquote');
        appendInlineText(node, quote[1]);
        container.append(node);
        continue;
      }
      flushList();
      paragraph.push(line);
    }
    flushParagraph();
    flushList();
    if (inCode || codeLines.length) flushCode();
  }

  /* ── 전체 도구 로그 오버레이 — 데스크톱 ToolLogModal 과 같은 정보 구조.
     항목 행(이름/상태/소요) 클릭으로 입력·오류·결과를 펼친다. initialIndex 가
     있으면 그 항목이 펼쳐진 채 열리고 화면 가운데로 스크롤한다. */
  function shortToolName(raw) {
    const name = String(raw || '').trim();
    if (!name) return '(이름 없음)';
    return name.replace(/^mcp__connector__/, '').replace(/^mcp_(mcp-)?/, '');
  }
  function toolPhase(event) {
    if (event.eventType === 'tool_error' || event.error) return { label: '실패', tone: 'err' };
    if (event.eventType === 'tool_result') return { label: '완료', tone: 'ok' };
    return { label: '실행', tone: 'run' };
  }
  function prettyValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  function openToolLog(assistantId, initialIndex) {
    const source = state.messages.find((item) => item.id === assistantId);
    const events = (source && source.tools) || [];
    document.querySelector('.toollog-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'toollog-backdrop';
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) backdrop.remove();
    });
    const panel = document.createElement('div');
    panel.className = 'toollog';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '도구 실행 기록');
    const head = document.createElement('div');
    head.className = 'toollog-head';
    const title = document.createElement('span');
    title.className = 'toollog-title';
    title.textContent = `도구 실행 기록 · ${events.length}건`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toollog-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', '닫기');
    close.addEventListener('click', () => backdrop.remove());
    head.append(title, close);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'toollog-body';
    let focusRow = null;
    events.forEach((event, index) => {
      const phase = toolPhase(event);
      const itemEl = document.createElement('div');
      itemEl.className = `toollog-item ${phase.tone}`;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'toollog-row';
      const idx = document.createElement('span');
      idx.className = 'toollog-idx';
      idx.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'toollog-name';
      name.textContent = shortToolName(event.toolName);
      name.title = event.toolName || '';
      const phaseEl = document.createElement('span');
      phaseEl.className = `toollog-phase ${phase.tone}`;
      phaseEl.textContent = phase.label;
      row.append(idx, name, phaseEl);
      if (typeof event.durationMs === 'number') {
        const ms = document.createElement('span');
        ms.className = 'toollog-ms';
        ms.textContent = `${event.durationMs}ms`;
        row.append(ms);
      }
      const caret = document.createElement('span');
      caret.className = 'toollog-caret';
      row.append(caret);
      const detail = document.createElement('div');
      detail.className = 'toollog-detail';
      const addBlock = (labelText, value, err) => {
        if (!value) return;
        const blockLabel = document.createElement('div');
        blockLabel.className = `toollog-label${err ? ' err' : ''}`;
        blockLabel.textContent = labelText;
        const pre = document.createElement('pre');
        if (err) pre.className = 'err';
        pre.textContent = value;
        detail.append(blockLabel, pre);
      };
      addBlock('입력', prettyValue(event.toolInput));
      addBlock('오류', event.error ? String(event.error) : '', true);
      addBlock('결과', prettyValue(event.result));
      const setOpen = (openNow) => {
        itemEl.classList.toggle('open', openNow);
        caret.textContent = openNow ? '−' : '+';
      };
      setOpen(index === initialIndex);
      if (index === initialIndex) {
        itemEl.classList.add('focused');
        focusRow = itemEl;
      }
      row.addEventListener('click', () => setOpen(!itemEl.classList.contains('open')));
      itemEl.append(row, detail);
      bodyEl.append(itemEl);
    });
    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'toollog-empty';
      empty.textContent = '이 답변에서는 도구를 쓰지 않았습니다.';
      bodyEl.append(empty);
    }
    panel.append(head, bodyEl);
    backdrop.append(panel);
    document.body.append(backdrop);
    const onKey = (event) => {
      if (event.key === 'Escape') {
        backdrop.remove();
        window.removeEventListener('keydown', onKey);
      }
    };
    window.addEventListener('keydown', onKey);
    if (focusRow) focusRow.scrollIntoView({ block: 'center' });
  }

  function typingIndicator() {
    const indicator = document.createElement('span');
    indicator.className = 'typing-indicator';
    indicator.setAttribute('aria-label', '응답 생성 중');
    indicator.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    return indicator;
  }

  function messageElement(item) {
    const article = document.createElement('article');
    article.className = `message ${item.role}`;
    // [Trigger] 행 — Job/sub-agent 가 세션을 깨운 턴. 사용자 말풍선 대신
    // 한 줄 라벨 + 클릭 상세 (전 앱 공통 계약).
    if (item.role === 'user' && item.trigger) {
      article.className = 'message trigger';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'trigger-row';
      row.title = '클릭하면 트리거 원문을 봅니다';
      const label = document.createElement('span');
      label.className = 'trigger-label';
      label.textContent = item.trigger.rowLabel || 'Trigger';
      const caret = document.createElement('span');
      caret.className = 'trigger-caret';
      caret.textContent = '+';
      row.append(label, caret);
      const detail = document.createElement('pre');
      detail.className = 'trigger-detail';
      detail.textContent = item.trigger.body || '(내용 없음)';
      detail.hidden = true;
      row.addEventListener('click', () => {
        detail.hidden = !detail.hidden;
        caret.textContent = detail.hidden ? '+' : '−';
      });
      article.append(row, detail);
      return article;
    }
    if (item.role === 'activity') {
      const activityIcon = document.createElement('span');
      activityIcon.className = 'activity-icon';
      activityIcon.textContent = '⌁';
      const activityText = document.createElement('span');
      activityText.textContent = item.text;
      article.append(activityIcon, activityText);
      // 도구 줄은 빠르게 지나간다 — 누르면 그 도구가 펼쳐진 전체 로그로.
      if (item.toolRef) {
        article.classList.add('clickable');
        article.title = '눌러서 이 도구의 전체 로그 보기';
        article.setAttribute('role', 'button');
        article.tabIndex = 0;
        const openRef = () => openToolLog(item.toolRef.assistantId, item.toolRef.index);
        article.addEventListener('click', openRef);
        article.addEventListener('keydown', (event) => event.key === 'Enter' && openRef());
      }
      return article;
    }

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = item.role === 'user' ? '나' : item.role === 'system' ? '!' : '✦';
    const body = document.createElement('div');
    body.className = 'message-body';
    const header = document.createElement('div');
    header.className = 'message-header';
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = item.label;
    header.append(label);
    if (item.text && item.role !== 'assistant') header.append(copyButton(item.text, '메시지 복사'));
    const content = document.createElement('div');
    content.className = 'message-content';
    if (!item.text && item.role === 'assistant') content.append(typingIndicator());
    else if (item.role === 'assistant') renderRichText(content, item.text);
    else content.textContent = item.text;
    body.append(header, content);
    // 답변 푸터 한 줄 — 좌: 복사(아이콘, 상시), 우: 전체 로그(상시).
    // 데스크톱 앱과 같은 배치 계약이다.
    if (item.role === 'assistant' && (item.text || (item.tools && item.tools.length))) {
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      if (item.text) {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const copy = copyButton(item.text, '답변 복사');
        copy.classList.add('inline');
        actions.append(copy);
        footer.append(actions);
      }
      if (item.tools && item.tools.length) {
        const openLog = document.createElement('button');
        openLog.type = 'button';
        openLog.className = 'toollog-open';
        openLog.textContent = `전체 로그 보기 · ${item.tools.length}건`;
        openLog.addEventListener('click', () => openToolLog(item.id));
        footer.append(openLog);
      }
      body.append(footer);
    }
    article.append(avatar, body);
    return article;
  }

  function suggestion(label, prompt) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion';
    const icon = document.createElement('span');
    icon.textContent = '↗';
    const text = document.createElement('span');
    text.textContent = label;
    button.append(text, icon);
    button.addEventListener('click', () => {
      elements.input.value = prompt;
      elements.input.focus();
    });
    return button;
  }

  function emptyChatState() {
    const empty = document.createElement('section');
    empty.className = 'empty-state';
    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.textContent = '✦';
    const title = document.createElement('h2');
    title.textContent = `${state.agent.workflowName}와 대화하기`;
    const description = document.createElement('p');
    description.textContent = '질문을 입력하거나 아래 예시로 대화를 시작해 보세요.';
    const suggestions = document.createElement('div');
    suggestions.className = 'suggestions';
    suggestions.append(
      suggestion('무엇을 할 수 있나요?', '이 Agent가 할 수 있는 일을 간단히 알려줘.'),
      suggestion('작업 계획 만들기', '내가 하려는 작업을 위한 단계별 계획을 만들어줘.'),
      suggestion('프로젝트 설명하기', '현재 프로젝트를 이해하기 쉽게 설명해줘.'),
    );
    empty.append(mark, title, description, suggestions);
    return empty;
  }

  function renderGate() {
    showScreen('gate');
    const profile = state.profiles.find((item) => item.name === state.auth?.profile) || state.profiles.find((item) => item.current);
    const variants = {
      setup: {
        icon: '✦',
        title: '회사 XGEN 환경을 연결하세요',
        description: '사용할 서버 프로필을 등록하면 계정 로그인과 Agent 선택을 이어서 진행할 수 있습니다.',
        action: 'setupProfile',
        label: '연결 시작',
      },
      login: {
        icon: '↗',
        title: `${profile?.name || 'XGEN'}에 로그인하세요`,
        description: '로그인 정보는 dex-cli가 안전하게 처리하며 비밀번호는 저장하지 않습니다.',
        action: 'login',
        label: '로그인',
      },
      offline: {
        icon: '!',
        title: '회사 서버에 연결할 수 없습니다',
        description: '네트워크와 서버 주소를 확인한 다음 다시 연결해 주세요.',
        action: 'refresh',
        label: '다시 연결',
      },
      error: {
        icon: '!',
        title: 'XGEN Dex를 불러오지 못했습니다',
        description: state.error || 'CLI 엔진 상태를 확인한 다음 다시 시도해 주세요.',
        action: 'refresh',
        label: '다시 시도',
      },
    };
    const variant = variants[state.screen] || variants.error;
    gateAction = variant.action;
    elements.gateIcon.textContent = variant.icon;
    elements.gateTitle.textContent = variant.title;
    elements.gateDescription.textContent = variant.description;
    elements.gatePrimary.textContent = variant.label;
    elements.gatePrimary.disabled = !!state.refreshing;
    if (profile) {
      elements.gateConnection.textContent = `${profile.name} · ${hostOf(profile.serverUrl)}`;
      elements.gateConnection.classList.remove('hidden');
    } else {
      elements.gateConnection.classList.add('hidden');
    }
  }

  // ── 대화 목록 ──────────────────────────────────────────────────────
  // 마지막으로 말한 순서. 줄의 글(에이전트 이름·[지워짐]·꼬리표·제목)은 확장이 정해서 보낸다.

  let listSignature = '';
  let moreRequested = false;

  function rowAction(name, label, type, row) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-action';
    button.dataset.tip = label;
    button.setAttribute('aria-label', `${label}: ${row.title}`);
    button.append(icon(name, 13));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      post(type, { workflowId: row.workflowId, interactionId: row.interactionId });
    });
    return button;
  }

  /** 대화 한 줄: 위에 작은 에이전트 이름(사라졌으면 [지워짐])과 꼬리표, 아래에 제목. */
  function conversationRowElement(row) {
    const item = document.createElement('div');
    item.className = `conversation-row${row.active ? ' active' : ''}${row.agentDeleted ? ' deleted' : ''}`;
    item.setAttribute('role', 'listitem');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'conversation-open';
    if (row.active) open.setAttribute('aria-current', 'true');
    const meta = document.createElement('span');
    meta.className = 'conversation-meta';
    const agent = document.createElement('span');
    agent.className = 'conversation-agent';
    agent.textContent = row.agentLabel;
    meta.append(agent);
    if (row.tagLabel) {
      const tag = document.createElement('span');
      tag.className = 'conversation-tag';
      tag.textContent = row.tagLabel;
      meta.append(tag);
    }
    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = row.title;
    open.append(meta, title);
    open.addEventListener('click', () =>
      post('openConversation', { workflowId: row.workflowId, interactionId: row.interactionId }),
    );
    item.append(open);
    if (state.conversationActions) {
      const actions = document.createElement('div');
      actions.className = 'conversation-actions';
      actions.append(
        rowAction('pencil', '이름 바꾸기', 'renameConversation', row),
        rowAction('trash', '지우기', 'deleteConversation', row),
      );
      item.append(actions);
    }
    return item;
  }

  /** 끝까지 내렸으면 다음 쪽을 부른다(한 번에 하나). */
  function maybeLoadMore() {
    if (state.screen !== 'conversations' || !state.conversationsHasMore || state.conversationsLoadingMore || moreRequested) return;
    const list = elements.listContent;
    if (list.scrollHeight - list.scrollTop - list.clientHeight > 160) return;
    moreRequested = true;
    post('loadMoreConversations');
  }

  function setListMenu(open) {
    elements.listMenuPanel.classList.toggle('hidden', !open);
    elements.listMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderConversations() {
    showScreen('conversations');
    const user = state.auth?.user;
    elements.listConnection.textContent = `${state.auth?.profile || ''} · ${hostOf(state.auth?.serverUrl)}`;
    elements.accountAvatar.textContent = textInitials(user?.username);
    elements.accountName.textContent = user?.username || '계정';
    elements.listRefresh.classList.toggle('spinning', !!state.refreshing || !!state.conversationsLoading);
    // 목록 머리: [+ 새 채팅] [검색] [⋯]. ⋯ 메뉴의 [에이전트가 사라진 채팅 제거 (N)] 은 0 이면 눌리지 않는다.
    elements.listMenu.classList.toggle('hidden', !state.purgeLabel);
    if (!state.purgeLabel) setListMenu(false);
    elements.listPurge.textContent = state.purgeLabel || '';
    elements.listPurge.disabled = !(state.agentDeletedCount > 0);
    elements.listPurge.title = state.agentDeletedCount > 0 ? '' : '정리할 채팅이 없습니다.';
    const rows = state.conversations || [];
    // 답이 흐르는 동안에도 상태는 자주 온다. 목록이 그대로면 다시 그리지 않는다(스크롤·초점 유지).
    const signature = JSON.stringify([rows, !!state.conversationActions, !!state.conversationsLoading, !!state.conversationsError]);
    if (signature !== listSignature) {
      listSignature = signature;
      elements.conversationList.replaceChildren(...rows.map(conversationRowElement));
      if (!rows.length && !state.conversationsError) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = state.conversationsLoading ? '대화를 불러오는 중...' : '아직 대화가 없습니다.';
        elements.conversationList.append(empty);
      }
    }
    elements.listStatus.textContent = state.conversationsError
      ? `대화 목록을 불러오지 못했습니다. ${state.conversationsError}`
      : '';
    elements.listStatus.classList.toggle('hidden', !state.conversationsError);
    elements.listMore.classList.toggle('hidden', !state.conversationsHasMore);
    elements.listMore.disabled = !!state.conversationsLoadingMore;
    elements.listMore.textContent = state.conversationsLoadingMore ? '불러오는 중...' : '더 보기';
    if (!state.conversationsLoadingMore) moreRequested = false;
  }

  // ── 시작 화면 ──────────────────────────────────────────────────────
  // 칸의 글은 여기서 쥔다. 잠금·이름 검사·진행 글은 확장이 정해서 보낸다. 상태가 올 때마다 칸을
  // 다시 채우면 적던 글과 고른 값이 날아가므로, 새 시작 화면(session)이거나 선택지가 바뀔 때만 채운다.

  let startSession = -1;
  let startChoicesKey = '';
  let startOptionsKey = '';
  /** 손댄 세부 설정. 손대지 않은 칸은 보내지 않아 서버 기본값이 쓰인다. */
  const startDirty = new Set();

  function fillSelect(select, items, value) {
    select.replaceChildren(
      ...items.map((item) => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        return option;
      }),
    );
    if (items.some((item) => item.value === value)) select.value = value;
  }

  function fillModels(providerValue) {
    const options = state.start?.options;
    const provider = options?.providers.find((item) => item.value === providerValue);
    fillSelect(elements.startModel, provider ? provider.models : [], provider ? provider.defaultModel : '');
  }

  /** 세부 설정 한 칸: 서버가 알려 준 타입대로(참거짓은 체크, 선택지는 선택 상자, 숫자는 숫자 칸). */
  function settingField(setting) {
    const type = String(setting.type || '').toUpperCase();
    const value = setting.default;
    const text = value === null || value === undefined ? '' : String(value);
    const mark = (input) => {
      input.dataset.setting = setting.id;
      const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, () => startDirty.add(setting.id));
      return input;
    };
    if (type === 'BOOL' || type === 'BOOLEAN') {
      const label = document.createElement('label');
      label.className = 'start-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value === true || value === 'true';
      const name = document.createElement('span');
      name.textContent = setting.label;
      label.append(mark(input), name);
      if (setting.description) label.title = setting.description;
      return label;
    }
    const label = document.createElement('label');
    label.className = 'start-field';
    const name = document.createElement('span');
    name.textContent = setting.label;
    let input;
    if (setting.options && setting.options.length) {
      input = document.createElement('select');
      fillSelect(
        input,
        setting.options.map((option) => ({ value: String(option.value), label: option.label || String(option.value) })),
        text,
      );
    } else if (setting.id === 'system_prompt') {
      // 시스템 프롬프트는 한 줄로 받으면 쓸 수가 없다.
      input = document.createElement('textarea');
      input.rows = 4;
      input.value = text;
    } else {
      input = document.createElement('input');
      const numeric = type === 'INT' || type === 'INTEGER' || type === 'FLOAT' || type === 'NUMBER';
      input.type = numeric ? 'number' : 'text';
      if (numeric && typeof setting.min === 'number') input.min = String(setting.min);
      if (numeric && typeof setting.max === 'number') input.max = String(setting.max);
      if (numeric && typeof setting.step === 'number') input.step = String(setting.step);
      input.value = text;
    }
    input.classList.add('start-control');
    label.append(name, mark(input));
    if (setting.description) label.title = setting.description;
    return label;
  }

  function collectSettings() {
    const values = {};
    for (const input of elements.startSettingsFields.querySelectorAll('[data-setting]')) {
      const id = input.dataset.setting;
      if (!startDirty.has(id)) continue;
      values[id] = input.type === 'checkbox' ? input.checked : input.value;
    }
    return values;
  }

  function renderStart() {
    showScreen('start');
    const start = state.start;
    if (!start) return;
    elements.startConnection.textContent = `${state.auth?.profile || ''} · ${hostOf(state.auth?.serverUrl)}`;
    const fresh = start.session !== startSession;
    if (fresh) {
      startSession = start.session;
      elements.startName.value = '';
      elements.startInput.value = '';
      elements.startAdvanced.open = false;
      startChoicesKey = '';
      startOptionsKey = '';
      startDirty.clear();
    }
    const choicesKey = JSON.stringify(start.choices);
    if (choicesKey !== startChoicesKey) {
      const keep = startChoicesKey ? elements.startAgent.value : start.agentId;
      startChoicesKey = choicesKey;
      fillSelect(elements.startAgent, start.choices, keep);
      // 고른 에이전트가 목록에서 빠졌으면 첫 값으로 돌아간다. 확장도 같은 값을 알게 한다.
      if (elements.startAgent.value !== start.agentId) post('startAgent', { workflowId: elements.startAgent.value });
    }
    const options = start.options;
    const optionsKey = options
      ? JSON.stringify([options.defaultProvider, options.providers, options.settings.map((setting) => setting.id)])
      : `none:${!!start.optionsLoading}`;
    if (optionsKey !== startOptionsKey) {
      startOptionsKey = optionsKey;
      startDirty.clear();
      if (options) {
        fillSelect(elements.startProvider, options.providers, options.defaultProvider);
        fillModels(elements.startProvider.value);
        elements.startSettingsFields.replaceChildren(...options.settings.map(settingField));
      } else {
        const placeholder = start.optionsLoading ? [{ value: '', label: '불러오는 중...' }] : [];
        fillSelect(elements.startProvider, placeholder, '');
        fillSelect(elements.startModel, placeholder, '');
        elements.startSettingsFields.replaceChildren();
      }
    }
    const busy = !!start.busy;
    const creating = elements.startAgent.value === '' && !!start.canCreate;
    elements.startCreate.classList.toggle('hidden', !creating);
    elements.startAdvanced.classList.toggle('hidden', !(options && options.settings.length));
    elements.startAgent.disabled = busy;
    elements.startName.disabled = busy;
    elements.startProvider.disabled = busy || !options || !options.providers.length;
    elements.startModel.disabled = busy || !elements.startModel.options.length;
    elements.startNameError.textContent = start.nameError || '';
    elements.startNameError.classList.toggle('hidden', !start.nameError);
    elements.startName.setAttribute('aria-invalid', start.nameError ? 'true' : 'false');
    const message = start.message;
    elements.startMessageText.textContent = message ? message.text : '';
    elements.startMessage.classList.toggle('hidden', !message || !message.text);
    elements.startMessage.classList.toggle('running', !!message && message.tone === 'progress');
    elements.startMessage.classList.toggle('error', !!message && message.tone === 'error');
    // 잠겨 있어도 누를 수는 있다. 누르면 왜 못 보내는지 보인다.
    const locked = !start.lock || !start.lock.canSend;
    elements.startSend.classList.toggle('locked', locked);
    elements.startSend.setAttribute('aria-disabled', locked ? 'true' : 'false');
    elements.startSend.disabled = busy;
    elements.startInput.disabled = busy;
    const picked = start.choices.find((choice) => choice.value && choice.value === elements.startAgent.value);
    elements.startInput.placeholder = picked ? `${picked.label}에게 메시지 보내기` : '메시지 보내기';
    if (fresh) window.setTimeout(() => (creating ? elements.startName : elements.startInput).focus(), 0);
  }

  function startSend() {
    if (state.start?.busy) return;
    post('startSend', {
      text: elements.startInput.value.trim(),
      agentId: elements.startAgent.value,
      name: elements.startName.value,
      provider: elements.startProvider.value,
      model: elements.startModel.value,
      settings: collectSettings(),
    });
  }

  function renderChat() {
    showScreen('chat');
    const agent = state.agent;
    if (!agent) {
      post('showConversations');
      return;
    }
    const readOnly = !!state.readOnly;
    const wasNearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 100;
    const agentChanged = previousAgentId !== agent.workflowId;
    previousAgentId = agent.workflowId;
    elements.agentName.textContent = agent.workflowName || DELETED_AGENT_LABEL;
    // 설명이 없으면 그 자리를 비운다. 헤더는 아이디와 한 줄을 나눠 쓰므로,
    // '없습니다' 를 채워 넣으면 진짜 정보가 밀린다.
    elements.agentDescription.textContent = (agent.description || '').trim();
    // 에이전트가 사라진 대화: 범위·배포·폴더 대신 [지워짐] 하나.
    elements.agentScope.textContent = readOnly ? DELETED_AGENT_LABEL : agent.isShared ? '공유 Agent' : '개인 Agent';
    elements.agentScope.classList.toggle('deleted', readOnly);
    elements.agentStatus.textContent = agent.isDeployed ? '배포됨' : '초안';
    elements.agentStatus.classList.toggle('deployed', !!agent.isDeployed);
    elements.agentStatus.classList.toggle('hidden', readOnly);
    elements.agentFolders.classList.toggle('hidden', readOnly);
    // 대화 제목이 있으면 그 줄에 제목을 둔다(아이디·설명 대신).
    const title = state.conversationTitle || '';
    elements.chatTitle.textContent = title;
    elements.chatTitle.title = title;
    elements.chatTitle.classList.toggle('hidden', !title);
    elements.agentId.classList.toggle('hidden', !!title);
    elements.agentDescription.classList.toggle('hidden', !!title);
    // 이 대화의 작업 공간 — 열린 작업 영역 폴더. 이름만 보이고 전체 경로는 툴팁으로.
    const folders = state.workspaceFolders || [];
    elements.agentFolders.textContent = folders.length
      ? `폴더 ${folders.map(folderName).join(', ')}`
      : '폴더 없음';
    elements.agentFolders.title = folders.length
      ? `Agent가 이 폴더 안에서 파일과 터미널을 사용합니다.\n${folders.join('\n')}`
      : '작업 영역에 폴더를 열면 그 폴더에서 파일과 터미널을 사용합니다.';
    elements.agentId.textContent = agent.workflowId;
    elements.agentId.title = agent.workflowId;
    elements.messages.replaceChildren();
    if (!state.messages.length) elements.messages.append(emptyChatState());
    else {
      const stream = document.createElement('div');
      stream.className = 'message-stream';
      for (const item of state.messages) stream.append(messageElement(item));
      elements.messages.append(stream);
    }
    elements.statusText.textContent = state.status || '';
    elements.status.classList.toggle('hidden', !state.status);
    elements.status.classList.toggle('running', !!state.running);
    elements.input.disabled = !!state.running;
    elements.input.placeholder = `${agent.workflowName}에게 메시지 보내기`;
    elements.send.disabled = !!state.running;
    elements.attach.disabled = !!state.running;
    renderModel();
    renderThinking();
    renderAttachments();
    // 지워진 에이전트의 대화는 지난 대화만 보인다. 입력창 대신 안내 한 줄.
    elements.chatComposer.classList.toggle('hidden', readOnly);
    elements.chatReadonly.classList.toggle('hidden', !readOnly);
    elements.cancel.classList.toggle('hidden', !state.running);
    if (wasNearBottom) elements.messages.scrollTop = elements.messages.scrollHeight;
    if (agentChanged && !state.running && !readOnly) window.setTimeout(() => elements.input.focus(), 0);
  }

  /** 입력창 아래 모델 칩 — "제공자: 모델". 누르면 VS Code 빠른 선택으로 고른다. */
  function renderModel() {
    const model = state.model;
    elements.modelChip.classList.toggle('hidden', !model);
    if (!model) return;
    if (!elements.modelIcon.firstChild) elements.modelIcon.append(icon('model', 12));
    elements.modelLabel.textContent = model.label;
    elements.modelChevron.replaceChildren(...(model.locked ? [] : [icon('chevron', 11)]));
    elements.modelChip.disabled = !!model.locked || !!model.saving;
    elements.modelChip.classList.toggle('locked', !!model.locked);
    elements.modelChip.classList.toggle('saving', !!model.saving);
    elements.modelChip.setAttribute('aria-label', `모델: ${model.label}`);
    elements.modelChip.dataset.tip = model.locked
      ? '고정된 에이전트는 모델을 바꿀 수 없습니다'
      : '이 대화의 모델, 다음 답변부터 적용됩니다';
  }

  /** 모델 칩 오른쪽 생각 칩 — "생각: 높게". 조절할 수 없는 모델은 눌리지 않는 "생각 조절 불가". */
  function renderThinking() {
    const thinking = state.thinking;
    elements.thinkingChip.classList.toggle('hidden', !thinking);
    if (!thinking) return;
    if (!elements.thinkingIcon.firstChild) elements.thinkingIcon.append(icon('thinking', 12));
    elements.thinkingLabel.textContent = thinking.label;
    const fixed = !thinking.supported || !!thinking.locked;
    elements.thinkingChevron.replaceChildren(...(fixed ? [] : [icon('chevron', 11)]));
    elements.thinkingChip.disabled = fixed || !!thinking.saving;
    elements.thinkingChip.classList.toggle('locked', !!thinking.locked);
    elements.thinkingChip.classList.toggle('unsupported', !thinking.supported);
    elements.thinkingChip.classList.toggle('saving', !!thinking.saving);
    elements.thinkingChip.setAttribute('aria-label', thinking.label);
    elements.thinkingChip.dataset.tip = !thinking.supported
      ? '이 모델은 생각을 조절할 수 없습니다'
      : thinking.locked
        ? '고정된 에이전트는 생각 설정을 바꿀 수 없습니다'
        : '이 대화의 생각 정도, 다음 답변부터 적용됩니다';
  }

  function roleChip(label) {
    const chip = document.createElement('span');
    chip.className = 'role-chip';
    chip.textContent = label;
    return chip;
  }

  function profileRow(profile) {
    const active = profile.name === state.auth?.profile || (!state.auth && profile.current);
    const row = document.createElement('div');
    row.className = `profile-row${active ? ' active' : ''}`;
    const marker = document.createElement('span');
    marker.className = 'profile-marker';
    marker.textContent = active ? '✓' : '○';
    const copy = document.createElement('div');
    copy.className = 'profile-copy';
    const name = document.createElement('b');
    name.textContent = profile.name;
    const url = document.createElement('span');
    url.textContent = profile.serverUrl;
    copy.append(name, url);
    const actions = document.createElement('div');
    actions.className = 'profile-actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = active ? 'text-button active-label' : 'secondary-button';
    use.textContent = active ? '사용 중' : '전환';
    use.disabled = active || !!state.refreshing;
    use.addEventListener('click', () => post('useProfile', { profile: profile.name }));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-button';
    edit.textContent = '✎';
    edit.title = `${profile.name} 연결 수정`;
    edit.setAttribute('aria-label', `${profile.name} 연결 수정`);
    edit.addEventListener('click', () => post('editProfile', { profile: profile.name }));
    actions.append(use, edit);
    row.append(marker, copy, actions);
    return row;
  }

  function renderSettings() {
    showScreen('settings');
    const auth = state.auth;
    const user = auth?.user;
    const activeProfile = state.profiles.find((item) => item.name === auth?.profile) || state.profiles.find((item) => item.current);
    elements.settingsRefresh.classList.toggle('spinning', !!state.refreshing);
    elements.accountState.textContent = auth?.authenticated ? '로그인됨' : auth?.reason === 'network' ? '연결 오류' : '로그인 필요';
    elements.accountState.classList.toggle('connected', !!auth?.authenticated);
    elements.settingsAvatar.textContent = textInitials(user?.username);
    elements.settingsUsername.textContent = user?.username || '로그인하지 않음';
    elements.settingsUserId.textContent = user?.userId ? `User ID · ${user.userId}` : activeProfile ? `${activeProfile.name} 프로필` : '등록된 프로필이 없습니다.';
    elements.settingsRoles.replaceChildren();
    if (user) {
      const roles = user.roles?.length ? user.roles : ['사용자'];
      for (const role of roles) elements.settingsRoles.append(roleChip(role));
      if (user.permissions?.length) elements.settingsRoles.append(roleChip(`권한 ${user.permissions.length}개`));
    }
    elements.accountAction.textContent = auth?.authenticated ? '로그아웃' : auth?.reason === 'network' ? '다시 연결' : '로그인';
    elements.accountAction.disabled = !activeProfile || !!state.refreshing;
    elements.connectionName.textContent = activeProfile?.name || '연결 없음';
    elements.connectionHost.textContent = activeProfile ? `${hostOf(activeProfile.serverUrl)} · ${auth?.authenticated ? '연결됨' : auth?.reason === 'network' ? '연결 실패' : '인증 필요'}` : '회사 또는 환경 프로필을 추가하세요.';
    elements.connectionUrl.textContent = activeProfile?.serverUrl || '';
    elements.editConnection.disabled = !activeProfile || !!state.refreshing;
    elements.profilesList.replaceChildren();
    if (state.profiles.length) {
      for (const profile of state.profiles) elements.profilesList.append(profileRow(profile));
    } else {
      const empty = document.createElement('div');
      empty.className = 'profiles-empty';
      empty.textContent = '등록된 회사 / 환경 프로필이 없습니다.';
      elements.profilesList.append(empty);
    }
    if (wasLocalToolsSaving && !state.localToolsSaving) localToolsDirty = false;
    wasLocalToolsSaving = !!state.localToolsSaving;
    const localTools = state.localTools;
    const localConfig = localTools?.config;
    const bridge = localTools?.bridge;
    if (!localToolsDirty) {
      elements.localToolsDangerous.checked = !!localConfig?.allowDangerous;
    }
    const folders = state.workspaceFolders || [];
    elements.localToolsFolders.replaceChildren();
    for (const folder of folders) {
      const item = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = folderName(folder);
      const path = document.createElement('code');
      path.textContent = folder;
      item.append(name, path);
      elements.localToolsFolders.append(item);
    }
    elements.localToolsFolders.classList.toggle('hidden', !folders.length);
    elements.localToolsDescription.textContent = folders.length
      ? `대화를 시작하면 이 ${folders.length}개 폴더가 그 대화의 작업 공간이 됩니다.`
      : '작업 영역에 폴더를 열면 여기 표시됩니다.';
    const localStateLabel = !localTools
      ? '확인 필요'
      : bridge.catalogSynced
        ? '연결됨'
        : bridge.error
          ? '확인 필요'
          : '연결 중';
    elements.localToolsState.textContent = localStateLabel;
    elements.localToolsState.classList.toggle('connected', !!bridge?.catalogSynced);
    elements.localToolsState.classList.toggle('warning', !!bridge?.error);
    elements.localToolsMessage.textContent = state.localToolsMessage || (!localTools
      ? '이 PC 연결 상태를 확인하고 있습니다.'
      : bridge?.catalogSynced
        ? '이 PC가 XGEN 서버에 연결되었습니다.'
        : bridge?.error
          ? `연결 확인 필요 · ${bridge.error}`
          : '이 PC를 XGEN 서버에 연결하는 중입니다.');
    const localToolsUnavailable = !localTools || !!state.localToolsSaving;
    elements.localToolsDangerous.disabled = localToolsUnavailable;
    elements.saveLocalTools.disabled = localToolsUnavailable || !localToolsDirty;
    elements.saveLocalTools.textContent = state.localToolsSaving ? '저장 중...' : '설정 저장';
    elements.engineDescription.textContent = state.error
      ? `확인 필요 · ${state.error}`
      : state.refreshing
        ? 'CLI 엔진 상태를 확인하는 중입니다.'
        : `CLI 엔진 연결됨 · ${state.agents.length}개 Agent 확인`;
  }

  function render() {
    if (state.screen === 'loading') showScreen('loading');
    else if (state.screen === 'setup' || state.screen === 'login' || state.screen === 'offline' || state.screen === 'error') renderGate();
    else if (state.screen === 'conversations') renderConversations();
    else if (state.screen === 'start') renderStart();
    else if (state.screen === 'chat') renderChat();
    else if (state.screen === 'settings') renderSettings();
  }

  elements.gatePrimary.addEventListener('click', () => post(gateAction));
  elements.gateSettings.addEventListener('click', () => post('showSettings'));
  elements.listRefresh.addEventListener('click', () => post('refresh'));
  elements.listSettings.addEventListener('click', () => post('showSettings'));
  elements.listNew.addEventListener('click', () => post('newChat'));
  // 채팅 검색: VS Code 빠른 선택 창이 뜬다(제목·에이전트 이름·대화 내용).
  elements.listSearch.append(icon('search', 14));
  elements.listSearch.addEventListener('click', () => post('searchConversations'));
  elements.listMenu.append(icon('more', 14));
  elements.listMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    setListMenu(elements.listMenuPanel.classList.contains('hidden'));
  });
  elements.listPurge.addEventListener('click', () => {
    setListMenu(false);
    post('purgeDeletedAgents');
  });
  // 메뉴 바깥을 누르거나 Esc 면 닫는다.
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.list-menu-wrap')) setListMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setListMenu(false);
  });
  elements.listMore.addEventListener('click', () => {
    moreRequested = true;
    post('loadMoreConversations');
  });
  elements.listContent.addEventListener('scroll', maybeLoadMore, { passive: true });
  elements.startBack.addEventListener('click', () => post('showConversations'));
  elements.startSettings.addEventListener('click', () => post('showSettings'));
  elements.startAgent.addEventListener('change', () => {
    post('startAgent', { workflowId: elements.startAgent.value });
    renderStart();
  });
  elements.startName.addEventListener('input', () => post('startName', { name: elements.startName.value }));
  elements.startName.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || composing) return;
    event.preventDefault();
    elements.startInput.focus();
  });
  elements.startProvider.addEventListener('change', () => {
    fillModels(elements.startProvider.value);
    elements.startModel.disabled = !elements.startModel.options.length;
  });
  elements.startSend.addEventListener('click', startSend);
  for (const field of [elements.input, elements.startInput, elements.startName]) {
    field.addEventListener('compositionstart', () => {
      composing = true;
    });
    field.addEventListener('compositionend', () => {
      composing = false;
    });
  }
  elements.startInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing) return;
    event.preventDefault();
    startSend();
  });
  elements.chatBack.addEventListener('click', () => post('showConversations'));
  elements.chatNew.addEventListener('click', () => post('newChat'));
  elements.chatSettings.addEventListener('click', () => post('showSettings'));
  elements.send.addEventListener('click', send);
  elements.attach.addEventListener('click', () => post('attach'));
  elements.modelChip.addEventListener('click', () => post('pickModel'));
  elements.thinkingChip.addEventListener('click', () => post('pickThinking'));
  elements.cancel.addEventListener('click', () => post('cancel'));
  elements.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing) return;
    event.preventDefault();
    send();
  });
  elements.settingsBack.addEventListener('click', () => post('back'));
  elements.settingsRefresh.addEventListener('click', () => post('refresh'));
  elements.accountAction.addEventListener('click', () =>
    post(state.auth?.authenticated ? 'logout' : state.auth?.reason === 'network' ? 'refresh' : 'login'),
  );
  elements.editConnection.addEventListener('click', () => {
    const profile = state.profiles.find((item) => item.name === state.auth?.profile) || state.profiles.find((item) => item.current);
    if (profile) post('editProfile', { profile: profile.name });
  });
  elements.addProfile.addEventListener('click', () => post('setupProfile'));
  elements.localToolsDangerous.addEventListener('input', () => {
    localToolsDirty = true;
    elements.saveLocalTools.disabled = false;
  });
  elements.saveLocalTools.addEventListener('click', () => {
    post('configureLocalTools', {
      config: { allowDangerous: elements.localToolsDangerous.checked },
    });
  });
  elements.showOutput.addEventListener('click', () => post('showOutput'));
  elements.extensionSettings.addEventListener('click', () => post('openExtensionSettings'));
  elements.restartEngine.addEventListener('click', () => post('restartEngine'));
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'state') return;
    state = event.data.state;
    render();
  });

  render();
  post('ready');
})();
