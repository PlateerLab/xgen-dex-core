import {
  DexError,
  publicError
} from "./chunk-GL6MYQ62.js";

// src/tui/index.tsx
import { render } from "ink";

// src/tui/app.tsx
import { useCallback, useEffect as useEffect6, useState as useState9 } from "react";
import { Box as Box8, Text as Text9, useApp as useApp2, useInput as useInput7 } from "ink";

// src/tui/dashboard.tsx
import { useEffect as useEffect4, useReducer, useRef as useRef2, useState as useState5 } from "react";
import { Box as Box4, Text as Text5, useApp, useInput as useInput4 } from "ink";

// src/tui/chat-state.ts
var initialChatState = { messages: [], running: false };
function lastMessageIndex(messages, predicate) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return index;
  }
  return -1;
}
function appendAssistant(messages, content) {
  const index = lastMessageIndex(messages, (message) => message.role === "assistant");
  if (index < 0) {
    return [...messages, { id: `assistant-${messages.length}`, role: "assistant", text: content }];
  }
  const next = [...messages];
  next[index] = { ...next[index], text: next[index].text + content };
  return next;
}
function upsertActivity(messages, key, text) {
  const index = lastMessageIndex(
    messages,
    (message) => message.role === "activity" && message.activityKey === key
  );
  const startsNewRun = index >= 0 && text.endsWith("\uC2E4\uD589 \uC911") && !messages[index].text.endsWith("\uC2E4\uD589 \uC911");
  if (index < 0 || startsNewRun) {
    return [
      ...messages,
      { id: `activity-${messages.length}`, role: "activity", activityKey: key, text }
    ];
  }
  const next = [...messages];
  next[index] = { ...next[index], text };
  return next;
}
function eventState(state, event) {
  if (event.kind === "text") return { ...state, messages: appendAssistant(state.messages, event.content) };
  if (event.kind === "summary") {
    const assistantIndex = lastMessageIndex(state.messages, (message) => message.role === "assistant");
    const assistant = assistantIndex >= 0 ? state.messages[assistantIndex] : void 0;
    return assistant?.text ? state : { ...state, messages: appendAssistant(state.messages, event.text) };
  }
  if (event.kind === "tool") {
    const tool = event.event.toolName ?? "tool";
    const key = event.event.runId ?? tool;
    const suffix = event.event.error ? `\uC2E4\uD328: ${event.event.error}` : event.event.eventType.includes("result") ? "\uC644\uB8CC" : "\uC2E4\uD589 \uC911";
    return { ...state, messages: upsertActivity(state.messages, key, `${tool} \xB7 ${suffix}`) };
  }
  if (event.kind === "node_status") {
    return { ...state, status: `${event.event.nodeId} \xB7 ${event.event.status}` };
  }
  if (event.kind === "status") {
    return { ...state, status: event.detail ?? event.surface };
  }
  if (event.kind === "quota") {
    return {
      ...state,
      messages: [
        ...state.messages,
        { id: `quota-${state.messages.length}`, role: "system", text: `Quota ${event.level}` }
      ]
    };
  }
  if (event.kind === "error") {
    return {
      ...state,
      running: false,
      status: void 0,
      messages: [
        ...state.messages,
        { id: `error-${state.messages.length}`, role: "system", text: event.detail }
      ]
    };
  }
  if (event.kind === "end") return { ...state, running: false, status: void 0 };
  return state;
}
function chatReducer(state, action) {
  switch (action.type) {
    case "reset":
      return initialChatState;
    case "history_loaded":
      return {
        interactionId: action.interactionId,
        running: false,
        messages: action.turns.flatMap((turn, index) => [
          { id: `history-user-${index}`, role: "user", text: turn.input },
          { id: `history-assistant-${index}`, role: "assistant", text: turn.output }
        ])
      };
    case "turn_started":
      return {
        ...state,
        interactionId: action.interactionId,
        running: true,
        status: "\uC751\uB2F5\uC744 \uAE30\uB2E4\uB9AC\uB294 \uC911",
        messages: [
          ...state.messages,
          { id: `user-${state.messages.length}`, role: "user", text: action.input },
          { id: `assistant-${state.messages.length + 1}`, role: "assistant", text: "" }
        ]
      };
    case "event_received":
      return eventState(state, action.event);
    case "turn_completed":
      return { ...state, running: false, status: void 0 };
    case "turn_cancelled":
      return { ...state, running: false, status: void 0 };
    case "turn_failed":
      return {
        ...state,
        running: false,
        status: void 0,
        messages: [
          ...state.messages,
          { id: `failure-${state.messages.length}`, role: "system", text: action.message }
        ]
      };
  }
}

// src/tui/command-palette.tsx
import { useState as useState2 } from "react";
import { Box as Box2, Text as Text3, useInput as useInput2 } from "ink";

// src/tui/components.tsx
import { Box, Text as Text2 } from "ink";

