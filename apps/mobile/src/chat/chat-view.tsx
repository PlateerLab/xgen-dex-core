/**
 * 현재 채팅 — 폰에서 쓰는 XGEN 대화 화면.
 *
 * 무엇이 달라졌나 (이전 세대와 비교)
 * ----------------------------------
 * · 도구 과정: "도구 실행: X" 줄을 대화에 쌓지 않는다. 답변 위 칩 하나가
 *   지나가고, 전체는 [전체 로그 보기] 에서 인자·결과까지 본다(데스크톱과 동일).
 * · 실패: 전송 계층 원문 대신 **무슨 일인지 · 이제 뭘 하면 되는지 · 문의 코드**.
 *   원문은 [자세히] 로 접어 둔다.
 * · 스크롤: 새 글이 올 때마다 바닥으로 끌어내리지 않는다. 위를 읽는 중이면
 *   그 자리에 두고 [새 메시지] 단추를 띄운다 — 스트리밍 중에 옛 답을 읽을 수 있다.
 * · 대화 이동: 머리의 제목을 누르면 대화 목록으로, [새 대화] 는 시작 화면으로 간다(2026-10-09 대화 목록).
 *   시작 화면에서 적은 첫 메시지는 소켓이 처음 붙을 때 한 번만 보낸다(initial-message).
 * · 에이전트가 사라진 대화: 지난 기록만 보여 주고 입력창을 두지 않는다.
 * · 첨부: 파일뿐 아니라 사진·카메라. 폰에서 가장 많이 붙이는 것이 사진이다.
 *
 * 전송·재연결·다른 기기 턴의 규칙은 예전 그대로다(chat-ws). 화면만 바뀐다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { attachmentName, base64Bytes, imageMime } from '../lib/attachment-file';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import type { Agent, HistoryFlowItem, ToolEvent } from '@dex/protocol';
import {
  CHAT_SHARE_TEXT,
  UNTITLED_CONVERSATION,
  chatAnswerFiles,
  describeError,
  describeStreamError,
  requestBefore,
  turnEventToChatEvent,
} from '@dex/protocol';
import { Ionicons } from '@expo/vector-icons';
import { FilePreviewScreen, type PreviewFile } from '../files/file-preview';
import {
  createChat,
  stripAgentMarkers,
  type ChatWsHandle,
  type ChatWsState,
  type MobileChatAttachment,
} from '../lib/chat-ws';
import { cachedDeviceId } from '../lib/device';
import { diagLog } from '../lib/diag';
import { friendlyError } from '../lib/errors';
import { wsBaseOf, type XgenMobileClient } from '../lib/xgen';
import { TAP, useP } from '../theme';
import { notifyAnswer } from './answer-notice';
import { initialMessageGate, type InitialMessage } from './initial-message';
import { CONVERSATION_TEXT } from '../conversations/conversation-model';
import { MessageItem } from './message-item';
import { ToolLogSheet } from './tool-log-sheet';
import { AgentDetail } from '../agents/agent-detail';
import { FolderPill, FolderSheet } from './folder-sheet';
import { ChatShareSheet } from './chat-share-sheet';
import { ModelChip, ModelSheet, ThinkingChip, ThinkingSheet, useConversationModel } from './model-picker';
import { folderStore, useChatFolderRemote, useChatFolders } from '../lib/folder-store';
import { toWire } from '../lib/mobile-folders';
import {
  appendAssistantText,
  assistantPlaceholder,
  attachDownload,
  attachProcessById,
  attachTool,
  completeRemoteTurn,
  dropRemotePartials,
  ensureRemotePartial,
  finishStreaming,
  hasRemoteTurn,
  historyMessages,
  markExecutionIo,
  mergeHistory,
  mergeMissedTurns,
  setError,
  setRemoteLive,
  startRemoteTurn,
  userMessage,
  type ChatMessage,
} from './message-model';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** 파일 크기 — 고른 쪽이 알려 주지 않을 때. 알 수 없으면 undefined(서버가 상한을 다시 본다). */
async function fileSize(uri: string): Promise<number | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === 'number' ? info.size : undefined;
  } catch {
    return undefined;
  }
}

