/**
 * 서버 화면을 폰 안에 그리는 WebView — 내 앱·스토어 앱·문서 페이지·PDF·소리·영상이 함께 쓴다.
 *
 * 로그인은 쿠키로 싣는다(web-session). 서버 밖으로 나가는 이동(앱 안의 바깥 링크)은 WebView 에서 열지 않고
 * 기기의 브라우저로 넘긴다 — 우리 로그인이 실린 창에서 남의 사이트가 돌지 않게.
 *
 * WebView 는 따로 기록을 남기지 않는다(incognito) — 화면을 닫으면 심은 쿠키도 사라진다.
 */
import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useP } from '../theme';
import { serverOrigin, sessionBootstrapHtml, sessionDocumentHtml } from './web-session';

export type ServerWebContent =
  /** 같은 서버의 주소로 간다. `login` 이면 쿠키를 심고 간다(내 앱), 아니면 그대로(공개 링크). */
  | { kind: 'url'; url: string; login: boolean }
  /** 쿠키를 심은 한 장짜리 문서(문서 페이지·PDF·소리·영상). */
  | { kind: 'document'; body: string; head?: string };

export interface ServerWebViewHandle {
  reload(): void;
}

export const ServerWebView = forwardRef<
  ServerWebViewHandle,
  {
    serverUrl: string;
    token: string;
    content: ServerWebContent;
    dark?: boolean;
    /** 문서 안의 스크립트가 보낸 신호(예: PDF 를 그리지 못했다). */
    onMessage?: (data: string) => void;
  }
>(function ServerWebView({ serverUrl, token, content, dark, onMessage }, ref) {
  const p = useP();
  const web = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const origin = serverOrigin(serverUrl);
  const secure = origin.startsWith('https:');

  const source = useMemo(() => {
    if (content.kind === 'url') {
      if (!content.login) return { uri: content.url };
      return { html: sessionBootstrapHtml(content.url, token, { secure }), baseUrl: `${origin}/` };
    }
    return { html: sessionDocumentHtml(content.body, token, { secure, dark, head: content.head }), baseUrl: `${origin}/` };
    // nonce — [다시 읽기] 가 시작 문서부터 다시 연다(쿠키를 다시 심는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, token, origin, secure, dark, nonce]);

  const reload = useCallback(() => {
    setError('');
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);
  useImperativeHandle(ref, () => ({ reload }), [reload]);

  /** 같은 서버 안의 이동만 이 창에서 — 바깥 주소는 기기의 브라우저로. */
  const allow = useCallback(
    (req: WebViewNavigation) => {
      const url = req.url || '';
      if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:')) return true;
      try {
        if (new URL(url).origin === origin) return true;
      } catch {
        return false;
      }
      void Linking.openURL(url).catch(() => undefined);
      return false;
    },
    [origin],
  );

  if (!origin) {
    return (
      <View style={[st.center, { backgroundColor: p.bg }]}>
        <Text style={{ color: p.muted }}>서버 주소를 알 수 없습니다.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <WebView
        key={nonce}
        ref={web}
        source={source}
        originWhitelist={['*']}
        incognito
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={allow}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onError={(e) => setError(e.nativeEvent.description || '화면을 열지 못했습니다.')}
        onHttpError={(e) => {
          // 앱 안의 자원 하나가 실패한 것은 그 앱의 일이다 — 첫 문서가 실패했을 때만 알린다.
          if (e.nativeEvent.url && content.kind === 'url' && e.nativeEvent.url.split('?')[0] === content.url.split('?')[0]) {
            setError(`화면을 열지 못했습니다(${e.nativeEvent.statusCode}).`);
          }
        }}
        onMessage={(e) => onMessage?.(e.nativeEvent.data)}
        style={{ flex: 1, backgroundColor: p.bg }}
      />
      {loading && !error ? (
        <View pointerEvents="none" style={st.spinner}>
          <ActivityIndicator color={p.primary} />
        </View>
      ) : null}
      {error ? (
        <View style={[st.center, StyleSheet.absoluteFill, { backgroundColor: p.bg }]}>
          <Text style={{ color: p.text, fontSize: 15, marginBottom: 12, textAlign: 'center', paddingHorizontal: 24 }}>{error}</Text>
          <Pressable onPress={reload} style={[st.retry, { borderColor: p.border, backgroundColor: p.panel }]}>
            <Text style={{ color: p.text, fontWeight: '700' }}>다시 시도</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  spinner: { position: 'absolute', top: 16, left: 0, right: 0, alignItems: 'center' },
  retry: { height: 40, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