// src/tui/ime-text-input.tsx
import { useEffect, useRef, useState } from "react";
import { Text, useCursor, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
function graphemes(value) {
  return [...segmenter.segment(value)].map(({ segment }) => segment);
}
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
function visibleInput(segments, cursor, maximumWidth) {
  let start = cursor;
  let widthBeforeCursor = 0;
  const followingWidth = cursor < segments.length ? stringWidth(segments[cursor] ?? "") : 0;
  const beforeLimit = Math.max(0, maximumWidth - Math.min(followingWidth, maximumWidth));
  while (start > 0) {
    const width = stringWidth(segments[start - 1] ?? "");
    if (widthBeforeCursor + width > beforeLimit) break;
    widthBeforeCursor += width;
    start -= 1;
  }
  let end = cursor;
  let totalWidth = widthBeforeCursor;
  while (end < segments.length) {
    const width = stringWidth(segments[end] ?? "");
    if (totalWidth + width > maximumWidth) break;
    totalWidth += width;
    end += 1;
  }
  return {
    text: segments.slice(start, end).join(""),
    cursorWidth: widthBeforeCursor
  };
}
function TerminalCursor({ origin, offset }) {
  const { setCursorPosition } = useCursor();
  setCursorPosition({ x: origin.x + offset, y: origin.y });
  return null;
}
function ImeTextInput(props) {
  const { stdout } = useStdout();
  const initialSegments = graphemes(props.value);
  const [cursor, setCursor] = useState(initialSegments.length);
  const valueRef = useRef(props.value);
  const cursorRef = useRef(initialSegments.length);
  const moveCursor = (next, length) => {
    const resolved = clamp(next, 0, length);
    cursorRef.current = resolved;
    setCursor(resolved);
  };
  const updateValue = (segments, nextCursor) => {
    const nextValue = segments.join("");
    valueRef.current = nextValue;
    moveCursor(nextCursor, segments.length);
    props.onChange(nextValue);
  };
  useEffect(() => {
    if (props.value === valueRef.current) return;
    const previousLength = graphemes(valueRef.current).length;
    const nextLength = graphemes(props.value).length;
    const wasAtEnd = cursorRef.current >= previousLength;
    valueRef.current = props.value;
    moveCursor(wasAtEnd ? nextLength : cursorRef.current, nextLength);
  }, [props.value]);
  useInput(
    (input, key) => {
      const current = graphemes(valueRef.current);
      const currentCursor = clamp(cursorRef.current, 0, current.length);
      if (key.return) {
        props.onSubmit?.(valueRef.current);
        return;
      }
      if (key.leftArrow) {
        moveCursor(currentCursor - 1, current.length);
        return;
      }
      if (key.rightArrow) {
        moveCursor(currentCursor + 1, current.length);
        return;
      }
      if (key.home) {
        moveCursor(0, current.length);
        return;
      }
      if (key.end) {
        moveCursor(current.length, current.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (currentCursor === 0) return;
        current.splice(currentCursor - 1, 1);
        updateValue(current, currentCursor - 1);
        return;
      }
      if (!input || key.ctrl || key.meta || key.tab || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        return;
      }
      const inserted = graphemes(input);
      current.splice(currentCursor, 0, ...inserted);
      updateValue(current, currentCursor + inserted.length);
    },
    { isActive: props.focus }
  );
  const rawSegments = graphemes(props.value);
  const safeCursor = clamp(cursor, 0, rawSegments.length);
  const displayedSegments = props.mask ? rawSegments.map(() => props.mask ?? "") : rawSegments;
  const maximumWidth = Math.max(1, (stdout.columns || 100) - props.cursorOrigin.x - 3);
  const visible = visibleInput(displayedSegments, safeCursor, maximumWidth);
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    rawSegments.length === 0 ? /* @__PURE__ */ jsx(Text, { dimColor: true, children: props.placeholder ?? "" }) : /* @__PURE__ */ jsx(Text, { children: visible.text }),
    props.focus ? /* @__PURE__ */ jsx(TerminalCursor, { origin: props.cursorOrigin, offset: visible.cursorWidth }) : null
  ] });
}

// src/tui/components.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function Header(props) {
  return /* @__PURE__ */ jsxs2(Box, { paddingX: 1, justifyContent: "space-between", children: [
    /* @__PURE__ */ jsx2(Text2, { bold: true, color: "blueBright", children: "XGEN Dex" }),
    props.profile ? /* @__PURE__ */ jsxs2(Text2, { children: [
      props.profile,
      " \xB7 ",
      props.username ?? "\uB85C\uADF8\uC778 \uD544\uC694",
      " \xB7",
      " ",
      /* @__PURE__ */ jsx2(Text2, { color: props.connected ? "green" : "yellow", children: props.connected ? "Connected" : "Offline" })
    ] }) : /* @__PURE__ */ jsx2(Text2, { dimColor: true, children: "\uC124\uC815 \uD544\uC694" })
  ] });
}
function Footer({ text }) {
  return /* @__PURE__ */ jsx2(Box, { paddingX: 1, children: /* @__PURE__ */ jsx2(Text2, { dimColor: true, children: text }) });
}
function Loading({ label = "\uBD88\uB7EC\uC624\uB294 \uC911..." }) {
  return /* @__PURE__ */ jsx2(Box, { padding: 1, children: /* @__PURE__ */ jsxs2(Text2, { color: "cyan", children: [
    "\u25C6 ",
    label
  ] }) });
}
function Notice({ children, error = false }) {
  return /* @__PURE__ */ jsx2(Box, { borderStyle: "round", borderColor: error ? "red" : "cyan", paddingX: 1, children: /* @__PURE__ */ jsx2(Text2, { color: error ? "red" : void 0, children }) });
}
function FormField(props) {
  return /* @__PURE__ */ jsxs2(Box, { children: [
    /* @__PURE__ */ jsx2(Box, { width: 14, children: /* @__PURE__ */ jsxs2(Text2, { color: props.focus ? "cyan" : void 0, children: [
      props.focus ? "\u203A" : " ",
      " ",
      props.label
    ] }) }),
    /* @__PURE__ */ jsx2(
      ImeTextInput,
      {
        value: props.value,
        onChange: props.onChange,
        onSubmit: props.onSubmit,
        focus: props.focus,
        cursorOrigin: props.cursorOrigin,
        placeholder: props.placeholder,
        mask: props.secret ? "\u2022" : void 0
      }
    )
  ] });
}

