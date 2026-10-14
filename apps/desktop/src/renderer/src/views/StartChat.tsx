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
 */
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentCreateOptions } from '@dex/protocol';
import { xgen } from '../bridge';
import { sessionStore } from '../session';
import { agentDirectory, useAgentDirectory } from '../agent-directory';
import { CloseIcon, DocIcon, PlusIcon, SendIcon } from '../brand/icons';
import { Selector, type SelectorOption } from './Selector';
import { ordered, readPick, SettingField, writePick } from './agent-create-fields';
import { lockedByName, NAME_REQUIRED, NAME_TAKEN, startChatLockReason } from './start-chat-model';
import {
  CHAT_IMAGE_ACCEPT,
  CHAT_IMAGE_MAX_COUNT,
  pastedImageFiles,
  stageChatFiles,
  type StagedChatImage,
} from './chat-attach';
import { DropTracker, dragHasFiles } from './chat-drop';
import { useChatInputCheck } from './use-chat-input-check';

/** 에이전트 고르기의 첫 칸(기본값). */
const NEW_AGENT = '__new_agent__';
/** 적는 동안 이름이 겹치는지 묻는 간격. */
const NAME_CHECK_DELAY_MS = 300;

export function StartChat({ onStarted }: { onStarted: () => void }) {
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

  const send = useCallback(async () => {
    if (busy || preparing > 0) return;
    if (locked) {
      explainLock();
      return;
    }
    const text = input.trim();
    const files = stagedRef.current;
    if (!text && files.length === 0) return;
    // 통제 정책: 첫 메시지가 막힐 글이면 에이전트를 만들지도, 대화를 열지도 않는다. 이유는 작성기 위에 선다.
    if (text && !(await policy.confirm(text))) return;
    setBusy(true);
    setError(null);
    try {
      let agent: Agent;
      if (isNew) {
        const trimmed = name.trim();
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
        agent = {
          id: 0,
          workflowId: created.workflowId,
          workflowName: created.workflowName,
          nodeCount: 1,
          isShared: false,
          isDeployed: false,
          isCompleted: true,
          description: '',
          username: '',
          fullName: '',
          createdAt: '',
          updatedAt: '',
          // 이 화면이 만드는 것은 Agent Geny 하나다. 이 표시가 없으면 스토어가 첨부를 그림만 남기고 거른다.
          hasAgentGeny: true,
        };
        agentDirectory.add(agent);
      } else if (selectedAgent) {
        agent = selectedAgent;
      } else {
        return;
      }
      const key = sessionStore.openNew(agent);
      sessionStore.send(key, text, null, files);
      onStarted();
    } catch (err: unknown) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [busy, preparing, locked, explainLock, input, isNew, name, provider, model, settings, selectedAgent, onStarted, policy]);

  const valueOf = (id: string, fallback: unknown) =>
    Object.prototype.hasOwnProperty.call(settings, id) ? settings[id] : fallback;

  return (
    <div className={`start-chat${dragOver ? ' dropping' : ''}`} {...dragProps}>
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
            onChange={(e) => setInput(e.target.value)}
            onPaste={(event) => {
              const files = pastedImageFiles(event.clipboardData.items);
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
