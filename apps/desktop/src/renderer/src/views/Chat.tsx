/**
 * Chat view — renders ONE open session and streams turns with its agent.
 *
 * The durable session runtime (transcript, interactionId, the in-flight stream
 * handle) lives in the SessionStore, NOT here — so switching away keeps this
 * session's connector alive and its answer still arriving in the background.
 * This component is a disposable view over the active `SessionState`: it is
 * remounted (via `key={session.key}`) when the foreground session changes, and
 * owns only foreground concerns — the composer, TTS/STT, screen capture, the
 * avatar overlay feed, and the tool-activity animation.
 *
 * Node-agnostic: works for agent_geny / agent_xgen / agent_harness because the
 * store drives the single execute-stream endpoint.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen, copyText } from '../bridge';
import { sessionStore } from '../session';
import { CONTEXT_LIMIT_CHOICES, teamsContextStore, useContextChip } from '../teams-context';
import { browserSelectionStore, useBrowserSelections } from '../browser-selection-store';
import { notificationStore, useNotifications } from '../notifications';
import { notificationChatKey } from '@dex/protocol/notifications';
import { ShareToTeamsModal } from './ShareToTeams';
import { TeamsRoomList } from './TeamsRoomPicker';
import { useModalDismiss } from './use-modal-dismiss';
import type { ChatImageAttachment, SessionState } from '../session-store';
import type { ToolEvent, Citation, VoiceConfig } from '@dex/protocol';
import type { BrowserSelectionResult } from '@dex/protocol/browser';
import type { McpBridgeStatusLike, McpRuntimeLogEntryLike } from '../../../preload/index';
import { collapseToolSteps, nextToolIndex } from './tool-activity-model';
import { mcpChatStatus } from './mcp-status-model';
import { Markdown } from './Markdown';
import { ToolLogModal } from './ToolLogModal';
import { parseAgentTrigger, triggerRowLabel, type AgentTrigger } from '@dex/protocol';
import type { AvatarState } from '../avatar/AvatarSlot';
import { XgenMark } from '../brand/Logo';
import {
  BrowserIcon,
  BellIcon,
  BellOffIcon,
  ChatIcon,
  CloseIcon,
  CopyIcon,
  DocIcon,
  MicIcon,
  MonitorIcon,
  PlusIcon,
  SendIcon,
  ShareIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  StopIcon,
  TeamsIcon,
} from '../brand/icons';
import type { AgentViewerSub } from './workspace-layout';

/** [Trigger] 행 — Job/sub-agent 결과가 세션을 깨운 턴.
 *
 * 서버는 이 턴을 사용자 발화와 같은 경로로 주입하지만(<agent_trigger:*> 태그),
 * 사용자가 친 채팅이 아니므로 말풍선으로 그리지 않는다: 한 줄
 * [Trigger · 종류 · 출처] + 클릭하면 원문 상세. 전 앱(CLI/VSCode/모바일/웹)
 * 공통 계약이다. */
const TriggerRow: React.FC<{ trigger: AgentTrigger }> = ({ trigger }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="trigger-block">
      <button
        className="trigger-row"
        onClick={() => setOpen((v) => !v)}
        title="클릭하면 트리거 원문을 봅니다"
      >
        <span className="trigger-bolt">⚡</span>
        <span className="trigger-label">{triggerRowLabel(trigger)}</span>
        <span className="trigger-caret">{open ? '−' : '+'}</span>
      </button>
      {open && <pre className="trigger-detail">{trigger.body || '(내용 없음)'}</pre>}
    </div>
  );
};

/** 도구 활동 표시 — **한 번에 하나**만 보여주고 다음 것으로 스르륵 교체된다.
 *
 * 이전에는 한 턴에서 쓴 도구 칩이 전부 쌓여 화면을 덮었다(스크린샷 30개+).
 * 지금은 "지금 쓰는 도구" 한 칸만 유지한다:
 *   · 같은 도구의 연속 이벤트(tool_call→tool_start→tool_result)는 **제자리**
 *     에서 아이콘만 바뀐다 (불필요한 깜빡임 없음)
 *   · 다른 도구로 넘어갈 때만 페이드 아웃 → 인
 *   · 여러 도구가 몰아치면 중간을 건너뛰고 최신으로 점프한다 (슥 지나감)
 *   · 턴이 끝나면 사라진다 (완료된 답변 위에 낡은 칩을 남기지 않는다)
 */
const TOOL_STEP_MS = 320; // 한 도구가 최소로 머무는 시간
const TOOL_FADE_MS = 220; // 교체 크로스페이드 길이

interface ToolSlot {
  key: number;
  ev: ToolEvent;
}

const ToolActivity: React.FC<{
  events: ToolEvent[];
  streaming: boolean;
  /** 칩 클릭 — 그 도구가 펼쳐진 전체 로그로 (칩은 빠르게 지나가므로 이게 통로다). */
  onOpen?: (ev: ToolEvent) => void;
}> = ({ events, streaming, onOpen }) => {
  // 연속 동일 도구 이벤트를 한 단계로 접는다 (마지막 상태만 유지).
  const steps = useMemo(() => collapseToolSteps(events), [events]);

  const [idx, setIdx] = useState(0);
  // 크로스페이드: 나가는 칩과 들어오는 칩을 **동시에** 겹쳐 둔다. 한 요소의
  // 클래스만 바꿔 out→in 을 순차로 돌리면 중간에 빈 구간이 생겨 전환이
  // 끊겨 보인다 (첫 구현의 문제).
  const [cur, setCur] = useState<ToolSlot | null>(null);
  const [out, setOut] = useState<ToolSlot | null>(null);

  // 밀린 단계 전진 — 많이 밀렸으면 최신으로 점프 (여러 도구를 빠르게 쓰면 슥 지나감).
  useEffect(() => {
    if (!steps.length) return;
    if (idx > steps.length - 1) {
      setIdx(steps.length - 1);
      return;
    }
    if (idx === steps.length - 1) return;
    const t = setTimeout(() => setIdx((i) => nextToolIndex(i, steps.length)), TOOL_STEP_MS);
    return () => clearTimeout(t);
  }, [steps.length, idx]);

  // 표시 대상 갱신 — 같은 단계의 상태 변화(⚙→✓)는 제자리, 단계가 바뀌면 크로스페이드.
  // streaming 이 아니면(탭 전환으로 이미 끝난 메시지에 새로 마운트된 경우) 아무것도
  // 켜지 않는다 — 켰다가 바로 아래 이펙트가 꺼버리면 옛 도구 칩이 한 프레임 번쩍이고
  // 사라지는 걸로 보인다(탭 전환 시 "이전 Tool 로그가 잠깐 다시 나타났다 사라짐" 버그).
  useEffect(() => {
    if (!streaming) return;
    const target = steps[Math.min(idx, steps.length - 1)];
    if (!target) return;
    setCur((prev) => {
      if (prev && prev.key === idx) {
        return prev.ev === target ? prev : { key: idx, ev: target }; // 제자리 갱신
      }
      if (prev) setOut(prev); // 이전 칩은 나가는 레이어로
      return { key: idx, ev: target };
    });
  }, [idx, steps, streaming]);

  // 나가는 레이어 정리 (애니메이션이 끝난 뒤 언마운트).
  useEffect(() => {
    if (!out) return;
    const t = setTimeout(() => setOut(null), TOOL_FADE_MS);
    return () => clearTimeout(t);
  }, [out]);

  // 턴 종료 → 스르륵 사라짐.
  useEffect(() => {
    if (streaming || !cur) return;
    setOut(cur);
    setCur(null);
  }, [streaming, cur]);

  if (!cur && !out) return null;
  const chip = (slot: ToolSlot, leaving: boolean) => (
    <button
      key={`${slot.key}-${leaving ? 'out' : 'in'}`}
      className={`tool-chip ${slot.ev.eventType ?? ''} ${leaving ? 'leaving' : 'entering'}`}
      title={`${slot.ev.toolName ?? 'tool'} — 눌러서 이 도구의 로그 보기`}
      onClick={() => !leaving && onOpen?.(slot.ev)}
      disabled={leaving}
    >
      <span className="tname">{slot.ev.toolName ?? 'tool'}</span>
      {!leaving && steps.length > 1 && (
        <span className="tstep">
          {Math.min(slot.key + 1, steps.length)}/{steps.length}
        </span>
      )}
    </button>
  );
  return (
    <div className="tool-activity">
      {out && chip(out, true)}
      {cur && chip(cur, false)}
    </div>
  );
};