// src/tui/command-palette.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function CommandPalette(props) {
  const [cursor, setCursor] = useState2(0);
  useInput2((_input, key) => {
    if (key.escape) props.onCancel();
    if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
    if (key.downArrow) setCursor((current) => Math.min(props.actions.length - 1, current + 1));
    if (key.return && props.actions[cursor]) props.actions[cursor].run();
  });
  return /* @__PURE__ */ jsxs3(Box2, { flexDirection: "column", flexGrow: 1, borderStyle: "double", borderColor: "magenta", padding: 1, children: [
    /* @__PURE__ */ jsx3(Text3, { bold: true, children: "\uBA85\uB839" }),
    /* @__PURE__ */ jsx3(Box2, { flexDirection: "column", marginTop: 1, children: props.actions.map((action, index) => /* @__PURE__ */ jsxs3(Text3, { color: index === cursor ? "magentaBright" : void 0, children: [
      index === cursor ? "\u203A" : " ",
      " ",
      action.label
    ] }, action.id)) }),
    /* @__PURE__ */ jsx3(Footer, { text: "\u2191\u2193 \uC774\uB3D9 \xB7 Enter \uC2E4\uD589 \xB7 Esc \uB2EB\uAE30" })
  ] });
}

// src/tui/history-screen.tsx
import { useEffect as useEffect2, useState as useState3 } from "react";
import { Box as Box3, Text as Text4, useInput as useInput3 } from "ink";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function HistoryScreen(props) {
  const [items, setItems] = useState3([]);
  const [cursor, setCursor] = useState3(0);
  const [loading, setLoading] = useState3(true);
  const [error, setError] = useState3();
  useEffect2(() => {
    let alive = true;
    props.engine.listConversations(props.profile).then((result) => alive && setItems(result)).catch((reason) => alive && setError(publicError(reason).message)).finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [props.engine, props.profile]);
  useInput3(
    (_input, key) => {
      if (key.escape) props.onCancel();
      if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
      if (key.downArrow && items.length > 0) {
        setCursor((current) => Math.min(items.length - 1, current + 1));
      }
      if (key.return && items[cursor]) {
        const conversation = items[cursor];
        setLoading(true);
        setError(void 0);
        props.engine.historyTurns(
          conversation.workflowId,
          conversation.interactionId,
          conversation.workflowName,
          props.profile
        ).then((turns) => props.onOpen(conversation, turns)).catch((reason) => setError(publicError(reason).message)).finally(() => setLoading(false));
      }
    },
    { isActive: !loading }
  );
  return /* @__PURE__ */ jsxs4(Box3, { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: "cyan", padding: 1, children: [
    /* @__PURE__ */ jsx4(Text4, { bold: true, children: "\uB300\uD654 \uAE30\uB85D" }),
    loading ? /* @__PURE__ */ jsx4(Loading, {}) : null,
    !loading && items.length === 0 ? /* @__PURE__ */ jsx4(Text4, { dimColor: true, children: "\uB300\uD654 \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." }) : null,
    !loading ? items.slice(Math.max(0, cursor - 8), cursor + 9).map((item) => {
      const index = items.indexOf(item);
      return /* @__PURE__ */ jsxs4(Text4, { color: index === cursor ? "cyan" : void 0, children: [
        index === cursor ? "\u203A" : " ",
        " ",
        item.workflowName,
        " \xB7",
        " ",
        /* @__PURE__ */ jsx4(Text4, { dimColor: true, children: item.updatedAt || item.createdAt })
      ] }, item.interactionId);
    }) : null,
    error ? /* @__PURE__ */ jsx4(Notice, { error: true, children: error }) : null,
    /* @__PURE__ */ jsx4(Footer, { text: "\u2191\u2193 \uC774\uB3D9 \xB7 Enter \uC5F4\uAE30 \xB7 Esc \uB3CC\uC544\uAC00\uAE30" })
  ] });
}

// src/tui/use-terminal-size.ts
import { useEffect as useEffect3, useState as useState4 } from "react";
import { useStdout as useStdout2 } from "ink";
function useTerminalSize() {
  const { stdout } = useStdout2();
  const read = () => {
    const columns = stdout.columns || 100;
    const rows = stdout.rows || 30;
    return { columns, rows, wide: columns >= 88 };
  };
  const [size, setSize] = useState4(read);
  useEffect3(() => {
    const resize = () => setSize(read());
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout]);
  return size;
}

// src/tui/dashboard.tsx
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function AgentSidebar(props) {
  const radius = Math.max(3, Math.floor((props.height - 4) / 2));
  const start = Math.max(0, props.cursor - radius);
  const visible = props.agents.slice(start, start + radius * 2 + 1);
  return /* @__PURE__ */ jsxs5(Box4, { flexDirection: "column", width: 30, borderStyle: "round", borderColor: props.focused ? "cyan" : "gray", paddingX: 1, children: [
    /* @__PURE__ */ jsx5(Text5, { bold: true, children: "Agents" }),
    visible.map((agent) => {
      const index = props.agents.indexOf(agent);
      const cursor = index === props.cursor;
      const selected = agent.workflowId === props.selected;
      return /* @__PURE__ */ jsxs5(Text5, { color: cursor && props.focused ? "cyan" : void 0, wrap: "truncate-end", children: [
        cursor ? "\u203A" : " ",
        " ",
        selected ? "\u25CF" : "\u25CB",
        " ",
        agent.workflowName
      ] }, agent.workflowId);
    }),
    props.agents.length === 0 ? /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: "\uC0AC\uC6A9 \uAC00\uB2A5\uD55C Agent\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." }) : null
  ] });
}
function messageColor(role) {
  if (role === "user") return "cyan";
  if (role === "assistant") return "green";
  if (role === "activity") return "yellow";
  if (role === "system") return "red";
  return void 0;
}
function labelOf(role, agentName) {
  if (role === "user") return "You";
  if (role === "assistant") return agentName;
  if (role === "activity") return "Tool";
  return "System";
}
function ChatPane(props) {
  const visibleCount = Math.max(4, Math.floor((props.height - 5) / 2));
  const visible = props.messages.slice(-visibleCount);
  return /* @__PURE__ */ jsxs5(Box4, { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: "blue", paddingX: 1, children: [
    /* @__PURE__ */ jsx5(Text5, { bold: true, children: props.agent?.workflowName ?? "Agent\uB97C \uC120\uD0DD\uD558\uC138\uC694" }),
    /* @__PURE__ */ jsxs5(Box4, { flexDirection: "column", flexGrow: 1, children: [
      visible.length === 0 ? /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: props.agent ? "\uBA54\uC2DC\uC9C0\uB97C \uC785\uB825\uD574 \uB300\uD654\uB97C \uC2DC\uC791\uD558\uC138\uC694." : "\uC67C\uCABD\uC5D0\uC11C Agent\uB97C \uC120\uD0DD\uD558\uC138\uC694." }) : null,
      visible.map((message) => /* @__PURE__ */ jsxs5(Box4, { flexDirection: "column", marginTop: message.role === "activity" ? 0 : 1, children: [
        /* @__PURE__ */ jsx5(Text5, { bold: true, color: messageColor(message.role), children: labelOf(message.role, props.agent?.workflowName ?? "Agent") }),
        /* @__PURE__ */ jsx5(Text5, { dimColor: message.role === "activity", children: message.text || (message.role === "assistant" ? "\u2026" : "") })
      ] }, message.id))
    ] }),
    props.status ? /* @__PURE__ */ jsxs5(Text5, { color: "yellow", children: [
      "\u25C6 ",
      props.status
    ] }) : null
  ] });
}
function Composer(props) {
  return /* @__PURE__ */ jsxs5(Box4, { borderStyle: "round", borderColor: props.focused ? "cyan" : "gray", paddingX: 1, children: [
    /* @__PURE__ */ jsx5(Text5, { color: "cyan", children: "\u203A " }),
    props.disabled ? /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: "\uC751\uB2F5\uC744 \uAE30\uB2E4\uB9AC\uB294 \uC911..." }) : /* @__PURE__ */ jsx5(
      ImeTextInput,
      {
        value: props.value,
        onChange: props.onChange,
        onSubmit: props.onSubmit,
        focus: props.focused,
        cursorOrigin: props.cursorOrigin,
        placeholder: "\uBA54\uC2DC\uC9C0\uB97C \uC785\uB825\uD558\uC138\uC694"
      }
    )
  ] });
}
function Dashboard(props) {
  const { exit } = useApp();
  const size = useTerminalSize();
  const bodyHeight = Math.max(12, size.rows - 5);
  const [focus, setFocus] = useState5("agents");
  const [cursor, setCursor] = useState5(0);
  const [selected, setSelected] = useState5(() => {
    const first = props.session.agents[0];
    return first ? { workflowId: first.workflowId, workflowName: first.workflowName } : void 0;
  });
  const [input, setInput] = useState5("");
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const [palette, setPalette] = useState5(false);
  const [history, setHistory] = useState5(false);
  const controller = useRef2(null);
  useEffect4(() => () => controller.current?.abort(), []);
  const selectAgent = () => {
    const agent = props.session.agents[cursor];
    if (!agent || chat.running) return;
    setSelected({ workflowId: agent.workflowId, workflowName: agent.workflowName });
    dispatch({ type: "reset" });
    setFocus("composer");
  };
  const openHistory = (conversation, turns) => {
    setSelected({ workflowId: conversation.workflowId, workflowName: conversation.workflowName });
    dispatch({ type: "history_loaded", interactionId: conversation.interactionId, turns });
    const index = props.session.agents.findIndex((agent) => agent.workflowId === conversation.workflowId);
    if (index >= 0) setCursor(index);
    setHistory(false);
    setFocus("composer");
  };
  const cancelTurn = () => {
    controller.current?.abort();
    dispatch({ type: "turn_cancelled" });
  };
  const newConversation = () => {
    if (chat.running) return;
    dispatch({ type: "reset" });
    setInput("");
    setPalette(false);
    setFocus("composer");
  };
  const send = async (value) => {
    const text = value.trim();
    if (!text || !selected || chat.running) return;
    try {
      const resolved = await props.engine.resolveChatInput({
        profile: props.session.profile,
        workflowId: selected.workflowId,
        workflowName: selected.workflowName,
        interactionId: chat.interactionId,
        input: text
      });
      setInput("");
      dispatch({ type: "turn_started", interactionId: resolved.interactionId, input: text });
      const active = new AbortController();
      controller.current = active;
      for await (const event of props.engine.chat(resolved, active.signal)) {
        dispatch({ type: "event_received", event });
      }
      if (active.signal.aborted) dispatch({ type: "turn_cancelled" });
      else dispatch({ type: "turn_completed" });
    } catch (error) {
      if (controller.current?.signal.aborted) dispatch({ type: "turn_cancelled" });
      else dispatch({ type: "turn_failed", message: publicError(error).message });
    } finally {
      controller.current = null;
    }
  };
  useInput4(
    (keyInput, key) => {
      if (key.ctrl && keyInput === "k") setPalette(true);
      else if (key.ctrl && keyInput === "p") {
        controller.current?.abort();
        props.onProfiles();
      } else if (key.ctrl && keyInput === "h") {
        if (chat.running) cancelTurn();
        setHistory(true);
      } else if (key.ctrl && keyInput === "n") newConversation();
      else if (key.escape && chat.running) cancelTurn();
      else if (key.escape) setFocus("agents");
      else if (key.tab) setFocus((current) => current === "agents" ? "composer" : "agents");
      else if (focus === "agents" && key.upArrow) setCursor((current) => Math.max(0, current - 1));
      else if (focus === "agents" && key.downArrow && props.session.agents.length > 0) {
        setCursor((current) => Math.min(props.session.agents.length - 1, current + 1));
      } else if (focus === "agents" && key.return) selectAgent();
    },
    { isActive: !palette && !history }
  );
  const paletteActions = [
    { id: "new", label: "\uC0C8 \uB300\uD654", run: newConversation },
    {
      id: "history",
      label: "\uB300\uD654 \uAE30\uB85D",
      run: () => {
        if (chat.running) cancelTurn();
        setPalette(false);
        setHistory(true);
      }
    },
    {
      id: "profile",
      label: "\uD504\uB85C\uD544 \uC804\uD658",
      run: () => {
        controller.current?.abort();
        setPalette(false);
        props.onProfiles();
      }
    },
    {
      id: "logout",
      label: "\uB85C\uADF8\uC544\uC6C3",
      run: () => {
        controller.current?.abort();
        props.onLogout();
      }
    },
    { id: "quit", label: "\uC885\uB8CC", run: exit }
  ];
  let body;
  if (palette) {
    body = /* @__PURE__ */ jsx5(CommandPalette, { actions: paletteActions, onCancel: () => setPalette(false) });
  } else if (history) {
    body = /* @__PURE__ */ jsx5(
      HistoryScreen,
      {
        engine: props.engine,
        profile: props.session.profile,
        onOpen: openHistory,
        onCancel: () => setHistory(false)
      }
    );
  } else {
    const sidebar = /* @__PURE__ */ jsx5(
      AgentSidebar,
      {
        agents: props.session.agents,
        cursor,
        selected: selected?.workflowId,
        focused: focus === "agents",
        height: bodyHeight
      }
    );
    const conversation = /* @__PURE__ */ jsxs5(Box4, { flexDirection: "column", flexGrow: 1, children: [
      /* @__PURE__ */ jsx5(ChatPane, { agent: selected, messages: chat.messages, status: chat.status, height: bodyHeight - 3 }),
      /* @__PURE__ */ jsx5(
        Composer,
        {
          value: input,
          onChange: setInput,
          onSubmit: (value) => void send(value),
          focused: focus === "composer",
          disabled: chat.running || !selected,
          cursorOrigin: { x: size.wide ? 34 : 4, y: bodyHeight - 1 }
        }
      )
    ] });
    body = size.wide ? /* @__PURE__ */ jsxs5(Box4, { height: bodyHeight, children: [
      sidebar,
      conversation
    ] }) : focus === "agents" ? /* @__PURE__ */ jsx5(Box4, { height: bodyHeight, children: sidebar }) : /* @__PURE__ */ jsx5(Box4, { height: bodyHeight, children: conversation });
  }
  return /* @__PURE__ */ jsxs5(Box4, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx5(
      Header,
      {
        profile: props.session.profile,
        username: props.session.username,
        connected: true
      }
    ),
    body,
    /* @__PURE__ */ jsx5(Footer, { text: "Tab \uD328\uB110 \xB7 Ctrl+K \uBA85\uB839 \xB7 Ctrl+H \uAE30\uB85D \xB7 Ctrl+P \uD504\uB85C\uD544 \xB7 Esc \uCDE8\uC18C \xB7 Ctrl+Q \uC885\uB8CC" })
  ] });
}

