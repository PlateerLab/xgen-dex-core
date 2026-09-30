# XGEN Dex Mobile (React Native)

**서버 세션 채팅 + 모바일 도구** 전용 크로스플랫폼(안드로이드/iOS) 앱 —
데스크톱/CLI/VSCode 와 완전히 독립적으로 동작한다 (공유하는 것은
`@dex/protocol` 클라이언트 계층뿐). 데스크톱의 클라우드 동기화·웹 브라우저 등
특수 기능은 의도적으로 없다.

## 아키텍처

Expo(React Native) 위에 WebView 세대(apps/android, Capacitor)의 구조를
그대로 옮겼다 — **순수 로직 계층은 같은 파일**이고 전송로만 네이티브다:

| 계층 | 파일 | 비고 |
|---|---|---|
| 채팅 WS | `src/lib/chat-ws.ts` | `/api/agentflow/ws/geny-chat/{iid}` — WebView 세대와 동일 |
| 도구 브리지 WS | `src/lib/tool-bridge.ts` | `/api/tools/ws/connector-mcp/{uid}` — 데스크톱 McpBridge 와 같은 와이어 |
| 도구 정의/게이트 | `src/lib/mobile-tools.ts` | 7그룹 × 12도구, 그룹별 on/off + 승인 |
| 기기 어댑터 | `src/lib/rn-port.ts` | DevicePort 의 Expo 구현 (파일/알림/카메라/위치/…) |
| 클라이언트 조립 | `src/lib/xgen.ts` | REST=fetch(네이티브, CORS 없음), **WS 인증=Bearer 헤더** (쿠키/SameSite 핵 폐기 — RN WebSocket 은 헤더를 지원) |
| 껍데기 UI | `src/App.tsx` | [☰] 드로어 → 현재 채팅 / 에이전트 목록 / 설정 |
| 채팅 화면 | `src/chat/*` | 아래 표 참고 |
| 색·간격 | `src/theme.ts` | 팔레트 한 자리 (라이트/다크) |

### 채팅 화면 (`src/chat/`)

| 파일 | 하는 일 |
|---|---|
| `chat-view.tsx` | 화면 전체 — 소켓 배선, 스크롤 규칙, 작성기, 첨부, 대화 이동 |
| `message-model.ts` | 대화 한 줄의 모양과 그것을 고치는 **순수 규칙** (테스트가 지킨다) |
| `message-item.tsx` | 말풍선 한 개 — 답변 본문·오류 블록·출처·복사 |
| `markdown.tsx` | 답변 본문 렌더 (코드 블록 가로 스크롤 + [복사], 표 가로 스크롤) |
| `tool-activity.tsx` | 도구 과정 칩 — 한 번에 하나, 다음 것으로 크로스페이드 |
| `tool-log-sheet.tsx` | [전체 로그 보기] — 호출별 인자·결과·소요 시간, 항목별 복사 |
| `trigger-row.tsx` | Job/sub-agent 가 깨운 턴의 한 줄 표시 |
| `answer-notice.ts` | 앱이 뒤에 있을 때 답변 도착 알림 |

도구 칩·전체 로그의 **규칙**(짝 맞추기·건수 세기·이름 줄이기)은 앱마다 두지 않는다 —
`@dex/protocol` 의 `tool-activity` 가 정본이고 데스크톱·웹도 같은 것을 쓴다.

`@dex/protocol` 은 metro alias 로 소스 그대로 번들된다. RN 에 없는
WebCrypto(`crypto.subtle.digest`)는 `src/shims/crypto.ts` 가 순수 JS 로 채운다.

## 네이티브 프로젝트

`android/`, `ios/` 는 `expo prebuild` 산출물을 **커밋**해 둔 것이다 — CI 는
재생성 없이 그대로 빌드한다(결정적). 수정한 부분:

