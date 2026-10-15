/**
 * 앱 보기 — [열기] 를 누르면 폰 안에서 그 앱을 띄운다(데스크톱이 탭으로 여는 것과 같은 자리).
 *
 * 예전에는 기기의 브라우저로 넘겼다. 내 앱은 웹의 로그인이 없으면 열리지 않았고, 열려도 앱 밖으로 나갔다.
 *
 *   내 앱(사이트·앱)   그 앱의 주소를 바로 — 로그인은 쿠키로 싣는다(web-session)
 *   내 앱(옛 화면)     웹의 앱 화면(/app/…) — 같은 격리 프레임으로 그린다
 *   스토어의 앱        공개 링크 그대로 — 로그인을 싣지 않는다(남의 앱이다)
 *
 * 머리의 [브라우저로 열기] 는 기기의 브라우저로 넘기는 예전 길이다.
 */
import React, { useMemo, useRef } from 'react';
import { useColorScheme } from 'react-native';
import * as Linking from 'expo-linking';
import type { XgenMobileClient } from '../lib/xgen';
import { ScreenModal } from '../lib/screen-modal';
import { ServerWebView, type ServerWebViewHandle } from '../lib/server-web-view';
import type { AppViewTarget } from './app-targets';

export { myAppTarget, storeAppTarget, type AppViewTarget } from './app-targets';

export const AppViewer: React.FC<{
  client: XgenMobileClient;
  target: AppViewTarget | null;
  onClose: () => void;
}> = ({ client, target, onClose }) => {
  const web = useRef<ServerWebViewHandle>(null);
  const dark = useColorScheme() !== 'light';
  const actions = useMemo(
    () =>
      target
        ? [
            { icon: 'refresh' as const, label: '다시 읽기', onPress: (): void => web.current?.reload() },
            {
              icon: 'open-outline' as const,
              label: '브라우저로 열기',
              onPress: (): void => void Linking.openURL(target.browserUrl).catch(() => undefined),
            },
          ]
        : [],
    [target],
  );
  return (
    <ScreenModal visible={!!target} title={target?.title ?? ''} subtitle={target?.subtitle} onClose={onClose} actions={actions}>
      {target ? (
        <ServerWebView
          ref={web}
          serverUrl={client.session.serverUrl}
          token={client.session.accessToken}
          content={target.content}
          dark={dark}
        />
      ) : null}
    </ScreenModal>
  );
};