// src/tui/login-screen.tsx
import { useState as useState6 } from "react";
import { Box as Box5, Text as Text6, useInput as useInput5 } from "ink";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function LoginScreen(props) {
  const [email, setEmail] = useState6("");
  const [password, setPassword] = useState6("");
  const [focus, setFocus] = useState6("email");
  useInput5(
    (input, key) => {
      if (key.tab) setFocus((current) => current === "email" ? "password" : "email");
      if (key.ctrl && input === "p") props.onProfiles();
    },
    { isActive: !props.busy }
  );
  const submit = () => {
    if (focus === "email") {
      setFocus("password");
      return;
    }
    if (email.trim() && password) {
      const secret = password;
      setPassword("");
      props.onSubmit(email.trim(), secret);
    }
  };
  return /* @__PURE__ */ jsxs6(Box5, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx6(Header, { profile: props.profile, connected: false }),
    /* @__PURE__ */ jsxs6(Box5, { flexDirection: "column", borderStyle: "round", borderColor: "blue", padding: 1, children: [
      /* @__PURE__ */ jsx6(Text6, { bold: true, children: "\uB85C\uADF8\uC778" }),
      /* @__PURE__ */ jsx6(Text6, { dimColor: true, children: props.serverUrl }),
      /* @__PURE__ */ jsxs6(Box5, { flexDirection: "column", marginTop: 1, children: [
        /* @__PURE__ */ jsx6(
          FormField,
          {
            label: "Email",
            value: email,
            onChange: setEmail,
            onSubmit: () => setFocus("password"),
            focus: !props.busy && focus === "email",
            cursorOrigin: { x: 16, y: 6 },
            placeholder: "me@corp.com"
          }
        ),
        /* @__PURE__ */ jsx6(
          FormField,
          {
            label: "Password",
            value: password,
            onChange: setPassword,
            onSubmit: submit,
            focus: !props.busy && focus === "password",
            cursorOrigin: { x: 16, y: 7 },
            secret: true
          }
        )
      ] }),
      props.busy ? /* @__PURE__ */ jsx6(Loading, { label: "\uB85C\uADF8\uC778\uD558\uB294 \uC911..." }) : null,
      props.error ? /* @__PURE__ */ jsx6(Notice, { error: true, children: props.error }) : null
    ] }),
    /* @__PURE__ */ jsx6(Footer, { text: "Tab \uC774\uB3D9 \xB7 Enter \uB85C\uADF8\uC778 \xB7 Ctrl+P \uD504\uB85C\uD544 \xB7 Ctrl+Q \uC885\uB8CC" })
  ] });
}

