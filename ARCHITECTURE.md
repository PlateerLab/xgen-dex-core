# 구조

세 개의 표면이 하나의 코어를 공유한다.

```
packages/protocol   XGEN 서버와 말하는 법. 순수 TypeScript, 의존 0.
packages/engine     이 기기에서 실제로 무언가를 하는 것. Node 를 쓰되 Electron 은 모른다.
packages/rpc        엔진을 다른 프로세스에 빌려주는 법 (JSON-RPC).

apps/desktop        Electron. 창·트레이·오버레이·자동업데이트.
apps/cli            터미널. Ink TUI + 일회성 명령.
apps/vscode         편집기. 웹뷰 + apps/cli 를 RPC 로 띄운다.
```

## 규칙

**1. 서버와 말하는 코드는 `packages/protocol` 에만 있다.**
앱이 `/api/...` 를 직접 부르면 CI 가 막는다. 이 규칙 하나가 이 저장소의 존재 이유다 —
예전에는 커넥터와 CLI 가 같은 WebSocket 프로토콜을 각자 구현했고, 재접속 정책이 서로
달랐으며, 한쪽만 고쳐진 채 몇 달을 갔다.

**2. 호스트가 다른 것은 포트로 받는다.**
설정을 어디에 두는가(`ConfigPort`), 비밀을 어떻게 보관하는가(`SecretPort`)는 호스트마다
다르다. 엔진은 인터페이스만 알고, 구현은 각 앱이 준다. 그 둘 말고 호스트가 달라지는
지점은 없다 — 실제로 세어 봤다.

**3. 패키지는 소스로 소비한다.**
세 앱 모두 번들러를 쓰므로(electron-vite / esbuild / esbuild) `@dex/*` 는 경로 별칭으로
붙고 빌드에 그대로 녹는다. 심링크도, 버전 올림도, ESM/CJS 이중 배포도 없다.

**4. 인터페이스는 다 있고, 표면은 앱이 고른다.**
CLI 는 Teams 와 음성을 쓰지 않지만 `packages/protocol` 에는 그 타입과 클라이언트가
그대로 있다. 나중에 켜는 것은 앱의 한 줄이지, 프로토콜의 재작성이 아니다.