interface PickedFile {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

/** 바닥에서 이 정도 안쪽이면 "따라가는 중" 으로 본다. */
const STICK_PX = 120;


/** 작업 과정의 단계 글 정리 — 상태 표식·생각 블록, 그리고 단추로 그리는 파일 표식을 걷는다. */
function cleanStep(text: string): string {
  return chatAnswerFiles(stripAgentMarkers(text)).text;
}

export function ChatView({
  client,
  agent,
  interactionId,
  title,
  readOnly = false,
  initialMessage,
  onInitialMessageSent,
  onWsState,
  onNewChat,
  onOpenList,
}: {
  client: XgenMobileClient;
  agent: Agent | null;
  interactionId: string;
  /** 머리에 보일 대화 제목(목록에서 열었을 때). 없으면 첫 메시지, 그것도 없으면 "새 대화". */
  title?: string;
  /** 에이전트가 사라진 대화: 지난 기록만 보여 주고 입력창을 두지 않는다(소켓도 붙지 않는다). */
  readOnly?: boolean;
  /** 시작 화면에서 적은 첫 메시지. 이 대화의 소켓이 처음 붙을 때 한 번만 보낸다. */
  initialMessage?: InitialMessage | null;
  /** 첫 메시지를 꺼냈다(보냈거나, 보낼 수 없어 입력창에 옮겼다). */
  onInitialMessageSent?: (id: string) => void;
  onWsState: (s: ChatWsState) => void;
  /** 시작 화면으로 간다. 에이전트를 주면 그 에이전트를 골라 둔다. */
  onNewChat: (agent?: Agent) => void;
  /** 대화 목록으로 간다. */
  onOpenList: () => void;
}): React.ReactElement {
  const p = useP();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** 대화의 마지막 답 — 시작 시각을 모르는 되살린 답은 이것만 본문 경로로 파일을 찾는다. */
  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return i;
    return -1;
  }, [messages]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<MobileChatAttachment[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [logFor, setLogFor] = useState<{ events: ToolEvent[]; initialOpen?: number } | null>(null);
  /** 폰 안에서 여는 파일 한 장(첨부·답이 만든 파일·답에 딸린 결과물). */
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const openFile = useCallback((file: PreviewFile) => setPreviewFile(file), []);
  /** 에이전트 상세 — 데스크톱·웹 채팅 머리의 [상세] 와 같은 자리. */
  const [detailOpen, setDetailOpen] = useState(false);
  // 이 대화에 연결된 휴대폰 폴더 — 에이전트의 파일 도구가 닿는 범위.
  const folders = useChatFolders(interactionId);
  const folderRemote = useChatFolderRemote(interactionId);
  // 이 대화의 모델 — 입력창 위 칩과 아래에서 올라오는 목록(다음 답변부터, 세션 재시작 없음).
  // 에이전트가 사라진 대화는 모델을 묻지 않는다(바꿀 수도 없다).
  const model = useConversationModel(client, readOnly ? '' : (agent?.workflowId ?? ''), interactionId);
  const [modelSheet, setModelSheet] = useState(false);
  const [thinkingSheet, setThinkingSheet] = useState(false);
  const [folderSheet, setFolderSheet] = useState(false);
  /** [공유] 시트: 지금까지의 대화를 링크로. */
  const [shareSheet, setShareSheet] = useState(false);
  const [wsState, setWsState] = useState<ChatWsState>('closed');
  const [running, setRunningState] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

  const uploadBusy = useRef(false);
  const attachmentContext = `${agent?.workflowId ?? ''}:${interactionId}`;
  const attachmentContextRef = useRef(attachmentContext);
  attachmentContextRef.current = attachmentContext;

  /** `running` 의 ref 사본 — 소켓 콜백은 렌더 사이에도 온다. */
  const runningRef = useRef(false);
  const setRunning = useCallback((v: boolean): void => {
    runningRef.current = v;
    setRunningState(v);
  }, []);
  /** 지금 도는 턴이 **다른 기기**의 것인가 (완결 push 를 그릴지 가른다). */
  const runningElsewhereRef = useRef(false);
  /**
   * 지금 도는 턴이 **이 폰의 스트림**인가. `running` 만 보면 안 된다 — 다른 화면의 턴도 작성기를 잠그려고
   * `running` 을 켠다. 예전에는 그 둘을 가르지 않아, 다른 화면의 턴이 시작되는 순간부터 그 턴의 글·도구·
   * 완결 행·종료가 전부 "내 턴" 으로 읽혀 버려졌다(진행분도, 끝난 답도 다시 열 때까지 안 보였다).
   */
  const ownTurn = (): boolean => runningRef.current && !runningElsewhereRef.current;
  /** 다른 곳에서 도는 턴의 임시 말풍선(질문·진행분)을 그려 두었다 — 완결 행이 그 자리를 대신한다. */
  const remoteTurnRef = useRef(false);
  /** 사용자가 [정지] 를 눌렀다 — 끝난 뒤 그 사실을 답변에 남긴다. */
  const stoppedRef = useRef(false);
  const chatRef = useRef<ChatWsHandle | null>(null);
  /**
   * 시작 화면의 첫 메시지를 건네는 자리. 소켓 콜백은 붙을 때의 렌더를 들고 있어, 지금 렌더의 대화·보내기를
   * 쓰도록 ref 로 건넨다(내용은 보내기 아래에서 채운다).
   */
  const initialRef = useRef(initialMessage);
  initialRef.current = initialMessage;
  const initialSentRef = useRef(onInitialMessageSent);
  initialSentRef.current = onInitialMessageSent;
  const deliverInitialRef = useRef<(s: ChatWsState) => void>(() => undefined);
  /**
   * 이 대화의 이력을 다 읽었다. 첫 메시지는 이력 뒤에 보낸다: 이력이 늦게 오면 그 응답의 [진행 중] 이 방금 보낸
   * 내 턴을 다른 화면의 턴으로 잘못 읽는다(답이 두 번 그려진다).
   */
  const historyReadyRef = useRef(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    onWsState(wsState);
  }, [wsState, onWsState]);

