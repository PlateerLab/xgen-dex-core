/**
 * 에이전트 만들기·고치기 — 이름·설명·제공자·모델·지시·도구·기억·연결 폴더.
 *
 * 모델 목록은 그 제공자에게 물어 채운다(=연결 시험). 목록이 없으면 이름을 직접 쓴다. 작업 공간 폴더 이름은 만들 때
 * 정해지고(이름을 바꿔도 그대로), 지워도 그 폴더는 남는다.
 */
import React, { useEffect, useState } from 'react';
import type { XdAgent } from '../../../main/store';
import { xd } from '../bridge';
import { errorText, FOLDER_BADGE, FOLDER_TEXT, KIND_LABEL, useData } from '../data';
import { FolderIcon, PlusIcon, TrashIcon } from '../dex';

/** 끌 수 있는 도구 묶음 — 엔진 설정 이름(GENY_TOOLS_<묶음>_ENABLED)과 화면 이름. */
const TOOL_FAMILIES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'FILESYSTEM', label: '파일', hint: '작업 공간과 연결 폴더의 파일을 읽고 씁니다.' },
  { key: 'SHELL', label: '명령 실행', hint: '이 PC 에서 명령을 실행하고, 되돌리기 어려운 명령은 먼저 묻습니다.' },
  { key: 'WEB', label: '웹', hint: '웹을 검색하고 페이지를 읽습니다.' },
  { key: 'PARSING', label: '문서 읽기', hint: 'PDF·워드·엑셀·파워포인트 문서의 글을 읽습니다.' },
];

const flag = (key: string) => `GENY_TOOLS_${key}_ENABLED`;