- `android/app/build.gradle`: 버전을 `package.json` 에서 파생
  (versionCode = M·10⁶ + m·10³ + p), 릴리즈 서명을 환경변수(CI 시크릿) 기반
  고정 키로 — 키가 같아야 기존 설치 위 업데이트가 된다.
- `android/app/src/main/AndroidManifest.xml`: cleartext 허용(HTTP 서버 지원).

설정을 바꿔 prebuild 를 다시 돌렸다면 위 패치가 살아 있는지 확인할 것.

## 개발

```
npm install
npm test          # 순수 로직 테스트 (node:test)
npm run typecheck
npm start         # expo dev server
```

APK 로컬 빌드: `npm run apk` (debug 키 서명 — 배포 키는 CI 시크릿에만 있다).

## 기기 보안 키 / Native device security key

HTTPS 서버 로그인 후 **설정 → 기기 보안**에서 `기기 키 상태 확인`과 `인증 키 준비`를 사용할 수 있다. 준비 성공은 로컬 키의 존재만 의미한다. 서버 기기 등록·브라우저 승인·Platform Session과 Canonical 구독은 후속 연결이다.

- `modules/xgen-native-device`: Expo 로컬 모듈. iOS Secure Enclave, Android 28 이상 TEE/StrongBox P-256 키. 화면 잠금이 필요하다. 개인키를 JS로 반환하거나 소프트웨어 저장소로 대체하지 않는다.
- 서버 HTTPS origin·실제 사용자별 설치 ID/공개키를 복원한다. 기록 불일치에는 자동 생성·덮어쓰기하지 않고 복구를 요구한다. 기기 키 준비는 신뢰 승인 없이 HTTP 호출도 하지 않는다.
- Expo Go·웹·iOS Simulator 및 지원하지 않는 하드웨어에서는 안전한 오류가 표시된다. 로컬 모듈을 포함한 development build 또는 native build를 사용해야 한다. [Expo 개발 빌드](https://docs.expo.dev/workflow/customizing/).
- 계정·서버·재로그인·설정 화면 이탈·백그라운드·취소 이후 늦게 도착한 결과를 폐기한다. 이미 시작된 OS 키 생성은 취소되지 않을 수 있으나 원래 계정에만 묶이고 서버 신뢰를 얻지 않는다.

빌드·검증 (아래 명령은 `apps/mobile`에서 실행):

```sh
npm test
npm run typecheck
cd android
# JDK 21 및 설치된 Android SDK가 필요하다.
./gradlew :xgen-native-device:compileDebugKotlin :xgen-native-device:testDebugUnitTest
cd ../ios
pod install
xcodebuild -workspace XGENDex.xcworkspace -scheme XGENDex \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

실제 iPhone/Android 기기에서 키 생성 → 앱 종료/재실행 → 같은 공개키·설치 ID 복원 → challenge 서명, 잠금/화면 잠금 해제 및 계정 전환을 검증해야 한다. `verify/native-device-key-codec.swift`는 생산 codec의 서명 변환 검증이고 `verify/native-device-key-simulator.swift`는 생산 공급자의 시뮬레이터 거절 검증 앱이다. Simulator 성공 빌드와 테스트의 소프트웨어 키는 실제 하드웨어 성공 증거가 아니다. 자세한 증거·제한은 [통합 문서](../../docs/cross-platform-session-integration.md#mobile-하드웨어-기기-키-기반-2026-09-30)에 있다.

After signing in to an HTTPS server, **Settings → Device security** can inspect or prepare a local hardware key. This does not enroll a trusted device or issue a Platform Session. A native build is required: Expo Go, web, iOS Simulator and unsupported hardware fail closed. Private key material stays in Secure Enclave or Android hardware-backed Keystore; JavaScript receives public metadata and fixed challenge proofs only. Lost or inconsistent records require recovery rather than silent key replacement. Physical-device generation, persistence, lock behavior and signing still need validation before the server enrollment/session and Canonical subscription steps.
