/**
 * 파일 한 장 보기 — 에이전트 [스토리지] 의 파일을 폰 안에서 **그려서** 보여 준다(데스크톱·웹과 같은 규칙).
 *
 *   그림        RN 그림(로그인 머리를 실어 받는다)
 *   md          마크다운으로 그린다(채팅 답변과 같은 렌더러)
 *   코드·글     고정폭 글
 *   csv·tsv     표
 *   문서        서버 렌더 페이지 그림(docx·pptx·xlsx·hwp — [파일 저장소] 와 같은 렌더러)
 *   PDF         pdf.js 로 쪽마다(안드로이드 WebView 는 PDF 를 그리지 못한다)
 *   소리·영상   기기의 재생기
 *
 * 어떤 형식이든 [내보내기] 로 기기 앱에 넘길 수 있다.
 * 어떻게 그릴지 정하는 규칙(kindForFile)은 데스크톱과 같은 한 곳(@dex/protocol file-view)이다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  decodeText,
  extOf,
  formatBytes,
  kindForFile,
  looksBinary,
  parseCsv,
  TEXT_RENDER_LIMIT,
  type ViewerKind,
} from '@dex/protocol';
import { MONO, useP, type Palette } from '../theme';
import type { XgenMobileClient } from '../lib/xgen';
import { serverLink } from '../lib/links';
import { friendlyError } from '../lib/errors';
import { ScreenModal } from '../lib/screen-modal';
import { ServerWebView } from '../lib/server-web-view';
import { mediaBody, pagesBody, pdfBody } from '../lib/web-session';
import { AssistantMarkdown } from '../chat/markdown';

export interface PreviewFile {
  path: string;
  name: string;
  size?: number | null;
}

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'text'; text: string; truncated: boolean }
  | { state: 'pages'; pages: string[] }
  | { state: 'ready' };

export const FilePreviewScreen: React.FC<{
  client: XgenMobileClient;
  workflowId: string;
  file: PreviewFile | null;
  onClose: () => void;
}> = ({ client, workflowId, file, onClose }) => {
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState('');

  const share = async () => {
    if (!file || exporting) return;
    setExporting(true);
    setNote('');
    try {
      const url = serverLink(client.session.serverUrl, client.api.agentData.workspaceRawPath(workflowId, file.path));
      const dest = `${FileSystem.cacheDirectory}${Date.now()}-${file.name.replace(/[\\/:*?"<>|]/g, '_')}`;
      const res = await FileSystem.downloadAsync(url, dest, { headers: { Authorization: `Bearer ${client.session.accessToken}` } });
      if (res.status >= 400) throw new Error(`파일을 받지 못했습니다(${res.status}).`);
      if (!(await Sharing.isAvailableAsync())) throw new Error('이 기기에서는 내보낼 수 없습니다.');
      await Sharing.shareAsync(res.uri, { dialogTitle: file.name });
    } catch (e) {
      setNote(friendlyError(e, '내보내지 못했습니다.'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <ScreenModal
      visible={!!file}
      title={file?.name ?? ''}
      subtitle={file?.size != null ? formatBytes(file.size) : undefined}
      onClose={onClose}
      actions={[{ icon: 'share-outline', label: '내보내기', onPress: () => void share(), disabled: exporting }]}
    >
      {file ? <FileBody client={client} workflowId={workflowId} file={file} onShare={() => void share()} /> : null}
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </ScreenModal>
  );
};

const FileBody: React.FC<{ client: XgenMobileClient; workflowId: string; file: PreviewFile; onShare: () => void }> = ({
  client,
  workflowId,
  file,
  onShare,
}) => {
  const p = useP();
  const dark = p.bg === '#0E1015';
  const declared: ViewerKind = kindForFile(file.name);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [kind, setKind] = useState<ViewerKind>(declared);
  const rawPath = client.api.agentData.workspaceRawPath(workflowId, file.path);

  useEffect(() => {
    let alive = true;
    setKind(declared);
    setLoaded({ state: 'loading' });
    void (async () => {
      try {
        if (declared === 'office') {
          const meta = await client.api.agentData.workspaceDocPreview(workflowId, file.path);
          if (!alive) return;
          const pages = meta.pages.map((pg) => client.api.agentData.workspacePreviewPagePath(workflowId, pg)).filter(Boolean);
          if (!pages.length) throw new Error('이 문서의 미리보기를 만들지 못했습니다.');
          setLoaded({ state: 'pages', pages });
          return;
        }
        if (['image', 'pdf', 'audio', 'video'].includes(declared)) {
          setLoaded({ state: 'ready' });
          return;
        }
        // 글로 그리는 형식 — md·코드·csv, 그리고 모르는 확장자(글이면 코드로 보인다).
        const { bytes } = await client.api.agentData.workspaceBinary(workflowId, file.path);
        if (!alive) return;
        if (declared === 'binary' && looksBinary(bytes)) {
          setLoaded({ state: 'ready' });
          return;
        }
        const truncated = bytes.byteLength > TEXT_RENDER_LIMIT;
        const text = decodeText(truncated ? bytes.subarray(0, TEXT_RENDER_LIMIT) : bytes);
        if (declared === 'binary') setKind('code');
        setLoaded({ state: 'text', text, truncated });
      } catch (e) {
        if (alive) setLoaded({ state: 'error', message: friendlyError(e, '파일을 열지 못했습니다.') });
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, workflowId, file.path, declared]);

  if (loaded.state === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={p.primary} />
        {declared === 'office' ? <Text style={[styles.hint, { color: p.muted }]}>문서를 그리는 중입니다. 처음 여는 문서는 시간이 걸립니다.</Text> : null}
      </View>
    );
  }
  if (loaded.state === 'error') {
    return (
      <View style={styles.center}>
        <Text style={{ color: p.text, textAlign: 'center', paddingHorizontal: 24 }}>{loaded.message}</Text>
      </View>
    );
  }

  const server = client.session.serverUrl;
  const token = client.session.accessToken;
  if (loaded.state === 'pages') {
    return <ServerWebView serverUrl={server} token={token} dark={dark} content={{ kind: 'document', body: pagesBody(loaded.pages, file.name) }} />;
  }
  if (kind === 'pdf') return <ServerWebView serverUrl={server} token={token} dark={dark} content={{ kind: 'document', body: pdfBody(rawPath) }} />;
  if (kind === 'audio' || kind === 'video') {
    return <ServerWebView serverUrl={server} token={token} dark={dark} content={{ kind: 'document', body: mediaBody(rawPath, kind) }} />;
  }
  if (kind === 'image') return <ImageView uri={serverLink(server, rawPath)} token={token} />;
  if (loaded.state === 'text') {
    const tail = loaded.truncated ? <Text style={[styles.hint, { color: p.muted }]}>앞 2MB만 보여 줍니다.</Text> : null;
    if (kind === 'markdown') {
      return (
        <ScrollView contentContainerStyle={styles.pad}>
          <AssistantMarkdown text={loaded.text} />
          {tail}
        </ScrollView>
      );
    }
    if (kind === 'csv') return <CsvTable text={loaded.text} tsv={extOf(file.name) === 'tsv'} p={p} footer={tail} />;
    return (
      <ScrollView contentContainerStyle={styles.pad}>
        <ScrollView horizontal>
          <Text selectable style={[styles.code, { color: p.text, backgroundColor: p.code }]}>
            {loaded.text || ' '}
          </Text>
        </ScrollView>
        {tail}
      </ScrollView>
    );
  }
  return (
    <View style={styles.center}>
      <Text style={{ color: p.text, fontWeight: '700', marginBottom: 6 }}>{file.name}</Text>
      <Text style={{ color: p.muted, marginBottom: 16 }}>미리보기를 지원하지 않는 형식입니다.</Text>
      <Pressable onPress={onShare} style={[styles.btn, { backgroundColor: p.primary }]}>
        <Text style={{ color: p.onPrimary, fontWeight: '800' }}>내보내기</Text>
      </Pressable>
    </View>
  );
};

const ImageView: React.FC<{ uri: string; token: string }> = ({ uri, token }) => {
  const { width } = useWindowDimensions();
  const [ratio, setRatio] = useState(1);
  const [failed, setFailed] = useState(false);
  const p = useP();
  if (failed) {
    return (
      <View style={styles.center}>
        <Text style={{ color: p.muted }}>그림을 받지 못했습니다.</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.pad} maximumZoomScale={4} minimumZoomScale={1} centerContent>
      <Image
        source={{ uri, headers: { Authorization: `Bearer ${token}` } }}
        style={{ width: width - 24, height: (width - 24) / ratio, borderRadius: 6 }}
        resizeMode="contain"
        onLoad={(e) => {
          const { width: w, height: h } = e.nativeEvent.source;
          if (w && h) setRatio(w / h);
        }}
        onError={() => setFailed(true)}
      />
    </ScrollView>
  );
};

const CsvTable: React.FC<{ text: string; tsv: boolean; p: Palette; footer: React.ReactNode }> = ({ text, tsv, p, footer }) => {
  const { rows, truncated } = useMemo(() => parseCsv(text, tsv ? '\t' : ','), [text, tsv]);
  if (rows.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={{ color: p.muted }}>빈 파일입니다.</Text>
      </View>
    );
  }
  const [head, ...body] = rows;
  const cell = (value: string, i: number, bold = false) => (
    <Text key={i} numberOfLines={3} style={[styles.cell, { color: p.text, borderColor: p.border }, bold && { fontWeight: '800', backgroundColor: p.panel2 }]}>
      {value}
    </Text>
  );
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <ScrollView horizontal>
        <View style={{ borderWidth: 1, borderColor: p.border, borderRadius: 6, overflow: 'hidden' }}>
          <View style={styles.row}>{head.map((h, i) => cell(h, i, true))}</View>
          {body.map((r, ri) => (
            <View key={ri} style={styles.row}>
              {head.map((_, i) => cell(r[i] ?? '', i))}
            </View>
          ))}
        </View>
      </ScrollView>
      {truncated ? <Text style={[styles.hint, { color: p.muted }]}>표는 2,000행까지 보여 줍니다.</Text> : null}
      {footer}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  pad: { padding: 12, paddingBottom: 40 },
  hint: { fontSize: 13, marginTop: 12, textAlign: 'center' },
  note: { position: 'absolute', bottom: 24, left: 16, right: 16, textAlign: 'center', color: '#fff', backgroundColor: 'rgba(0,0,0,0.75)', padding: 10, borderRadius: 10, overflow: 'hidden' },
  code: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18, padding: 10, borderRadius: 8, minWidth: '100%' },
  row: { flexDirection: 'row' },
  cell: { width: 140, paddingHorizontal: 8, paddingVertical: 6, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, fontSize: 13 },
  btn: { height: 44, paddingHorizontal: 22, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
