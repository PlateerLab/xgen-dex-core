"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode3 = __toESM(require("vscode"));

// src/chat-view-provider.ts
var import_node_crypto = require("node:crypto");
var vscode = __toESM(require("vscode"));
var ChatViewProvider = class {
  constructor(context, service) {
    this.context = context;
    this.service = service;
    this.removeNotificationListener = service.rpc.onNotification((notification) => this.onNotification(notification));
  }
  context;
  service;
  view;
  screen = "loading";
  profiles = [];
  auth;
  agents = [];
  agentTotal = 0;
  selectedAgent;
  messages = [];
  interactionId;
  streamId;
  assistantMessageId;
  status;
  error;
  initialSearch;
  localTools;
  localToolsSaving = false;
  localToolsMessage;
  refreshing = false;
  refreshVersion = 0;
  renderTimer;
  toolMessages = /* @__PURE__ */ new Map();
  removeNotificationListener;
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot]
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message2) => this.onWebviewMessage(message2), void 0, this.context.subscriptions);
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = void 0;
    });
    this.postState();
    void this.refreshSession();
  }
  async refreshSession() {
    const version = ++this.refreshVersion;
    const previousScreen = this.screen;
    this.refreshing = true;
    this.error = void 0;
    if (this.profiles.length === 0 && !this.auth) this.screen = "loading";
    this.postState();
    try {
      const [profiles, localTools] = await Promise.all([
        this.service.request("profile/list"),
        this.service.request("localTools/status").catch((error) => {
          this.localToolsMessage = `\uB85C\uCEEC \uB3C4\uAD6C \uC0C1\uD0DC\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`;
          return void 0;
        })
      ]);
      if (version !== this.refreshVersion) return;
      this.profiles = profiles;
      if (localTools) {
        this.localTools = localTools;
        this.localToolsMessage = void 0;
      }
      if (profiles.length === 0) {
        this.auth = void 0;
        this.agents = [];
        this.agentTotal = 0;
        this.selectedAgent = void 0;
        this.screen = previousScreen === "settings" ? "settings" : "setup";
        return;
      }
      const configured = this.service.profileParams().profile;
      const profile = profiles.find((item) => item.name === configured) ?? profiles.find((item) => item.current) ?? profiles[0];
      if (!profile) {
        this.screen = "setup";
        return;
      }
      const auth = await this.service.request("auth/status", { profile: profile.name });
      if (version !== this.refreshVersion) return;
      this.auth = auth;
      if (!auth.authenticated) {
        this.agents = [];
        this.agentTotal = 0;
        this.selectedAgent = void 0;
        this.screen = previousScreen === "settings" ? "settings" : auth.reason === "network" ? "offline" : "login";
        return;
      }
      const result = await this.service.request("agents/list", {
        profile: auth.profile,
        page: 1,
        pageSize: 100,
        includeHarness: true
      });
      if (version !== this.refreshVersion) return;
      this.agents = result.items;
      this.agentTotal = result.pagination.totalCount;
      if (this.selectedAgent) {
        const updated = this.agents.find((agent) => agent.workflowId === this.selectedAgent?.workflowId);
        if (updated) this.selectedAgent = updated;
        else {
          this.selectedAgent = void 0;
          this.messages = [];
          this.interactionId = void 0;
        }
      }
      if (previousScreen === "settings") this.screen = "settings";
      else this.screen = this.selectedAgent ? "chat" : "agents";
    } catch (error) {
      if (version !== this.refreshVersion) return;
      this.error = errorMessage(error);
      this.screen = previousScreen === "settings" ? "settings" : "error";
    } finally {
      if (version === this.refreshVersion) {
        this.refreshing = false;
        this.postState();
      }
    }
  }
  async selectAgent(agent) {
    if (this.streamId) return;
    const changed = this.selectedAgent?.workflowId !== agent.workflowId;
    if (changed) await this.clearConversation();
    this.selectedAgent = agent;
    this.screen = "chat";
    this.status = void 0;
    this.initialSearch = void 0;
    this.postState();
    await vscode.commands.executeCommand("xgenDex.chat.focus");
  }
  async showAgents(search) {
    if (this.streamId) return;
    if (!this.auth?.authenticated) await this.refreshSession();
    if (!this.auth?.authenticated) return;
    this.screen = "agents";
    this.initialSearch = search?.trim() || void 0;
    this.postState();
    this.view?.show(true);
  }
  async showSettings() {
    this.screen = "settings";
    this.postState();
    this.view?.show(true);
  }
  async connectionChanged() {
    await this.clearConversation();
    this.selectedAgent = void 0;
    this.auth = void 0;
    this.agents = [];
    this.agentTotal = 0;
    this.screen = "loading";
    await this.refreshSession();
  }
  async newChat() {
    await this.clearConversation();
    this.screen = this.selectedAgent ? "chat" : this.auth?.authenticated ? "agents" : this.screen;
    this.postState();
  }
  async cancel() {
    if (!this.streamId) return;
    this.status = "\uC751\uB2F5\uC744 \uCDE8\uC18C\uD558\uB294 \uC911...";
    this.postState();
    await this.service.request("chat/cancel", { streamId: this.streamId });
  }
  async openHistory() {
    try {
      const conversations = await this.service.request("history/conversations", this.activeProfileParams());
      if (conversations.length === 0) {
        await vscode.window.showInformationMessage("\uC800\uC7A5\uB41C XGEN Dex \uB300\uD654\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        conversations.map((conversation2) => ({
          label: conversation2.workflowName,
          description: new Date(conversation2.updatedAt).toLocaleString(),
          detail: `${conversation2.interactionCount} turns \xB7 ${conversation2.interactionId}`,
          conversation: conversation2
        })),
        { placeHolder: "\uBD88\uB7EC\uC62C \uB300\uD654\uB97C \uC120\uD0DD\uD558\uC138\uC694", matchOnDescription: true, matchOnDetail: true }
      );
      if (!picked) return;
      const conversation = picked.conversation;
      const turns = await this.service.request("history/turns", {
        ...this.activeProfileParams(),
        workflowId: conversation.workflowId,
        workflowName: conversation.workflowName,
        interactionId: conversation.interactionId
      });
      await this.clearConversation();
      this.selectedAgent = this.agents.find((agent) => agent.workflowId === conversation.workflowId) ?? agentFromConversation(conversation);
      this.interactionId = conversation.interactionId;
      this.messages = turns.flatMap((turn) => [
        message("user", "\uB098", turn.input),
        message("assistant", conversation.workflowName, turn.output)
      ]);
      this.status = `${turns.length}\uAC1C\uC758 \uC774\uC804 \uB300\uD654\uB97C \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4.`;
      this.screen = "chat";
      this.postState();
      await vscode.commands.executeCommand("xgenDex.chat.focus");
    } catch (error) {
      await vscode.window.showErrorMessage(`\uB300\uD654 \uAE30\uB85D\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`);
    }
  }
  dispose() {
    this.removeNotificationListener();
    if (this.renderTimer) clearTimeout(this.renderTimer);
  }
  async clearConversation() {
    const activeStream = this.streamId;
    this.streamId = void 0;
    this.assistantMessageId = void 0;
    this.interactionId = void 0;
    this.messages = [];
    this.toolMessages.clear();
    this.status = void 0;
    await this.setRunning(false);
    if (activeStream) await this.service.request("chat/cancel", { streamId: activeStream }).catch(() => void 0);
  }
  async send(input) {
    const text = input.trim();
    if (!text || !this.selectedAgent || this.streamId) return;
    const agent = this.selectedAgent;
    const streamId = (0, import_node_crypto.randomUUID)();
    this.streamId = streamId;
    this.status = "\uC751\uB2F5\uC744 \uAE30\uB2E4\uB9AC\uB294 \uC911...";
    this.messages.push(message("user", "\uB098", text));
    const assistant = message("assistant", agent.workflowName, "");
    this.messages.push(assistant);
    this.assistantMessageId = assistant.id;
    this.toolMessages.clear();
    await this.setRunning(true);
    this.postState();
    try {
      const started = await this.service.request("chat/start", {
        ...this.activeProfileParams(),
        streamId,
        workflowId: agent.workflowId,
        workflowName: agent.workflowName,
        ...this.interactionId ? { interactionId: this.interactionId } : {},
        input: text
      });
      if (this.streamId !== streamId) return;
      this.interactionId = started.interactionId;
      this.status = "\uC751\uB2F5 \uC0DD\uC131 \uC911...";
      this.postState();
    } catch (error) {
      if (this.streamId !== streamId) return;
      this.streamId = void 0;
      this.status = void 0;
      this.updateAssistant(`\uC624\uB958: ${errorMessage(error)}`);
      await this.setRunning(false);
      this.postState();
    }
  }
  onNotification(notification) {
    if (notification.method === "localTools/status") {
      if (this.localTools && isLocalToolBridgeStatus(notification.params)) {
        this.localTools = { ...this.localTools, bridge: notification.params };
        this.localToolsMessage = localToolsBridgeLabel(this.localTools);
        this.scheduleState();
      }
      return;
    }
    if (notification.method === "chat/event") {
      const params = notification.params;
      if (params?.streamId !== this.streamId) return;
      this.applyEvent(params.event);
      return;
    }
    if (notification.method === "chat/complete") {
      const params = notification.params;
      if (params?.streamId !== this.streamId) return;
      this.interactionId = params.interactionId;
      this.streamId = void 0;
      this.status = void 0;
      const assistant = this.messages.find((item) => item.id === this.assistantMessageId);
      if (assistant && !assistant.text) assistant.text = "\uC751\uB2F5 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
      void this.setRunning(false);
      this.postState();
      return;
    }
    if (notification.method === "chat/error") {
      const params = notification.params;
      if (params?.streamId !== this.streamId) return;
      this.streamId = void 0;
      this.status = void 0;
      this.updateAssistant(`\uC624\uB958: ${params.error.message}`);
      void this.setRunning(false);
      this.postState();
    }
  }
  applyEvent(event) {
    if (event.kind === "text") this.updateAssistant(event.content);
    else if (event.kind === "summary") this.updateAssistant(event.text);
    else if (event.kind === "tool") this.updateTool(event.event);
    else if (event.kind === "node_status") this.status = `${event.event.nodeId} \xB7 ${event.event.status}`;
    else if (event.kind === "quota") this.messages.push(message("system", "\uC0AC\uC6A9\uB7C9", `\uC0AC\uC6A9\uB7C9 ${event.level}`));
    else if (event.kind === "error") this.messages.push(message("system", "\uC2DC\uC2A4\uD15C", event.detail));
    else if (event.kind === "status") this.status = event.detail || event.reason || event.surface;
    this.scheduleState();
  }
  updateAssistant(chunk) {
    const assistant = this.messages.find((item) => item.id === this.assistantMessageId);
    if (assistant) assistant.text += chunk;
  }
  updateTool(event) {
    const key = event.runId || `${event.toolName ?? "tool"}:${event.eventType}`;
    const existingId = this.toolMessages.get(key);
    const text = describeTool(event);
    const existing = existingId ? this.messages.find((item2) => item2.id === existingId) : void 0;
    if (existing) {
      existing.text = text;
      return;
    }
    const item = message("activity", "Tool", text);
    this.messages.push(item);
    this.toolMessages.set(key, item.id);
  }
  onWebviewMessage(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const data = raw;
    if (data.type === "ready") this.postState();
    else if (data.type === "send" && typeof data.text === "string") void this.send(data.text);
    else if (data.type === "selectAgent" && typeof data.workflowId === "string") {
      const agent = this.agents.find((item) => item.workflowId === data.workflowId);
      if (agent) void this.selectAgent(agent);
    } else if (data.type === "showAgents") void this.showAgents();
    else if (data.type === "showSettings") void this.showSettings();
    else if (data.type === "back") {
      this.screen = this.selectedAgent ? "chat" : this.auth?.authenticated ? "agents" : this.auth?.reason === "network" ? "offline" : this.profiles.length ? "login" : "setup";
      this.postState();
    } else if (data.type === "cancel") void this.cancel();
    else if (data.type === "newChat") void this.newChat();
    else if (data.type === "history") void this.openHistory();
    else if (data.type === "refresh") void vscode.commands.executeCommand("xgenDex.refresh");
    else if (data.type === "login") void vscode.commands.executeCommand("xgenDex.login");
    else if (data.type === "logout") void vscode.commands.executeCommand("xgenDex.logout");
    else if (data.type === "setupProfile") void vscode.commands.executeCommand("xgenDex.setupProfile");
    else if (data.type === "editProfile" && typeof data.profile === "string") {
      void vscode.commands.executeCommand("xgenDex.setupProfile", data.profile);
    } else if (data.type === "useProfile" && typeof data.profile === "string") {
      void vscode.commands.executeCommand("xgenDex.switchProfile", data.profile);
    } else if (data.type === "configureLocalTools") {
      void this.configureLocalTools(data.config);
    } else if (data.type === "restartEngine") void vscode.commands.executeCommand("xgenDex.restartEngine");
    else if (data.type === "openExtensionSettings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:xgen.xgen-dex-vscode");
    } else if (data.type === "showOutput") this.service.showOutput();
  }
  activeProfileParams() {
    return this.auth?.profile ? { profile: this.auth.profile } : this.service.profileParams();
  }
  async configureLocalTools(raw) {
    if (this.localToolsSaving) return;
    try {
      const patch = localToolsConfigInput(raw, this.localTools?.config, this.workspaceRoot());
      if (patch.allowDangerous && !this.localTools?.config.allowDangerous) {
        const approved = await vscode.window.showWarningMessage(
          "\uC704\uD5D8 \uBA85\uB839 \uD328\uD134 \uCC28\uB2E8\uC744 \uD574\uC81C\uD558\uBA74 Agent\uAC00 \uB418\uB3CC\uB9AC\uAE30 \uC5B4\uB824\uC6B4 \uB85C\uCEEC \uBA85\uB839\uC744 \uC2E4\uD589\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
          { modal: true },
          "\uC704\uD5D8 \uBA85\uB839 \uD5C8\uC6A9"
        );
        if (approved !== "\uC704\uD5D8 \uBA85\uB839 \uD5C8\uC6A9") {
          this.localToolsMessage = "\uC704\uD5D8 \uBA85\uB839 \uD5C8\uC6A9\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
          this.postState();
          return;
        }
      }
      this.localToolsSaving = true;
      this.localToolsMessage = "\uB85C\uCEEC \uB3C4\uAD6C \uC124\uC815\uC744 \uC800\uC7A5\uD558\uB294 \uC911\uC785\uB2C8\uB2E4...";
      this.postState();
      let status = await this.service.request("localTools/configure", {
        ...this.activeProfileParams(),
        ...patch
      });
      if (status.config.enabled && this.auth?.authenticated) {
        status = await this.service.request("localTools/start", {
          ...this.activeProfileParams(),
          waitMs: 3e3
        });
      }
      this.localTools = status;
      this.localToolsMessage = localToolsBridgeLabel(status);
    } catch (error) {
      this.localToolsMessage = `\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`;
      void vscode.window.showErrorMessage(`\uB85C\uCEEC \uB3C4\uAD6C \uC124\uC815\uC744 \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`);
    } finally {
      this.localToolsSaving = false;
      this.postState();
    }
  }
  workspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
  async setRunning(running) {
    await vscode.commands.executeCommand("setContext", "xgenDex.chatRunning", running);
  }
  scheduleState() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = void 0;
      this.postState();
    }, 33);
  }
  postState() {
    const state = {
      screen: this.screen,
      profiles: this.profiles,
      auth: this.auth,
      agents: this.agents,
      agentTotal: this.agentTotal,
      agent: this.selectedAgent,
      messages: this.messages,
      running: !!this.streamId,
      refreshing: this.refreshing,
      status: this.status,
      error: this.error,
      initialSearch: this.initialSearch,
      workspaceRoot: this.workspaceRoot(),
      localTools: this.localTools,
      localToolsSaving: this.localToolsSaving,
      localToolsMessage: this.localToolsMessage
    };
    void this.view?.webview.postMessage({ type: "state", state });
  }
  html(webview) {
    const nonce = (0, import_node_crypto.randomBytes)(16).toString("base64");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.css"));
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>XGEN Dex</title>
</head>
<body>
  <section id="loading-screen" class="screen loading-screen">
    <div class="brand-mark large" aria-hidden="true">\u2726</div>
    <strong>XGEN Dex\uB97C \uC900\uBE44\uD558\uB294 \uC911</strong>
    <span>CLI \uC5D4\uC9C4\uACFC \uC5F0\uACB0 \uC815\uBCF4\uB97C \uD655\uC778\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.</span>
    <div class="loading-bar" aria-hidden="true"><i></i></div>
  </section>

  <section id="gate-screen" class="screen gate-screen hidden">
    <div class="gate-card">
      <div id="gate-icon" class="brand-mark large" aria-hidden="true">\u2726</div>
      <div class="eyebrow">XGEN DEX FOR VS CODE</div>
      <h1 id="gate-title"></h1>
      <p id="gate-description"></p>
      <div id="gate-connection" class="gate-connection hidden"></div>
      <div class="gate-actions">
        <button id="gate-primary" type="button"></button>
        <button id="gate-settings" class="secondary-button" type="button">\uC5F0\uACB0 \uC124\uC815</button>
      </div>
    </div>
  </section>

  <section id="agents-screen" class="screen agents-screen hidden">
    <header class="workspace-header">
      <div class="brand-lockup"><span class="brand-mark" aria-hidden="true">\u2726</span><div><b>XGEN Dex</b><small id="agents-connection"></small></div></div>
      <div class="header-actions">
        <button id="agents-refresh" class="icon-button" type="button" title="\uC0C8\uB85C \uACE0\uCE68" aria-label="\uC0C8\uB85C \uACE0\uCE68">\u21BB</button>
        <button id="agents-settings" class="account-button" type="button" title="\uACC4\uC815 \uBC0F \uC5F0\uACB0 \uC124\uC815"><span id="account-avatar">?</span><span id="account-name"></span><i>\u203A</i></button>
      </div>
    </header>
    <main class="agents-content">
      <div class="agents-heading">
        <div><div class="eyebrow">SELECT AN AGENT</div><h1>\uC5B4\uB5A4 Agent\uC640 \uB300\uD654\uD560\uAE4C\uC694?</h1><p>\uC5C5\uBB34\uC5D0 \uB9DE\uB294 Agent\uB97C \uC120\uD0DD\uD558\uBA74 \uBC14\uB85C \uC0C8 \uB300\uD654\uB97C \uC2DC\uC791\uD569\uB2C8\uB2E4.</p></div>
        <span id="agent-count" class="count-badge"></span>
      </div>
      <div class="agent-toolbar">
        <label class="search-box"><span aria-hidden="true">\u2315</span><input id="agent-search" type="search" placeholder="Agent \uC774\uB984 \uB610\uB294 \uC124\uBA85 \uAC80\uC0C9" autocomplete="off"></label>
        <div id="agent-filters" class="filter-group" role="group" aria-label="Agent \uBC94\uC704">
          <button class="filter active" type="button" data-filter="all">\uC804\uCCB4</button>
          <button class="filter" type="button" data-filter="personal">\uAC1C\uC778</button>
          <button class="filter" type="button" data-filter="shared">\uACF5\uC720</button>
        </div>
      </div>
      <div id="agent-list" class="agent-grid"></div>
    </main>
  </section>

  <section id="chat-screen" class="screen chat-screen hidden">
    <header class="agent-header">
      <div class="agent-avatar" aria-hidden="true">\u2726</div>
      <div class="agent-copy">
        <div class="agent-eyebrow">ACTIVE AGENT</div>
        <div id="agent-name" class="agent-name"></div>
        <div class="agent-meta">
          <span id="agent-scope" class="meta-badge"></span>
          <span id="agent-status" class="meta-badge subtle"></span>
          <span id="agent-id" class="agent-id"></span>
        </div>
        <div id="agent-description" class="agent-description"></div>
      </div>
      <div class="agent-actions">
        <button id="change-agent" class="secondary-button compact" type="button">Agent \uBCC0\uACBD</button>
        <button id="chat-settings" class="icon-button" type="button" title="\uACC4\uC815 \uBC0F \uC5F0\uACB0 \uC124\uC815" aria-label="\uACC4\uC815 \uBC0F \uC5F0\uACB0 \uC124\uC815">\u2699</button>
      </div>
    </header>
    <main id="messages" class="messages" aria-live="polite"></main>
    <div id="status" class="status hidden" role="status"><span class="status-dot" aria-hidden="true"></span><span id="status-text"></span></div>
    <footer class="composer-shell">
      <div class="composer-card">
        <textarea id="input" rows="2" placeholder="Agent\uC5D0\uAC8C \uBA54\uC2DC\uC9C0 \uBCF4\uB0B4\uAE30" aria-label="\uBA54\uC2DC\uC9C0"></textarea>
        <div class="composer-actions">
          <span class="hint"><kbd>Enter</kbd> \uC804\uC1A1 <span aria-hidden="true">\xB7</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> \uC904\uBC14\uAFC8</span>
          <button id="cancel" class="secondary-button hidden" type="button">\uC751\uB2F5 \uC911\uC9C0</button>
          <button id="send" class="send-button" type="button"><span>\uC804\uC1A1</span><span class="send-icon" aria-hidden="true">\u2191</span></button>
        </div>
      </div>
    </footer>
  </section>

  <section id="settings-screen" class="screen settings-screen hidden">
    <header class="workspace-header">
      <div class="header-title"><button id="settings-back" class="icon-button" type="button" aria-label="\uC774\uC804 \uD654\uBA74">\u2039</button><div><b>\uACC4\uC815 \uBC0F \uC5F0\uACB0 \uC124\uC815</b><small>XGEN Dex\uAC00 \uC0AC\uC6A9\uD558\uB294 \uD68C\uC0AC \uD658\uACBD\uACFC \uACC4\uC815\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.</small></div></div>
      <button id="settings-refresh" class="icon-button" type="button" title="\uC0C8\uB85C \uACE0\uCE68" aria-label="\uC0C8\uB85C \uACE0\uCE68">\u21BB</button>
    </header>
    <main class="settings-content">
      <section class="settings-section">
        <div class="section-heading"><div><span>\uACC4\uC815</span><small>\uD604\uC7AC \uB85C\uADF8\uC778 \uC815\uBCF4</small></div><span id="account-state" class="state-pill"></span></div>
        <div class="settings-card identity-card">
          <div id="settings-avatar" class="identity-avatar">?</div>
          <div class="identity-copy"><b id="settings-username">\uB85C\uADF8\uC778\uD558\uC9C0 \uC54A\uC74C</b><span id="settings-user-id"></span><div id="settings-roles" class="role-list"></div></div>
          <button id="account-action" class="secondary-button" type="button"></button>
        </div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>\uC5F0\uACB0\uB41C \uD68C\uC0AC / \uD658\uACBD</span><small>\uD504\uB85C\uD544 \uC774\uB984\uC744 \uD68C\uC0AC \uB610\uB294 \uD658\uACBD \uAD6C\uBD84\uC73C\uB85C \uC0AC\uC6A9\uD569\uB2C8\uB2E4.</small></div></div>
        <div class="settings-card connection-card">
          <div class="connection-icon" aria-hidden="true">\u2302</div>
          <div class="connection-copy"><b id="connection-name">\uC5F0\uACB0 \uC5C6\uC74C</b><span id="connection-host"></span><code id="connection-url"></code></div>
          <button id="edit-connection" class="secondary-button" type="button">\uC5F0\uACB0 \uC218\uC815</button>
        </div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>\uD68C\uC0AC / \uD658\uACBD \uD504\uB85C\uD544</span><small>\uB2E4\uB978 XGEN \uC11C\uBC84\uB85C \uC804\uD658\uD558\uAC70\uB098 \uC0C8 \uC5F0\uACB0\uC744 \uCD94\uAC00\uD569\uB2C8\uB2E4.</small></div><button id="add-profile" class="text-button" type="button">+ \uD504\uB85C\uD544 \uCD94\uAC00</button></div>
        <div id="profiles-list" class="profiles-list"></div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>\uB85C\uCEEC \uB3C4\uAD6C</span><small>Agent\uAC00 \uC774 \uCEF4\uD4E8\uD130\uC758 \uD504\uB85C\uC81D\uD2B8 \uD30C\uC77C\uACFC \uBA85\uB839\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC788\uAC8C \uD569\uB2C8\uB2E4.</small></div><span id="local-tools-state" class="state-pill">\uAEBC\uC9D0</span></div>
        <div class="settings-card local-tools-card">
          <div class="local-tools-summary">
            <div class="local-tools-icon" aria-hidden="true">\u2318</div>
            <div><b>CLI \uB85C\uCEEC \uB3C4\uAD6C \uBE0C\uB9AC\uC9C0</b><span id="local-tools-description">Shell, \uD30C\uC77C \uC77D\uAE30\xB7\uC4F0\uAE30, \uBAA9\uB85D, \uAC80\uC0C9, \uC5F4\uAE30 \uB3C4\uAD6C\uB97C \uC81C\uACF5\uD569\uB2C8\uB2E4.</span></div>
            <label class="switch-control"><input id="local-tools-enabled" type="checkbox"><span aria-hidden="true"></span><em>\uC0AC\uC6A9</em></label>
          </div>
          <div class="local-tools-form">
            <label class="settings-field field-wide"><span>\uC791\uC5C5 \uD3F4\uB354</span><div class="field-with-action"><input id="local-tools-cwd" class="settings-input" type="text" spellcheck="false" placeholder="/path/to/project"><button id="use-workspace-root" class="secondary-button" type="button">\uD604\uC7AC Workspace</button></div><small>Shell \uBA85\uB839\uC758 \uAE30\uBCF8 \uC2E4\uD589 \uC704\uCE58\uC785\uB2C8\uB2E4.</small></label>
            <label class="settings-field field-wide"><span>\uD5C8\uC6A9 \uACBD\uB85C</span><textarea id="local-tools-roots" class="settings-textarea" rows="2" spellcheck="false" placeholder="\uD55C \uC904\uC5D0 \uD558\uB098\uC529 \uC785\uB825"></textarea><small>\uD30C\uC77C \uB3C4\uAD6C\uC640 Open\uC774 \uC811\uADFC\uD560 \uC218 \uC788\uB294 \uD3F4\uB354\uC785\uB2C8\uB2E4.</small></label>
            <label class="settings-field"><span>\uBA85\uB839 \uC81C\uD55C \uC2DC\uAC04</span><div class="input-suffix"><input id="local-tools-timeout" class="settings-input" type="number" min="1000" max="3600000" step="1000"><span>ms</span></div></label>
            <label class="settings-field"><span>\uCC28\uB2E8 \uBA85\uB839</span><input id="local-tools-blocked" class="settings-input" type="text" spellcheck="false" placeholder="sudo, rm"><small>\uC27C\uD45C \uB610\uB294 \uC904\uBC14\uAFC8\uC73C\uB85C \uAD6C\uBD84\uD569\uB2C8\uB2E4.</small></label>
            <label class="dangerous-setting field-wide"><input id="local-tools-dangerous" type="checkbox"><span><b>\uC704\uD5D8 \uBA85\uB839 \uD328\uD134 \uD5C8\uC6A9</b><small>\uD30C\uAD34\uC801 \uBA85\uB839 \uCC28\uB2E8\uC744 \uD574\uC81C\uD569\uB2C8\uB2E4. \uD544\uC694\uD55C \uACBD\uC6B0\uC5D0\uB9CC \uC0AC\uC6A9\uD558\uC138\uC694.</small></span></label>
          </div>
          <div class="local-tools-footer"><span id="local-tools-message">\uB85C\uCEEC \uB3C4\uAD6C\uB294 \uAE30\uBCF8\uC801\uC73C\uB85C \uAEBC\uC838 \uC788\uC2B5\uB2C8\uB2E4.</span><button id="save-local-tools" type="button">\uC124\uC815 \uC800\uC7A5</button></div>
        </div>
      </section>
      <section class="settings-section">
        <div class="section-heading"><div><span>CLI \uC5D4\uC9C4</span><small>\uD655\uC7A5\uC740 dex-cli\uB97C \uBC31\uADF8\uB77C\uC6B4\uB4DC \uC5D4\uC9C4\uC73C\uB85C \uC0AC\uC6A9\uD569\uB2C8\uB2E4.</small></div></div>
        <div class="settings-card engine-card">
          <div><b>dex-cli \uC5F0\uACB0</b><span id="engine-description">\uD504\uB85C\uC138\uC2A4 \uBC0F \uD655\uC7A5 \uC124\uC815\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.</span></div>
          <div class="inline-actions"><button id="show-output" class="secondary-button" type="button">\uB85C\uADF8 \uBCF4\uAE30</button><button id="extension-settings" class="secondary-button" type="button">\uD655\uC7A5 \uC124\uC815</button><button id="restart-engine" type="button">\uC5D4\uC9C4 \uC7AC\uC2DC\uC791</button></div>
        </div>
      </section>
    </main>
  </section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
};
function message(role, label, text) {
  return { id: (0, import_node_crypto.randomUUID)(), role, label, text };
}
function agentFromConversation(conversation) {
  return {
    id: 0,
    workflowId: conversation.workflowId,
    workflowName: conversation.workflowName,
    nodeCount: 0,
    isShared: false,
    isDeployed: true,
    isCompleted: true,
    workflowType: "history",
    description: "\uC774\uC804 \uB300\uD654\uC5D0\uC11C \uBD88\uB7EC\uC628 Agent",
    username: "",
    fullName: "",
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  };
}
function describeTool(event) {
  const name = event.toolName || "tool";
  if (event.eventType === "tool_result") return `${name} \xB7 \uC644\uB8CC${event.durationMs ? ` \xB7 ${event.durationMs}ms` : ""}`;
  if (event.eventType === "tool_error") return `${name} \xB7 \uC2E4\uD328${event.error ? ` \xB7 ${event.error}` : ""}`;
  return `${name} \xB7 \uC2E4\uD589 \uC911`;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function localToolsConfigInput(raw, current, workspaceRoot) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("\uB85C\uCEEC \uB3C4\uAD6C \uC124\uC815\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const value = raw;
  const cwd = typeof value.cwd === "string" ? value.cwd.trim() : current?.cwd || workspaceRoot || "";
  if (!cwd) throw new Error("\uC791\uC5C5 \uD3F4\uB354\uB97C \uC785\uB825\uD558\uC138\uC694.");
  const timeoutMs = Number(value.timeoutMs ?? current?.timeoutMs ?? 12e4);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1e3 || timeoutMs > 36e5) {
    throw new Error("\uBA85\uB839 \uC81C\uD55C \uC2DC\uAC04\uC740 1,000~3,600,000ms \uC0AC\uC774\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  }
  const stringList = (input, fallback) => {
    if (!Array.isArray(input)) return fallback;
    return [...new Set(input.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  };
  const allowedRoots = stringList(value.allowedRoots, current?.allowedRoots ?? []);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : current?.enabled === true,
    cwd,
    timeoutMs,
    allowedRoots: allowedRoots.length ? allowedRoots : [cwd],
    blockedCommands: stringList(value.blockedCommands, current?.blockedCommands ?? []),
    allowDangerous: typeof value.allowDangerous === "boolean" ? value.allowDangerous : current?.allowDangerous === true
  };
}
function isLocalToolBridgeStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value;
  return typeof status.running === "boolean" && typeof status.connected === "boolean" && typeof status.catalogSynced === "boolean" && typeof status.advertisedTools === "number" && typeof status.serverTools === "number";
}
function localToolsBridgeLabel(status) {
  if (!status.config.enabled) return "\uB85C\uCEEC \uB3C4\uAD6C\uAC00 \uAEBC\uC838 \uC788\uC2B5\uB2C8\uB2E4.";
  if (status.bridge.catalogSynced) return `\uC5F0\uACB0\uB428 \xB7 ${status.bridge.serverToolCount || status.tools.length}\uAC1C \uB3C4\uAD6C \uC0AC\uC6A9 \uAC00\uB2A5`;
  if (status.bridge.error) return `\uC5F0\uACB0 \uD655\uC778 \uD544\uC694 \xB7 ${status.bridge.error}`;
  if (status.bridge.connected) return "\uC11C\uBC84\uC640 \uB3C4\uAD6C \uBAA9\uB85D\uC744 \uB3D9\uAE30\uD654\uD558\uB294 \uC911\uC785\uB2C8\uB2E4.";
  if (status.bridge.enabled) return "XGEN \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD558\uB294 \uC911\uC785\uB2C8\uB2E4.";
  return "\uC124\uC815\uB428 \xB7 \uB85C\uADF8\uC778 \uD6C4 \uBE0C\uB9AC\uC9C0\uAC00 \uC790\uB3D9\uC73C\uB85C \uC5F0\uACB0\uB429\uB2C8\uB2E4.";
}

// src/dex-service.ts
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var vscode2 = __toESM(require("vscode"));

// ../../packages/rpc/src/client.ts
var import_node_child_process = require("node:child_process");
var import_node_readline = require("node:readline");

// ../../packages/rpc/src/wire.ts
var DEX_PROTOCOL_VERSION = 1;

// ../../packages/rpc/src/client.ts
var DexRpcError = class extends Error {
  constructor(message2, rpcCode, data) {
    super(message2);
    this.rpcCode = rpcCode;
    this.data = data;
  }
  rpcCode;
  data;
  get engineCode() {
    if (!this.data || typeof this.data !== "object") return void 0;
    const code = this.data.code;
    return typeof code === "string" ? code : void 0;
  }
};
var DexRpcClient = class {
  constructor(options) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3e4;
    this.log = options.log ?? (() => void 0);
    this.spawnProcess = options.spawnProcess ?? ((command, args, processOptions) => (0, import_node_child_process.spawn)(command, args, { ...processOptions, stdio: ["pipe", "pipe", "pipe"] }));
  }
  options;
  requestTimeoutMs;
  log;
  spawnProcess;
  pending = /* @__PURE__ */ new Map();
  notificationListeners = /* @__PURE__ */ new Set();
  stateListeners = /* @__PURE__ */ new Set();
  child;
  lineReader;
  nextId = 1;
  startPromise;
  initializeResult;
  currentState = "stopped";
  get state() {
    return this.currentState;
  }
  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
  onStateChange(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  async start() {
    if (this.currentState === "ready" && this.initializeResult) return this.initializeResult;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = void 0;
    }
  }
  async request(method, params = {}) {
    await this.start();
    return this.sendRequest(method, params);
  }
  async notify(method, params = {}) {
    await this.start();
    this.write({ jsonrpc: "2.0", method, params });
  }
  async stop() {
    const child = this.child;
    if (!child) {
      this.setState("stopped");
      return;
    }
    this.setState("stopping");
    try {
      await this.sendRequest("shutdown", {}, 1500);
    } catch {
    }
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve2) => child.once("exit", () => resolve2())),
        new Promise((resolve2) => setTimeout(resolve2, 500))
      ]);
    }
    if (child.exitCode === null && !child.killed) child.kill();
    this.cleanupProcess(child, new DexRpcError("dex-cli engine stopped"));
  }
  async restart(processSpec) {
    await this.stop();
    if (processSpec) this.options.process = processSpec;
    return this.start();
  }
  async startProcess() {
    this.setState("starting");
    const spec = this.options.process;
    this.log(`Starting dex-cli: ${spec.command} ${spec.args.join(" ")}`);
    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      windowsHide: true
    });
    this.child = child;
    this.lineReader = (0, import_node_readline.createInterface)({ input: child.stdout, crlfDelay: Infinity });
    this.lineReader.on("line", (line) => this.handleLine(line));
    child.stdin.on("error", (error) => this.cleanupProcess(child, error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.trimEnd().split(/\r?\n/)) {
        if (line) this.log(`[engine] ${line}`);
      }
    });
    child.once("close", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${String(code)}`;
      this.cleanupProcess(child, new DexRpcError(`dex-cli engine exited with ${suffix}`));
    });
    await new Promise((resolve2, reject) => {
      child.once("spawn", resolve2);
      child.once("error", reject);
    }).catch((error) => {
      const message2 = error instanceof Error ? error.message : String(error);
      this.cleanupProcess(child, new DexRpcError(`dex-cli\uB97C \uC2DC\uC791\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${message2}`));
      throw new DexRpcError(`dex-cli\uB97C \uC2DC\uC791\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${message2}`);
    });
    try {
      const initialized = await this.sendRequest("initialize", {
        protocolVersion: DEX_PROTOCOL_VERSION,
        client: { name: "xgen-dex-vscode", version: this.options.clientVersion }
      });
      this.initializeResult = initialized;
      this.setState("ready");
      this.log(`Connected to ${initialized.server.name} ${initialized.server.version}`);
      return initialized;
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill();
      this.cleanupProcess(child, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  sendRequest(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve2, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new DexRpcError(`RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve2(value),
        reject,
        timeout
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  write(message2) {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.exitCode !== null) {
      throw new DexRpcError("dex-cli engine is not running");
    }
    child.stdin.write(`${JSON.stringify(message2)}
`);
  }
  handleLine(line) {
    if (!line.trim()) return;
    let message2;
    try {
      message2 = JSON.parse(line);
    } catch {
      this.log("[protocol] Ignored malformed JSON stdout frame");
      return;
    }
    if (!message2 || typeof message2 !== "object" || Array.isArray(message2)) return;
    const record = message2;
    if (typeof record.method === "string" && !Object.prototype.hasOwnProperty.call(record, "id")) {
      const notification = message2;
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }
    if (typeof record.id !== "number") return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    clearTimeout(pending.timeout);
    const response = message2;
    if (response.error) {
      pending.reject(new DexRpcError(response.error.message, response.error.code, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }
  cleanupProcess(child, error) {
    if (this.child !== child) return;
    this.lineReader?.close();
    this.lineReader = void 0;
    this.child = void 0;
    this.initializeResult = void 0;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new DexRpcError(`${error.message} (${request.method})`));
    }
    this.pending.clear();
    this.setState("stopped");
  }
  setState(state) {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
};

// src/dex-service.ts
var DexService = class {
  constructor(context) {
    this.context = context;
    this.rpc = new DexRpcClient({
      process: this.resolveProcess(),
      clientVersion: String(context.extension.packageJSON.version ?? "0.1.0"),
      log: (message2) => this.output.appendLine(message2)
    });
  }
  context;
  output = vscode2.window.createOutputChannel("XGEN Dex");
  rpc;
  profileParams() {
    const profile = vscode2.workspace.getConfiguration("xgenDex").get("profile", "").trim();
    return profile ? { profile } : {};
  }
  async request(method, params = {}) {
    return this.rpc.request(method, params);
  }
  async restart() {
    await this.rpc.restart(this.resolveProcess());
  }
  showOutput() {
    this.output.show(true);
  }
  dispose() {
    void this.rpc.stop();
    this.output.dispose();
  }
  async shutdown() {
    await this.rpc.stop();
  }
  resolveProcess() {
    const configured = vscode2.workspace.getConfiguration("xgenDex").get("cliPath", "dex").trim();
    let cliPath = configured || "dex";
    if (cliPath === "dex" && this.context.extensionMode === vscode2.ExtensionMode.Development) {
      const developmentCli = path.resolve(this.context.extensionPath, "..", "dist", "cli.js");
      if (fs.existsSync(developmentCli)) cliPath = developmentCli;
    }
    if (cliPath.startsWith(".")) {
      const base = vscode2.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionPath;
      cliPath = path.resolve(base, cliPath);
    }
    const extension = path.extname(cliPath).toLowerCase();
    if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
      return {
        command: "node",
        args: [cliPath, "serve", "--stdio"],
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" }
      };
    }
    return {
      command: cliPath,
      args: ["serve", "--stdio"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" }
    };
  }
};

// src/extension.ts
var activeService;
function activate(context) {
  const service = new DexService(context);
  activeService = service;
  const chat = new ChatViewProvider(context, service);
  const status = vscode3.window.createStatusBarItem(vscode3.StatusBarAlignment.Right, 100);
  status.name = "XGEN Dex";
  status.command = "xgenDex.login";
  status.text = "$(loading~spin) Dex";
  status.tooltip = "XGEN Dex CLI \uC5D4\uC9C4\uC5D0 \uC5F0\uACB0\uD558\uB294 \uC911\uC785\uB2C8\uB2E4.";
  status.show();
  const refreshAll = async () => {
    await Promise.all([chat.refreshSession(), updateStatus(service, status)]);
  };
  context.subscriptions.push(
    service,
    chat,
    status,
    vscode3.window.registerWebviewViewProvider("xgenDex.chat", chat, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode3.commands.registerCommand("xgenDex.refresh", () => refreshAll()),
    vscode3.commands.registerCommand("xgenDex.searchAgents", async () => {
      const search = await vscode3.window.showInputBox({
        title: "XGEN Dex Agent \uAC80\uC0C9",
        prompt: "\uC774\uB984 \uB610\uB294 \uC124\uBA85\uC73C\uB85C Agent\uB97C \uAC80\uC0C9\uD569\uB2C8\uB2E4. \uBE44\uC6B0\uBA74 \uC804\uCCB4 \uBAA9\uB85D\uC744 \uD45C\uC2DC\uD569\uB2C8\uB2E4.",
        placeHolder: "\uAC80\uC0C9\uC5B4"
      });
      if (search === void 0) return;
      await chat.showAgents(search);
    }),
    vscode3.commands.registerCommand("xgenDex.showAgents", () => chat.showAgents()),
    vscode3.commands.registerCommand("xgenDex.showSettings", () => chat.showSettings()),
    vscode3.commands.registerCommand("xgenDex.openAgent", async (value) => {
      const agent = resolveAgent(value);
      if (!agent) return;
      await chat.selectAgent(agent);
    }),
    vscode3.commands.registerCommand("xgenDex.newChat", () => chat.newChat()),
    vscode3.commands.registerCommand("xgenDex.cancelChat", () => chat.cancel()),
    vscode3.commands.registerCommand("xgenDex.openHistory", () => chat.openHistory()),
    vscode3.commands.registerCommand("xgenDex.setupProfile", async (value) => {
      if (await setupProfile(service, profileNameOf(value))) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode3.commands.registerCommand("xgenDex.login", async () => {
      if (await login(service)) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode3.commands.registerCommand("xgenDex.switchProfile", async (value) => {
      if (await switchProfile(service, profileNameOf(value))) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode3.commands.registerCommand("xgenDex.logout", async () => {
      if (await logout(service)) {
        await chat.connectionChanged();
        await refreshAll();
      }
    }),
    vscode3.commands.registerCommand("xgenDex.restartEngine", async () => {
      await withProgress("dex-cli \uC5D4\uC9C4\uC744 \uB2E4\uC2DC \uC2DC\uC791\uD558\uB294 \uC911...", () => service.restart());
      await refreshAll();
    }),
    vscode3.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("xgenDex.cliPath")) {
        await service.restart().catch((error) => showError(service, "CLI \uC5D4\uC9C4\uC744 \uB2E4\uC2DC \uC2DC\uC791\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", error));
      }
      if (event.affectsConfiguration("xgenDex.cliPath") || event.affectsConfiguration("xgenDex.profile")) {
        await chat.connectionChanged();
        await refreshAll();
      }
    })
  );
  void refreshAll();
}
async function deactivate() {
  await activeService?.shutdown();
  activeService = void 0;
}
async function updateStatus(service, status) {
  status.text = "$(loading~spin) Dex";
  status.tooltip = "XGEN Dex \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uB294 \uC911\uC785\uB2C8\uB2E4.";
  try {
    const profiles = await service.request("profile/list");
    if (profiles.length === 0) {
      status.text = "$(tools) Dex \uC124\uC815";
      status.tooltip = "XGEN \uC11C\uBC84 \uD504\uB85C\uD544\uC744 \uC124\uC815\uD558\uC138\uC694.";
      status.command = "xgenDex.setupProfile";
      return;
    }
    const auth = await service.request("auth/status", service.profileParams());
    if (auth.authenticated) {
      status.text = `$(hubot) ${auth.user?.username ?? auth.profile}`;
      status.tooltip = `${auth.profile} \xB7 ${auth.serverUrl}`;
      status.command = "xgenDex.showSettings";
    } else if (auth.reason === "network") {
      status.text = "$(cloud-off) Dex \uC624\uD504\uB77C\uC778";
      status.tooltip = `${auth.serverUrl}\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`;
      status.command = "xgenDex.restartEngine";
    } else {
      status.text = "$(key) Dex \uB85C\uADF8\uC778";
      status.tooltip = `${auth.profile} \uD504\uB85C\uD544\uC5D0 \uB85C\uADF8\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.`;
      status.command = "xgenDex.login";
    }
  } catch (error) {
    status.text = "$(error) Dex CLI";
    status.tooltip = errorMessage2(error);
    status.command = "xgenDex.restartEngine";
  }
}
async function setupProfile(service, requestedProfile) {
  const profiles = await service.request("profile/list").catch(() => []);
  const existing = requestedProfile ? profiles.find((profile) => profile.name === requestedProfile) : void 0;
  const name = existing?.name ?? await vscode3.window.showInputBox({
    title: "XGEN Dex \uD68C\uC0AC / \uD658\uACBD \uD504\uB85C\uD544",
    prompt: "\uD68C\uC0AC \uB610\uB294 \uC5F0\uACB0 \uD658\uACBD\uC744 \uAD6C\uBD84\uD560 \uD504\uB85C\uD544 \uC774\uB984\uC744 \uC785\uB825\uD558\uC138\uC694.",
    value: "default",
    validateInput: (value) => /^[A-Za-z0-9._-]{1,64}$/.test(value) ? void 0 : "\uC601\uBB38, \uC22B\uC790, ., _, -\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  });
  if (!name) return false;
  const serverUrl = await vscode3.window.showInputBox({
    title: existing ? `${name} \uC5F0\uACB0 \uC218\uC815` : "XGEN Gateway \uC8FC\uC18C",
    prompt: "\uC5F0\uACB0\uD560 HTTPS Gateway URL\uC744 \uC785\uB825\uD558\uC138\uC694.",
    placeHolder: "https://xgen.example.com",
    value: existing?.serverUrl,
    validateInput: (value) => validateServerUrl(value)
  });
  if (!serverUrl) return false;
  try {
    await withProgress("\uC11C\uBC84 \uD504\uB85C\uD544\uC744 \uC800\uC7A5\uD558\uB294 \uC911...", async () => {
      await service.request("profile/set", { name, serverUrl });
      await service.request("profile/use", { name });
      await vscode3.workspace.getConfiguration("xgenDex").update("profile", name, vscode3.ConfigurationTarget.Global);
    });
    const action = await vscode3.window.showInformationMessage(
      `${name} \uD68C\uC0AC / \uD658\uACBD \uC5F0\uACB0\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.`,
      ...existing ? [] : ["\uB85C\uADF8\uC778"]
    );
    if (action === "\uB85C\uADF8\uC778") await login(service, name);
    return true;
  } catch (error) {
    await showError(service, "\uD504\uB85C\uD544\uC744 \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", error);
    return false;
  }
}
async function login(service, requestedProfile) {
  try {
    let profiles = await service.request("profile/list");
    if (profiles.length === 0) return setupProfile(service);
    const configured = requestedProfile || service.profileParams().profile;
    const current = profiles.find((profile2) => profile2.name === configured) ?? profiles.find((profile2) => profile2.current) ?? profiles[0];
    if (!current) return false;
    if (!requestedProfile && profiles.length > 1) {
      const selected = await vscode3.window.showQuickPick(
        profiles.map((profile2) => ({
          label: profile2.name,
          description: profile2.current ? "\uD604\uC7AC \uD504\uB85C\uD544" : void 0,
          detail: profile2.serverUrl,
          profile: profile2
        })),
        { title: "\uB85C\uADF8\uC778\uD560 XGEN Dex \uD504\uB85C\uD544" }
      );
      if (!selected) return false;
      profiles = [selected.profile];
    } else {
      profiles = [current];
    }
    const profile = profiles[0];
    if (!profile) return false;
    const email = await vscode3.window.showInputBox({
      title: `${profile.name} \uB85C\uADF8\uC778`,
      prompt: profile.serverUrl,
      placeHolder: "me@corp.com",
      ignoreFocusOut: true
    });
    if (!email?.trim()) return false;
    let password = await vscode3.window.showInputBox({
      title: `${profile.name} \uB85C\uADF8\uC778`,
      prompt: "\uBE44\uBC00\uBC88\uD638\uB294 dex-cli \uD504\uB85C\uC138\uC2A4\uB85C\uB9CC \uC804\uB2EC\uB418\uACE0 \uC800\uC7A5\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",
      password: true,
      ignoreFocusOut: true
    });
    if (!password) return false;
    const secret = password;
    password = void 0;
    const auth = await withProgress(
      "XGEN\uC5D0 \uB85C\uADF8\uC778\uD558\uB294 \uC911...",
      () => service.request("auth/login", { profile: profile.name, email: email.trim(), password: secret })
    );
    await vscode3.workspace.getConfiguration("xgenDex").update("profile", profile.name, vscode3.ConfigurationTarget.Global);
    await vscode3.window.showInformationMessage(`${auth.user?.username ?? email} \uACC4\uC815\uC73C\uB85C \uB85C\uADF8\uC778\uD588\uC2B5\uB2C8\uB2E4.`);
    return true;
  } catch (error) {
    await showError(service, "\uB85C\uADF8\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", error);
    return false;
  }
}
async function switchProfile(service, requestedProfile) {
  try {
    const profiles = await service.request("profile/list");
    if (profiles.length === 0) return setupProfile(service);
    const requested = requestedProfile ? profiles.find((profile) => profile.name === requestedProfile) : void 0;
    const selected = requested ? { profile: requested } : await vscode3.window.showQuickPick(
      profiles.map((profile) => ({
        label: profile.name,
        description: profile.current ? "\uD604\uC7AC \uD504\uB85C\uD544" : void 0,
        detail: profile.serverUrl,
        profile
      })),
      { title: "\uC0AC\uC6A9\uD560 \uD68C\uC0AC / \uD658\uACBD \uD504\uB85C\uD544" }
    );
    if (!selected) return false;
    await service.request("profile/use", { name: selected.profile.name });
    await vscode3.workspace.getConfiguration("xgenDex").update("profile", selected.profile.name, vscode3.ConfigurationTarget.Global);
    return true;
  } catch (error) {
    await showError(service, "\uD504\uB85C\uD544\uC744 \uC804\uD658\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", error);
    return false;
  }
}
async function logout(service) {
  const choice = await vscode3.window.showWarningMessage(
    "\uD604\uC7AC XGEN Dex \uD504\uB85C\uD544\uC5D0\uC11C \uB85C\uADF8\uC544\uC6C3\uD560\uAE4C\uC694?",
    { modal: true },
    "\uB85C\uADF8\uC544\uC6C3"
  );
  if (choice !== "\uB85C\uADF8\uC544\uC6C3") return false;
  try {
    await service.request("auth/logout", service.profileParams());
    await vscode3.window.showInformationMessage("XGEN Dex\uC5D0\uC11C \uB85C\uADF8\uC544\uC6C3\uD588\uC2B5\uB2C8\uB2E4.");
    return true;
  } catch (error) {
    await showError(service, "\uB85C\uADF8\uC544\uC6C3\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", error);
    return false;
  }
}
function resolveAgent(value) {
  if (!value || typeof value !== "object") return void 0;
  const record = value;
  const candidate = record.agent && typeof record.agent === "object" ? record.agent : record;
  return typeof candidate.workflowId === "string" && typeof candidate.workflowName === "string" ? candidate : void 0;
}
function profileNameOf(value) {
  if (typeof value === "string") return value.trim() || void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const name = value.name;
  return typeof name === "string" ? name.trim() || void 0 : void 0;
}
function validateServerUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "http \uB610\uB294 https URL\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.";
    return void 0;
  } catch {
    return "\uC62C\uBC14\uB978 URL\uC744 \uC785\uB825\uD558\uC138\uC694.";
  }
}
async function withProgress(title, task) {
  return vscode3.window.withProgress({ location: vscode3.ProgressLocation.Notification, title }, task);
}
async function showError(service, prefix, error) {
  const action = await vscode3.window.showErrorMessage(`${prefix} ${errorMessage2(error)}`, "\uB85C\uADF8 \uBCF4\uAE30");
  if (action === "\uB85C\uADF8 \uBCF4\uAE30") service.showOutput();
}
function errorMessage2(error) {
  if (error instanceof DexRpcError && error.engineCode) return `[${error.engineCode}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
