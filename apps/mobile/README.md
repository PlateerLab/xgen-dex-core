# XGEN Dex Mobile (React Native)

**서버 세션 채팅 + 모바일 도구** 전용 크로스플랫폼(안드로이드/iOS) 앱 —
데스크톱/CLI/VSCode 와 완전히 독립적으로 동작한다 (공유하는 것은
`@dex/protocol` 클라이언트 계층뿐). 데스크톱의 내장 웹 브라우저·IDE 등
특수 기능은 의도적으로 없다.

## 아키텍처

Expo(React Native) 위에 WebView 세대(apps/android, Capacitor)의 구조를
그대로 옮겼다 — **순수 로직 계층은 같은 파일**이고 전송로만 네이티브다:

| 계층 | 파일 | 비고 |
|---|---|---|
| 채팅 WS | `src/lib/chat-ws.ts` | `/api/agentflow/ws/geny-chat/{iid}` — WebView 세대와 동일 |
| 도구 브리지 WS | `src/lib/tool-bridge.ts` | `/api/tools/ws/connector-mcp/{uid}` — 데스크톱 McpBridge 와 같은 와이어 |
| 도구 정의/게이트 | `src/lib/mobile-tools.ts` | 파일 도구 7종(대화에 연결한 폴더) + 6그룹 도구, 그룹별 on/off + 승인 |
| 대화별 폴더 | `src/lib/mobile-folders.ts` · `folder-store.ts` · `folder-fs.ts` | 장부·가상 경로(`/<폴더>/…`) · 계정별 저장 · 플랫폼 파일 작업 |
| 폴더 네이티브 | `modules/xgen-folder-access` | 로컬 Expo 모듈 — Android 문서 제공자 트리, iOS 폴더 선택기+북마크 |
| 기기 어댑터 | `src/lib/rn-port.ts` | DevicePort 의 Expo 구현 (알림/카메라/위치/열기/…) |
| 클라이언트 조립 | `src/lib/xgen.ts` | REST=fetch(네이티브, CORS 없음), **WS 인증=Bearer 헤더** (쿠키/SameSite 핵 폐기 — RN WebSocket 은 헤더를 지원) |
| 껍데기 UI | `src/App.tsx` | [☰] 드로어 → 새 채팅 / 현재 채팅 / 채팅 목록 / 앱 / 설정 |
| 채팅 목록·시작 화면 | `src/conversations/*` | 대화 단위 목록(마지막으로 말한 순서, 40개씩), [+ 새 채팅] 시작 화면. 규칙은 `conversation-model.ts` (테스트가 지킨다) |
| 채팅 화면 | `src/chat/*` | 아래 표 참고 |
| 색·간격 | `src/theme.ts` | 팔레트 한 자리 (라이트/다크) |

### 채팅 화면 (`src/chat/`)

| 파일 | 하는 일 |
|---|---|
| `chat-view.tsx` | 화면 전체: 소켓 배선, 스크롤 규칙, 작성기, 첨부, 대화 이동 |
| `initial-message.ts` | 시작 화면에서 적은 첫 메시지를 소켓이 처음 붙을 때 한 번만 보내는 표식 |
| `folder-sheet.tsx` | 대화 머리의 [폴더 연결] — 이 대화에서 에이전트가 다룰 휴대폰 폴더 |
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

## 대화별 폴더 연결

에이전트의 파일 도구(ReadFile·WriteFile·ListDir·DeleteFile·Search·OpenFile·TakePhoto)는
**그 대화에 연결한 휴대폰 폴더** 안에서만 돈다. 대화 머리의 [폴더 연결]에서 시스템 폴더
선택기로 고르고, 해제하면 다음 요청부터 쓰지 않는다. 에이전트에게는 `/<폴더 이름>/…`
가상 경로로 보인다(휴대폰의 실제 경로는 사람이 알아볼 수 없고 OS 마다 다르다).

- **Android** — `ACTION_OPEN_DOCUMENT_TREE` 로 고르고 권한을 영구 보관한다. 파일 작업은
  네이티브 모듈이 그 트리 안에서만 한다(기기 저장소·SD 카드·다운로드·클라우드 제공자 모두).
- **iOS** — 폴더 선택기로 고르고 북마크로 보관한다. 북마크를 풀면 이 앱이 그 폴더에 접근할
  수 있고, 파일 작업은 expo-file-system 이 한다. 폴더가 옮겨져 북마크가 새로 나오면 저장본을
  바꾼다.

장부는 계정마다 따로다. 폴더 연결은 `local_folders` 로 매 턴 서버에 실리고(빈 목록 포함),
도구 호출은 서버가 실어 준 대화 id 로 이 기기의 장부에서 다시 확인한다.

## 네이티브 프로젝트

`android/`, `ios/` 는 `expo prebuild` 산출물을 **커밋**해 둔 것이다 — CI 는
재생성 없이 그대로 빌드한다(결정적). 수정한 부분:

- `android/app/build.gradle`: 버전을 `package.json` 에서 파생
  (versionCode = M·10⁶ + m·10³ + p), 릴리즈 서명을 환경변수(CI 시크릿) 기반
  고정 키로 — 키가 같아야 기존 설치 위 업데이트가 된다.
- `android/app/src/main/AndroidManifest.xml`: cleartext 허용(HTTP 서버 지원).

설정을 바꿔 prebuild 를 다시 돌렸다면 위 패치가 살아 있는지 확인할 것.

로컬 네이티브 모듈(`modules/`)은 자동 링크된다 — 안드로이드는 gradle 설정 단계, iOS 는
`pod install` 에서 잡힌다. 네이티브 프로젝트 파일을 고칠 필요는 없다.

## 개발

```
npm install
npm test          # 순수 로직 테스트 (node:test)
npm run typecheck
npm start         # expo dev server
```

APK 로컬 빌드: `npm run apk` (debug 키 서명 — 배포 키는 CI 시크릿에만 있다).
