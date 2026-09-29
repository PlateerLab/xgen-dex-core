/**
 * 모델 선택기 — 채팅 입력창 위, [Teams 대화 붙이기] 오른쪽.
 *
 * 지금 모델을 "제공자: 모델"(예 `Anthropic: Haiku 4.5`)로 보이고, 누르면 고를 수 있는 모델이
 * 위로 펼쳐진다(지금 모델이 맨 위). 고르면 **이 대화만** 그 모델로 돈다 — 다음 답변부터, 세션을
 * 다시 시작하지 않는다(서버가 다음 턴 시작에 바꿔 끼운다). 다른 화면(웹·휴대폰·다른 PC)에서
 * 바꿔도 곧바로 따라간다. 고정된 에이전트는 보이기만 한다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MODEL_PICKER_TEXT,
  UNSUPPORTED_MODEL_STATE,
  applyModelNotice,
  orderedChoices,
  sameModel,
  type ConversationModelState,
  type ModelChoice,
} from '@dex/protocol/conversation-model';
import { xgen } from '../bridge';
import { CheckIcon, ChevronDownIcon, ModelIcon } from '../brand/icons';
import { Tooltip } from './Tooltip';

/** 이 대화의 모델 — 읽기·고르기·다른 화면의 변경 따라가기. */
export function useConversationModel(interactionId: string, workflowId: string) {
  const [state, setState] = useState<ConversationModelState>(UNSUPPORTED_MODEL_STATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setState(UNSUPPORTED_MODEL_STATE);
    setError('');
    if (!interactionId || !workflowId || !xgen?.agentData?.conversationModel) return;
    void xgen.agentData
      .conversationModel(interactionId, workflowId)
      .then((next) => alive && setState(next))
      .catch(() => alive && setState(UNSUPPORTED_MODEL_STATE));
    const off = xgen.agentData.onConversationModelChanged?.((id, notice) => {
      if (id === interactionId) setState((cur) => applyModelNotice(cur, notice));
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [interactionId, workflowId]);

  const choose = useCallback(
    async (choice: ModelChoice) => {
      if (sameModel(choice, state.current)) return;
      setSaving(true);
      setError('');
      try {
        setState(await xgen.agentData.setConversationModel(interactionId, workflowId, choice));
      } catch {
        setError(MODEL_PICKER_TEXT.failed);
      } finally {
        setSaving(false);
      }
    },
    [interactionId, workflowId, state.current],
  );

  return { state, saving, error, choose };
}

export const ModelPicker: React.FC<{ interactionId: string; workflowId: string }> = ({ interactionId, workflowId }) => {
  const { state, saving, error, choose } = useConversationModel(interactionId, workflowId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const all = useMemo(() => orderedChoices(state), [state]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
  }, [all, query]);

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // 펼치면 지금 모델에 초점을 둔다(↑↓·Enter 로 고른다).
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('.model-opt')?.focus());
  }, [open]);

  if (!state.supported || !state.current) return null;
  const current = state.current;

  const onListKey = (e: React.KeyboardEvent) => {
    const items = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.model-opt') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
      items[next]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      wrap.current?.querySelector<HTMLButtonElement>('.model-chip')?.focus();
    }
  };

  const pick = (c: ModelChoice) => {
    setOpen(false);
    void choose(c);
  };

  return (
    <div className="model-picker" ref={wrap}>
      <Tooltip label={state.locked ? MODEL_PICKER_TEXT.locked : open ? '' : '이 대화의 모델'}>
        <button
          type="button"
          className={`model-chip${open ? ' open' : ''}${state.locked ? ' locked' : ''}`}
          onClick={() => setOpen((v) => !v)}
          disabled={state.locked || saving}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`모델: ${current.label}`}
        >
          <ModelIcon size={12} />
          <span className="model-chip-label">{current.label}</span>
          {!state.locked && <ChevronDownIcon size={11} />}
        </button>
      </Tooltip>
      {error && (
        <span className="model-picker-error" role="alert">
          {error}
        </span>
      )}
      {open && (
        <div className="model-menu" role="dialog" aria-label="모델 고르기" onKeyDown={onListKey}>
          {all.length > 10 && (
            <input
              className="model-menu-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="모델 찾기"
              aria-label="모델 찾기"
              autoFocus
            />
          )}
          <div className="model-menu-list" role="listbox" ref={list} aria-label="모델">
            {shown.map((c, i) => {
              const isCurrent = sameModel(c, current);
              const prev = shown[i - 1];
              // 지금 모델 아래, 그리고 제공자가 바뀌는 자리에 가는 줄.
              const sep = i > 0 && (sameModel(prev, current) || prev.group !== c.group);
              return (
                <React.Fragment key={`${c.provider}:${c.model}`}>
                  {sep && <div className="model-menu-sep" role="separator" />}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    className={`model-opt${isCurrent ? ' current' : ''}`}
                    onClick={() => pick(c)}
                  >
                    <span className="model-opt-check">{isCurrent ? <CheckIcon size={13} /> : null}</span>
                    <span className="model-opt-label">{c.label}</span>
                    {isCurrent && <span className="model-opt-tag">{MODEL_PICKER_TEXT.current}</span>}
                  </button>
                </React.Fragment>
              );
            })}
            {!shown.length && <div className="model-menu-empty">맞는 모델이 없습니다</div>}
          </div>
          <div className="model-menu-note">{MODEL_PICKER_TEXT.nextTurn}</div>
        </div>
      )}
    </div>
  );
};