export const AgentEditor: React.FC<{
  agent: XdAgent | null;
  onDone: (agentId: string | null) => void;
  onProviders: () => void;
}> = ({ agent, onDone, onProviders }) => {
  const { accounts, info, reloadAgents } = useData();
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [accountId, setAccountId] = useState<string>(agent?.accountId ?? accounts[0]?.id ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsNote, setModelsNote] = useState('');
  const [prompt, setPrompt] = useState(agent?.systemPrompt ?? '');
  const [memory, setMemory] = useState(agent?.memory ?? true);
  const [folders, setFolders] = useState<string[]>(agent?.folders ?? []);
  /** 연결 폴더의 지금 상태(없어졌는지) — 경로 → 상태. */
  const [folderStatus, setFolderStatus] = useState<Record<string, string>>({});
  const [folderError, setFolderError] = useState('');
  const settings = (agent?.options.settings ?? {}) as Record<string, string>;
  const [tools, setTools] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(TOOL_FAMILIES.map((f) => [f.key, !['0', 'false', 'off'].includes(String(settings[flag(f.key)] ?? '').toLowerCase())])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 계정 목록이 늦게 오면(새 에이전트) 첫 제공자를 고른다 — 보이는 것과 저장되는 것이 같게.
  useEffect(() => {
    if (!accountId && !agent && accounts[0]) setAccountId(accounts[0].id);
  }, [accountId, accounts, agent]);

  // 제공자를 바꾸면 그 제공자의 모델을 묻는다.
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

  useEffect(() => {
    if (!folders.length) return;
    let alive = true;
    xd.folders
      .check(folders)
      // 돌아온 path 는 정리된 글자일 수 있다 — 저장된 글자로 찾도록 순서로 맞춘다.
      .then((list) => alive && setFolderStatus(Object.fromEntries(folders.map((f, i) => [f, list[i]?.status ?? 'ok']))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [folders]);

  const pickFolder = async () => {
    setFolderError('');
    const picked = await xd.pickFolder();
    if (!picked) return;
    const [check] = await xd.folders.check([picked]);
    // 고르는 그 자리에서 알린다 — 저장할 때 가서야 거절당하지 않게.
    if (check.status !== 'ok') {
      setFolderError(FOLDER_TEXT[`folder_${check.status}`] ?? '이 폴더는 연결할 수 없습니다.');
      return;
    }
    setFolders((list) => (list.includes(check.path) ? list : [...list, check.path]));
  };

  const save = async () => {
    setBusy(true);
    setError('');
    const options = {
      ...(agent?.options ?? {}),
      settings: {
        ...settings,
        ...Object.fromEntries(TOOL_FAMILIES.map((f) => [flag(f.key), tools[f.key] ? '1' : '0'])),
      },
    };
    const input = {
      name,
      description,
      accountId: accountId || null,
      model: model.trim(),
      // 비우면 기본 지시를 쓴다.
      systemPrompt: prompt.trim() ? prompt : null,
      memory,
      folders,
      options,
    };
    try {
      const saved = agent ? await xd.agents.update(agent.id, input) : await xd.agents.create(input);
      await reloadAgents();
      onDone(saved.id);
    } catch (e) {
      setError(errorText(e, '저장하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      await xd.agents.remove(agent.id);
      await reloadAgents();
      onDone(null);
    } catch (e) {
      setError(errorText(e, '지우지 못했습니다.'));
      setBusy(false);
    }
  };

  return (
    <div className="xd-page">
      <div className="xd-page-head">
        <h2>{agent ? '에이전트 설정' : '새 에이전트'}</h2>
        {agent && info && (
          <p className="muted small">
            작업 공간: {info.workspace}
            {info.platform === 'win32' ? '\\' : '/'}
            {agent.workspace}
          </p>
        )}
      </div>

      <section className="xd-card">
        <label className="field">
          <span>이름</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 리서치 도우미" maxLength={100} />
        </label>
        <label className="field">
          <span>설명</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="무엇을 하는 에이전트인지 한 줄로" />
        </label>
      </section>

      <section className="xd-card">
        <h3>AI 제공자와 모델</h3>
        {accounts.length === 0 ? (
          <div className="xd-empty-line">
            <span>연결된 AI 제공자가 없습니다.</span>
            <button type="button" className="secondary" onClick={onProviders}>
              제공자 연결하기
            </button>
          </div>
        ) : (
          <>
            <label className="field">
              <span>제공자</span>
              <select
                value={accountId}
                onChange={(e) => {
                  // 다른 제공자의 모델 이름이 남지 않게 — 새 제공자의 목록에서 다시 고른다.
                  setModel('');
                  setAccountId(e.target.value);
                }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label === (KIND_LABEL[a.kind] ?? a.kind) ? a.label : `${a.label} · ${KIND_LABEL[a.kind] ?? a.kind}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>모델</span>
              <input
                list="xd-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={models === null ? '모델 목록을 받는 중…' : '모델 이름'}
              />
              <datalist id="xd-models">
                {(models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            {modelsNote && <p className="muted small">{modelsNote}</p>}
          </>
        )}
      </section>

      <section className="xd-card">
        <h3>지시</h3>
        <label className="field">
          <span>시스템 프롬프트</span>
          <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="비워 두면 기본 지시를 씁니다" />
        </label>
      </section>

      <section className="xd-card">
        <h3>도구</h3>
        {TOOL_FAMILIES.map((f) => (
          <label key={f.key} className="xd-check">
            <input type="checkbox" checked={tools[f.key]} onChange={(e) => setTools((t) => ({ ...t, [f.key]: e.target.checked }))} />
            <span>
              <strong>{f.label}</strong>
              <em>{f.hint}</em>
            </span>
          </label>
        ))}
        <label className="xd-check">
          <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
          <span>
            <strong>기억</strong>
            <em>대화에서 알게 된 것을 이 에이전트의 기억으로 남기고 다음 대화에서 씁니다.</em>
          </span>
        </label>
      </section>

      <section className="xd-card">
        <h3>연결 폴더</h3>
        <p className="muted small">작업 공간 밖에서 이 에이전트가 읽고 쓸 수 있는 폴더입니다.</p>
        {folders.map((f) => (
          <div key={f} className="xd-folder-row">
            <FolderIcon size={14} />
            <span className="xd-folder-path" title={f}>
              {f}
            </span>
            {FOLDER_BADGE[folderStatus[f]] && <span className="xd-folder-missing">{FOLDER_BADGE[folderStatus[f]]}</span>}
            <button type="button" className="icon-btn sm" aria-label="연결 끊기" onClick={() => setFolders((list) => list.filter((x) => x !== f))}>
              <TrashIcon size={13} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary xd-inline-btn"
          onClick={() => void pickFolder().catch((e) => setFolderError(errorText(e, '폴더를 고르지 못했습니다.')))}
        >
          <PlusIcon size={13} /> 폴더 연결
        </button>
        {folderError && (
          <p className="voice-error small" role="alert">
            {folderError}
          </p>
        )}
      </section>

      {error && (
        <div className="voice-error small" role="alert">
          {error}
        </div>
      )}
      <div className="xd-actions">
        <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {agent ? '저장' : '만들기'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => onDone(agent?.id ?? null)}>
          취소
        </button>
        {agent && (
          <span className="xd-actions-end">
            {confirmDelete ? (
              <>
                <span className="muted small">작업 공간 폴더는 남습니다.</span>
                <button type="button" className="secondary danger" disabled={busy} onClick={() => void remove()}>
                  지우기
                </button>
                <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>
                  그만두기
                </button>
              </>
            ) : (
              <button type="button" className="secondary danger" onClick={() => setConfirmDelete(true)}>
                에이전트 지우기
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
};
