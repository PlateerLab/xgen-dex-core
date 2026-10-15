/**
 * 앱 공유 창. [앱] 탭의 [내 앱] 카드와 에이전트 [앱] 하위 탭이 함께 쓴다(웹 [앱 공유] 창과 같은 내용).
 *
 *   공개 범위   [XGEN 사용자에게 공유] 로그인한 사람만(아니면 로그인을 거쳐 이 앱으로 돌아온다)
 *               [모두에게 공유]         링크를 아는 누구나 로그인 없이
 *   공유 링크   공유 중이면 링크와 [링크 복사]. 범위를 바꿔도 링크는 그대로다.
 *   [공유 중지] 아래 줄에서 한 번 더 묻는다. 다시 켜면 새 링크다.
 *
 * 예전에는 운영체제의 확인 창(window.confirm)으로 켜고 껐다. 범위를 고를 수도, 링크를 다시 볼 수도 없었다.
 * 링크는 주인에게만 오므로(목록에는 공유 여부만 있다) 공유 중인 앱을 열면 서버에서 링크를 다시 받는다.
 */
import React, { useEffect, useState } from 'react';
import { APP_SHARE_TEXT as T, toShareAudience, type AppShareState, type ShareAudience } from '@dex/protocol';
import { copyText, xgen } from '../bridge';
import { useModalDismiss } from '../views/use-modal-dismiss';
import { ShareAudiencePicker, ShareLinkRow } from '../views/ShareParts';

export interface ShareAppTarget {
  workflow_id: string;
  slug: string;
  title: string;
  shared: boolean;
  /** 열리는 앱인가. 아니면 새로 공유할 수 없다(이미 공유 중이면 중지는 된다). */
  ready: boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const ShareAppModal: React.FC<{
  app: ShareAppTarget;
  onClose: () => void;
  /** 공유를 켜고 끄거나 범위를 바꾼 뒤: 부르는 쪽이 카드·목록에 서버의 답을 입힌다. */
  onChanged: (res: AppShareState & { url: string }) => void;
}> = ({ app, onClose, onChanged }) => {
  useModalDismiss(onClose);
  const [audience, setAudience] = useState<ShareAudience>('users');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(app.shared);
  /** 공유 중인데 링크를 다시 받지 못했다. */
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askStop, setAskStop] = useState(false);
  const [notice, setNotice] = useState('');
  /** 고른 범위와 서버의 실제 범위가 다를 때(옛 서버). */
  const [warn, setWarn] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!app.shared) return;
    let alive = true;
    xgen.apps
      .getShare(app.workflow_id, app.slug)
      .then((st) => {
        if (!alive) return;
        if (st.shared) {
          setUrl(st.url);
          setAudience(toShareAudience(st.audience || 'public'));
        }
      })
      .catch((e) => {
        if (!alive) return;
        setLost(true);
        setError(errText(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [app.workflow_id, app.slug, app.shared]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const res = await xgen.apps.setShare(app.workflow_id, app.slug, true, { audience });
      setUrl(res.url);
      // 화면은 서버의 답을 따른다. 옛 서버는 범위를 모른다(모두에게 공개된다).
      const actual = toShareAudience(res.audience || 'public');
      setAudience(actual);
      const copied = res.url ? await copyText(res.url) : false;
      setWarn(actual !== audience ? T.audienceUnsupported : '');
      setNotice(copied ? T.created : T.createdNoCopy);
      onChanged(res);
    });

  const changeAudience = (next: ShareAudience) => {
    if (next === audience) return;
    const before = audience;
    setAudience(next);
    if (!url) return;
    void run(async () => {
      try {
        const res = await xgen.apps.setShare(app.workflow_id, app.slug, true, { audience: next });
        setUrl(res.url);
        const actual = toShareAudience(res.audience || 'public');
        setAudience(actual);
        setWarn(actual !== next ? T.audienceUnsupported : '');
        setNotice(actual !== next ? '' : T.audienceChanged);
        onChanged(res);
      } catch (e) {
        setAudience(before);
        throw e;
      }
    });
  };

  const stop = () =>
    run(async () => {
      const res = await xgen.apps.setShare(app.workflow_id, app.slug, false);
      onChanged(res);
      onClose();
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal share-modal"
        role="dialog"
        aria-label={T.title}
        data-ui-id="app-share-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>
            {T.title} · {app.title}
          </h2>
          <button className="link" onClick={onClose}>
            {T.close}
          </button>
        </div>
        <p className="share-intro">{T.intro}</p>
        <div className="share-section-label">{T.audience}</div>
        <ShareAudiencePicker
          value={audience}
          onChange={changeAudience}
          disabled={busy || loading}
          labels={{ users: T.users, public: T.public }}
          ariaLabel={T.audience}
        />
        {loading ? (
          <p className="share-hint">{T.loading}</p>
        ) : url ? (
          <>
            <div className="share-section-label">{T.link}</div>
            <ShareLinkRow url={url} copyLabel={T.copy} copiedLabel={T.copied} />
            <p className="share-hint">{T.linkKept}</p>
          </>
        ) : lost ? (
          <p className="share-hint warn">{T.linkLost}</p>
        ) : !app.ready ? (
          <p className="share-hint warn">{T.notReady}</p>
        ) : null}
        {notice ? <p className="share-notice" role="status">{notice}</p> : null}
        {warn ? <p className="share-hint warn" role="status">{warn}</p> : null}
        {error ? <p className="share-error" role="alert">{error}</p> : null}
        {askStop ? (
          <div className="modal-actions share-actions">
            <span className="share-ask">{T.stopAsk}</span>
            <button className="secondary" onClick={() => setAskStop(false)} disabled={busy}>
              {T.cancel}
            </button>
            <button className="danger" onClick={() => void stop()} disabled={busy}>
              {T.stop}
            </button>
          </div>
        ) : url || lost ? (
          // 공유 중인데 링크를 다시 받지 못했으면(옛 서버 등) 새로 만들지 않는다. 옛 서버는 만들 때마다 새
          // 토큰이라 이미 나간 링크가 끊긴다. 중지만 둔다.
          <div className="modal-actions share-actions">
            <button className="danger share-stop" onClick={() => setAskStop(true)} disabled={busy}>
              {T.stop}
            </button>
            {url ? (
              <button className="secondary" onClick={() => void xgen.openExternal(url)}>
                {T.open}
              </button>
            ) : null}
            <button className="primary" onClick={onClose}>
              {T.close}
            </button>
          </div>
        ) : (
          <div className="modal-actions share-actions">
            <button className="secondary" onClick={onClose}>
              {T.cancel}
            </button>
            <button className="primary" onClick={() => void create()} disabled={busy || loading || !app.ready}>
              {T.create}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ShareAppModal;
