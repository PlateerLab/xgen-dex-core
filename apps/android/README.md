# XGEN Dex Android

**서버 세션 채팅 + 모바일 도구** 전용 안드로이드 앱 — 데스크톱/CLI/VSCode 와
완전히 독립적으로 동작한다 (공유하는 것은 `@dex/protocol` 클라이언트 계층뿐).
데스크톱의 클라우드 동기화·웹 브라우저 등 특수 기능은 의도적으로 없다.

## 구조

- 채팅: `wss://<gateway>/api/agentflow/ws/geny-chat/{interaction_id}` — 쿠키
  (`xgen_access_token`) 인증 WS 스트리밍. `client_surface: 'connector'` +
  `execution_target: 'sandbox'` 로 실행은 항상 서버, 도구만 휴대폰에서 돈다.
- 모바일 도구: `wss://<gateway>/api/tools/ws/connector-mcp/{user_id}` — 데스크톱
  McpBridge 와 같은 hello/mcp_call 와이어 (서버 무변경). 네임스페이스 `mobile`
  (`mcp_mobile_*`). 사용자당 1연결 last-writer-wins — 이 앱이 연결된 동안
  데스크톱 로컬 도구 대신 휴대폰 도구가 노출된다.
- REST(로그인/목록/히스토리): CapacitorHttp(네이티브) — WebView CORS 우회.
- 파일 도구 루트: 공용 `Documents/XGenDex` (경로 탈출 차단).

## 빌드

```bash
npm ci && npm test && npm run build   # 웹 번들 + 로직 테스트
npx cap sync android                  # 네이티브 프로젝트 동기화
cd android && ./gradlew assembleRelease   # APK (로컬은 debug 키 서명)
```

릴리즈 파이프라인(.github/workflows/release.yml 의 `android` 잡)이
`XGen-Dex-<버전>.apk` 를 GitHub Release 에 올린다. 버전은 모노레포
package.json 단일 원천이다 (`versionCode = M*1e6 + m*1e3 + p`).