// src/tui/profile-screen.tsx
import { useEffect as useEffect5, useState as useState7 } from "react";
import { Box as Box6, Text as Text7, useInput as useInput6 } from "ink";
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
function ProfileScreen(props) {
  const [cursor, setCursor] = useState7(Math.max(0, props.profiles.findIndex((profile) => profile.current)));
  const [creating, setCreating] = useState7(false);
  const [focus, setFocus] = useState7("name");
  const [name, setName] = useState7("");
  const [serverUrl, setServerUrl] = useState7("");
  useEffect5(() => setCursor((current) => Math.min(current, Math.max(0, props.profiles.length - 1))), [props.profiles]);
  useInput6(
    (input, key) => {
      if (key.escape) {
        if (creating) setCreating(false);
        else props.onCancel();
        return;
      }
      if (creating) {
        if (key.tab) setFocus((current) => current === "name" ? "url" : "name");
        return;
      }
      if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
      if (key.downArrow && props.profiles.length > 0) {
        setCursor((current) => Math.min(props.profiles.length - 1, current + 1));
      }
      if (key.return && props.profiles[cursor]) props.onSelect(props.profiles[cursor].name);
      if (input === "n") {
        setCreating(true);
        setFocus("name");
      }
    },
    { isActive: !props.busy }
  );
  const create = () => {
    if (focus === "name") {
      setFocus("url");
      return;
    }
    if (name.trim() && serverUrl.trim()) props.onCreate(name.trim(), serverUrl.trim());
  };
  return /* @__PURE__ */ jsxs7(Box6, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx7(Header, {}),
    /* @__PURE__ */ jsxs7(Box6, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", padding: 1, children: [
      /* @__PURE__ */ jsx7(Text7, { bold: true, children: creating ? "\uC0C8 \uD504\uB85C\uD544" : "\uD504\uB85C\uD544 \uC804\uD658" }),
      creating ? /* @__PURE__ */ jsxs7(Box6, { flexDirection: "column", marginTop: 1, children: [
        /* @__PURE__ */ jsx7(
          FormField,
          {
            label: "Name",
            value: name,
            onChange: setName,
            onSubmit: () => setFocus("url"),
            focus: !props.busy && focus === "name",
            cursorOrigin: { x: 16, y: 5 },
            placeholder: "corp"
          }
        ),
        /* @__PURE__ */ jsx7(
          FormField,
          {
            label: "Server URL",
            value: serverUrl,
            onChange: setServerUrl,
            onSubmit: create,
            focus: !props.busy && focus === "url",
            cursorOrigin: { x: 16, y: 6 },
            placeholder: "https://xgen.example.com"
          }
        )
      ] }) : /* @__PURE__ */ jsxs7(Box6, { flexDirection: "column", marginTop: 1, children: [
        props.profiles.map((profile, index) => /* @__PURE__ */ jsxs7(Text7, { color: index === cursor ? "cyan" : void 0, children: [
          index === cursor ? "\u203A" : " ",
          " ",
          profile.current ? "\u25CF" : "\u25CB",
          " ",
          profile.name,
          " \xB7",
          " ",
          /* @__PURE__ */ jsx7(Text7, { dimColor: true, children: profile.serverUrl })
        ] }, profile.name)),
        props.profiles.length === 0 ? /* @__PURE__ */ jsx7(Text7, { dimColor: true, children: "\uC800\uC7A5\uB41C \uD504\uB85C\uD544\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." }) : null
      ] }),
      props.busy ? /* @__PURE__ */ jsx7(Loading, { label: "\uD504\uB85C\uD544\uC744 \uC804\uD658\uD558\uB294 \uC911..." }) : null,
      props.error ? /* @__PURE__ */ jsx7(Notice, { error: true, children: props.error }) : null
    ] }),
    /* @__PURE__ */ jsx7(
      Footer,
      {
        text: creating ? "Tab \uC774\uB3D9 \xB7 Enter \uC800\uC7A5 \xB7 Esc \uB4A4\uB85C" : "\u2191\u2193 \uC774\uB3D9 \xB7 Enter \uC120\uD0DD \xB7 N \uC0C8 \uD504\uB85C\uD544 \xB7 Esc \uB2EB\uAE30"
      }
    )
  ] });
}