  // ── 지난 대화 ──────────────────────────────────────────────
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    // 대화가 바뀌었다 — 앞 대화의 [진행 중] 을 들고 오지 않는다. 이 화면은 대화를 옮겨도 그대로 떠 있어서,
    // 예전에는 앞 대화에서 돌던 턴 때문에 새 대화의 작성기가 잠긴 채로 열렸다. 이 대화의 사실은 이력과
    // 구독 응답이 곧 다시 알려 준다.
    runningElsewhereRef.current = false;
    remoteTurnRef.current = false;
    stoppedRef.current = false;
    setRunning(false);
    setMessages([]);
    setAttachments([]);
    setAttachmentStatus('');
    setUnseen(0);
    setLoadingHistory(true);
    historyReadyRef.current = false;
    atBottomRef.current = true;
    setAtBottom(true);
    void client.api.history
      .snapshot(agent.workflowId, interactionId, agent.workflowName)
      .then((snap) => {
        if (cancelled) return;
        // 구독의 진행분·다른 화면의 턴 시작이 이력보다 먼저 왔을 수 있다 — 덮어쓰지 않고 합친다.
        setMessages((prev) => mergeHistory(historyMessages(snap.turns), prev));
        // 서버는 실행을 연결이 아니라 대화에 매어 둔다 — 웹에서 시작한 턴이
        // 이 화면을 여는 순간에도 돌 수 있다. 모르고 새 턴을 얹으면 같은
        // 대화에서 둘이 겹친다.
        if (snap.running) {
          runningElsewhereRef.current = true;
          setRunning(true);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        setLoadingHistory(false);
        historyReadyRef.current = true;
        // 소켓이 이력보다 먼저 붙었으면 기다리던 첫 메시지를 지금 보낸다.
        if (chatRef.current?.state() === 'connected') deliverInitialRef.current('connected');
      });
    return () => {
      cancelled = true;
    };
  }, [client, agent, interactionId, setRunning]);

  // ── 소켓 ───────────────────────────────────────────────────
  useEffect(() => {
    if (!agent) return;
    if (readOnly) {
      // 에이전트가 사라진 대화: 이어 갈 수 없으니 붙지 않는다. 앞 대화의 [연결됨] 도 들고 오지 않는다.
      setWsState('closed');
      return;
    }
    const seenExternalIo = new Set<number>();
    /**
     * 완결 행이 실어 온 작업 과정(실행 id 별). 행이 종료 프레임보다 먼저 오는데, 그 순간 이 폰이 그 턴을 다른
     * 곳의 턴으로 모르면(시작·진행 프레임을 놓쳤다) 붙일 답이 아직 없다 — 종료 프레임이 답을 세울 때 꺼내 쓴다.
     */
    const serverProcess = new Map<number, HistoryFlowItem[]>();
    let alive = true;
    /**
     * 이력으로 맞춘다 — 놓친 턴과 그 도구 과정까지(규칙은 mergeMissedTurns). 이 폰의 스트림이 살아 있으면
     * 건너뛴다: 그 턴은 스트림이 끝내고, 그 사이 다른 턴은 다음 구멍이 맞춘다.
     */
    const resync = (): void => {
      void client.api.history
        .snapshot(agent.workflowId, interactionId, agent.workflowName)
        .then((snap) => {
          if (!alive || ownTurn()) return;
          setMessages((prev) => {
            const next = mergeMissedTurns(prev, snap.turns, runningElsewhereRef.current) ?? prev;
            // 임시 말풍선이 모두 완결 턴으로 바뀌었다 — 다음 완결 행은 이미 그린 턴이다.
            if (!hasRemoteTurn(next)) remoteTurnRef.current = false;
            return next;
          });
          if (!snap.running && runningRef.current && !ownTurn()) {
            runningElsewhereRef.current = false;
            setRunning(false);
          }
        })
        .catch(() => undefined);
    };
    const handle = createChat({
      wsBase: wsBaseOf(client.session.serverUrl),
      workflowId: agent.workflowId,
      workflowName: agent.workflowName || agent.workflowId,
      interactionId,
      clientDeviceId: cachedDeviceId() || undefined,
      onState: (s) => {
        setWsState(s);
        // 시작 화면의 첫 메시지: 붙은 순간(또는 붙을 수 없다고 알게 된 순간) 한 번. 한 박자 뒤에 본다:
        // 같은 구독 응답이 실어 온 [진행 중] 이 먼저 반영된다.
        if (s === 'connected' || s === 'unsupported' || s === 'failed') {
          setTimeout(() => {
            if (alive) deliverInitialRef.current(s);
          }, 0);
        }
      },
      wsFactory: client.wsFactory,
      log: diagLog,
      // 이 대화의 폴더가 다른 기기로 옮겨 가거나 그 기기가 바뀌었다.
      onFolders: (data) => folderStore.serverFolders(interactionId, data),
      // 다른 화면에서 이 대화의 모델을 바꿨다.
      onModel: (data) => model.notice(data),
      // 다른 기기에서 시작한 턴이 도는가 — 그동안 작성기를 잠그고 [정지] 를 연다.
      onRunning: (isRunning) => {
        if (isRunning) {
          if (!runningRef.current) {
            runningElsewhereRef.current = true;
            setRunning(true);
          }
          return;
        }
        // 이 폰의 스트림이 살아 있으면 그 스트림이 끝을 알린다(막 보낸 턴을 서버가 아직 등록하기 전일 수도 있다).
        if (!runningRef.current || ownTurn()) return;
        // 서버에는 도는 턴이 없는데 화면은 아직 [진행 중] 이다 — 끝을 알리는 프레임을 놓쳤다(잠든 사이 끝났다).
        // 예전에는 이 신호가 [진행 중] 을 끄지 못했다: 다시 켜는 줄이 함께 있어, 앱을 다시 시작하기 전까지
        // 정지 단추와 받다 만 답이 그대로 남았다. 내리고, 이력으로 그 턴의 답을 채운다.
        runningElsewhereRef.current = false;
        setRunning(false);
        resync();
      },
      // 구독 시점에 이미 돌던 턴의 진행분 — 글만이 아니라 작업 과정(도구)까지. 아직 한 글자도 없어도
      // 받을 자리를 세운다: 그래야 이어서 오는 도구·글이 임시 말풍선에 쌓이고 완결 턴이 그 자리를 대신한다.
      onLiveTurn: (live) => {
        if (ownTurn()) return; // 내 턴이면 스트림이 이미 그리고 있다.
        remoteTurnRef.current = true;
        setMessages((prev) => setRemoteLive(prev, live));
      },
      // 다른 화면이 **지금** 돌리는 턴 — 시작·토큰·종료.
      onPeerTurn: (event) => {
        if (ownTurn()) return;
        if (event.kind === 'gap') {
          // 구멍 — 번호가 건너뛰었거나 소켓이 끊겼다 다시 붙었다(화면을 끄고 켰다). 끊긴 사이에 시작해 끝난
          // 턴은 어떤 프레임으로도 오지 않는다. 이력으로 메운다 — 놓친 턴과 그 도구 과정까지.
          resync();
          return;
        }
        if (event.kind === 'started') {
          runningElsewhereRef.current = true;
          remoteTurnRef.current = true;
          setRunning(true);
          setMessages((prev) => startRemoteTurn(prev, event.input, event.attachments));
          return;
        }
        if (event.kind === 'exec') {
          // 글과 **도구**를 같은 규칙(정본 해석기)으로 — 예전에는 글만 받고 도구는 버려서, 다른 화면이
          // 도구를 부르는 동안 이 폰에는 아무 일도 없어 보였다.
          const ev = turnEventToChatEvent(
            event.event,
            event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : null,
          );
          if ((ev?.kind === 'text' && ev.content) || ev?.kind === 'tool') {
            // 시작 프레임을 못 받은 채 연 대화 — 이 턴이 도는 동안 작성기를 잠근다.
            if (!runningRef.current) {
              runningElsewhereRef.current = true;
              setRunning(true);
            }
          }
          if (ev?.kind === 'text' && ev.content) {
            remoteTurnRef.current = true;
            setMessages((prev) => appendAssistantText(ensureRemotePartial(prev), ev.content));
          } else if (ev?.kind === 'tool') {
            remoteTurnRef.current = true;
            setMessages((prev) => attachTool(ensureRemotePartial(prev), ev.event));
          } else if (ev?.kind === 'download') {
            setMessages((prev) => attachDownload(ensureRemotePartial(prev), ev.data));
          }
          return;
        }
        // 종료 — 완결 행이 먼저 와서 이미 그렸으면 그대로 둔다(같은 실행 id).
        if (event.ioId) seenExternalIo.add(event.ioId);
        const process = event.ioId ? serverProcess.get(event.ioId) : undefined;
        setMessages((prev) => completeRemoteTurn(prev, { ...event, process }) ?? prev);
        remoteTurnRef.current = false;
        runningElsewhereRef.current = false;
        setRunning(false);
      },
      onServerTurn: (turn) => {
        // 다른 기기에서 시작한 턴은 이 폰이 그린 적이 없다 — 완결 push 로 받는다.
        // 이 폰의 스트림이 그리는 턴이면 스트림이 끝낸다. 하트비트가 [끝남] 을 먼저 말했어도
        // 그 턴의 임시 말풍선이 남아 있으면 이 행이 그 자리를 대신한다.
        if (turn.ioId && turn.process?.length) {
          serverProcess.set(turn.ioId, turn.process);
          if (serverProcess.size > 8) serverProcess.delete(serverProcess.keys().next().value as number);
        }
        const report = turn.source === 'subagent_report';
        const mine = ownTurn() || (!runningElsewhereRef.current && !remoteTurnRef.current);
        if (!report && mine) {
          // 이미 그린 턴이다 — 그 답에 도구 과정이 없으면(진행 프레임을 놓쳤다) 서버가 실어 온 과정만 붙인다.
          if (!ownTurn()) setMessages((prev) => attachProcessById(prev, turn.ioId, turn.process) ?? prev);
          return;
        }
        if (!turn.output) return;
        if (turn.ioId && seenExternalIo.has(turn.ioId)) return;
        if (turn.ioId) seenExternalIo.add(turn.ioId);
        if (report) {
          setMessages((prev) => [
            ...dropRemotePartials(prev),
            userMessage(turn.input),
            { ...assistantPlaceholder({ streaming: false }), text: turn.output },
          ]);
        } else {
          // 서버는 완결 행을 turn_ended 보다 먼저 민다 — 진행분과 질문을 이 턴으로 바꿔 끼운다
          // (예전에는 덧붙여 질문이 두 번 보였다).
          setMessages((prev) => completeRemoteTurn(prev, turn) ?? prev);
          remoteTurnRef.current = false;
        }
        void notifyAnswer(agent.workflowName || agent.workflowId, stripAgentMarkers(turn.output));
        runningElsewhereRef.current = false;
        setRunning(false);
      },
      callbacks: {
        onData: (text) => setMessages((prev) => appendAssistantText(prev, text)),
        onTool: (ev) => setMessages((prev) => attachTool(prev, ev)),
        onDownload: (data) => setMessages((prev) => attachDownload(prev, data)),
        // 이 턴의 실행 id — 같은 턴이 완결 행·이력으로 다시 와도 한 번만, 소켓 구멍도 이것으로 메운다.
        onExecutionIo: (ioId) => setMessages((prev) => markExecutionIo(prev, ioId) ?? prev),
        onEnd: () => {
          const interrupted = stoppedRef.current;
          stoppedRef.current = false;
          setRunning(false);
          setMessages((prev) => {
            const next = finishStreaming(prev, { interrupted });
            // 주머니 속에서 끝난 답변을 알린다 — 앞에 있으면 알리지 않는다.
            if (!interrupted) {
              const last = next[next.length - 1];
              if (last?.role === 'assistant' && last.text) {
                void notifyAnswer(agent.workflowName || agent.workflowId, stripAgentMarkers(last.text));
              }
            }
            return next;
          });
        },
        onError: (message) => {
          stoppedRef.current = false;
          setRunning(false);
          setMessages((prev) => setError(prev, describeStreamError(message)));
        },
        // 끊김은 실패가 아니다 — 서버의 턴은 계속 돈다. 재연결에 맡긴다.
        onDetached: () => {
          // 끊긴 이 턴은 이제 다른 화면의 턴처럼 받는다(새 연결은 새 표식이라 서버가 진행·종료를 보내 준다) —
          // 완결 행이 오면 이 진행분 자리를 대신한다.
          runningElsewhereRef.current = true;
          remoteTurnRef.current = true;
          setRunning(true);
          setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false, remotePartial: true } : m)));
        },
      },
    });
    chatRef.current = handle;
    // 앱이 다시 앞으로 왔다 — 뒤에 있던 사이 OS 가 소켓을 놓았을 수 있다. 지금 확인하고, 죽었으면 새로 붙는다
    // (새로 붙으면 지금 도는가·어디까지 왔나·놓친 턴이 함께 온다).
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') handle.resume();
    });
    return () => {
      alive = false;
      appState.remove();
      handle.close();
    };
  }, [client, agent, interactionId, readOnly, setRunning]);

  // ── 스크롤 — 따라갈 때만 따라간다 ───────────────────────────
  //
  // 예전에는 메시지가 늘 때마다 바닥으로 끌어내렸다. 답변이 길게 흐르는 동안
  // 위를 읽으려 하면 매 청크마다 아래로 튕겨 나갔다 — 읽는 것이 불가능했다.
  const lastCountRef = useRef(0);
  useEffect(() => {
    const grew = messages.length > lastCountRef.current;
    lastCountRef.current = messages.length;
    if (atBottomRef.current) {
      const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
      return () => clearTimeout(t);
    }
    if (grew) setUnseen((n) => n + 1);
    return undefined;
  }, [messages.length]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const bottom = distance <= STICK_PX;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  }, []);

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  // ── 보내기 ─────────────────────────────────────────────────
  /** 한 턴을 보낸다. 입력창에서도, 시작 화면의 첫 메시지에서도 이 길 하나로. */
  const sendText = useCallback(async (text: string, sending: MobileChatAttachment[]): Promise<void> => {
    if ((!text && sending.length === 0) || runningRef.current || uploadBusy.current || !chatRef.current) return;
    setRunning(true);
    stoppedRef.current = false;
    jumpToBottom();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setMessages((prev) => [
      ...prev,
      userMessage(
        text,
        // 올라간 자리를 함께 — 말풍선의 첨부를 눌러 다시 열고 내보낸다.
        sending.map((a) => ({ name: a.name, kind: a.kind, workspacePath: a.workspace_path, size: a.size })),
      ),
      assistantPlaceholder(),
    ]);
    try {
      // 보내는 순간의 폴더 — 빈 목록도 보낸다(서버가 파일 도구를 감춘다).
      await chatRef.current.execute(text, sending, toWire(folderStore.list(interactionId)));
    } catch (e) {
      setRunning(false);
      // 올려둔 첨부는 돌려준다 — 다시 고르게 만들지 않는다.
      setAttachments((current) => [...sending, ...current]);
      setMessages((prev) => setError(prev, describeError(e)));
    }
  }, [interactionId, jumpToBottom, setRunning]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || running || uploadBusy.current || !chatRef.current) return;
    const sending = [...attachments];
    setInput('');
    setAttachments([]);
    setAttachmentStatus('');
    await sendText(text, sending);
  }, [attachments, input, running, sendText]);

  // ── 시작 화면의 첫 메시지 ──────────────────────────────────
  deliverInitialRef.current = (s: ChatWsState): void => {
    if (!agent || readOnly) return;
    // 붙었지만 이력이 아직이면 기다린다(이력을 다 읽으면 다시 부른다).
    if (s === 'connected' && !historyReadyRef.current) return;
    const msg = initialMessageGate.take(initialRef.current, agent.workflowId, interactionId);
    if (!msg) return;
    initialSentRef.current?.(msg.id);
    if (s === 'connected' && !runningRef.current && !uploadBusy.current && chatRef.current) {
      void sendText(msg.text.trim(), []);
      return;
    }
    // 지금 보낼 수 없다(이 에이전트는 모바일 채팅을 못 하거나 연결이 끊겼다). 적은 글은 입력창에 남긴다.
    setInput((cur) => (cur.trim() ? cur : msg.text));
  };

  const stop = useCallback(() => {
    stoppedRef.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    chatRef.current?.stop();
  }, []);

  // ── 첨부 ───────────────────────────────────────────────────
  const uploadPicked = useCallback(
    async (files: PickedFile[]): Promise<void> => {
      if (!agent || files.length === 0) return;
      uploadBusy.current = true;
      setUploading(true);
      const context = attachmentContextRef.current;
      const isCurrent = (): boolean => attachmentContextRef.current === context;
      let count = 0;
      try {
        setAttachmentStatus('파일을 올리는 중…');
        for (const file of files) {
          if (!isCurrent()) return;
          // 파일은 경로로 흘려보낸다 — RN 의 Blob 은 바이트로 만들 수 없어 예전 방식(전체를 base64 로
          // 읽어 바이트로)은 모든 첨부가 업로드 직전에 실패했다. 크기·종류만 앞에서 확인한다.
          const size = file.size ?? (await fileSize(file.uri));
          if ((size ?? 0) > MAX_ATTACHMENT_BYTES) {
            throw new Error('첨부 파일 한 개는 100MiB를 넘을 수 없습니다.');
          }
          const head = await FileSystem.readAsStringAsync(file.uri, {
            encoding: FileSystem.EncodingType.Base64,
            position: 0,
            length: 16,
          }).catch(() => '');
          const detected = imageMime(base64Bytes(head));
          const mime = detected || (file.mimeType || 'application/octet-stream').toLowerCase();
          const kind: 'image' | 'file' = detected ? 'image' : 'file';
          const name = attachmentName(file.name, detected);
          const attachmentId = `mob-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const result = await client.api.agentData.workspaceUpload(
            agent.workflowId,
            { uri: file.uri },
            name,
            mime,
            interactionId,
            attachmentId,
          );
          if (!isCurrent()) return;
          if (result.status === 'pending_approval') throw new Error('파일 업로드가 승인 대기 중입니다.');
          const workspacePath = result.workspace_path;
          if (!workspacePath) throw new Error('Workspace 업로드 경로가 없습니다.');
          // 하나가 실패해도 먼저 올라간 것은 남긴다.
          setAttachments((current) => [
            ...current,
            {
              kind,
              attachment_id: attachmentId,
              name,
              mime_type: mime,
              size: result.size ?? size ?? 0,
              sha256: result.sha256,
              workspace_path: workspacePath,
            },
          ]);
          count += 1;
        }
        if (isCurrent()) setAttachmentStatus(`${count}개 첨부됨`);
      } catch (error) {
        if (isCurrent()) setAttachmentStatus(friendlyError(error, '파일을 첨부하지 못했습니다.'));
      } finally {
        uploadBusy.current = false;
        setUploading(false);
      }
    },
    [agent, client, interactionId],
  );

  const pickFiles = useCallback(async (): Promise<void> => {
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (picked.canceled) return;
    await uploadPicked(
      picked.assets.map((asset: DocumentPicker.DocumentPickerAsset) => ({
        uri: asset.uri,
        name: asset.name,
        size: asset.size ?? undefined,
        mimeType: asset.mimeType,
      })),
    );
  }, [uploadPicked]);

  const pickPhotos = useCallback(async (): Promise<void> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setAttachmentStatus('사진 접근 권한이 필요합니다.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      quality: 0.85,
      allowsMultipleSelection: true,
      // iOS 사진은 HEIC 로 올 수 있다 — 모델이 읽는 JPEG 로 받는다.
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (picked.canceled) return;
    await uploadPicked(
      picked.assets.map((a, i) => ({
        uri: a.uri,
        name: a.fileName || `photo-${Date.now()}-${i + 1}.jpg`,
        size: a.fileSize ?? undefined,
        mimeType: a.mimeType ?? 'image/jpeg',
      })),
    );
  }, [uploadPicked]);

  const takePhoto = useCallback(async (): Promise<void> => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setAttachmentStatus('카메라 권한이 필요합니다.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (shot.canceled || !shot.assets?.[0]) return;
    const a = shot.assets[0];
    await uploadPicked([
      {
        uri: a.uri,
        name: a.fileName || `camera-${Date.now()}.jpg`,
        size: a.fileSize ?? undefined,
        mimeType: a.mimeType ?? 'image/jpeg',
      },
    ]);
  }, [uploadPicked]);

  // ── 대화 머리의 제목 ───────────────────────────────────────
  // 목록에서 열었으면 그 제목, 새 대화면 첫 메시지 한 줄(서버도 그것을 제목으로 삼는다), 둘 다 없으면 "새 대화".
  const headTitle = useMemo(() => {
    const given = title?.trim();
    if (given) return given;
    const first = messages.find((m) => m.role === 'user' && m.text.trim());
    return first ? first.text.replace(/\s+/g, ' ').trim() : UNTITLED_CONVERSATION;
  }, [title, messages]);

  if (!agent) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 }}>
        <Text style={{ color: p.text, fontSize: 17, fontWeight: '800', textAlign: 'center' }}>
          진행 중인 대화가 없습니다
        </Text>
        <Pressable
          onPress={() => onNewChat()}
          accessibilityRole="button"
          style={{ backgroundColor: p.primary, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 20, marginTop: 6 }}
        >
          <Text style={{ color: p.onPrimary, fontSize: 15, fontWeight: '700' }}>새 채팅</Text>
        </Pressable>
        <Pressable
          onPress={onOpenList}
          accessibilityRole="button"
          style={{ backgroundColor: p.panel2, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 20 }}
        >
          <Text style={{ color: p.text, fontSize: 15, fontWeight: '700' }}>채팅 목록</Text>
        </Pressable>
      </View>
    );
  }

  const canSend = !uploading && wsState === 'connected' && (!!input.trim() || attachments.length > 0);
  const placeholder =
    wsState === 'connected'
      ? running
        ? '답변이 도는 중입니다'
        : '메시지를 입력하세요'
      : wsState === 'unsupported'
        ? '이 에이전트는 모바일 채팅을 지원하지 않습니다'
        : wsState === 'failed'
          ? '연결이 끊겼습니다. 잠시 뒤 다시 시도합니다'
          : '연결 중…';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* 대화 머리 — 지금 어느 대화인지, 그리고 옮겨 가는 길. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: p.border,
          backgroundColor: p.panel,
        }}
      >
        {/* 제목: 누르면 대화 목록으로 돌아간다. */}
        <Pressable
          onPress={onOpenList}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="채팅 목록"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, minHeight: 32 }}
        >
          <Ionicons name="chevron-back" size={16} color={p.muted} />
          <Text numberOfLines={1} style={{ color: p.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }}>
            {headTitle}
          </Text>
        </Pressable>
        {!readOnly && (
          <FolderPill
            count={
              folderRemote.elsewhere
                ? (folderRemote.state?.folders.length ?? 0)
                : folders.length + folderRemote.others.reduce((n, other) => n + other.folders.length, 0)
            }
            elsewhereName={folderRemote.elsewhere ? folderRemote.state?.device?.name : undefined}
            onPress={() => setFolderSheet(true)}
          />
        )}
        {/* [새 대화]: 시작 화면으로. 이 에이전트를 골라 둔다(사라진 에이전트면 고르지 않는다). */}
        <Pressable
          onPress={() => onNewChat(readOnly ? undefined : agent)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="새 대화 시작"
          style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: p.panel2 }}
        >
          <Text style={{ color: p.text, fontSize: 12, fontWeight: '700' }}>새 대화</Text>
        </Pressable>
        {!readOnly && (
          <Pressable
            onPress={() => setDetailOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="에이전트 상세"
            style={{ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: p.panel2 }}
          >
            <Text style={{ color: p.text, fontSize: 12, fontWeight: '700' }}>상세</Text>
          </Pressable>
        )}
        {/* [공유]: 지금까지 끝난 대화를 이 시점 그대로 링크로(데스크톱·웹 머리줄의 공유 아이콘과 같다). */}
        {!readOnly && (
          <Pressable
            onPress={() => setShareSheet(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={CHAT_SHARE_TEXT.buttonTitle}
            style={{ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: p.panel2 }}
          >
            <Ionicons name="share-outline" size={16} color={p.text} />
          </Pressable>
        )}
      </View>

      {loadingHistory && messages.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <ActivityIndicator color={p.primary} />
          <Text style={{ color: p.muted, fontSize: 13 }}>대화를 불러오는 중…</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 18 }}
          onScroll={onScroll}
          scrollEventThrottle={64}
          keyboardDismissMode="on-drag"
          renderItem={({ item: m, index }) => {
            const text = m.role === 'assistant' ? stripAgentMarkers(m.text) : m.text;
            if (
              !text &&
              !m.streaming &&
              !m.remotePartial &&
              !m.errorInfo &&
              !m.tools?.length &&
              !m.attachments?.length
            ) {
              return null;
            }
            return (
              <MessageItem
                message={m}
                text={text}
                clean={cleanStep}
                onOpenLog={(events, initialOpen) => setLogFor({ events, initialOpen })}
                client={client}
                workflowId={agent.workflowId}
                request={m.role === 'assistant' ? requestBefore(messages, index) : ''}
                latest={index === lastAssistant}
                onOpenFile={openFile}
              />
            );
          }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: 48, gap: 6 }}>
              <Text style={{ color: p.text, fontSize: 16, fontWeight: '800' }}>
                {agent.workflowName || agent.workflowId}
              </Text>
              <Text style={{ color: p.muted, fontSize: 13.5 }}>이 에이전트와 대화를 시작하세요.</Text>
            </View>
          }
        />
      )}

      {/* 위를 읽는 중에 새 글이 오면 알린다 — 화면을 끌어내리지 않는다. */}
      {!atBottom && (
        <Pressable
          onPress={jumpToBottom}
          accessibilityRole="button"
          accessibilityLabel="맨 아래로"
          style={{
            position: 'absolute',
            alignSelf: 'center',
            bottom: 96,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 999,
            backgroundColor: p.primary,
            shadowColor: '#000',
            shadowOpacity: 0.2,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 3 },
            elevation: 4,
          }}
        >
          <Text style={{ color: p.onPrimary, fontSize: 12.5, fontWeight: '700' }}>
            {unseen > 0 ? `새 메시지 ${unseen}개` : '맨 아래로'}
          </Text>
          <Text style={{ color: p.onPrimary, fontSize: 12 }}>↓</Text>
        </Pressable>
      )}

      {/* 작성기. 에이전트가 사라진 대화는 지난 기록만 본다. */}
      {readOnly ? (
        <View
          style={{
            backgroundColor: p.panel,
            borderTopWidth: 1,
            borderTopColor: p.border,
            paddingHorizontal: 16,
            paddingVertical: 14,
            paddingBottom: 18,
          }}
        >
          <Text style={{ color: p.muted, fontSize: 13.5, textAlign: 'center' }}>{CONVERSATION_TEXT.deletedAgentNotice}</Text>
        </View>
      ) : (
        <View
          style={{
            backgroundColor: p.panel,
            borderTopWidth: 1,
            borderTopColor: p.border,
            padding: 8,
            paddingBottom: 14,
          }}
        >
          {/* 모델 칩, 그 오른쪽이 생각 칩. 둘 다 이 대화에만 붙는다. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: model.state.supported ? 6 : 0, maxWidth: '100%' }}>
            <ModelChip state={model.state} saving={model.saving} onPress={() => setModelSheet(true)} />
            <ThinkingChip state={model.state} saving={model.saving} onPress={() => setThinkingSheet(true)} />
          </View>
          {attachments.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 6 }}>
              {attachments.map((item) => (
                <Pressable
                  key={item.attachment_id}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name} 첨부 빼기`}
                  onPress={() =>
                    setAttachments((current) => current.filter((a) => a.attachment_id !== item.attachment_id))
                  }
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    backgroundColor: p.panel2,
                    borderWidth: 1,
                    borderColor: p.border,
                    borderRadius: 999,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    maxWidth: 220,
                  }}
                >
                  <Text style={{ fontSize: 12 }}>{item.kind === 'image' ? '🖼' : '📎'}</Text>
                  <Text numberOfLines={1} style={{ color: p.text, fontSize: 12, flexShrink: 1 }}>
                    {item.name}
                  </Text>
                  <Text style={{ color: p.muted, fontSize: 12 }}>✕</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          {!!attachmentStatus && (
            <Text style={{ color: p.muted, fontSize: 12, marginBottom: 5 }}>{attachmentStatus}</Text>
          )}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: 6,
              backgroundColor: p.panel2,
              borderWidth: 1,
              borderColor: p.border,
              borderRadius: 22,
              paddingLeft: 6,
              paddingRight: 6,
              paddingVertical: 6,
            }}
          >
            <Pressable
              onPress={() => setAttachMenu(true)}
              disabled={running || uploading}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="첨부"
              style={{
                width: TAP - 6,
                height: TAP - 6,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: running || uploading ? 0.4 : 1,
              }}
            >
              {uploading ? <ActivityIndicator color={p.muted} /> : <Text style={{ fontSize: 18 }}>＋</Text>}
            </Pressable>
            <TextInput
              style={{ flex: 1, color: p.text, fontSize: 15.5, maxHeight: 140, paddingVertical: 8 }}
              value={input}
              onChangeText={setInput}
              placeholder={placeholder}
              placeholderTextColor={p.muted}
              multiline
              accessibilityLabel="메시지 입력"
            />
            {running ? (
              <Pressable
                onPress={stop}
                accessibilityRole="button"
                accessibilityLabel="정지"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  backgroundColor: p.danger,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: '#fff' }} />
              </Pressable>
            ) : (
              <Pressable
                onPress={() => void send()}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel="보내기"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  backgroundColor: p.primary,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: canSend ? 1 : 0.35,
                }}
              >
                <Text style={{ color: p.onPrimary, fontSize: 16, fontWeight: '900', marginLeft: 2 }}>➤</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* 첨부 고르기 */}
      <Modal visible={attachMenu} transparent animationType="fade" onRequestClose={() => setAttachMenu(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }}
          accessibilityLabel="닫기"
          onPress={() => setAttachMenu(false)}
        />
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: p.panel,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderWidth: 1,
            borderColor: p.border,
            paddingBottom: 28,
            paddingTop: 10,
          }}
        >
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center', marginBottom: 8 }} />
          {[
            { label: '사진 보관함', icon: '🖼', run: pickPhotos },
            { label: '사진 찍기', icon: '📷', run: takePhoto },
            { label: '파일', icon: '📎', run: pickFiles },
          ].map((item) => (
            <Pressable
              key={item.label}
              onPress={() => {
                setAttachMenu(false);
                setTimeout(() => void item.run(), 250); // 모달이 닫힌 뒤 시스템 창을 연다
              }}
              accessibilityRole="button"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, minHeight: TAP + 6 }}
            >
              <Text style={{ fontSize: 18 }}>{item.icon}</Text>
              <Text style={{ color: p.text, fontSize: 15.5, fontWeight: '600' }}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>

      <FilePreviewScreen client={client} workflowId={agent.workflowId} file={previewFile} onClose={() => setPreviewFile(null)} />

      {/* 에이전트 상세: [대화 시작] 은 이 에이전트를 골라 둔 시작 화면으로. */}
      <AgentDetail
        client={client}
        agent={detailOpen ? agent : null}
        onClose={() => setDetailOpen(false)}
        onOpenChat={(a) => {
          setDetailOpen(false);
          onNewChat(a);
        }}
      />
      <FolderSheet interactionId={interactionId} visible={folderSheet} onClose={() => setFolderSheet(false)} />
      <ChatShareSheet
        client={client}
        workflowId={agent?.workflowId ?? ''}
        interactionId={interactionId}
        visible={shareSheet}
        onClose={() => setShareSheet(false)}
      />
      <ModelSheet
        state={model.state}
        visible={modelSheet}
        error={model.error}
        onPick={(choice) => {
          setModelSheet(false);
          void model.choose(choice);
        }}
        onClose={() => setModelSheet(false)}
      />
      <ThinkingSheet
        state={model.state}
        visible={thinkingSheet}
        error={model.error}
        onPick={(value) => {
          setThinkingSheet(false);
          void model.chooseThinking(value);
        }}
        onClose={() => setThinkingSheet(false)}
      />

      {logFor && (
        <ToolLogSheet
          events={logFor.events}
          initialOpen={logFor.initialOpen}
          onClose={() => setLogFor(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}
