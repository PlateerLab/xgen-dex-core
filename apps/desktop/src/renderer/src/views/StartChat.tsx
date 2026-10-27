/**
 * 시작 화면: "오늘은 무엇을 해볼까요?" (2026-10-09).
 *
 * 사이드바 [+ 새 채팅] 과 앱을 처음 켰을 때 서는 화면이다. 웹 Agent 작업실의 시작 화면과 같은 구조다:
 * 가운데에 제목과 에이전트 고르기(기본은 "새 에이전트로 시작"), 새 에이전트면 이름·모델·[세부설정],
 * 바닥에 입력창. 적고 보내면 (새 에이전트면 만들고) 그 에이전트와의 대화가 열리며 적은 말이 첫 메시지로 간다.
 *
 * 입력창은 보낼 수 있을 때만 열린다. 새 에이전트는 이름이 있고 겹치지 않아야 하며(적는 대로 서버에
 * 묻는다), 모델 목록이 와 있어야 한다. 잠긴 입력창을 누르면 무엇이 빠졌는지 알려 주고 이름 칸으로 간다.
 * 예전의 [새 에이전트] 화면(만들고 대화 시작)은 이 화면이 대신한다.
 *
 * 첫 메시지와 함께 파일을 줄 수 있다(2026-10-11): [+]·붙여넣기·끌어다 놓기. 검사는 대화 화면과
 * 같은 곳(chat-attach)에서 하고, 올려 둔 파일은 첫 메시지와 함께 그 대화로 간다.
 *
 * 말로도 시작한다(2026-10-28). 대화 화면에서 켜 둔 계속 듣기는 이 화면이 이어 듣고(voice-loop-owner — 말로 "새 에이전트
 * 만들어 줘" 하면 열린다, main fast-act-dex), 들은 말이 첫 메시지가 되며 연 대화가 다시 이어 듣는다. 말로는 이름 칸을
 * 채울 수 없으니 비어 있으면 겹치지 않는 이름("새 에이전트", "새 에이전트 2" …)을 붙인다.
 *
 * 이 화면을 연 대화에 폴더가 연결돼 있으면 새 대화도 그 폴더로 시작한다(같은 작업 공간에서 새 대화). 무엇을 잇는지
 * 입력창 위에 보이고 빼낼 수 있다. 경로는 main 이 그 대화의 연결에서만 옮긴다(chatFolders.inherit).
 */
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentCreateOptions } from '@dex/protocol';
import { xgen } from '../bridge';
import { sessionStore } from '../session';
import { agentDirectory, useAgentDirectory } from '../agent-directory';
import { CloseIcon, DocIcon, FolderIcon, MicIcon, PlusIcon, SendIcon } from '../brand/icons';
import { Selector, type SelectorOption } from './Selector';
import { ordered, readPick, SettingField, writePick } from './agent-create-fields';
import { freeAgentName, lockedByName, NAME_REQUIRED, NAME_TAKEN, startChatLockReason } from './start-chat-model';
import {
  CHAT_IMAGE_ACCEPT,
  CHAT_IMAGE_MAX_COUNT,
  pastedFiles,
  stageChatFiles,
  type StagedChatImage,
} from './chat-attach';
import { DropTracker, dragHasFiles } from './chat-drop';
import { useDocumentPasteAttach } from './use-paste-attach';
import { useChatInputCheck } from './use-chat-input-check';
import { useVoiceLoop, useVoiceStreamAvailable } from '../voice/voice-loop';
import { useVoiceLoopOwner, voiceLoopOwner } from '../voice/voice-loop-owner';
import { VoiceLoopBar } from '../voice/VoiceLoopBar';
import { createVoiceInputTracker } from '../voice/voice-input';
import { parseWakeWords } from '../../../main/voice-wake';
import type { ChatFolderView } from '../../../main/chat-folders';

/** 에이전트 고르기의 첫 칸(기본값). */
const NEW_AGENT = '__new_agent__';
/** 적는 동안 이름이 겹치는지 묻는 간격. */
const NAME_CHECK_DELAY_MS = 300;
/**
 * 이 화면의 계속 듣기가 main 에 대는 이름 — 아직 에이전트가 없다. main 은 이 이름의 브라우저 탭을 찾지 못하니
 * 탭 없는 화면(앱·DeX 명령 후보)에서 판단하고, 호출어만 말한 뒤 기다리는 시간도 이 이름으로 잰다.
 */
