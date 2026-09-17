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
 * · 대화 이동: 채팅 안에서 같은 에이전트의 다른 대화로 건너뛰고, 새 대화를 연다.
 * · 첨부: 파일뿐 아니라 사진·카메라. 폰에서 가장 많이 붙이는 것이 사진이다.
 *
 * 전송·재연결·다른 기기 턴의 규칙은 예전 그대로다(chat-ws). 화면만 바뀐다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import type { Agent, Conversation, ToolEvent } from '@dex/protocol';
import { describeError, describeStreamError } from '@dex/protocol';
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
import { TAP, alpha, useP } from '../theme';
import { notifyAnswer } from './answer-notice';
import { MessageItem } from './message-item';
import { ToolLogSheet } from './tool-log-sheet';
import {
  appendAssistantText,
  assistantPlaceholder,
  attachTool,
  dropRemotePartials,
  finishStreaming,
  historyMessages,
  setError,
  setRemotePartial,
  userMessage,
  type ChatMessage,
} from './message-model';

/** base64 → 바이트. RN 에는 atob 가 없다. */
function base64Bytes(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    const n = alphabet.indexOf(char);
    if (n < 0) continue;
    buffer = (buffer << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return offset === out.length ? out : out.slice(0, offset);
}

/** 내용으로 그림인지 본다 — 확장자·선언된 MIME 은 자주 틀린다. */
function imageMime(bytes: Uint8Array): string | undefined {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 8 && png.every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  const gif = String.fromCharCode(...bytes.slice(0, 6));
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return undefined;
}

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

interface PickedFile {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

/** 바닥에서 이 정도 안쪽이면 "따라가는 중" 으로 본다. */
const STICK_PX = 120;

export function ChatView({
  client,
  agent,
  interactionId,
  onWsState,
  onPickAgent,
  onOpenChat,
}: {
  client: XgenMobileClient;
  agent: Agent | null;
  interactionId: string;
  onWsState: (s: ChatWsState) => void;
  onPickAgent: () => void;
  /** 같은 에이전트의 다른 대화로 옮겨 간다(대화 id 를 비우면 새 대화). */
  onOpenChat: (agent: Agent, interactionId?: string) => void;
}): React.ReactElement {
  const p = useP();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<MobileChatAttachment[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [logFor, setLogFor] = useState<{ events: ToolEvent[]; initialOpen?: number } | null>(null);
  const [convSheet, setConvSheet] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
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
  /** 사용자가 [정지] 를 눌렀다 — 끝난 뒤 그 사실을 답변에 남긴다. */
  const stoppedRef = useRef(false);
  const chatRef = useRef<ChatWsHandle | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    onWsState(wsState);
  }, [wsState, onWsState]);

  // ── 지난 대화 ──────────────────────────────────────────────
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    setMessages([]);
    setAttachments([]);
    setAttachmentStatus('');
    setUnseen(0);
    setLoadingHistory(true);
    atBottomRef.current = true;
    setAtBottom(true);
    void client.api.history
      .snapshot(agent.workflowId, interactionId, agent.workflowName)
      .then((snap) => {
        if (cancelled) return;
        setMessages(historyMessages(snap.turns));
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
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, agent, interactionId, setRunning]);

  // ── 소켓 ───────────────────────────────────────────────────
  useEffect(() => {
    if (!agent) return;
    const seenExternalIo = new Set<number>();
    const handle = createChat({
      wsBase: wsBaseOf(client.session.serverUrl),
      workflowId: agent.workflowId,
      workflowName: agent.workflowName || agent.workflowId,
      interactionId,
      clientDeviceId: cachedDeviceId() || undefined,
      onState: setWsState,
      wsFactory: client.wsFactory,
      log: diagLog,
      // 다른 기기에서 시작한 턴이 도는가 — 그동안 작성기를 잠그고 [정지] 를 연다.
      onRunning: (isRunning) => {
        if (isRunning && !runningRef.current) runningElsewhereRef.current = true;
        if (!isRunning) runningElsewhereRef.current = false;
        if (isRunning !== runningRef.current) setRunning(isRunning || runningRef.current);
      },
      // 구독 시점에 이미 돌던 턴의 진행분 — 없으면 "진행 중" 옆이 빈 말풍선이다.
      onLiveTurn: (live) => {
        if (!live.text) return;
        if (runningRef.current) return; // 내 턴이면 스트림이 이미 그리고 있다.
        setMessages((prev) => setRemotePartial(prev, live.text));
      },
      // 다른 화면이 **지금** 돌리는 턴 — 시작·토큰·종료.
      onPeerTurn: (event) => {
        if (runningRef.current) return;
        if (event.kind === 'gap') return; // 종료 프레임이 완결 본문을 싣고 온다.
        if (event.kind === 'started') {
          runningElsewhereRef.current = true;
          setRunning(true);
          setMessages((prev) => [
            ...dropRemotePartials(prev),
            userMessage(event.input),
            assistantPlaceholder({ streaming: false, remotePartial: true }),
          ]);
          return;
        }
        if (event.kind === 'exec') {
          const d = event.data as { type?: string; content?: unknown } | undefined;
          if (event.event !== 'message' || d?.type !== 'data') return;
          const text = typeof d.content === 'string' ? d.content : '';
          if (!text) return;
          setMessages((prev) => appendAssistantText(prev, text));
          return;
        }
        if (event.ioId) seenExternalIo.add(event.ioId);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.remotePartial) return prev;
          const next = prev.slice();
          next[next.length - 1] = { ...last, text: event.output, remotePartial: false, streaming: false };
          return next;
        });
        runningElsewhereRef.current = false;
        setRunning(false);
      },
      onServerTurn: (turn) => {
        // 다른 기기에서 시작한 턴은 이 폰이 그린 적이 없다 — 완결 push 로 받는다.
        const mine = !runningElsewhereRef.current;
        if (turn.source !== 'subagent_report' && mine) return;
        if (!turn.output) return;
        if (turn.ioId && seenExternalIo.has(turn.ioId)) return;
        if (turn.ioId) seenExternalIo.add(turn.ioId);
        setMessages((prev) => [
          ...dropRemotePartials(prev),
          userMessage(turn.input),
          { ...assistantPlaceholder({ streaming: false }), text: turn.output },
        ]);
        void notifyAnswer(agent.workflowName || agent.workflowId, stripAgentMarkers(turn.output));
        runningElsewhereRef.current = false;
        setRunning(false);
      },
      callbacks: {
        onData: (text) => setMessages((prev) => appendAssistantText(prev, text)),
        onTool: (ev) => setMessages((prev) => attachTool(prev, ev)),
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
          runningElsewhereRef.current = true;
          setRunning(true);
          setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false, remotePartial: true } : m)));
        },
      },
    });
    chatRef.current = handle;
    return () => handle.close();
  }, [client, agent, interactionId, setRunning]);

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
  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || running || uploadBusy.current || !chatRef.current) return;
    const sending = [...attachments];
    setInput('');
    setAttachments([]);
    setAttachmentStatus('');
    setRunning(true);
    stoppedRef.current = false;
    jumpToBottom();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setMessages((prev) => [
      ...prev,
      userMessage(
        text,
        sending.map((a) => ({ name: a.name, kind: a.kind })),
      ),
      assistantPlaceholder(),
    ]);
    try {
      await chatRef.current.execute(text, sending);
    } catch (e) {
      setRunning(false);
      // 올려둔 첨부는 돌려준다 — 다시 고르게 만들지 않는다.
      setAttachments((current) => [...sending, ...current]);
      setMessages((prev) => setError(prev, describeError(e)));
    }
  }, [attachments, input, jumpToBottom, running, setRunning]);

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
          if ((file.size ?? 0) > MAX_ATTACHMENT_BYTES) {
            throw new Error('첨부 파일 한 개는 100MiB를 넘을 수 없습니다.');
          }
          const b64 = await FileSystem.readAsStringAsync(file.uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          const bytes = base64Bytes(b64);
          if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
            throw new Error('첨부 파일 한 개는 100MiB를 넘을 수 없습니다.');
          }
          const detected = imageMime(bytes);
          const mime = detected || (file.mimeType || 'application/octet-stream').toLowerCase();
          const kind: 'image' | 'file' = detected ? 'image' : 'file';
          const attachmentId = `mob-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const result = await client.api.agentData.workspaceUpload(
            agent.workflowId,
            bytes,
            file.name,
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
              name: file.name,
              mime_type: mime,
              size: result.size ?? bytes.byteLength,
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
    const picked = await ImagePicker.launchImageLibraryAsync({ quality: 0.85, allowsMultipleSelection: true });
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

  // ── 대화 이동 ──────────────────────────────────────────────
  const openConversations = useCallback(() => {
    setConvSheet(true);
    void client.api.history
      .conversations()
      .then((all) => setConversations(all.filter((c) => c.workflowId === agent?.workflowId)))
      .catch(() => setConversations([]));
  }, [client, agent]);

  if (!agent) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 }}>
        <Text style={{ color: p.text, fontSize: 17, fontWeight: '800', textAlign: 'center' }}>
          진행 중인 대화가 없습니다
        </Text>
        <Text style={{ color: p.muted, fontSize: 14, textAlign: 'center' }}>
          에이전트를 선택해 대화를 시작하세요.
        </Text>
        <Pressable
          onPress={onPickAgent}
          accessibilityRole="button"
          style={{ backgroundColor: p.primary, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 20, marginTop: 6 }}
        >
          <Text style={{ color: p.onPrimary, fontSize: 15, fontWeight: '700' }}>에이전트 목록 열기</Text>
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
        <Pressable
          onPress={openConversations}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="이 에이전트의 대화 목록"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, minHeight: 32 }}
        >
          <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12.5, flexShrink: 1 }}>
            대화 · {interactionId.slice(-6)}
          </Text>
          <Text style={{ color: p.muted, fontSize: 11 }}>▾</Text>
        </Pressable>
        <Pressable
          onPress={() => onOpenChat(agent)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="새 대화 시작"
          style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: p.panel2 }}
        >
          <Text style={{ color: p.text, fontSize: 12, fontWeight: '700' }}>새 대화</Text>
        </Pressable>
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
          renderItem={({ item: m }) => {
            const text = m.role === 'assistant' ? stripAgentMarkers(m.text) : m.text;
            if (
              !text &&
              !m.streaming &&
              !m.remotePartial &&
              !m.errorInfo &&
              !m.tools?.length &&
              !m.attachments?.length &&
              !m.attachmentCount
            ) {
              return null;
            }
            return (
              <MessageItem
                message={m}
                text={text}
                onOpenLog={(events, initialOpen) => setLogFor({ events, initialOpen })}
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

      {/* 작성기 */}
      <View
        style={{
          backgroundColor: p.panel,
          borderTopWidth: 1,
          borderTopColor: p.border,
          padding: 8,
          paddingBottom: 14,
        }}
      >
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

      {/* 이 에이전트의 대화들 */}
      <Modal visible={convSheet} transparent animationType="slide" onRequestClose={() => setConvSheet(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }}
          accessibilityLabel="닫기"
          onPress={() => setConvSheet(false)}
        />
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            maxHeight: '70%',
            backgroundColor: p.panel,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderWidth: 1,
            borderColor: p.border,
            padding: 16,
            paddingBottom: 28,
          }}
        >
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center', marginBottom: 10 }} />
          <Text style={{ color: p.text, fontSize: 16, fontWeight: '800', marginBottom: 8 }}>
            {agent.workflowName || agent.workflowId}
          </Text>
          <ScrollView>
            {conversations.length === 0 ? (
              <Text style={{ color: p.muted, fontSize: 13, paddingVertical: 16, textAlign: 'center' }}>
                다른 대화가 없습니다.
              </Text>
            ) : (
              conversations.map((c) => {
                const current = c.interactionId === interactionId;
                return (
                  <Pressable
                    key={c.interactionId}
                    onPress={() => {
                      setConvSheet(false);
                      if (!current) onOpenChat(agent, c.interactionId);
                    }}
                    accessibilityRole="button"
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 13,
                      borderBottomWidth: 1,
                      borderBottomColor: p.border,
                      backgroundColor: current ? alpha(p.primary, 12) : undefined,
                      borderRadius: current ? 10 : 0,
                      paddingHorizontal: current ? 8 : 0,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: current ? p.primary : p.text, fontSize: 14, fontWeight: '700' }}>
                        {formatWhen(c.updatedAt) || '대화'}
                        {current ? ' · 지금 보는 대화' : ''}
                      </Text>
                      <Text style={{ color: p.muted, fontSize: 12 }}>메시지 {c.interactionCount}개</Text>
                    </View>
                    <Text style={{ color: p.muted, fontSize: 18 }}>›</Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>

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

/** 오늘이면 시:분, 아니면 월/일 시:분. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}
