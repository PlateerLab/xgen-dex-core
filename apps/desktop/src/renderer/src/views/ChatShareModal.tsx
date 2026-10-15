/**
 * [채팅 공유] 창: 지금까지의 대화를 링크로 공유한다(웹 [채팅 공유] 창과 같은 내용·같은 서버 계약).
 *
 *   공개 범위       [XGEN 사용자에게 공유] 로그인한 사람만 / [모두에게 공유] 로그인 없이
 *   함께 공유할 것   [작업 과정 공개] [파일 공개] (기본 켜짐)
 *   공유 링크       지금 시점의 링크. 범위·공유할 것을 바꿔도 링크는 그대로다.
 *
 * 링크는 대화의 한 시점이다. 대화가 그대로면 창을 다시 열어도 같은 링크이고, 턴이 늘면 다시 공유할 때 새
 * 링크가 만들어진다(앞 링크는 그 시점 그대로 남아 [앞 시점의 링크]에 보인다). 공유된 화면은 웹이 그린다.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CHAT_SHARE_TEXT as T, type ShareAudience } from '@dex/protocol';
import { copyText, xgen } from '../bridge';
import { useModalDismiss } from './use-modal-dismiss';
import { ShareAudiencePicker, ShareLinkRow, ShareToggleRow } from './ShareParts';

type ShareState = Awaited<ReturnType<typeof xgen.chatShares.state>>;
type Link = NonNullable<ShareState['share']>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function whenOf(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export const ChatShareModal: React.FC<{
  workflowId: string;
  interactionId: string;
  onClose: () => void;
}> = ({ workflowId, interactionId, onClose }) => {
  useModalDismiss(onClose);
  const [state, setState] = useState<ShareState | null>(null);
  const [audience, setAudience] = useState<ShareAudience>('users');
  const [includeProcess, setIncludeProcess] = useState(true);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [askStop, setAskStop] = useState('');
  const [showPrevious, setShowPrevious] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const adopt = useCallback((next: ShareState) => {
    setState(next);
    if (next.share) {
      setAudience(next.share.audience);
      setIncludeProcess(next.share.include_process);
      setIncludeFiles(next.share.include_files);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    xgen.chatShares
      .state(workflowId, interactionId)
      .then((next) => alive && adopt(next))
      .catch((e) => alive && setError(`${T.loadError}: ${errText(e)}`));
    return () => {
      alive = false;
    };
  }, [workflowId, interactionId, adopt]);

  const current = state?.share ?? null;

  const save = async (next: { audience: ShareAudience; includeProcess: boolean; includeFiles: boolean }) => {
    setBusy(true);
    setError('');
    try {
      const fresh = !current;
      const res = await xgen.chatShares.create({ workflowId, interactionId, ...next });
      setState((prev) => (prev ? { ...prev, share: res.share } : prev));
      setAudience(res.share.audience);
      setIncludeProcess(res.share.include_process);
      setIncludeFiles(res.share.include_files);
      if (fresh) {
        const copied = await copyText(res.share.url);
        setNotice(copied ? T.created : T.createdNoCopy);
      } else {
        setNotice(T.updated);
      }
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** 링크가 있으면 범위는 바로 반영한다(내용은 다시 얼리지 않는다). */
  const changeAudience = (next: ShareAudience) => {
    if (next === audience) return;
    const before = audience;
    setAudience(next);
    if (!current) return;
    void save({ audience: next, includeProcess: current.include_process, includeFiles: current.include_files }).then(
      (ok) => {
        if (!ok) setAudience(before);
      },
    );
  };

  const stop = async (token: string) => {
    setBusy(true);
    setError('');
    try {
      await xgen.chatShares.revoke(token);
      setAskStop('');
      setNotice(T.stopDone);
      const next = await xgen.chatShares.state(workflowId, interactionId);
      adopt(next);
      if (!next.share) {
        setAudience('users');
        setIncludeProcess(true);
        setIncludeFiles(true);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const nothing = !!state && state.checkpoint.last_io_id == null;
  const dirty = !!current && (current.include_process !== includeProcess || current.include_files !== includeFiles);
  const previous: Link[] = state?.previous ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-modal" role="dialog" aria-label={T.title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{T.title}</h2>
          <button className="link" onClick={onClose}>
            {T.close}
          </button>
        </div>
        {!state ? (
          <p className="share-intro">{error || T.loading}</p>
        ) : (
          <>
            <p className="share-intro">{nothing ? T.empty : T.intro(state.checkpoint.turn_count)}</p>
            {state.running ? <p className="share-running">{T.running}</p> : null}
            <div className="share-section-label">{T.audience}</div>
            <ShareAudiencePicker
              value={audience}
              onChange={changeAudience}
              disabled={busy || nothing}
              labels={{ users: T.users, public: T.public }}
              ariaLabel={T.audience}
            />
            <div className="share-section-label">{T.contents}</div>
            <ShareToggleRow
              checked={includeProcess}
              onChange={setIncludeProcess}
              disabled={busy || nothing}
              title={T.process.title}
              hint={T.process.hint}
            />
            <ShareToggleRow
              checked={includeFiles}
              onChange={setIncludeFiles}
              disabled={busy || nothing}
              title={T.files.title}
              hint={T.files.hint}
            />
            {current ? (
              <>
                <div className="share-section-label">{T.link}</div>
                <ShareLinkRow url={current.url} copyLabel={T.copy} copiedLabel={T.copied} />
                <p className="share-hint">{T.linkHint}</p>
              </>
            ) : null}
            {previous.length > 0 ? (
              <div className="share-previous">
                <button
                  type="button"
                  className="share-previous-toggle"
                  aria-expanded={showPrevious}
                  onClick={() => setShowPrevious((v) => !v)}
                >
                  {T.previous(previous.length)} {showPrevious ? '▾' : '▸'}
                </button>
                {showPrevious ? (
                  <ul className="share-previous-list">
                    {previous.map((link) => (
                      <li key={link.token}>
                        <span>{T.previousRow(link.turn_count, link.audience, whenOf(link.created_at))}</span>
                        <button type="button" onClick={() => void copyText(link.url).then((ok) => ok && setNotice(T.copied))}>
                          {T.copy}
                        </button>
                        <button type="button" className="stop" disabled={busy} onClick={() => setAskStop(link.token)}>
                          {T.stop}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {notice ? <p className="share-notice" role="status">{notice}</p> : null}
            {error ? <p className="share-error" role="alert">{error}</p> : null}
          </>
        )}
        {askStop ? (
          <div className="modal-actions share-actions">
            <span className="share-ask">{T.stopAsk}</span>
            <button className="secondary" disabled={busy} onClick={() => setAskStop('')}>
              {T.cancel}
            </button>
            <button className="danger" disabled={busy} onClick={() => void stop(askStop)}>
              {T.stop}
            </button>
          </div>
        ) : current ? (
          <div className="modal-actions share-actions">
            <button className="danger share-stop" disabled={busy} onClick={() => setAskStop(current.token)}>
              {T.stop}
            </button>
            <button className="secondary" onClick={() => void xgen.openExternal(current.url)}>
              {T.open}
            </button>
            {dirty ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void save({ audience, includeProcess, includeFiles })}
              >
                {busy ? T.creating : T.apply}
              </button>
            ) : (
              <button className="primary" onClick={onClose}>
                {T.close}
              </button>
            )}
          </div>
        ) : (
          <div className="modal-actions share-actions">
            <button className="secondary" onClick={onClose}>
              {T.cancel}
            </button>
            <button
              className="primary"
              disabled={busy || !state || nothing}
              onClick={() => void save({ audience, includeProcess, includeFiles })}
            >
              {busy ? T.creating : T.create}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatShareModal;