const START_VOICE_KEY = 'start-chat';

export function StartChat({
  onStarted,
  voiceKey = 'start:agent-create',
  fromInteractionId = null,
}: {
  /** 대화가 열렸다 — 그 대화 세션 키. */
  onStarted: (sessionKey: string) => void;
  /** 계속 듣기를 맡을 때의 이름(voice-loop-owner). */
  voiceKey?: string;
  /** 이 화면을 연 대화 — 폴더 연결을 잇는다. */
  fromInteractionId?: string | null;
}) {
  const dir = useAgentDirectory();
  const [choice, setChoice] = useState<string>(NEW_AGENT);
  const [options, setOptions] = useState<AgentCreateOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [advanced, setAdvanced] = useState(false);
  const [nameCheck, setNameCheck] = useState<{ name: string; taken: boolean } | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameAlert, setNameAlert] = useState(false);
  const [staged, setStaged] = useState<StagedChatImage[]>([]);
  const stagedRef = useRef<StagedChatImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(new DropTracker());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const alive = useRef(true);
  // 연 대화의 폴더 — 새 대화로 잇는다(빼낼 수 있다).
  const [folders, setFolders] = useState<ChatFolderView[]>([]);
  useEffect(() => {
    if (!fromInteractionId) return undefined;
    let cancelled = false;
    void xgen.chatFolders
      ?.list(fromInteractionId)
      .then((list) => {
        if (!cancelled) setFolders(list.filter((f) => !f.missing));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fromInteractionId]);

  useEffect(() => {
    alive.current = true;
    void agentDirectory.load();
    return () => {
      alive.current = false;
    };
  }, []);

  // 제공사·모델·설정은 서버가 노드에서 읽어 내려 준다. 마지막에 고른 제공사·모델을 기억해 둔다.
  useEffect(() => {
    let cancelled = false;
    void xgen.agents
      .createOptions()
      .then((data) => {
        if (cancelled) return;
        setOptions(data);
        const saved = readPick();
        const first =
          data.providers.find((p) => p.value === saved.provider) ??
          data.providers.find((p) => p.value === data.defaultProvider) ??
          data.providers[0];
        if (first) {
          setProvider(first.value);
          const savedModel =
            saved.provider === first.value && first.models.some((m) => m.value === saved.model) ? saved.model : '';
          setModel(savedModel || first.defaultModel || first.models[0]?.value || '');
        }
        // 설정마다 제 기본값을 심어 둔다. 비어 보이면 값이 없는 줄 안다.
        const seeded: Record<string, unknown> = {};
        for (const setting of data.settings) seeded[setting.id] = setting.default;
        setSettings(seeded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setOptionsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isNew = choice === NEW_AGENT;

  // 이름이 겹치는지 적는 대로 묻는다(잠깐 멈추면). 보낼 때 가서야 겹친다고 하면 이미 할 말까지 다 적은 뒤다.
  useEffect(() => {
    const trimmed = name.trim();
    if (!isNew || !trimmed) {
      setNameCheck(null);
      return undefined;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void xgen.agents
        .nameTaken(trimmed)
        .then((taken) => {
          if (!cancelled) setNameCheck({ name: trimmed, taken });
        })
        .catch(() => {
          if (!cancelled) setNameCheck(null);
        });
    }, NAME_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [name, isNew]);

  const nameTaken = isNew && !!nameCheck && nameCheck.name === name.trim() && nameCheck.taken;
  const selectedAgent = isNew ? null : (dir.agents.find((a) => a.workflowId === choice) ?? null);
  // 통제 정책 입력창 사전 검사. 새 에이전트는 아직 id 가 없다(예외가 없으니 모든 정책으로 본다: 서버도 같다).
  const policy = useChatInputCheck(input, selectedAgent?.workflowId ?? null);
  const lockReason = startChatLockReason({
    isNew,
    name,
    nameTaken,
    optionsReady: !!options,
    optionsError,
    agentSelected: !!selectedAgent,
  });
  const locked = lockReason !== null;

  const agentOptions = useMemo<SelectorOption[]>(
    () => [
      { value: NEW_AGENT, label: '새 에이전트로 시작', keywords: '새 에이전트' },
      ...dir.agents.map((a) => ({ value: a.workflowId, label: a.workflowName, keywords: a.workflowName })),
    ],
    [dir.agents],
  );

  const current = useMemo(() => options?.providers.find((p) => p.value === provider) ?? null, [options, provider]);

  const changeProvider = useCallback(
    (next: string) => {
      setProvider(next);
      // 모델은 제공사에 딸린 것이다. 그대로 두면 OpenAI 모델 이름으로 Anthropic 을 부르는 에이전트가 생긴다.
      const info = options?.providers.find((p) => p.value === next);
      setModel(info?.defaultModel || info?.models[0]?.value || '');
    },
    [options],
  );

  /** 잠긴 입력창을 눌렀다: 무엇이 빠졌는지 알리고 이름 칸으로 간다. */
  const explainLock = useCallback(() => {
    if (!lockReason) return;
    setError(lockReason);
    if (isNew && lockedByName(lockReason)) {
      setNameAlert(true);
      nameRef.current?.focus();
    }
  }, [isNew, lockReason]);

  useEffect(() => {
    if (!nameAlert) return;
    const id = window.setTimeout(() => setNameAlert(false), 1200);
    return () => window.clearTimeout(id);
  }, [nameAlert]);

  // 잠금이 풀리면 남아 있던 잠금 안내를 거둔다.
  useEffect(() => {
    if (!locked && (error === NAME_REQUIRED || error === NAME_TAKEN)) setError(null);
  }, [locked, error]);

  const replaceStaged = useCallback((next: StagedChatImage[]) => {
    stagedRef.current = next;
    setStaged(next);
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      setPreparing((count) => count + 1);
      let problem: string | null = null;
      try {
        problem = await stageChatFiles(
          files,
          () => ({
            count: stagedRef.current.length,
            bytes: stagedRef.current.reduce((sum, image) => sum + image.size, 0),
          }),
          (image) => replaceStaged([...stagedRef.current, image]),
        );
      } finally {
        if (alive.current) setPreparing((count) => Math.max(0, count - 1));
      }
      if (alive.current && problem) setError(problem);
    },
    [replaceStaged],
  );
  // 작성기에 포커스가 없을 때의 붙여넣기도 받는다(끌어다 놓기처럼 만드는 중에는 받지 않는다).
  const pasteFilesFromPage = useCallback((files: File[]) => void addFiles(files), [addFiles]);
  useDocumentPasteAttach(!busy, inputRef, pasteFilesFromPage);

  // 끌어다 놓기: 화면 어디에 놓아도 첨부된다(대화 화면과 같은 규칙).
  const dragProps = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (busy || !dragHasFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      if (dragDepth.current.enter()) setDragOver(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (busy || !dragHasFiles(event.dataTransfer?.types)) return;
      // preventDefault 가 없으면 창이 그 파일을 열어 버린다.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      if (dragDepth.current.leave()) setDragOver(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current.reset();
      setDragOver(false);
      if (busy) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void addFiles(files);
    },
  };

  /** voiceText = 말로 보낸다 — 이름이 비어 있으면 겹치지 않는 이름을 붙인다(말로는 이름 칸을 채울 수 없다). */
  const send = useCallback(async (voiceText?: string) => {
    if (busy || preparing > 0) return;
    let agentName = name;
    if (voiceText !== undefined && isNew && !name.trim()) {
      const free = await freeAgentName((n) => xgen.agents.nameTaken(n)).catch(() => null);
      if (!alive.current) return;
      if (!free) {
        setError(NAME_REQUIRED);
        return;
      }
      agentName = free;
      setName(free);
    }
    const reason =
      voiceText === undefined
        ? lockReason
        : startChatLockReason({ isNew, name: agentName, nameTaken: agentName === name && nameTaken, optionsReady: !!options, optionsError, agentSelected: !!selectedAgent });
    if (reason) {
      if (voiceText === undefined) explainLock();
      else setError(reason);
      return;
    }
    const text = (voiceText ?? input).trim();
    const files = stagedRef.current;
    if (!text && files.length === 0) return;
    // 통제 정책: 첫 메시지가 막힐 글이면 에이전트를 만들지도, 대화를 열지도 않는다. 이유는 작성기 위에 선다.
    if (text && !(await policy.confirm(text))) return;
    setBusy(true);
    setError(null);
    try {
      let agent: Agent;
      if (isNew) {
        const trimmed = agentName.trim();
        // 만들기 직전에 한 번 더 묻는다(적는 사이 누가 같은 이름을 만들었을 수 있다).
        if (await xgen.agents.nameTaken(trimmed)) {
          if (!alive.current) return;
          setNameCheck({ name: trimmed, taken: true });
          setError(NAME_TAKEN);
          nameRef.current?.focus();
          return;
        }
        const created = await xgen.agents.create({ name: trimmed, provider, model, settings });
        writePick(provider, model);
        // 서버가 무엇으로 만들었는지 말한다. 관리자가 Agent Geny 를 꺼 두면 Agent Xgen(입력 · 에이전트 · 출력)이다.
        // 옛 서버는 말하지 않는다: 그때는 예전처럼 Agent Geny 하나로 본다.
        const genyCreated = !created.agentNodeType || created.agentNodeType.startsWith('agents/geny');
        agent = {
          id: 0,
          workflowId: created.workflowId,
          workflowName: created.workflowName,
          nodeCount: created.nodeCount ?? 1,
          isShared: false,
          isDeployed: false,
          isCompleted: true,
          description: '',
          username: '',
          fullName: '',
          createdAt: '',
          updatedAt: '',
          // Agent Geny 면 이 표시가 있어야 스토어가 첨부를 그림만 남기고 거르지 않는다.
          hasAgentGeny: genyCreated,
        };
        agentDirectory.add(agent);
      } else if (selectedAgent) {
        agent = selectedAgent;
      } else {
        return;
      }
      const key = sessionStore.openNew(agent);
      // 폴더는 첫 메시지 전에 — 첫 요청부터 그 폴더를 쓴다(main 이 요청마다 이 대화의 폴더를 싣는다).
      const iid = sessionStore.get(key)?.interactionId;
      if (fromInteractionId && iid && folders.length) {
        await xgen.chatFolders
          .inherit(
            fromInteractionId,
            iid,
            folders.map((f) => f.id),
          )
          .catch(() => undefined);
      }
      sessionStore.send(key, text, null, files);
      // 이 화면이 듣고 있었으면 연 대화가 이어 듣는다.
      voiceLoopOwner.pass(voiceKey, key);
      onStarted(key);
    } catch (err: unknown) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [busy, preparing, lockReason, explainLock, input, isNew, name, nameTaken, options, optionsError, provider, model, settings, selectedAgent, onStarted, policy, fromInteractionId, folders, voiceKey]);

  // 계속 듣기 — 대화 화면에서 켜 둔 채 이 화면이 열리면 이어 듣는다. 들은 말이 첫 메시지다.
  const streamVoice = useVoiceStreamAvailable();
  const [loopOn, toggleLoop, stopLoop] = useVoiceLoopOwner(voiceKey, true);
  const [wakeWord, setWakeWord] = useState<string | null>(null);
  const [called, setCalled] = useState(false);
  const voiceInput = useMemo(() => createVoiceInputTracker(), []);
  const sendRef = useRef(send);
  sendRef.current = send;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const read = (cfg: { voiceWake?: boolean; voiceWakeWords?: string }) =>
      setWakeWord(cfg.voiceWake === true ? (parseWakeWords(cfg.voiceWakeWords?.trim() || undefined)[0] ?? null) : null);
    void xgen.config
      ?.get()
      .then(read)
      .catch(() => undefined);
    return xgen.config?.onChange?.(read);
  }, []);
  const { state: loopState, error: loopError, notice: loopNotice } = useVoiceLoop({
    enabled: streamVoice && loopOn,
    workflowId: START_VOICE_KEY,
    responseKey: null,
    isPaused: () => busyRef.current,
    onPartial: (t) => {
      if (voiceInput.preview(t)) setInput(t);
    },
    onWake: () => setCalled(true),
    onResult: async (r) => {
      const clear = voiceInput.complete();
      if (r.wake === 'called') {
        setCalled(true);
        return;
      }
      if (r.wake !== 'off') setCalled(false);
      if (r.blocked || !r.text) {
        setInput(clear);
        return;
      }
      // 화면 조작으로 끝난 말(앱 열기 등)은 보내지 않는다. 한두 글자짜리 말은 말버릇·잡음이다.
      if ((r.actions.length && !r.unhandled) || r.text.replace(/[\s.,!?。…]/g, '').length <= 2) {
        setInput(clear);
        return;
      }
      if (busyRef.current) return;
      setInput(r.text);
      await sendRef.current(r.text);
    },
  });
  useEffect(() => {
    if (loopError) {
      setError(`음성 입력 오류: ${loopError} 마이크를 다시 켜 주세요.`);
      stopLoop();
    }
  }, [loopError, stopLoop]);

  const valueOf = (id: string, fallback: unknown) =>
    Object.prototype.hasOwnProperty.call(settings, id) ? settings[id] : fallback;

  return (
    <div className={`start-chat${dragOver ? ' dropping' : ''}`} data-paste-root="" {...dragProps}>
      {dragOver && (
        <div className="chat-drop" role="status">
          <div className="chat-drop-card">
            <PlusIcon size={22} />
            <span>여기에 놓으면 첫 메시지와 함께 보냅니다</span>
            <em>이미지 · 문서 · 표 · 압축 파일</em>
          </div>
        </div>
      )}
      <div className="start-chat-scroll">
        <div className="start-chat-center">
          <h1 className="start-chat-title">오늘은 무엇을 해볼까요?</h1>

          <div className="start-chat-pick">
            <Selector
              value={choice}
              onChange={(v) => {
                setChoice(v);
                setError(null);
              }}
              options={agentOptions}
              searchable
              searchPlaceholder="에이전트 검색…"
              emptyText="맞는 에이전트가 없습니다"
              ariaLabel="대화할 에이전트"
              size="lg"
              className="start-chat-selector"
            />
          </div>

          {isNew && (
            <div className="start-chat-card">
              <label className={`field ${nameAlert ? 'alert' : ''} ${nameTaken ? 'invalid' : ''}`}>
                <span>에이전트 이름</span>
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 영업 리서치 도우미"
                  aria-invalid={nameTaken}
                  autoFocus
                />
                {nameTaken && <small className="field-error">{NAME_TAKEN}</small>}
              </label>

              <div className="field-row">
                <label className="field">
                  <span>AI 제공사</span>
                  <select value={provider} onChange={(e) => changeProvider(e.target.value)} disabled={!options}>
                    {(options?.providers ?? []).map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>모델</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!current}>
                    {(current?.models ?? []).map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <button className="link" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
                <span className="link-caret" aria-hidden>
                  {advanced ? '▾' : '▸'}
                </span>
                세부설정
              </button>

              {advanced && options && (
                <div className="advanced">
                  {ordered(options.settings).map((setting) => (
                    <SettingField
                      key={setting.id}
                      setting={setting}
                      value={valueOf(setting.id, setting.default)}
                      onChange={(v) => setSettings((prev) => ({ ...prev, [setting.id]: v }))}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="start-chat-error" role="alert">
              {error}
            </p>
          )}
          {busy && <p className="start-chat-progress">{isNew ? '에이전트를 만드는 중…' : '대화를 여는 중…'}</p>}
        </div>
      </div>

      <div className="chat-input start-chat-input">
        <input
          ref={fileInputRef}
          className="composer-image-input"
          type="file"
          accept={CHAT_IMAGE_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (files.length > 0) void addFiles(files);
          }}
        />
        {staged.length > 0 && (
          <div className="composer-images" aria-label={`전송 대기 파일 ${staged.length}개`}>
            {staged.map((image) => (
              <div className="composer-image" key={image.id}>
                {image.kind === 'image' ? <img src={image.dataUrl} alt="" /> : <DocIcon size={24} />}
                <span className="composer-image-name" title={image.name}>
                  {image.name}
                </span>
                <button
                  type="button"
                  onClick={() => replaceStaged(stagedRef.current.filter((item) => item.id !== image.id))}
                  title={`${image.name} 첨부 취소`}
                  aria-label={`${image.name} 첨부 취소`}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {folders.length > 0 && (
          <div className="start-chat-folders" aria-label="새 대화에 연결할 폴더">
            {folders.map((folder) => (
              <span className="start-chat-folder" key={folder.id} title={folder.path}>
                <FolderIcon size={13} />
                <span className="start-chat-folder-name">{folder.name}</span>
                <button
                  type="button"
                  onClick={() => setFolders((list) => list.filter((f) => f.id !== folder.id))}
                  title={`${folder.name} 연결하지 않기`}
                  aria-label={`${folder.name} 연결하지 않기`}
                >
                  <CloseIcon size={11} />
                </button>
              </span>
            ))}
            <span className="start-chat-folders-hint">지금 대화의 폴더로 시작합니다</span>
          </div>
        )}
        {loopOn && loopNotice && <div className="voice-error small" role="status">{loopNotice}</div>}
        {loopOn && <VoiceLoopBar state={loopState} wakeWord={wakeWord} called={called} />}
        {policy.notice && (
          <div
            className={policy.notice.tone === 'block' ? 'sensitive-warn blocked' : 'sensitive-warn'}
            role={policy.notice.tone === 'block' ? 'alert' : 'status'}
          >
            <strong>{policy.notice.tone === 'block' ? '보낼 수 없는 내용' : '민감한 내용 안내'}</strong>
            <span>{policy.notice.text}</span>
          </div>
        )}
        <div className={`composer ${locked ? 'locked' : ''}`}>
          {locked && (
            // 잠긴 칸 위의 덮개가 누름을 받는다. 비활성 칸은 누름을 흘리지 않는다.
            <button type="button" className="composer-lock" aria-label={lockReason ?? ''} title={lockReason ?? ''} onClick={explainLock} />
          )}
          <textarea
            ref={inputRef}
            className="composer-input"
            value={input}
            readOnly={locked}
            tabIndex={locked ? -1 : undefined}
            placeholder={staged.length > 0 ? '첨부한 파일로 무엇을 할지 적어 주세요…' : '메시지를 입력하세요…'}
            onChange={(e) => {
              voiceInput.edited();
              setInput(e.target.value);
            }}
            onPaste={(event) => {
              const files = pastedFiles(event.clipboardData);
              if (files.length === 0) return;
              event.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            spellCheck={false}
          />
          <button
            type="button"
            className="composer-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || preparing > 0 || staged.length >= CHAT_IMAGE_MAX_COUNT}
            title={
              staged.length >= CHAT_IMAGE_MAX_COUNT
                ? `파일은 최대 ${CHAT_IMAGE_MAX_COUNT}개까지 첨부할 수 있습니다`
                : preparing > 0
                  ? '파일을 준비하는 중…'
                  : `파일 첨부 · 이미지는 붙여 넣어도 됩니다 (최대 ${CHAT_IMAGE_MAX_COUNT}개)`
            }
            aria-label="파일 첨부"
          >
            <PlusIcon size={17} />
          </button>
          {streamVoice && (
            <button
              type="button"
              className={`composer-mic${loopOn ? ' recording' : ''}`}
              onClick={toggleLoop}
              title={loopOn ? '계속 듣기 끄기' : '계속 듣기 — 말한 것을 첫 메시지로 보냅니다'}
              aria-label="음성 입력"
            >
              <MicIcon size={16} />
            </button>
          )}
          <button
            className="composer-send"
            onClick={() => void send()}
            disabled={busy || preparing > 0 || policy.blocked || (!locked && !input.trim() && staged.length === 0)}
            title="전송"
            aria-label="전송"
          >
            <SendIcon size={17} />
          </button>
        </div>
        <div className="composer-foot">
          <span className="kbd-hint">
            <kbd>Enter</kbd> 전송 · <kbd>Shift + Enter</kbd> 줄바꿈
          </span>
        </div>
      </div>
    </div>
  );
}
