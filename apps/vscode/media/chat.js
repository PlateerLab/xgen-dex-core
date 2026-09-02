(function () {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const elements = {
    screens: {
      loading: byId('loading-screen'),
      gate: byId('gate-screen'),
      agents: byId('agents-screen'),
      chat: byId('chat-screen'),
      settings: byId('settings-screen'),
    },
    gateIcon: byId('gate-icon'),
    gateTitle: byId('gate-title'),
    gateDescription: byId('gate-description'),
    gateConnection: byId('gate-connection'),
    gatePrimary: byId('gate-primary'),
    gateSettings: byId('gate-settings'),
    agentsConnection: byId('agents-connection'),
    agentsRefresh: byId('agents-refresh'),
    agentsSettings: byId('agents-settings'),
    accountAvatar: byId('account-avatar'),
    accountName: byId('account-name'),
    agentCount: byId('agent-count'),
    agentSearch: byId('agent-search'),
    agentFilters: byId('agent-filters'),
    agentList: byId('agent-list'),
    agentName: byId('agent-name'),
    agentDescription: byId('agent-description'),
    agentScope: byId('agent-scope'),
    agentStatus: byId('agent-status'),
    agentId: byId('agent-id'),
    changeAgent: byId('change-agent'),
    chatSettings: byId('chat-settings'),
    messages: byId('messages'),
    status: byId('status'),
    statusText: byId('status-text'),
    input: byId('input'),
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
    localToolsEnabled: byId('local-tools-enabled'),
    localToolsShell: byId('local-tools-shell'),
    localToolsCwd: byId('local-tools-cwd'),
    localToolsRoots: byId('local-tools-roots'),
    localToolsTimeout: byId('local-tools-timeout'),
    localToolsBlocked: byId('local-tools-blocked'),
    localToolsDangerous: byId('local-tools-dangerous'),
    localToolsMessage: byId('local-tools-message'),
    useWorkspaceRoot: byId('use-workspace-root'),
    saveLocalTools: byId('save-local-tools'),
    engineDescription: byId('engine-description'),
    showOutput: byId('show-output'),
    extensionSettings: byId('extension-settings'),
    restartEngine: byId('restart-engine'),
  };
  const persisted = vscode.getState() || {};
  let state = {
    screen: 'loading',
    profiles: [],
    agents: [],
    agentTotal: 0,
    messages: [],
    running: false,
    refreshing: true,
    localToolsSaving: false,
  };
  let agentFilter = persisted.agentFilter || 'all';
  let composing = false;
  let previousAgentId;
  let gateAction = 'refresh';
  let localToolsDirty = false;
  let wasLocalToolsSaving = false;

  function post(type, extra) {
    vscode.postMessage({ type, ...(extra || {}) });
  }

  function persistUi() {
    vscode.setState({ agentFilter, agentSearch: elements.agentSearch.value });
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
    if (!text || state.running || !state.agent) return;
    post('send', { text });
    elements.input.value = '';
  }

  function copyButton(text, label) {
    const button = document.createElement('button');
    button.className = 'copy-button';
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = '⧉';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = '✓';
      } catch {
        button.textContent = '!';
      }
      window.setTimeout(() => {
        button.textContent = '⧉';
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
    if (item.role === 'activity') {
      const activityIcon = document.createElement('span');
      activityIcon.className = 'activity-icon';
      activityIcon.textContent = '⌁';
      const activityText = document.createElement('span');
      activityText.textContent = item.text;
      article.append(activityIcon, activityText);
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
    if (item.text) header.append(copyButton(item.text, '메시지 복사'));
    const content = document.createElement('div');
    content.className = 'message-content';
    if (!item.text && item.role === 'assistant') content.append(typingIndicator());
    else if (item.role === 'assistant') renderRichText(content, item.text);
    else content.textContent = item.text;
    body.append(header, content);
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

  function badge(label, className) {
    const node = document.createElement('span');
    node.className = `card-badge ${className || ''}`.trim();
    node.textContent = label;
    return node;
  }

  function agentCard(agent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-card';
    button.addEventListener('click', () => post('selectAgent', { workflowId: agent.workflowId }));

    // 이름과 배지를 한 줄에 둔다. 예전에는 장식용 ✦ 와 '대화 시작 →' 가 카드마다
    // 두 줄을 더 먹었는데, 아이콘은 어느 카드나 같아서 고르는 데 도움이 안 되고
    // 카드 전체가 이미 버튼이라 그 안내도 없어도 된다.
    const top = document.createElement('div');
    top.className = 'agent-card-top';
    const name = document.createElement('strong');
    name.textContent = agent.workflowName;
    const badges = document.createElement('span');
    badges.className = 'agent-card-badges';
    badges.append(badge(agent.isShared ? '공유' : '개인', agent.isShared ? 'shared' : 'personal'));
    // 배포 여부는 초안일 때만 말한다 — 대부분이 초안이라 둘 다 붙이면 소음이다.
    if (agent.isDeployed) badges.append(badge('배포됨', 'deployed'));
    top.append(name, badges);
    button.append(top);

    // 설명이 없는 Agent 가 대부분이다. '등록된 설명이 없습니다.' 로 한 줄을
    // 채우느니 그 줄을 아예 없앤다.
    const summary = (agent.description || '').trim();
    const owner = agent.fullName || agent.username || '';
    if (summary) {
      const description = document.createElement('p');
      description.textContent = summary;
      button.append(description);
    }
    if (owner) {
      const meta = document.createElement('span');
      meta.className = 'agent-card-meta';
      meta.textContent = owner;
      button.append(meta);
    }
    return button;
  }

  function renderAgentList() {
    const query = elements.agentSearch.value.trim().toLocaleLowerCase();
    const filtered = state.agents.filter((agent) => {
      if (agentFilter === 'personal' && agent.isShared) return false;
      if (agentFilter === 'shared' && !agent.isShared) return false;
      if (!query) return true;
      return [agent.workflowName, agent.description, agent.username, agent.fullName]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
    elements.agentCount.textContent = `${filtered.length}${state.agentTotal > state.agents.length ? ` / ${state.agentTotal}` : ''} Agents`;
    elements.agentList.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'agent-empty';
      const icon = document.createElement('span');
      icon.textContent = '⌕';
      const title = document.createElement('strong');
      title.textContent = query ? '검색 결과가 없습니다' : '사용 가능한 Agent가 없습니다';
      const description = document.createElement('p');
      description.textContent = query ? '다른 이름이나 설명으로 검색해 보세요.' : '서버에서 Agent를 배포한 뒤 새로 고침해 주세요.';
      empty.append(icon, title, description);
      elements.agentList.append(empty);
      return;
    }
    for (const agent of filtered) elements.agentList.append(agentCard(agent));
  }

  function renderAgents() {
    showScreen('agents');
    const user = state.auth?.user;
    elements.agentsConnection.textContent = `${state.auth?.profile || ''} · ${hostOf(state.auth?.serverUrl)}`;
    elements.accountAvatar.textContent = textInitials(user?.username);
    elements.accountName.textContent = user?.username || '계정';
    if (state.initialSearch && elements.agentSearch.value !== state.initialSearch) elements.agentSearch.value = state.initialSearch;
    else if (!elements.agentSearch.value && persisted.agentSearch) elements.agentSearch.value = persisted.agentSearch;
    for (const button of elements.agentFilters.querySelectorAll('[data-filter]')) {
      button.classList.toggle('active', button.dataset.filter === agentFilter);
    }
    elements.agentsRefresh.classList.toggle('spinning', !!state.refreshing);
    renderAgentList();
  }

  function renderChat() {
    showScreen('chat');
    const agent = state.agent;
    if (!agent) {
      post('showAgents');
      return;
    }
    const wasNearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 100;
    const agentChanged = previousAgentId !== agent.workflowId;
    previousAgentId = agent.workflowId;
    elements.agentName.textContent = agent.workflowName;
    // 설명이 없으면 그 자리를 비운다. 헤더는 아이디와 한 줄을 나눠 쓰므로,
    // '없습니다' 를 채워 넣으면 진짜 정보가 밀린다.
    elements.agentDescription.textContent = (agent.description || '').trim();
    elements.agentScope.textContent = agent.isShared ? '공유 Agent' : '개인 Agent';
    elements.agentStatus.textContent = agent.isDeployed ? '배포됨' : '초안';
    elements.agentStatus.classList.toggle('deployed', !!agent.isDeployed);
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
    elements.changeAgent.disabled = !!state.running;
    elements.cancel.classList.toggle('hidden', !state.running);
    if (wasNearBottom) elements.messages.scrollTop = elements.messages.scrollHeight;
    if (agentChanged && !state.running) window.setTimeout(() => elements.input.focus(), 0);
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
      elements.localToolsEnabled.checked = !!localConfig?.enabled;
      elements.localToolsShell.checked = !!localConfig?.shellEnabled;
      elements.localToolsCwd.value = localConfig?.cwd || state.workspaceRoot || '';
      elements.localToolsRoots.value = (localConfig?.allowedRoots?.length
        ? localConfig.allowedRoots
        : state.workspaceRoot
          ? [state.workspaceRoot]
          : []
      ).join('\n');
      elements.localToolsTimeout.value = String(localConfig?.timeoutMs || 120000);
      elements.localToolsBlocked.value = (localConfig?.blockedCommands || []).join(', ');
      elements.localToolsDangerous.checked = !!localConfig?.allowDangerous;
    }
    const localStateLabel = !localTools
      ? '확인 필요'
      : !localConfig.enabled
        ? '꺼짐'
        : bridge.catalogSynced
          ? '연결됨'
          : bridge.error
            ? '확인 필요'
            : '연결 중';
    elements.localToolsState.textContent = localStateLabel;
    elements.localToolsState.classList.toggle('connected', !!localConfig?.enabled && !!bridge?.catalogSynced);
    elements.localToolsState.classList.toggle('warning', !!localConfig?.enabled && !!bridge?.error);
    elements.localToolsDescription.textContent = localConfig?.enabled
      ? `${localConfig.shellEnabled ? 'Shell, ' : ''}ReadFile, WriteFile, ListDir, Search, Open · ${bridge?.advertisedTools || localTools.tools.length}개 광고`
      : '허용 경로 안의 파일 읽기·쓰기, 목록, 검색, 열기 도구를 제공합니다.';
    elements.localToolsMessage.textContent = state.localToolsMessage || (!localConfig?.enabled
      ? '로컬 도구는 기본적으로 꺼져 있습니다.'
      : bridge?.catalogSynced
        ? `${bridge.serverTools || localTools.tools.length}개 도구가 XGEN 서버에 연결되었습니다.`
        : bridge?.error
          ? `연결 확인 필요 · ${bridge.error}`
        : '저장된 설정으로 브리지 연결을 준비하고 있습니다.');
    const localToolsUnavailable = !localTools || !!state.localToolsSaving;
    for (const control of [
      elements.localToolsEnabled,
      elements.localToolsShell,
      elements.localToolsCwd,
      elements.localToolsRoots,
      elements.localToolsTimeout,
      elements.localToolsBlocked,
      elements.localToolsDangerous,
    ]) control.disabled = localToolsUnavailable;
    elements.useWorkspaceRoot.disabled = localToolsUnavailable || !state.workspaceRoot;
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
    else if (state.screen === 'agents') renderAgents();
    else if (state.screen === 'chat') renderChat();
    else if (state.screen === 'settings') renderSettings();
  }

  elements.gatePrimary.addEventListener('click', () => post(gateAction));
  elements.gateSettings.addEventListener('click', () => post('showSettings'));
  elements.agentsRefresh.addEventListener('click', () => post('refresh'));
  elements.agentsSettings.addEventListener('click', () => post('showSettings'));
  elements.agentSearch.addEventListener('input', () => {
    persistUi();
    renderAgentList();
  });
  elements.agentSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      elements.agentSearch.value = '';
      persistUi();
      renderAgentList();
    }
  });
  elements.agentFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    agentFilter = button.dataset.filter;
    persistUi();
    for (const item of elements.agentFilters.querySelectorAll('[data-filter]')) item.classList.toggle('active', item === button);
    renderAgentList();
  });
  elements.changeAgent.addEventListener('click', () => post('showAgents'));
  elements.chatSettings.addEventListener('click', () => post('showSettings'));
  elements.send.addEventListener('click', send);
  elements.cancel.addEventListener('click', () => post('cancel'));
  elements.input.addEventListener('compositionstart', () => {
    composing = true;
  });
  elements.input.addEventListener('compositionend', () => {
    composing = false;
  });
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
  for (const control of [
    elements.localToolsEnabled,
    elements.localToolsShell,
    elements.localToolsCwd,
    elements.localToolsRoots,
    elements.localToolsTimeout,
    elements.localToolsBlocked,
    elements.localToolsDangerous,
  ]) {
    control.addEventListener('input', () => {
      localToolsDirty = true;
      elements.saveLocalTools.disabled = false;
    });
  }
  elements.useWorkspaceRoot.addEventListener('click', () => {
    if (!state.workspaceRoot) return;
    elements.localToolsCwd.value = state.workspaceRoot;
    elements.localToolsRoots.value = state.workspaceRoot;
    localToolsDirty = true;
    elements.saveLocalTools.disabled = false;
  });
  elements.saveLocalTools.addEventListener('click', () => {
    const splitList = (value) => [...new Set(value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean))];
    post('configureLocalTools', {
      config: {
        enabled: elements.localToolsEnabled.checked,
        shellEnabled: elements.localToolsShell.checked,
        cwd: elements.localToolsCwd.value.trim(),
        timeoutMs: Number(elements.localToolsTimeout.value),
        allowedRoots: splitList(elements.localToolsRoots.value),
        blockedCommands: splitList(elements.localToolsBlocked.value),
        allowDangerous: elements.localToolsDangerous.checked,
      },
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