/** TTS 용 텍스트 정리 — 코드블록/마크다운 기호/링크를 걷어내 읽을 문장만 남긴다. */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' 코드 블록. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 스트리밍 텍스트에서 "완결 문장까지" 잘라낼 위치를 찾는다 (없으면 0).
 *  문장부호(./!/?/…/。/！/？) + 공백/개행, 또는 빈 줄 경계. 너무 짧은 조각
 *  (MIN_TTS_CHUNK 미만)은 다음 경계까지 기다린다. */
const MIN_TTS_CHUNK = 12;
function sentenceCut(pending: string): number {
  let cut = 0;
  const re = /[.!?…。！？](?=["')\]]?(\s|$))|\n{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pending)) !== null) {
    const end = m.index + m[0].length;
    if (end >= MIN_TTS_CHUNK) cut = end;
  }
  return cut;
}

const AGENT_KIND: Record<string, string> = { canvas: 'Canvas', harness: 'Harness' };

const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CHAT_IMAGE_ACCEPT = [...CHAT_IMAGE_TYPES].join(',');
const CHAT_IMAGE_MAX_COUNT = 5;
const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

interface StagedChatImage extends ChatImageAttachment {
  id: string;
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('이미지를 읽지 못했습니다.'));
    reader.onerror = () => reject(reader.error ?? new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('지원하지 않거나 손상된 이미지입니다.'));
    image.src = dataUrl;
  });
}

function imageError(file: File): string | null {
  if (!CHAT_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return `${file.name || '이미지'}: PNG, JPEG, WebP, GIF 형식만 첨부할 수 있습니다.`;
  }
  if (file.size <= 0) return `${file.name || '이미지'}: 빈 파일은 첨부할 수 없습니다.`;
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return `${file.name || '이미지'}: 이미지 한 장은 10MB까지 첨부할 수 있습니다.`;
  }
  return null;
}

async function prepareChatImage(file: File): Promise<StagedChatImage> {
  const problem = imageError(file);
  if (problem) throw new Error(problem);
  const dataUrl = await fileAsDataUrl(file);
  const { width, height } = await imageDimensions(dataUrl);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    dataUrl,
    name: file.name || `붙여넣은 이미지.${file.type.split('/')[1] || 'png'}`,
    mime: file.type.toLowerCase(),
    size: file.size,
    width,
    height,
  };
}