// src/tui/setup-screen.tsx
import { useState as useState8 } from "react";
import { Box as Box7, Text as Text8 } from "ink";
import { jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
function SetupScreen(props) {
  const [serverUrl, setServerUrl] = useState8("");
  return /* @__PURE__ */ jsxs8(Box7, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx8(Header, {}),
    /* @__PURE__ */ jsxs8(Box7, { flexDirection: "column", borderStyle: "round", borderColor: "blue", padding: 1, children: [
      /* @__PURE__ */ jsx8(Text8, { bold: true, children: "\uCC98\uC74C \uC624\uC168\uAD70\uC694" }),
      /* @__PURE__ */ jsx8(Text8, { dimColor: true, children: "\uC5F0\uACB0\uD560 XGEN Gateway \uC8FC\uC18C\uB97C \uC785\uB825\uD558\uC138\uC694." }),
      /* @__PURE__ */ jsx8(Box7, { marginTop: 1, children: /* @__PURE__ */ jsx8(
        FormField,
        {
          label: "Server URL",
          value: serverUrl,
          onChange: setServerUrl,
          onSubmit: (value) => value.trim() && props.onSubmit(value.trim()),
          focus: !props.busy,
          cursorOrigin: { x: 16, y: 6 },
          placeholder: "https://xgen.example.com"
        }
      ) }),
      props.busy ? /* @__PURE__ */ jsx8(Loading, { label: "\uC11C\uBC84 \uD504\uB85C\uD544\uC744 \uC800\uC7A5\uD558\uB294 \uC911..." }) : null,
      props.error ? /* @__PURE__ */ jsx8(Notice, { error: true, children: props.error }) : null
    ] }),
    /* @__PURE__ */ jsx8(Footer, { text: "Enter \uACC4\uC18D \xB7 Ctrl+Q \uC885\uB8CC" })
  ] });
}

