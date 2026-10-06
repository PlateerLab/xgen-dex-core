/**
 * 앱 공유 시트. 데스크톱·웹 [앱 공유] 창과 같은 내용이다(문구는 @dex/protocol 의 APP_SHARE_TEXT).
 *
 *   공개 범위   [XGEN 사용자에게 공유] 로그인한 사람만 / [모두에게 공유] 로그인 없이
 *   공유 링크   공유 중이면 링크와 [링크 복사]·[보내기]. 범위를 바꿔도 링크는 그대로다.
 *   [공유 중지] 한 번 더 묻는다. 다시 켜면 새 링크다.
 *
 * 링크는 주인에게만 온다(목록에는 공유 여부만 있다). 공유 중인 앱을 열면 서버에서 링크를 다시 받는다.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { APP_SHARE_TEXT as T, toShareAudience, type MyApp, type ShareAudience } from '@dex/protocol';
import { friendlyError } from '../lib/errors';
import { serverLink } from '../lib/links';
import type { XgenMobileClient } from '../lib/xgen';
import {
  ShareAudienceRows,
  ShareButton,
  ShareLinkBox,
  ShareMessage,
  ShareSectionLabel,
  ShareSheet,
} from '../lib/share-sheet';

export function AppShareSheet({
  client,
  app,
  onClose,
  onChanged,
}: {
  client: XgenMobileClient;
  app: MyApp;
  onClose: () => void;
  /** 공유를 켜고 끄거나 범위를 바꿨다: 목록을 다시 읽는다. */
  onChanged: () => void;
}): React.ReactElement {
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
  const ready = app.ready && app.serving;
  const link = (path: string) => (path ? serverLink(client.session.serverUrl, path) : '');

  useEffect(() => {
    if (!app.shared) return;
    let alive = true;
    client.api.agentData
      .appGetShare(app.workflow_id, app.slug)
      .then((st) => {
        if (!alive || !st.shared) return;
        setUrl(link(st.path));
        setAudience(toShareAudience(st.audience || 'public'));
      })
      .catch((e) => {
        if (!alive) return;
        setLost(true);
        setError(friendlyError(e, '공유 상태를 불러오지 못했습니다.'));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // 시트를 열 때 한 번만 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.workflow_id, app.slug]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(friendlyError(e, '공유를 바꾸지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const res = await client.api.agentData.appSetShare(app.workflow_id, app.slug, true, { audience });
      const next = link(res.path);
      setUrl(next);
      // 화면은 서버의 답을 따른다. 옛 서버는 범위를 모른다(모두에게 공개된다).
      const actual = toShareAudience(res.audience || 'public');
      setAudience(actual);
      const copied = next ? await Clipboard.setStringAsync(next).then(() => true, () => false) : false;
      setWarn(actual !== audience ? T.audienceUnsupported : '');
      setNotice(copied ? T.created : T.createdNoCopy);
      onChanged();
    });

  const changeAudience = (next: ShareAudience) => {
    if (next === audience) return;
    const before = audience;
    setAudience(next);
    if (!url) return;
    void run(async () => {
      try {
        const res = await client.api.agentData.appSetShare(app.workflow_id, app.slug, true, { audience: next });
        setUrl(link(res.path));
        const actual = toShareAudience(res.audience || 'public');
        setAudience(actual);
        setWarn(actual !== next ? T.audienceUnsupported : '');
        setNotice(actual !== next ? '' : T.audienceChanged);
        onChanged();
      } catch (e) {
        setAudience(before);
        throw e;
      }
    });
  };

  const stop = () =>
    run(async () => {
      await client.api.agentData.appSetShare(app.workflow_id, app.slug, false);
      onChanged();
      onClose();
    });

  const footer = askStop ? (
    <View style={{ gap: 8 }}>
      <ShareMessage text={T.stopAsk} tone="muted" />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ShareButton label={T.cancel} onPress={() => setAskStop(false)} disabled={busy} />
        <ShareButton label={T.stop} onPress={() => void stop()} danger disabled={busy} />
      </View>
    </View>
  ) : url || lost ? (
    // 공유 중인데 링크를 다시 받지 못했으면(옛 서버 등) 새로 만들지 않는다(옛 서버는 만들 때마다 새 토큰). 중지만 둔다.
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <ShareButton label={T.stop} onPress={() => setAskStop(true)} danger disabled={busy} />
      <ShareButton label={T.close} onPress={onClose} primary />
    </View>
  ) : (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <ShareButton label={T.cancel} onPress={onClose} />
      <ShareButton label={T.create} onPress={() => void create()} primary disabled={busy || loading || !ready} />
    </View>
  );

  return (
    <ShareSheet visible title={`${T.title} · ${app.title}`} onClose={onClose} footer={footer}>
      <ShareMessage text={T.intro} tone="muted" />
      <ShareSectionLabel>{T.audience}</ShareSectionLabel>
      <ShareAudienceRows
        value={audience}
        onChange={changeAudience}
        disabled={busy || loading}
        labels={{ users: T.users, public: T.public }}
      />
      {loading ? (
        <ShareMessage text={T.loading} tone="muted" />
      ) : url ? (
        <>
          <ShareSectionLabel>{T.link}</ShareSectionLabel>
          <ShareLinkBox url={url} copyLabel={T.copy} copiedLabel={T.copied} />
          <ShareMessage text={T.linkKept} tone="muted" />
        </>
      ) : lost ? (
        <ShareMessage text={T.linkLost} tone="warn" />
      ) : !ready ? (
        <ShareMessage text={T.notReady} tone="warn" />
      ) : null}
      <ShareMessage text={notice} tone="ok" />
      <ShareMessage text={warn} tone="warn" />
      <ShareMessage text={error} tone="error" />
    </ShareSheet>
  );
}