export const Chat: React.FC<{
  session: SessionState;
  /** 로그인 사용자 표시 이름 — Teams 로 공유할 때 낙관적 렌더에 쓴다. */
  myName: string;
  mcpDebug?: boolean;
  /** 헤더 [...] 메뉴 → 에이전트 뷰어 탭을 연다 (메모리/작업/도구/스토리지/전체로그). */
  onOpenViewer?: (sub: AgentViewerSub) => void;
}> = ({ session, myName, mcpDebug = false, onOpenViewer }) => {
  const { agent } = session;
  const messages = session.messages;
  const streaming = session.streaming;
  const loadingHistory = session.loadingHistory;
  const notificationSnapshot = useNotifications();

  const [input, setInput] = useState('');
  // 로컬 그림 첨부 — 서버에 미리 업로드하지 않고, 전송 순간 멀티모달 content 로
  // 함께 보낸다. 대기 중인 data URL 은 이 Chat 컴포넌트와 열린 세션에만 남는다.
  const [stagedImages, setStagedImages] = useState<StagedChatImage[]>([]);
  const stagedImagesRef = useRef<StagedChatImage[]>([]);
  const browserSelections = useBrowserSelections(session.key);
  const browserSelectionsRef = useRef<BrowserSelectionResult[]>(browserSelections);
  browserSelectionsRef.current = browserSelections;
  const [preparingImages, setPreparingImages] = useState(0);
  const [imageNotice, setImageNotice] = useState('');
  // 화면 캡처 — 기본 꺼짐. 화면에는 다른 사람의 메시지·비밀번호·미공개 문서가
  // 있을 수 있어서, 서버로 보내는 것은 사용자가 명시적으로 골라야 한다.
  const [screenCaptureOn, setScreenCaptureOn] = useState(false);
  const [captureNotice, setCaptureNotice] = useState('');
  // 전체 도구 로그 — 흐름에는 하나씩 지나가게 두고, 필요할 때 여기서 펼친다.
  const [logFor, setLogFor] = useState<{ events: ToolEvent[]; initialOpen?: number } | null>(
    null,
  );
  // Teams 문맥 — 칩이 붙은 채 처음 보낼 때 확인창을 띄우고, 확인될 때까지
  // 사용자가 친 문장을 여기에 들고 있는다 (입력창은 이미 비워졌으므로).
  const [ctxConfirm, setCtxConfirm] = useState<{
    text: string;
    count: number;
    roomName: string;
    images: StagedChatImage[];
    browserSelections: BrowserSelectionResult[];
  } | null>(null);
  // 이 답변을 Teams 로 공유하는 중 — 본문을 들고 모달을 띄운다.
  const [shareBody, setShareBody] = useState<string | null>(null);
  // 사용자가 보낸 그림 확대 미리보기. data URL 은 열린 세션 메시지가 소유하므로
  // 별도 파일 접근이나 네트워크 요청 없이 그대로 보여 준다.
  const [previewImage, setPreviewImage] = useState<ChatImageAttachment | null>(null);
  // Teams 대화를 문맥으로 붙일 방을 고르는 중.
  const [ctxPicker, setCtxPicker] = useState(false);
  const [copiedAt, setCopiedAt] = useState(-1);
  const [mcpStatus, setMcpStatus] = useState<McpBridgeStatusLike | null>(null);
  const [mcpLogs, setMcpLogs] = useState<McpRuntimeLogEntryLike[]>([]);
  const [mcpLogsOpen, setMcpLogsOpen] = useState(false);
  const [notificationMenuOpen, setNotificationMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // ── Voice (STT/TTS) state ──────────────────────────────────────
  const [voiceCfg, setVoiceCfg] = useState<VoiceConfig | null>(null);
  const [localVoice, setLocalVoice] = useState({ input: true, output: true });
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [muted, setMuted] = useState(false);
  // 음성 합성 실패를 조용히 삼키지 않는다 — 마지막 오류를 잠깐 표시.
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Effective gates: server must enable AND this device must not have turned off.
  const sttOn = !!voiceCfg?.stt?.enabled && localVoice.input;
  const ttsOn = !!voiceCfg?.tts?.enabled && localVoice.output;

  // Mic capture refs.
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // TTS playback refs — a simple serial queue so replies never overlap.
  const ttsQueueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  // 기기 로컬 볼륨 (0~300%) — 100% 초과 부스트는 WebAudio GainNode 로.
  const volumeRef = useRef(100);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const bufferSrcRef = useRef<AudioBufferSourceNode | null>(null);
  // stopTts 세대 표식 — 중단 이후 도착한 이전 세대의 합성/재생 결과를 버린다.
  const ttsEpochRef = useRef(0);
  // Mirrors for use inside async/stream callbacks (avoid stale closures + dep churn).
  const mutedRef = useRef(muted);
  const ttsOnRef = useRef(ttsOn);
  // 이 세션에서 이미 읽어 준(TTS) assistant 텍스트 위치. 세션 전환으로
  // 재마운트되면 처음부터 다시 읽지 않도록, 마지막 answer 의 현재 길이에서 시작.
  const spokenRef = useRef<number | null>(null);
  const lastAsstIdxRef = useRef(-1);

  useEffect(() => {
    if (!mcpDebug) {
      setMcpStatus(null);
      return;
    }
    let alive = true;
    void xgen.mcp
      .status()
      .then((status) => alive && setMcpStatus(status))
      .catch(() => undefined);
    const off = xgen.mcp.onStatus((status) => setMcpStatus(status));
    return () => {
      alive = false;
      off();
    };
  }, [mcpDebug]);

  useEffect(() => {
    if (!mcpDebug) {
      setMcpLogs([]);
      setMcpLogsOpen(false);
      return;
    }
    let alive = true;
    void xgen.mcp
      .runtimeLogs()
      .then((logs) => alive && setMcpLogs(logs))
      .catch(() => undefined);
    const off = xgen.mcp.onRuntimeLog((entry) => {
      setMcpLogs((logs) => [...logs.slice(-199), entry]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [mcpDebug]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  }, [input]);

  const replaceStagedImages = useCallback((next: StagedChatImage[]) => {
    stagedImagesRef.current = next;
    setStagedImages(next);
  }, []);

  const addImageFiles = useCallback(
    async (files: File[]) => {
      const candidates = files.filter((file) => file.type.toLowerCase().startsWith('image/'));
      if (candidates.length === 0) {
        setImageNotice('이미지 파일을 선택하거나 클립보드에서 붙여넣어 주세요.');
        return;
      }

      setPreparingImages((count) => count + 1);
      const problems: string[] = [];
      try {
        for (const file of candidates) {
          const current = stagedImagesRef.current;
          const selected = browserSelectionsRef.current;
          if (current.length + selected.length >= CHAT_IMAGE_MAX_COUNT) {
            problems.push(
              `이미지는 한 번에 최대 ${CHAT_IMAGE_MAX_COUNT}장까지 첨부할 수 있습니다.`,
            );
            break;
          }
          const problem = imageError(file);
          if (problem) {
            problems.push(problem);
            continue;
          }
          const usedBytes =
            current.reduce((sum, image) => sum + image.size, 0) +
            selected.reduce((sum, selection) => sum + selection.image.size, 0);
          if (usedBytes + file.size > CHAT_IMAGE_MAX_TOTAL_BYTES) {
            problems.push('첨부 이미지의 전체 크기는 25MB를 넘을 수 없습니다.');
            break;
          }
          try {
            const image = await prepareChatImage(file);
            replaceStagedImages([...stagedImagesRef.current, image]);
          } catch (error) {
            problems.push(error instanceof Error ? error.message : '이미지를 읽지 못했습니다.');
          }
        }
      } finally {
        setPreparingImages((count) => Math.max(0, count - 1));
      }
      setImageNotice(problems[0] ?? '');
    },
    [replaceStagedImages],
  );

  const removeStagedImage = useCallback(
    (id: string) => {
      replaceStagedImages(stagedImagesRef.current.filter((image) => image.id !== id));
    },
    [replaceStagedImages],
  );

  const handleImagePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
      if (files.length === 0) return;
      event.preventDefault();
      void addImageFiles(files);
    },
    [addImageFiles],
  );

  useEffect(() => {
    if (!imageNotice) return;
    const timer = setTimeout(() => setImageNotice(''), 7000);
    return () => clearTimeout(timer);
  }, [imageNotice]);

  const endChat = useCallback(() => {
    browserSelectionStore.forgetSession(session.key);
    sessionStore.endChat(session.key);
  }, [session.key]);

  // ── TTS playback: serial queue over WebAudio (Geny 방식) ──
  // HTMLAudioElement + blob URL 은 CSP media-src 의 지배를 받고(누락 시
  // "no supported source" 로 조용히 죽는다) 재생 오류 이벤트가 이중 콜백
  // 레이스를 만든다. decodeAudioData + AudioBufferSourceNode 는 바이트를
  // 직접 디코드하므로 CSP/MIME 과 무관하고, onended 단일 경로로 직렬이 보장된다.
  const playNext = useCallback(async () => {
    if (playingRef.current) return;
    const text = ttsQueueRef.current.shift();
    if (!text) return;
    playingRef.current = true;
    const epoch = ttsEpochRef.current;
    try {
      const blob = await xgen.voice.speak(text);
      if (ttsEpochRef.current !== epoch) return;
      let ctx = audioCtxRef.current;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gainRef.current = gain;
      }
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      const bytes = await blob.arrayBuffer();
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(bytes.slice(0));
      } catch {
        // 디코드 실패 = 서버가 오디오가 아닌 것을 보냈다는 뜻 — 원인 추적이
        // 되도록 응답의 정체(타입/크기/시그니처)를 오류에 담는다.
        const head = new Uint8Array(bytes.slice(0, 4));
        const sig = String.fromCharCode(...head).replace(/[^\x20-\x7e]/g, '?');
        throw new Error(
          `오디오 디코드 실패 (type=${blob.type || '?'}, ${bytes.byteLength}B, head="${sig}")`,
        );
      }
      setVoiceError(null);
      if (ttsEpochRef.current !== epoch) return;
      if (gainRef.current) {
        gainRef.current.gain.value = Math.max(0, Math.min(300, volumeRef.current)) / 100;
      }
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = decoded;
        src.connect(gainRef.current ?? ctx.destination);
        src.onended = () => resolve();
        bufferSrcRef.current = src;
        src.start();
      });
    } catch (e) {
      // 합성/재생 실패 — 원인(예: 'TTS upstream 404: voice_profile_not_found...')
      // 을 잠깐 보여 준다. 큐의 다음 문장은 계속 시도한다.
      const msg = e instanceof Error && e.message ? e.message : '음성 합성에 실패했습니다.';
      setVoiceError(msg);
      if (voiceErrTimer.current) clearTimeout(voiceErrTimer.current);
      voiceErrTimer.current = setTimeout(() => setVoiceError(null), 6000);
    } finally {
      // 세대가 바뀌었으면(stopTts) 새 루프가 이미 소유권을 가진다 — 손대지 않는다.
      if (ttsEpochRef.current === epoch) {
        bufferSrcRef.current = null;
        playingRef.current = false;
        void playNext();
      }
    }
  }, []);

  const enqueueTts = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || mutedRef.current) return;
      ttsQueueRef.current.push(t);
      void playNext();
    },
    [playNext],
  );

  const stopTts = useCallback(() => {
    ttsQueueRef.current = [];
    ttsEpochRef.current += 1;
    try {
      bufferSrcRef.current?.stop();
    } catch {
      /* 이미 종료된 소스 */
    }
    bufferSrcRef.current = null;
    playingRef.current = false;
  }, []);

  useEffect(() => {
    // 화면 캡처 버튼을 작성기에서 숨긴 동안에는 예전에 저장된 on 설정도 반드시
    // 끈다. 토글이 보이지 않는데 화면이 전송되는 상태가 생기면 안 된다.
    const apply = (c: { screenCapture?: boolean }): void => {
      setScreenCaptureOn(false);
      if (c.screenCapture) void xgen.config.set({ screenCapture: false });
    };
    void xgen.config.get().then(apply);
    return xgen.config.onChange(apply);
  }, []);

  // 캡처 실패 안내는 잠깐만 — 다음 전송이 성공하면 지워진다.
  useEffect(() => {
    if (!captureNotice) return;
    const t = setTimeout(() => setCaptureNotice(''), 8000);
    return () => clearTimeout(t);
  }, [captureNotice]);

  const chip = useContextChip(session.key);

  /**
   * 실제 전송 — 확인이 끝난 뒤에만 불린다.
   *
   * 봉투는 **여기서, 매 턴** 준비한다. 한 번 만들어 두고 재사용하면 방금 오간
   * 말을 못 본 채 답하게 된다. 준비에 실패해도 전송은 막지 않는다 — 문맥은
   * 덤이고, 그것 때문에 사용자의 질문이 사라지면 그게 더 나쁘다.
   */
  const dispatch = useCallback(
    async (
      text: string,
      images: StagedChatImage[] = [],
      selections: BrowserSelectionResult[] = [],
    ) => {
      let shot: { dataUrl?: string; sourceName?: string; width?: number; height?: number } | null =
        null;
      if (screenCaptureOn) {
        try {
          const r = await xgen.capture.screen();
          if (r.ok && r.dataUrl) shot = r;
          else if (r.error) setCaptureNotice(r.error);
        } catch (e) {
          setCaptureNotice(e instanceof Error ? e.message : '화면을 캡처하지 못했습니다');
        }
      }
      try {
        await teamsContextStore.prepare(session.key);
      } catch {
        /* 문맥을 못 실었어도 질문은 보낸다 */
      }
      const selectionImages: StagedChatImage[] = selections.map((selection) => ({
        id: `browser:${selection.id}`,
        dataUrl: selection.image.dataUrl,
        name: selection.image.name,
        mime: selection.image.mime,
        size: selection.image.size,
        width: selection.image.width,
        height: selection.image.height,
      }));
      // 전송·스트림 수명은 스토어가 소유한다 — 이 뷰가 언마운트돼도(세션 전환)
      // 답변은 백그라운드에서 계속 도착한다.
      sessionStore.send(session.key, text, shot, [...images, ...selectionImages], selections);
    },
    [session.key, screenCaptureOn],
  );

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      // Quick Chat/STT 가 override 텍스트로 들어올 때 메인 작성기에 대기 중인 그림을
      // 몰래 가져가지 않는다. +/붙여넣기 그림은 해당 작성기에서 직접 보낼 때만 간다.
      const images = override === undefined ? stagedImagesRef.current : [];
      const selections = override === undefined ? browserSelectionsRef.current : [];
      const attachmentCount = images.length + selections.length;
      const attachmentBytes =
        images.reduce((sum, image) => sum + image.size, 0) +
        selections.reduce((sum, selection) => sum + selection.image.size, 0);
      if ((!text && attachmentCount === 0) || streaming || preparingImages > 0) return;
      if (attachmentCount > CHAT_IMAGE_MAX_COUNT) {
        setImageNotice(
          `이미지는 브라우저 캡처를 포함해 최대 ${CHAT_IMAGE_MAX_COUNT}장까지 보낼 수 있습니다.`,
        );
        return;
      }
      if (attachmentBytes > CHAT_IMAGE_MAX_TOTAL_BYTES) {
        setImageNotice('브라우저 캡처를 포함한 이미지 전체 크기는 25MB를 넘을 수 없습니다.');
        return;
      }
      if (override === undefined) {
        setInput('');
        replaceStagedImages([]);
        browserSelectionStore.clear(session.key);
      }

      // Teams 문맥이 붙어 있는데 아직 승인 전이면 **먼저 묻는다**. 남이 쓴 글이
      // 에이전트로 나가는 것이므로, 몇 건이 나가는지 보여 주고 동의를 받는다.
      // 같은 (세션·방·범위) 조합은 다시 묻지 않는다.
      const pendingChip = teamsContextStore.chipFor(session.key);
      if (pendingChip && !pendingChip.approved) {
        const count = await teamsContextStore.ensureLoaded(session.key);
        if (count > 0) {
          // 방 이름까지 들고 간다 — 확인창을 칩 상태에 매달아 두면, 그 사이
          // 칩이 사라질 때 붙잡아 둔 사용자의 문장까지 함께 증발한다.
          setCtxConfirm({
            text,
            count,
            roomName: pendingChip.roomName,
            images,
            browserSelections: selections,
          });
          return;
        }
        // 실을 게 없으면 물을 것도 없다 — 그냥 보낸다.
      }
      await dispatch(text, images, selections);
    },
    [input, streaming, preparingImages, session.key, dispatch, replaceStagedImages],
  );

  /** 확인창의 [보내기] — 승인 기록을 남기고 그대로 이어서 보낸다. */
  const confirmContext = useCallback(async () => {
    const held = ctxConfirm;
    if (!held) return;
    teamsContextStore.approve(session.key);
    setCtxConfirm(null);
    await dispatch(held.text, held.images, held.browserSelections);
  }, [ctxConfirm, session.key, dispatch]);

  /** 확인창의 [취소] — 사용자가 친 문장을 입력창에 그대로 돌려준다. */
  const cancelContext = useCallback(() => {
    setCtxConfirm((held) => {
      if (held) {
        setInput((current) => current || held.text);
        // 확인창이 떠 있는 동안에는 작성기를 조작할 수 없지만, 방어적으로 현재
        // 대기분과 합치고 최대 장수까지만 복원한다.
        const current = stagedImagesRef.current;
        const known = new Set(current.map((image) => image.id));
        replaceStagedImages(
          [...held.images.filter((image) => !known.has(image.id)), ...current].slice(
            0,
            CHAT_IMAGE_MAX_COUNT,
          ),
        );
        browserSelectionStore.restore(session.key, held.browserSelections);
      }
      return null;
    });
  }, [replaceStagedImages, session.key]);

  // 문맥 확인창도 Esc 로 취소된다 — 취소는 사용자의 문장을 입력창에 돌려준다.
  useModalDismiss(cancelContext, !!ctxConfirm);
  useModalDismiss(() => setCtxPicker(false), ctxPicker);
  useModalDismiss(() => setPreviewImage(null), !!previewImage);

  const stop = useCallback(() => {
    // 사용자가 멈추면 소리도 멈춘다 — 아직 안 읽은 문장을 마저 읽지 않는다.
    // 낭독 위치를 현재 끝으로 당겨, streaming=false 로 바뀔 때 TTS 감시가
    // 잔여분을 flush 하지 못하게 한다.
    stopTts();
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant') spokenRef.current = last.text.length;
    sessionStore.stop(session.key);
  }, [session.key, session.messages, stopTts]);

  // ── STT: push-to-talk mic capture (getUserMedia + MediaRecorder) ──
  const startRecording = useCallback(async () => {
    if (recording || transcribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) return;
        setTranscribing(true);
        try {
          const lang = voiceCfg?.stt?.language || undefined;
          const t = (await xgen.voice.transcribe(blob, lang)).trim();
          if (t) send(t);
        } catch {
          /* transcription failed — leave the input untouched */
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch {
      // Permission denied / no mic — reset state.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
    }
  }, [recording, transcribing, voiceCfg, send]);

  const stopRecording = useCallback(() => {
    const mr = mediaRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    mediaRef.current = null;
    setRecording(false);
  }, []);

  const toggleMic = useCallback(() => {
    if (recording) stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording]);

  // Load voice config (server hints) + device-local overrides; track live changes.
  useEffect(() => {
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 구버전 preload(업데이트 직후) / 목 하네스에는 voice 브릿지가 없을 수 있다.
    // 기동 직후 인증 준비 전 401 이면 몇 번 재시도해 TTS 가 영구히 꺼진 채
    // 남지 않게 한다. avatarRefresh(로그인 완료/설정 변경)에도 재조회.
    const loadVoice = () => {
      xgen.voice
        ?.getConfig?.()
        ?.then((c) => alive && setVoiceCfg(c))
        ?.catch(() => {
          if (alive && tries < 5) {
            tries += 1;
            timer = setTimeout(loadVoice, 2000);
          }
        });
    };
    loadVoice();
    const offRefresh = xgen.user?.onAvatarRefresh?.(() => {
      tries = 0;
      loadVoice();
    });
    xgen.config
      .get()
      .then((cfg) => {
        if (!alive) return;
        setLocalVoice({ input: cfg.voiceInput !== false, output: cfg.voiceOutput !== false });
        volumeRef.current = typeof cfg.voiceVolume === 'number' ? cfg.voiceVolume : 100;
      })
      .catch(() => undefined);
    const off = xgen.config.onChange((cfg) => {
      setLocalVoice({ input: cfg.voiceInput !== false, output: cfg.voiceOutput !== false });
      volumeRef.current = typeof cfg.voiceVolume === 'number' ? cfg.voiceVolume : 100;
      // 재생 중에도 즉시 반영
      if (gainRef.current)
        gainRef.current.gain.value = Math.max(0, Math.min(300, volumeRef.current)) / 100;
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offRefresh?.();
      off();
    };
  }, []);

  // Keep async-callback mirrors in sync; muting also stops in-flight playback.
  useEffect(() => {
    mutedRef.current = muted;
    if (muted) stopTts();
  }, [muted, stopTts]);
  useEffect(() => {
    ttsOnRef.current = ttsOn;
    if (!ttsOn) stopTts();
  }, [ttsOn, stopTts]);

  // ── 스트리밍 답변을 문장 단위로 읽어 준다 (foreground 세션만) ──
  // 스토어가 채운 마지막 assistant 메시지의 텍스트 증가분을 감시해, 완결 문장이
  // 생길 때마다 큐에 넣는다. 재마운트(세션 전환) 직후에는 이미 있는 텍스트를
  // 다시 읽지 않도록 현재 길이에서 시작한다.
  useEffect(() => {
    const idx = messages.length - 1;
    const last = messages[idx];
    if (!last || last.role !== 'assistant') return;
    if (idx !== lastAsstIdxRef.current) {
      lastAsstIdxRef.current = idx;
      spokenRef.current = last.text.length; // 새 턴/첫 마운트 — 기존 텍스트는 읽지 않음
    }
    if (spokenRef.current == null) spokenRef.current = last.text.length;
    if (!ttsOnRef.current) {
      spokenRef.current = last.text.length;
      return;
    }
    const pending = last.text.slice(spokenRef.current);
    if (!pending) return;
    if (last.streaming) {
      const cut = sentenceCut(pending);
      if (cut > 0) {
        const chunk = cleanForSpeech(pending.slice(0, cut));
        if (chunk) enqueueTts(chunk);
        spokenRef.current += cut;
      }
    } else {
      const tail = cleanForSpeech(pending);
      if (tail) enqueueTts(tail);
      spokenRef.current = last.text.length;
    }
  }, [messages, enqueueTts]);

  // Tear down mic + audio when the view unmounts / session switches.
  // NB: this does NOT cancel the chat stream — that lives in the store and must
  // survive a foreground switch (기존 세션 connector 유지).
  useEffect(
    () => () => {
      stopRecording();
      stopTts();
    },
    [stopRecording, stopTts],
  );

  // 아바타에게는 **이 세션에서 라이브로 흐르는 텍스트만** 준다 — 기록을 여는 것과
  // 말하는 것은 다른 일이다. 스트리밍 중인 마지막 answer 만 흘려보낸다.
  const liveText = useMemo(() => {
    if (!streaming) return '';
    const last = messages[messages.length - 1];
    return last?.role === 'assistant' ? last.text : '';
  }, [streaming, messages]);

  const avatarState: AvatarState = useMemo(
    () => ({
      workflowId: agent.workflowId,
      workflowName: agent.workflowName,
      streamingText: liveText,
      speaking: streaming,
    }),
    [liveText, streaming, agent],
  );

  // Feed the live state to the floating avatar overlay (a no-op if it's closed).
  useEffect(() => {
    xgen.overlay.pushState(avatarState);
  }, [avatarState]);

  // Quick-chat: a message from the global hotkey bar sends to this agent.
  useEffect(() => xgen.quickChat.onQuickSend((t) => send(t)), [send]);

  const kind = AGENT_KIND[agent.workflowType ?? ''] ?? (agent.workflowType || 'Agent');
  const mcpIndicator = mcpChatStatus(mcpStatus);
  const agentNotificationMuted = !!notificationSnapshot.profile.mutedAgents[agent.workflowId];
  const chatNotificationMuted =
    !!notificationSnapshot.profile.mutedChats[
      notificationChatKey(agent.workflowId, session.interactionId)
    ];
  const effectiveNotificationMuted = agentNotificationMuted || chatNotificationMuted;

  return (
    <div className="chat">
      <div className="chat-header">
        <div className="chat-title">
          <span className="agent-mark">
            <XgenMark height={18} variant="color" />
          </span>
          <div className="chat-title-text">
            <strong>{agent.workflowName}</strong>
            <div className="agent-meta">
              {kind}
              {agent.nodeCount ? ` · 노드 ${agent.nodeCount}개` : ''}
              {agent.isShared ? ' · 공유' : ''}
              {streaming ? ' · 진행 중' : session.resume ? ' · 이어보기' : ''}
            </div>
          </div>
        </div>
        <div className="chat-header-actions">
          <div className="teams-menu-wrap">
            <button
              className="secondary"
              onClick={() => setNotificationMenuOpen((open) => !open)}
              title="이 에이전트와 대화의 알림 설정"
              aria-label="알림 설정"
              aria-expanded={notificationMenuOpen}
            >
              {effectiveNotificationMuted ? <BellOffIcon size={15} /> : <BellIcon size={15} />}
            </button>
            {notificationMenuOpen && (
              <>
                <div className="teams-menu-scrim" onClick={() => setNotificationMenuOpen(false)} />
                <div className="teams-menu notification-scope-menu" role="menu">
                  <button
                    onClick={() => {
                      setNotificationMenuOpen(false);
                      void notificationStore.setChat(
                        agent.workflowId,
                        session.interactionId,
                        !chatNotificationMuted,
                        `${agent.workflowName} · 현재 대화`,
                      );
                    }}
                  >
                    {chatNotificationMuted ? <BellIcon size={14} /> : <BellOffIcon size={14} />}
                    {chatNotificationMuted ? '이 대화 알림 켜기' : '이 대화 알림 끄기'}
                  </button>
                  <button
                    onClick={() => {
                      setNotificationMenuOpen(false);
                      void notificationStore.setScope(
                        'agent',
                        agent.workflowId,
                        !agentNotificationMuted,
                        agent.workflowName,
                      );
                    }}
                  >
                    {agentNotificationMuted ? <BellIcon size={14} /> : <BellOffIcon size={14} />}
                    {agentNotificationMuted
                      ? '이 에이전트 알림 켜기'
                      : '이 에이전트 알림 모두 끄기'}
                  </button>
                  {agentNotificationMuted && (
                    <div className="notification-scope-hint">
                      에이전트 음소거가 모든 하위 대화보다 우선합니다.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          {mcpDebug && (
            <button
              type="button"
              className={`mcp-chat-status ${mcpIndicator.tone}`}
              title={mcpIndicator.title}
              aria-label={mcpIndicator.title}
              aria-expanded={mcpLogsOpen}
              onClick={() => setMcpLogsOpen((open) => !open)}
            >
              <span className="mcp-chat-status-dot" />
              {mcpIndicator.label}
            </button>
          )}
          {ttsOn && (
            <button
              className="secondary"
              onClick={() => setMuted((v) => !v)}
              title={muted ? '음성 출력 켜기' : '음성 출력 끄기'}
              aria-label={muted ? '음성 출력 켜기' : '음성 출력 끄기'}
            >
              {muted ? <SpeakerOffIcon size={15} /> : <SpeakerIcon size={15} />}
            </button>
          )}
          {/* 상단 탭은 [상세보기] [대화 종료] 둘만. 상세보기는 이 에이전트의 메모리·작업·
              도구·스토리지·전체로그를 새 탭으로 연다(에이전트 관측 뷰어). '새 대화'는
              에이전트를 다시 선택해 여는 흐름과 중복이라 제거. */}
          {onOpenViewer && (
            <button
              className="secondary"
              onClick={() => onOpenViewer('memory')}
              title="이 에이전트의 메모리·작업·도구·스토리지·전체로그를 새 탭으로 봅니다"
            >
              상세보기
            </button>
          )}
          <button
            className="secondary end-chat"
            onClick={endChat}
            title="이 대화를 종료하고 목록으로 돌아갑니다"
          >
            <CloseIcon size={14} /> 대화 종료
          </button>
        </div>
      </div>

      {mcpDebug && mcpLogsOpen && (
        <div className="mcp-runtime-log" role="log" aria-label="로컬 MCP 실행 로그">
          <div className="mcp-runtime-log-head">
            <strong>로컬 MCP 실행 로그</strong>
            <div className="row">
              <button
                className="link"
                onClick={() => {
                  void xgen.mcp.clearRuntimeLogs();
                  setMcpLogs([]);
                }}
                disabled={mcpLogs.length === 0}
              >
                초기화
              </button>
              <button className="link" onClick={() => setMcpLogsOpen(false)}>
                닫기
              </button>
            </div>
          </div>
          {mcpLogs.length === 0 ? (
            <div className="mcp-runtime-log-empty">현재 실행에서 기록된 도구 호출이 없습니다.</div>
          ) : (
            <div className="mcp-runtime-log-list">
              {[...mcpLogs].reverse().map((entry) => (
                <div
                  className={`mcp-runtime-log-entry ${entry.ok === false ? 'error' : ''}`}
                  key={entry.id}
                >
                  <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                  <span className="mcp-runtime-log-kind">{entry.kind}</span>
                  <span className="mcp-runtime-log-message">
                    {entry.server && entry.tool ? `${entry.server}.${entry.tool} · ` : ''}
                    {entry.message}
                    {entry.durationMs !== undefined ? ` · ${entry.durationMs}ms` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="chat-log" ref={scrollRef}>
        {loadingHistory ? (
          <div className="chat-empty">
            <p>대화를 불러오는 중…</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">
            <ChatIcon size={44} className="mark" />
            <h3>{agent.workflowName}</h3>
            <p>이 에이전트와 대화를 시작하세요.</p>
          </div>
        ) : (
          messages.map((m, i) => (
            (() => {
              // 트리거 턴 — 사용자 말풍선 대신 [Trigger] 1행 (+클릭 상세).
              const trig = m.role === 'user' ? parseAgentTrigger(m.text) : null;
              if (trig) {
                return (
                  <div key={i} className="msg-row trigger">
                    <TriggerRow trigger={trig} />
                  </div>
                );
              }
              return (
            <div key={i} className={`msg-row ${m.role}`}>
              {m.role === 'assistant' && (
                <div className="msg-avatar assistant">
                  <XgenMark height={18} variant="mono" />
                </div>
              )}
              <div className="msg-col">
                {m.role === 'assistant' && m.surface && (
                  <div
                    className={`exec-surface ${m.surface}`}
                    title={
                      m.surface === 'connector_local'
                        ? `이 PC 의 로컬 실행 환경(커넥터 사이드카)에서 실행 중 — 기억·파일은 서버와 공유${m.surfaceNote ? ` (${m.surfaceNote})` : ''}`
                        : m.surface === 'blocked'
                          ? `실행이 차단되었습니다${m.surfaceNote ? ` — ${m.surfaceNote}` : ''}`
                          : `서버 sandbox 에서 실행${m.surfaceNote ? ` — ${m.surfaceNote}` : ''}`
                    }
                  >
                    {m.surface === 'connector_local'
                      ? `이 PC에서 실행${m.surfaceNote ? ` — ${m.surfaceNote}` : ''}`
                      : m.surface === 'blocked'
                        ? `실행 차단${m.surfaceNote ? ` — ${m.surfaceNote}` : ''}`
                        : `서버에서 실행${m.surfaceNote ? ` — ${m.surfaceNote}` : ''}`}
                  </div>
                )}
                {m.tools && m.tools.length > 0 && (
                  <ToolActivity
                    events={m.tools}
                    streaming={!!m.streaming}
                    onOpen={(ev) => {
                      // 클릭 시점의 스냅숏 — 지나간 칩의 "그 시점"이 그대로 열린다.
                      const events = [...(m.tools ?? [])];
                      const at = events.lastIndexOf(ev);
                      setLogFor({ events, initialOpen: at >= 0 ? at : undefined });
                    }}
                  />
                )}
                <div
                  className={`bubble ${m.role} ${m.error ? 'error' : ''}${m.images?.length ? ' has-images' : ''}`}
                >
                  {/* 어시스턴트 답변은 웹 채팅과 동일하게 마크다운 렌더 —
                      볼드/리스트/표/코드블록/링크. 사용자가 입력한 메시지는
                      리터럴 텍스트라 평문(pre-wrap)으로 둔다. */}
                  {m.role === 'assistant' ? (
                    m.text ? (
                      <Markdown text={m.text} />
                    ) : (
                      m.streaming && <span className="cursor" />
                    )
                  ) : (
                    <>
                      {m.images && m.images.length > 0 && (
                        <div
                          className={`chat-message-images count-${Math.min(m.images.length, 4)}`}
                          aria-label={`첨부 이미지 ${m.images.length}장`}
                        >
                          {m.images.map((image, imageIndex) => (
                            <button
                              key={`${image.name}-${imageIndex}`}
                              type="button"
                              className="chat-message-image-button"
                              onClick={() => setPreviewImage(image)}
                              aria-label={`${image.name || `첨부 이미지 ${imageIndex + 1}`} 확대 보기`}
                              title={
                                image.width && image.height
                                  ? `${image.name} · ${image.width}×${image.height} · 클릭하여 확대`
                                  : `${image.name} · 클릭하여 확대`
                              }
                            >
                              <img
                                src={image.dataUrl}
                                alt={image.name || `첨부 이미지 ${imageIndex + 1}`}
                              />
                            </button>
                          ))}
                        </div>
                      )}
                      {m.text && <span className="bubble-plain">{m.text}</span>}
                    </>
                  )}
                  {m.role === 'assistant' && m.text && m.streaming && <span className="cursor" />}
                </div>
                {/* 이 메시지와 함께 화면이 나갔다는 사실을 남긴다. 대화 기록만
                    봐도 언제 무엇을 보냈는지 알 수 있어야 한다. */}
                {m.screenshot && (
                  <div className="shot-note" title={`${m.screenshot.width}×${m.screenshot.height}`}>
                    <MonitorIcon size={11} />
                    <span>화면 첨부 · {m.screenshot.sourceName}</span>
                  </div>
                )}
                {m.browserSelections && m.browserSelections.length > 0 && (
                  <div className="browser-context-note">
                    <BrowserIcon size={11} />
                    <span>
                      브라우저 컨텍스트 ·{' '}
                      {m.browserSelections
                        .map(
                          (selection) =>
                            `${selection.kind === 'element' ? '요소' : '영역'} ${selection.elementCount}개`,
                        )
                        .join(', ')}
                    </span>
                  </div>
                )}
                {/* 답변에 딸린 행동. **끝난 뒤에만** 보인다 — 스트리밍 중에
                    공유하면 잘린 글이 방에 남고, 방에는 삭제가 없다.
                    복사는 main 의 clipboard 를 쓴다: 렌더러 navigator.clipboard 는
                    Electron 에서 권한/보안 컨텍스트 때문에 조용히 실패할 수 있다. */}
                {/* 푸터 한 줄 — 좌: 복사/공유(호버에만), 우: 전체 로그(상시).
                    한 row 로 붙어야 답변 하단이 두 줄로 널뛰지 않는다. */}
                {m.role === 'assistant' &&
                  !m.streaming &&
                  ((!!m.text && !m.error) || (m.tools && m.tools.length > 0)) && (
                    <div className="msg-footer">
                      {!!m.text && !m.error && (
                        <div className="msg-actions">
                          <button
                            onClick={() => {
                              void copyText(m.text).then((ok) => {
                                if (!ok) return;
                                setCopiedAt(i);
                                window.setTimeout(
                                  () => setCopiedAt((at) => (at === i ? -1 : at)),
                                  1200,
                                );
                              });
                            }}
                            title="답변 복사"
                          >
                            <CopyIcon size={13} /> {copiedAt === i ? '복사됨' : '복사'}
                          </button>
                          <button
                            onClick={() => setShareBody(m.text)}
                            title="이 답변을 Teams 방에 공유"
                          >
                            <ShareIcon size={13} /> Teams로 공유
                          </button>
                        </div>
                      )}
                      {/* 전체 도구 로그 — 흐름의 도구 칩은 하나씩 지나가므로,
                          무엇이 있었는지 되짚으려면 펼칠 곳이 필요하다. */}
                      {m.tools && m.tools.length > 0 && (
                        <button
                          className="toollog-open"
                          onClick={() => setLogFor({ events: [...(m.tools ?? [])] })}
                        >
                          전체 로그 보기 · {m.tools.length}건
                        </button>
                      )}
                    </div>
                  )}
                {m.citations && m.citations.length > 0 && (
                  <div className="citations">
                    <span className="label">출처</span>
                    {m.citations.map((c: Citation, j: number) => (
                      <span className="cite-pill" key={j} title={c.fileName}>
                        <DocIcon size={11} />
                        <span className="fname">
                          {c.fileName ?? '문서'}
                          {c.pageNumber ? ` p.${c.pageNumber}` : ''}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
              );
            })()
          ))
        )}
      </div>

      <div className="chat-input">
        {voiceError && (
          <div className="voice-error small" title={voiceError}>
            음성 재생 실패: {voiceError}
          </div>
        )}
        {logFor && (
          <ToolLogModal
            events={logFor.events}
            initialOpen={logFor.initialOpen}
            onClose={() => setLogFor(null)}
          />
        )}
        {captureNotice && (
          <div className="voice-error small" title={captureNotice}>
            화면을 첨부하지 못했습니다: {captureNotice}
          </div>
        )}
        {imageNotice && (
          <div className="voice-error small" title={imageNotice} role="status">
            {imageNotice}
          </div>
        )}
        {/* Teams 문맥 칩 — 켜져 있다는 사실이 **항상** 보여야 한다. 화면 캡처
            토글과 같은 원칙이다: 켜 둔 것을 잊고 남의 대화를 흘려보내는 것이
            이 기능의 유일한 위험이다. */}
        {chip ? (
          <div className="teams-ctx" role="status">
            <TeamsIcon size={13} />
            <span className="teams-ctx-name" title={chip.roomName}>
              {chip.roomName}
            </span>
            <span className="teams-ctx-sep">·</span>
            <label className="teams-ctx-range">
              최근
              <select
                value={chip.limit}
                onChange={(e) => teamsContextStore.setLimit(session.key, Number(e.target.value))}
                aria-label="함께 보낼 대화 범위"
              >
                {CONTEXT_LIMIT_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n}건
                  </option>
                ))}
              </select>
            </label>
            {chip.available > 0 && chip.available < chip.limit && (
              <span className="teams-ctx-actual">(실제 {chip.available}건)</span>
            )}
            <button
              className="teams-ctx-change"
              onClick={() => setCtxPicker(true)}
              title="다른 대화로 바꾸기"
            >
              변경
            </button>
            <span className="teams-ctx-note">이 대화가 에이전트에게 함께 전달됩니다</span>
            <button
              className="teams-ctx-off"
              onClick={() => teamsContextStore.dismiss(session.key)}
              title="이 대화에서 Teams 문맥 끄기"
              aria-label="Teams 문맥 끄기"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ) : (
          <button
            className="teams-ctx-add"
            onClick={() => setCtxPicker(true)}
            title="Teams 대화를 골라 이 에이전트에게 함께 전달합니다"
          >
            <TeamsIcon size={12} /> Teams 대화 붙이기
          </button>
        )}
        <input
          ref={imageInputRef}
          className="composer-image-input"
          type="file"
          accept={CHAT_IMAGE_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (files.length > 0) void addImageFiles(files);
          }}
        />
        {stagedImages.length > 0 && (
          <div className="composer-images" aria-label={`전송 대기 이미지 ${stagedImages.length}장`}>
            {stagedImages.map((image) => (
              <div className="composer-image" key={image.id}>
                <img src={image.dataUrl} alt="" />
                <span className="composer-image-name" title={image.name}>
                  {image.name}
                </span>
                <button
                  type="button"
                  onClick={() => removeStagedImage(image.id)}
                  title={`${image.name} 첨부 취소`}
                  aria-label={`${image.name} 첨부 취소`}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {browserSelections.length > 0 && (
          <div
            className="composer-images browser-context-images"
            aria-label={`전송 대기 브라우저 컨텍스트 ${browserSelections.length}개`}
          >
            {browserSelections.map((selection) => {
              const first = selection.elements[0];
              const label =
                selection.kind === 'element'
                  ? first?.name || first?.text || first?.tag || '요소'
                  : `선택 영역 · 요소 ${selection.elements.length}개`;
              return (
                <div className="composer-image browser-context-image" key={selection.id}>
                  <img src={selection.image.dataUrl} alt="" />
                  <span className="composer-image-name" title={`${selection.title} · ${label}`}>
                    {label}
                  </span>
                  <span className="browser-context-source" title={selection.title}>
                    <BrowserIcon size={10} /> {selection.title || '브라우저'}
                  </span>
                  <button
                    type="button"
                    onClick={() => browserSelectionStore.remove(session.key, selection.id)}
                    title="브라우저 컨텍스트 첨부 취소"
                    aria-label="브라우저 컨텍스트 첨부 취소"
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={taRef}
            className="composer-input"
            value={input}
            placeholder={
              stagedImages.length > 0 || browserSelections.length > 0
                ? '첨부한 화면이나 요소에 대해 질문해 보세요…'
                : '메시지를 입력하세요…'
            }
            onChange={(e) => setInput(e.target.value)}
            onPaste={handleImagePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            spellCheck={false}
          />
          {/* 화면 캡처 버튼은 이미지 첨부 버튼으로 교체하여 임시 비활성화.
          <button
            className={`composer-shot${screenCaptureOn ? ' on' : ''}`}
            onClick={() => void xgen.config.set({ screenCapture: !screenCaptureOn })}
            disabled={streaming}
            title={
              screenCaptureOn
                ? '화면 첨부 켜짐 — 보낼 때마다 지금 화면이 함께 전송됩니다. 눌러서 끄기'
                : '화면 첨부 — 메시지를 보낼 때 지금 화면을 함께 보냅니다'
            }
            aria-label="화면 첨부"
            aria-pressed={screenCaptureOn}
          >
            <MonitorIcon size={16} />
          </button>
          */}
          <button
            type="button"
            className="composer-attach"
            onClick={() => imageInputRef.current?.click()}
            disabled={
              streaming ||
              preparingImages > 0 ||
              stagedImages.length + browserSelections.length >= CHAT_IMAGE_MAX_COUNT
            }
            title={
              stagedImages.length + browserSelections.length >= CHAT_IMAGE_MAX_COUNT
                ? `이미지는 최대 ${CHAT_IMAGE_MAX_COUNT}장까지 첨부할 수 있습니다`
                : preparingImages > 0
                  ? '이미지를 준비하는 중…'
                  : '이미지 첨부'
            }
            aria-label="이미지 첨부"
          >
            <PlusIcon size={17} />
          </button>
          {sttOn && (
            <button
              className={`composer-mic${recording ? ' recording' : ''}`}
              onClick={toggleMic}
              disabled={transcribing || streaming}
              title={transcribing ? '변환 중…' : recording ? '녹음 중지' : '음성 입력'}
              aria-label="음성 입력"
            >
              {transcribing ? '…' : recording ? <StopIcon size={15} /> : <MicIcon size={16} />}
            </button>
          )}
          {streaming ? (
            <button className="composer-send stop" onClick={stop} title="중지" aria-label="중지">
              <StopIcon size={15} />
            </button>
          ) : (
            <button
              className="composer-send"
              onClick={() => void send()}
              disabled={
                (!input.trim() && stagedImages.length === 0 && browserSelections.length === 0) ||
                preparingImages > 0
              }
              title="전송"
              aria-label="전송"
            >
              <SendIcon size={17} />
            </button>
          )}
        </div>
        <div className="composer-foot">
          <span className="kbd-hint">
            <kbd>Enter</kbd> 전송 · <kbd>Shift + Enter</kbd> 줄바꿈
          </span>
          <span className="composer-image-hint">이미지는 붙여넣기 또는 + · 최대 5장</span>
        </div>
      </div>

      {previewImage && (
        <div
          className="modal-backdrop chat-image-preview"
          role="dialog"
          aria-modal="true"
          aria-label={`${previewImage.name} 이미지 미리보기`}
          onClick={() => setPreviewImage(null)}
        >
          <div className="chat-image-preview-dialog" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="chat-image-preview-close"
              onClick={() => setPreviewImage(null)}
              title="미리보기 닫기"
              aria-label="이미지 미리보기 닫기"
            >
              <CloseIcon size={16} />
            </button>
            <img src={previewImage.dataUrl} alt={previewImage.name} />
            <div className="chat-image-preview-caption">
              <span title={previewImage.name}>{previewImage.name}</span>
              {previewImage.width && previewImage.height && (
                <small>
                  {previewImage.width}×{previewImage.height}
                </small>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 남이 쓴 글이 에이전트로 나가기 전 마지막 확인. 건수를 **정확히** 적는다 —
          "대화 내용" 같은 뭉뚱그린 표현은 동의를 받은 것이 아니다. */}
      {ctxConfirm && (
        <div className="modal-backdrop" onClick={cancelContext}>
          <div className="modal teams-ctx-confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Teams 대화를 함께 보냅니다</h3>
            <p className="teams-ctx-confirm-lead">
              <strong>{ctxConfirm.roomName}</strong> 의 메시지 <strong>{ctxConfirm.count}건</strong>{' '}
              이<strong> {agent.workflowName}</strong> 에이전트로 전송됩니다.
            </p>
            <p className="teams-ctx-confirm-sub">
              다른 사람이 쓴 글이 포함됩니다. 이 대화에서 같은 방·같은 범위로 보낼 때는 다시 묻지
              않습니다.
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={cancelContext}>
                취소
              </button>
              <button className="primary" onClick={() => void confirmContext()}>
                보내기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Teams 대화 붙이기 — 저절로 붙는 경로는 없다. 사용자가 여기서 고른
          방만 문맥이 된다. 고르는 즉시 확정되고 창은 닫힌다. */}
      {ctxPicker && (
        <div className="modal-backdrop" onClick={() => setCtxPicker(false)}>
          <div className="modal teams-share" onClick={(e) => e.stopPropagation()}>
            <h3>어느 대화를 함께 보낼까요?</h3>
            <p className="teams-ctx-confirm-sub">
              고른 대화의 최근 메시지가 <strong>{agent.workflowName}</strong> 에이전트에게 함께
              전달됩니다. 보내기 전에 몇 건인지 다시 확인합니다.
            </p>
            <TeamsRoomList
              selectedId={chip?.roomId}
              onPick={(room) => {
                teamsContextStore.pickRoom(session.key, room);
                setCtxPicker(false);
              }}
            />
            <p className="modal-hint">
              바깥을 클릭하거나 <kbd>Esc</kbd> 를 누르면 닫힙니다.
            </p>
          </div>
        </div>
      )}

      {shareBody !== null && (
        <ShareToTeamsModal
          body={shareBody}
          myName={myName}
          shareRef={{
            kind: 'agent',
            label: agent.workflowName,
            workflowId: agent.workflowId,
            interactionId: session.interactionId,
          }}
          onClose={() => setShareBody(null)}
        />
      )}
    </div>
  );
};