// src/tui/app.tsx
import { jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
function App({ engine }) {
  const { exit } = useApp2();
  const [route, setRoute] = useState9("boot");
  const [session, setSession] = useState9();
  const [profiles, setProfiles] = useState9([]);
  const [loginTarget, setLoginTarget] = useState9();
  const [busy, setBusy] = useState9(false);
  const [error, setError] = useState9();
  useInput7((input, key) => {
    if (key.ctrl && input === "q") exit();
  });
  const bootstrap = useCallback(
    async (preferredProfile) => {
      setRoute("boot");
      setBusy(true);
      setError(void 0);
      try {
        let available = await engine.listProfiles();
        setProfiles(available);
        if (available.length === 0) {
          setSession(void 0);
          setRoute("setup");
          return;
        }
        if (preferredProfile) {
          await engine.useProfile(preferredProfile);
          available = await engine.listProfiles();
          setProfiles(available);
        }
        const current = available.find((profile) => profile.current) ?? available.find((profile) => profile.name === preferredProfile) ?? available[0];
        if (!current) throw new DexError("config_invalid", "\uC0AC\uC6A9\uD560 \uD504\uB85C\uD544\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
        const status = await engine.authStatus(current.name);
        if (!status.authenticated) {
          if (status.reason === "network") {
            throw new DexError("network_error", `XGEN \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${current.serverUrl}`);
          }
          setSession(void 0);
          setLoginTarget({ profile: current.name, serverUrl: current.serverUrl });
          setRoute("login");
          return;
        }
        const agents = await engine.listAgents({ pageSize: 100, includeHarness: true }, current.name);
        setSession({
          profile: current.name,
          serverUrl: current.serverUrl,
          username: status.user?.username ?? "unknown",
          agents: agents.items
        });
        setRoute("dashboard");
      } catch (reason) {
        setError(publicError(reason).message);
        setRoute("fatal");
      } finally {
        setBusy(false);
      }
    },
    [engine]
  );
  useEffect6(() => {
    void bootstrap();
  }, [bootstrap]);
  const configure = async (serverUrl) => {
    setBusy(true);
    setError(void 0);
    try {
      const profile = await engine.setProfile("default", serverUrl);
      await engine.useProfile(profile.name);
      setLoginTarget({ profile: profile.name, serverUrl: profile.serverUrl });
      setProfiles(await engine.listProfiles());
      setRoute("login");
    } catch (reason) {
      setError(publicError(reason).message);
    } finally {
      setBusy(false);
    }
  };
  const login = async (email, password) => {
    if (!loginTarget) return;
    setBusy(true);
    setError(void 0);
    try {
      await engine.login(email, password, loginTarget.profile);
      await bootstrap(loginTarget.profile);
    } catch (reason) {
      setError(publicError(reason).message);
      setRoute("login");
    } finally {
      setBusy(false);
    }
  };
  const openProfiles = async () => {
    setBusy(true);
    setError(void 0);
    try {
      setProfiles(await engine.listProfiles());
      setRoute("profiles");
    } catch (reason) {
      setError(publicError(reason).message);
    } finally {
      setBusy(false);
    }
  };
  const createProfile = async (name, serverUrl) => {
    setBusy(true);
    setError(void 0);
    try {
      await engine.setProfile(name, serverUrl);
      await bootstrap(name);
    } catch (reason) {
      setError(publicError(reason).message);
      setRoute("profiles");
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await engine.logout(session.profile);
      setLoginTarget({ profile: session.profile, serverUrl: session.serverUrl });
      setSession(void 0);
      setRoute("login");
    } catch (reason) {
      setError(publicError(reason).message);
      setRoute("fatal");
    } finally {
      setBusy(false);
    }
  };
  if (route === "boot") {
    return /* @__PURE__ */ jsxs9(Box8, { flexDirection: "column", children: [
      /* @__PURE__ */ jsx9(Header, {}),
      /* @__PURE__ */ jsx9(Loading, { label: "Dex\uB97C \uC900\uBE44\uD558\uB294 \uC911..." }),
      /* @__PURE__ */ jsx9(Footer, { text: "Ctrl+Q \uC885\uB8CC" })
    ] });
  }
  if (route === "setup") {
    return /* @__PURE__ */ jsx9(SetupScreen, { busy, error, onSubmit: (url) => void configure(url) });
  }
  if (route === "login" && loginTarget) {
    return /* @__PURE__ */ jsx9(
      LoginScreen,
      {
        profile: loginTarget.profile,
        serverUrl: loginTarget.serverUrl,
        busy,
        error,
        onSubmit: (email, password) => void login(email, password),
        onProfiles: () => void openProfiles()
      }
    );
  }
  if (route === "profiles") {
    return /* @__PURE__ */ jsx9(
      ProfileScreen,
      {
        profiles,
        busy,
        error,
        onSelect: (name) => void bootstrap(name),
        onCreate: (name, url) => void createProfile(name, url),
        onCancel: () => setRoute(session ? "dashboard" : loginTarget ? "login" : "setup")
      }
    );
  }
  if (route === "dashboard" && session) {
    return /* @__PURE__ */ jsx9(
      Dashboard,
      {
        engine,
        session,
        onProfiles: () => void openProfiles(),
        onLogout: () => void logout()
      }
    );
  }
  return /* @__PURE__ */ jsxs9(Box8, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx9(Header, {}),
    /* @__PURE__ */ jsx9(Notice, { error: true, children: error ?? "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." }),
    /* @__PURE__ */ jsx9(Text9, { dimColor: true, children: "\uC11C\uBC84\uC640 \uD0A4\uCCB4\uC778 \uC0C1\uD0DC\uB97C \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694." }),
    /* @__PURE__ */ jsx9(Footer, { text: "R \uB2E4\uC2DC \uC2DC\uB3C4 \xB7 Ctrl+Q \uC885\uB8CC" }),
    /* @__PURE__ */ jsx9(RetryInput, { onRetry: () => void bootstrap() })
  ] });
}
function RetryInput({ onRetry }) {
  useInput7((input) => {
    if (input.toLowerCase() === "r") onRetry();
  });
  return null;
}

// src/tui/index.tsx
import { jsx as jsx10 } from "react/jsx-runtime";
async function runTui(engine) {
  const instance = render(/* @__PURE__ */ jsx10(App, { engine }), {
    exitOnCtrlC: true,
    patchConsole: true
  });
  await instance.waitUntilExit();
}
export {
  runTui
};
//# sourceMappingURL=tui-4SAMYYOS.js.map
