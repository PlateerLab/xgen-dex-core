/**
 * 시작 화면: 대화를 시작하는 곳이자 아무 대화도 열려 있지 않을 때의 첫 화면.
 *
 * 채팅과 같은 짜임(머리 · 기록 칸 · 바닥 입력창)이고, 비어 있는 기록 칸에 "오늘은 무엇을 해볼까요?" 와 에이전트
 * 고르기가 선다. 기본은 "새 에이전트로 시작": 이름·제공자·모델(과 접힌 세부 설정)을 적고 보내면 에이전트를 만들고
 * 그 에이전트의 새 대화로 첫 메시지를 보낸다. 있는 에이전트를 고르면 만들지 않고 바로 보낸다.
 * 보낼 수 없으면(이름 없음·이름 겹침·제공자나 모델 없음) 입력창이 잠기고, 누르면 까닭을 보이고 그 칸으로 옮긴다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { xd } from '../bridge';
import { errorText, KIND_LABEL, useData } from '../data';
import { Selector, type SelectorOption } from '../dex';
import { isExistingAgent, NEW_AGENT, START_TEXT, startLock, type AgentDraft } from '../start-model';
import { Composer } from './Composer';
import { XdMark } from './XdMark';

export const StartView: React.FC<{
  /** 이 에이전트의 새 대화로 첫 메시지를 보낸다. */
  onStart: (agentId: string, text: string) => void;
  onProviders: () => void;
  /** [모든 설정]: 적은 것을 들고 에이전트 만들기 화면으로. */
  onFullEditor: (draft: AgentDraft) => void;
}> = ({ onStart, onProviders, onFullEditor }) => {
  const { agents, accounts, reloadAgents } = useData();
  const [agentId, setAgentId] = useState<string>(NEW_AGENT);
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsNote, setModelsNote] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 잠긴 입력창을 눌렀다: 까닭을 보인다. 풀리면 다시 숨긴다. */
  const [showLock, setShowLock] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);

  const existing = isExistingAgent(agentId, agents);
  const selected = existing ? agents.find((a) => a.id === agentId) ?? null : null;
  // 만드는 동안은 잠그지 않는다: 만든 에이전트가 목록에 들어오면 그 이름이 "겹친다" 로 읽힌다.
  const lock = busy ? null : startLock({ agentId, name, accountId, model }, agents);
  const lockReason = lock?.reason ?? null;
  useEffect(() => {
    if (!lockReason) setShowLock(false);
  }, [lockReason]);

  // 계정 목록이 늦게 오거나 고른 계정이 사라지면 첫 제공자를 고른다(보이는 것과 쓰는 것이 같게).
  useEffect(() => {
    if (accountId && accounts.some((a) => a.id === accountId)) return;
    setModel('');
    setAccountId(accounts[0]?.id ?? '');
  }, [accountId, accounts]);

  // 제공자를 바꾸면 그 제공자의 모델을 묻는다(에이전트 편집과 같다).
  useEffect(() => {
    setModels(null);
    setModelsNote('');
    if (!accountId) return;
    let alive = true;
    xd.models
      .list(accountId)
      .then((res) => {
        if (!alive) return;
        const ids = res.models.map((m) => m.id);
        setModels(ids);
        if (!res.ok) setModelsNote('모델 목록을 받지 못해 모델 이름을 직접 입력해야 합니다.');
        setModel((m) => m || ids[0] || '');
      })
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const agentOptions = useMemo<SelectorOption[]>(
    () => [{ value: NEW_AGENT, label: START_TEXT.newAgent }, ...agents.map((a) => ({ value: a.id, label: a.name }))],
    [agents],
  );
  const accountOptions = useMemo<SelectorOption[]>(
    () =>
      accounts.map((a) => {
        const kind = KIND_LABEL[a.kind] ?? a.kind;
        return { value: a.id, label: a.label === kind ? a.label : `${a.label} · ${kind}` };
      }),
    [accounts],
  );

  const showReason = () => {
    if (!lock) return;
    setShowLock(true);
    if (lock.reason === 'name' || lock.reason === 'duplicate') nameRef.current?.focus();
    else if (lock.reason === 'model') modelRef.current?.focus();
  };

  const start = async () => {
    const text = draft.trim();
    if (busy) return;
    if (lock) return showReason();
    if (!text) return;
    setBusy(true);
    setError('');
    try {
      let id = agentId;
      if (!existing) {
        const created = await xd.agents.create({
          name: name.trim(),
          accountId,
          model: model.trim(),
          description: description.trim(),
          // 비우면 기본 지시를 쓴다(에이전트 편집과 같다).
          systemPrompt: prompt.trim() ? prompt : null,
        });
        await reloadAgents();
        id = created.id;
      }
      onStart(id, text);
    } catch (e) {
      setError(errorText(e, '에이전트를 만들지 못했습니다.'));
      setBusy(false);
    }
  };

  const duplicate = lock?.reason === 'duplicate';

  return (
    <div className="chat xd-chat xd-start">
      <div className="chat-header">
        <div className="chat-title">
          <XdMark size={26} />
          <div className="chat-title-text">
            <strong>새 채팅</strong>
            <span className="muted small">{selected ? selected.name : START_TEXT.newAgent}</span>
          </div>
        </div>
      </div>

      <div className="chat-log">
        <div className="xd-start-panel">
          <h2>{START_TEXT.heading}</h2>
          <div className="field">
            <span>에이전트</span>
            <Selector value={existing ? agentId : NEW_AGENT} onChange={setAgentId} options={agentOptions} searchable={agents.length > 8} ariaLabel="에이전트 고르기" />
          </div>

          {!existing && (
            <div className="xd-start-new">
              <label className="field">
                <span>이름</span>
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 리서치 도우미"
                  maxLength={100}
                  aria-invalid={duplicate}
                />
              </label>
              {duplicate && (
                <p className="voice-error small xd-start-field-error" role="alert">
                  {START_TEXT.nameTaken}
                </p>
              )}
              {accounts.length === 0 ? (
                <div className="xd-empty-line">
                  <span>연결된 AI 제공자가 없습니다.</span>
                  <button type="button" className="secondary" onClick={onProviders}>
                    제공자 연결하기
                  </button>
                </div>
              ) : (
                <div className="xd-start-row">
                  <div className="field">
                    <span>AI 제공자</span>
                    <Selector
                      value={accountId}
                      onChange={(v) => {
                        // 다른 제공자의 모델 이름이 남지 않게: 새 제공자의 목록에서 다시 고른다.
                        setModel('');
                        setAccountId(v);
                      }}
                      options={accountOptions}
                      ariaLabel="AI 제공자 고르기"
                    />
                  </div>
                  <label className="field">
                    <span>모델</span>
                    <input
                      ref={modelRef}
                      list="xd-start-models"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={models === null ? '모델 목록을 받는 중…' : '모델 이름'}
                    />
                    <datalist id="xd-start-models">
                      {(models ?? []).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </label>
                </div>
              )}
              {modelsNote && <p className="muted small">{modelsNote}</p>}
              <details className="xd-start-more">
                <summary>세부 설정</summary>
                <label className="field">
                  <span>설명</span>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
                <label className="field">
                  <span>시스템 프롬프트</span>
                  <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                </label>
                <button
                  type="button"
                  className="secondary xd-inline-btn"
                  onClick={() => onFullEditor({ name: name.trim(), description, accountId, model: model.trim(), systemPrompt: prompt })}
                >
                  모든 설정
                </button>
              </details>
            </div>
          )}
        </div>
      </div>

      <div className="chat-input">
        {busy && !existing && (
          <div className="xd-notice" role="status">
            에이전트를 만드는 중…
          </div>
        )}
        {error && (
          <div className="voice-error small" role="alert">
            {error}
          </div>
        )}
        {showLock && lock && !duplicate && (
          <div className="voice-error small" role="alert">
            {lock.message}
          </div>
        )}
        <Composer value={draft} onChange={setDraft} onSend={() => void start()} sending={busy} locked={lock?.message ?? null} onLocked={showReason} />
      </div>
    </div>
  );
};
