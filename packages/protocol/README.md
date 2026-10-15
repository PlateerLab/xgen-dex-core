# @dex/protocol

XGEN 서버와 말하는 법. **의존 0** — 브라우저에서도, Electron 렌더러에서도,
Node 에서도, 터미널에서도 같은 코드가 돈다.

여기 있는 것과 없는 것의 기준은 하나다: **서버와 주고받는 것인가.**

- 있다 — HTTP 클라이언트, 인증·토큰 회전, SSE 파싱, 채팅/이력/에이전트/SSH/Teams/
  음성/알림의 요청·응답 타입, 그리고 그 응답을 다루는 **순수 함수**
  (`stripBrowserContext`, `toHistoryAttachments` 처럼 서버 응답의 형태를 아는 것).
  도구 과정 표시 규칙(`tool-activity`: `collapseToolSteps` · `pairToolCalls` ·
  `countToolCalls`)도 여기다 — 도구 이벤트의 모양을 알고, 앱과 웹이 같은 건수를 말해야 한다.
- 없다 — 파일을 읽거나, 프로세스를 띄우거나, 창을 열거나, 디스크에 무언가를
  쓰는 것. 그건 `@dex/engine` 이나 앱의 일이다.

## 앱이 전부를 쓰지 않아도 된다

CLI 는 Teams 와 음성을 부르지 않는다. 그래도 타입과 클라이언트는 여기 남는다 —
나중에 켜는 것이 앱의 한 줄이 되도록.

`XgenClient` 는 필요한 것만 붙일 수 있다:

```ts
const client = new XgenClient({ baseUrl, surface: 'cli' });
client.chat;    // 언제나
client.ssh;     // 언제나
client.teams;   // surface: 'desktop' 일 때만 — 아니면 접근 시 명확히 거절
```

## Native 기기 인증

`NativePlatformSessionClient`는 HTTPS Gateway의 기기 등록·상태 조회·선택 브라우저 승인 요청·로그인·refresh 회전 계약을 제공한다. 호스트는 검증한 계정의 현재 범위와 토큰, 고정 설치 ID·공개키 및 개인키 서명 공급자를 제공한다. `createNativeDeviceSigner`는 비추출 WebCrypto P-256 키를 사용하는 호스트를 위한 도우미다. 개인키나 회전 토큰의 저장, 앱 로그인 UI 및 DPoP access 공급자는 호스트가 구현한다. 상세 통신 경계와 로컬 Compose 검증 방법은 저장소의 `docs/cross-platform-session-integration.md`를 참고한다.
