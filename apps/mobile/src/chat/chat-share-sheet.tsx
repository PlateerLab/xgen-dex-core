/**
 * [채팅 공유] 시트: 지금까지의 대화를 링크로 공유한다(데스크톱·웹 [채팅 공유] 창과 같은 내용, 문구는
 * @dex/protocol 의 CHAT_SHARE_TEXT).
 *
 * 링크는 대화의 한 시점이다. 대화가 그대로면 시트를 다시 열어도 같은 링크이고, 턴이 늘면 다시 공유할 때 새
 * 링크가 만들어진다(앞 링크는 그 시점 그대로 남는다). 공유된 화면은 웹(/share/chat/<token>)이 그린다.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { CHAT_SHARE_TEXT as T, type ChatShareLink, type ChatShareState, type ShareAudience } from '@dex/protocol';
import { friendlyError } from '../lib/errors';
import { serverLink } from '../lib/links';
import type { XgenMobileClient } from '../lib/xgen';
import { useP } from '../theme';
import {
  ShareAudienceRows,
  ShareButton,
  ShareLinkBox,
  ShareMessage,
  ShareSectionLabel,
  ShareSheet,
  ShareToggle,
} from '../lib/share-sheet';

function whenOf(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function ChatShareSheet({
  client,
  workflowId,
  interactionId,
  visible,
  onClose,
}: {
  client: XgenMobileClient;
  workflowId: string;
  interactionId: string;
  visible: boolean;
  onClose: () => void;
}): React.ReactElement {
  const p = useP();
  const [state, setState] = useState<ChatShareState | null>(null);
  const [audience, setAudience] = useState<ShareAudience>('users');
  const [includeProcess, setIncludeProcess] = useState(true);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [askStop, setAskStop] = useState('');
  const [showPrevious, setShowPrevious] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const link = (l: ChatShareLink | null) => (l ? serverLink(client.session.serverUrl, l.path) : '');

  const adopt = useCallback((next: ChatShareState) => {
    setState(next);
    if (next.share) {
      setAudience(next.share.audience);
      setIncludeProcess(next.share.include_process);
      setIncludeFiles(next.share.include_files);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setState(null);
    setAskStop('');
    setNotice('');
    setError('');
    setShowPrevious(false);
    setAudience('users');
    setIncludeProcess(true);
    setIncludeFiles(true);
    client.api.chatShares
      .state(workflowId, interactionId)
      .then((next) => alive && adopt(next))
      .catch((e) => alive && setError(friendlyError(e, T.loadError)));
    return () => {
      alive = false;
    };
  }, [visible, client, workflowId, interactionId, adopt]);

  const current = state?.share ?? null;

  const save = async (next: { audience: ShareAudience; includeProcess: boolean; includeFiles: boolean }) => {
    setBusy(true);
    setError('');
    try {
      const fresh = !current;
      const res = await client.api.chatShares.create({ workflowId, interactionId, ...next });
      setState((prev) => (prev ? { ...prev, share: res.share } : prev));
      setAudience(res.share.audience);
      setIncludeProcess(res.share.include_process);
      setIncludeFiles(res.share.include_files);
      if (fresh) {
        const url = link(res.share);
        const copied = url ? await Clipboard.setStringAsync(url).then(() => true, () => false) : false;
        setNotice(copied ? T.created : T.createdNoCopy);
      } else {
        setNotice(T.updated);
      }
      return true;
    } catch (e) {
      setError(friendlyError(e, T.loadError));
      return false;
    } finally {
      setBusy(false);
    }
  };

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
      await client.api.chatShares.revoke(token);
      setAskStop('');
      setNotice(T.stopDone);
      const next = await client.api.chatShares.state(workflowId, interactionId);
      adopt(next);
      if (!next.share) {
        setAudience('users');
        setIncludeProcess(true);
        setIncludeFiles(true);
      }
    } catch (e) {
      setError(friendlyError(e, T.loadError));
    } finally {
      setBusy(false);
    }
  };

  const nothing = !!state && state.checkpoint.last_io_id == null;
  const dirty = !!current && (current.include_process !== includeProcess || current.include_files !== includeFiles);
  const previous = state?.previous ?? [];

  const footer = askStop ? (
    <View style={{ gap: 8 }}>
      <ShareMessage text={T.stopAsk} tone="muted" />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ShareButton label={T.cancel} onPress={() => setAskStop('')} disabled={busy} />
        <ShareButton label={T.stop} onPress={() => void stop(askStop)} danger disabled={busy} />
      </View>
    </View>
  ) : current ? (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <ShareButton label={T.stop} onPress={() => setAskStop(current.token)} danger disabled={busy} />
      {dirty ? (
        <ShareButton
          label={busy ? T.creating : T.apply}
          onPress={() => void save({ audience, includeProcess, includeFiles })}
          primary
          disabled={busy}
        />
      ) : (
        <ShareButton label={T.close} onPress={onClose} primary />
      )}
    </View>
  ) : (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <ShareButton label={T.cancel} onPress={onClose} />
      <ShareButton
        label={busy ? T.creating : T.create}
        onPress={() => void save({ audience, includeProcess, includeFiles })}
        primary
        disabled={busy || !state || nothing}
      />
    </View>
  );

  return (
    <ShareSheet visible={visible} title={T.title} onClose={onClose} footer={footer}>
      {!state ? (
        <ShareMessage text={error || T.loading} tone={error ? 'error' : 'muted'} />
      ) : (
        <>
          <ShareMessage text={nothing ? T.empty : T.intro(state.checkpoint.turn_count)} tone="muted" />
          {state.running ? <ShareMessage text={T.running} tone="warn" /> : null}
          <ShareSectionLabel>{T.audience}</ShareSectionLabel>
          <ShareAudienceRows
            value={audience}
            onChange={changeAudience}
            disabled={busy || nothing}
            labels={{ users: T.users, public: T.public }}
          />
          <ShareSectionLabel>{T.contents}</ShareSectionLabel>
          <ShareToggle
            checked={includeProcess}
            onChange={setIncludeProcess}
            disabled={busy || nothing}
            title={T.process.title}
            hint={T.process.hint}
          />
          <ShareToggle
            checked={includeFiles}
            onChange={setIncludeFiles}
            disabled={busy || nothing}
            title={T.files.title}
            hint={T.files.hint}
          />
          {current ? (
            <>
              <ShareSectionLabel>{T.link}</ShareSectionLabel>
              <ShareLinkBox url={link(current)} copyLabel={T.copy} copiedLabel={T.copied} />
              <ShareMessage text={T.linkHint} tone="muted" />
            </>
          ) : null}
          {previous.length > 0 ? (
            <View style={{ marginTop: 12 }}>
              <Pressable onPress={() => setShowPrevious((v) => !v)} accessibilityRole="button" hitSlop={6}>
                <Text style={{ color: p.muted, fontSize: 12.5 }}>
                  {T.previous(previous.length)} {showPrevious ? '▾' : '▸'}
                </Text>
              </Pressable>
              {showPrevious
                ? previous.map((l) => (
                    <View
                      key={l.token}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        marginTop: 6,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        borderRadius: 10,
                        backgroundColor: p.panel2,
                      }}
                    >
                      <Text numberOfLines={1} style={{ flex: 1, color: p.text, fontSize: 12.5 }}>
                        {T.previousRow(l.turn_count, l.audience, whenOf(l.created_at))}
                      </Text>
                      <Pressable
                        hitSlop={6}
                        onPress={() =>
                          void Clipboard.setStringAsync(link(l)).then(() => setNotice(T.copied), () => undefined)
                        }
                      >
                        <Text style={{ color: p.primary, fontSize: 12.5, fontWeight: '700' }}>{T.copy}</Text>
                      </Pressable>
                      <Pressable hitSlop={6} disabled={busy} onPress={() => setAskStop(l.token)}>
                        <Text style={{ color: p.danger, fontSize: 12.5, fontWeight: '700' }}>{T.stop}</Text>
                      </Pressable>
                    </View>
                  ))
                : null}
            </View>
          ) : null}
          <ShareMessage text={notice} tone="ok" />
          {state ? <ShareMessage text={error} tone="error" /> : null}
        </>
      )}
    </ShareSheet>
  );
}
