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

HTTPS 서버 로그인 후 **설정 → 기기 보안**에서 `기기 키 상태 확인`과 `인증 키 준비`를 사용할 수 있다. 준비 성공은 로컬 키의 존재만 의미한다. 아래의 등록·승인·휴대폰 세션 절차를 별도로 완료해야 하며 Canonical 구독은 후속 연결이다.

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

## 서버 기기 등록 / Server device enrollment

HTTPS 서버 로그인 후 **설정 → 기기 보안**에서 키를 준비하고 **휴대폰 기기 등록**에서 `이 휴대폰 등록`을 누른다. 이름과 기존 등록 상태는 실제 계정·서버·설치 키에 묶인다. `등록·승인 상태 확인`으로 pending/trusted/정지/폐기를 확인한다.

1. 승인할 신뢰 PC 브라우저를 선택한다. 기본 승인 브라우저가 하나면 최초 조회 시 선택되며, 없는 경우 직접 선택한다. 선택한 기기가 폐기되면 다른 기기로 자동 전환하지 않는다.
2. `선택한 브라우저에 승인 요청`을 누른다. 새 요청은 이전 pending 요청을 대체한다.
3. 6자리 코드를 양쪽에서 대조하고 선택한 브라우저의 내 페이지 → 세션에서 비밀번호·브라우저 키로 승인한다. 이 코드는 인증 수단이 아니다.
4. Mobile에서 상태를 다시 조회해 trusted를 확인한다. 이 단계는 Platform Session을 발급하지 않는다.

별도 native TLS 공급자는 enrollment API만 허용하고 Cookie/redirect/cache/credential storage를 사용하지 않는다. Android는 implicit connection retry를 끈다. iOS는 POST body stream 재공급과 앱 재시도를 거절하지만 URLSession 내부 재시도 전체의 차단 또는 exactly-once 전달을 보장하지 않는다. 서버의 일회 challenge 소비·설치 ID별 상태 조회와 결과 불확실 처리가 필요하다. login/refresh/Canonical 경로는 이 전송의 허용 범위에 없다.

계정/서버/로그인 수명 변경·로그아웃·화면 이탈·백그라운드·취소 이후 결과를 버리고 OS 요청도 취소한다. 등록/승인 실패는 자동 반복하지 않으며 상태와 브라우저의 요청을 확인한 뒤 직접 다시 요청한다. 실제 휴대폰 테스트가 필요하다. 로컬 Compose 계약 검증은 저장소 루트에서 `node --import tsx scripts/native-platform-session-compose.mts --mobile-controller`로 실행하며 소프트웨어 테스트 키와 Node TLS bridge를 쓰고 임시 자료를 정리한다.

After preparing a local hardware key, Mobile Settings can register this phone, reconcile its server trust status and request approval from a selected trusted PC browser. Compare the six-digit display code, approve using password/browser key on that browser, then explicitly refresh Mobile status. A unique default approver is preselected once; missing or revoked selections require a deliberate new choice. Enrollment does not issue a session. Dedicated native TLS enforces a narrow enrollment allowlist and rejects cookie/redirect reuse. Android disables implicit connection retries. iOS refuses replacement POST streams and app retries, but URLSession provides no exactly-once delivery guarantee. Cancellations and account/screen changes discard late results. Physical-device/UI success and session/Canonical wiring remain follow-up gates.

macOS에서 `apps/mobile` 기준 `bash verify/run-native-enrollment-transport.sh`는 임시 TLS leaf 인증서와 실제 URLSession으로 헤더·Cookie·redirect·stream cap·UTF-8·취소·POST 연결 분실을 검증한다. `NATIVE_ENROLLMENT_TRANSPORT_TESTING`은 이 임시 verifier에만 사용하고 앱 빌드에는 설정하지 않는다. 임시 인증서는 production 신뢰 저장소에 등록하지 않으며 종료 시 서버와 키를 정리한다.

On macOS, run `bash verify/run-native-enrollment-transport.sh` from `apps/mobile` for a real URLSession TLS fixture. Its temporary leaf certificate is injected only into a verifier built with `NATIVE_ENROLLMENT_TRANSPORT_TESTING`, never into a production app or system trust store. The fixture server and key are removed on exit.

## 휴대폰 세션 / Mobile Platform Session

HTTPS 서버 로그인 → 기기 키 준비 → 휴대폰 등록 → PC 브라우저 승인을 완료한 뒤 **설정 → 휴대폰 세션**에서 현재 계정 비밀번호로 발급한다. 서버가 ACTIVE 발급을 허용해야 한다. `저장된 세션 상태 확인`은 로컬 보관 상태만 조회하며 서버 신뢰·세션 유효성을 대신하지 않는다. 자동 발급·갱신·재시도는 없다. 기존 로그인·채팅 자격증명과 별도이며, 발급된 세션의 Canonical 포커스는 아래 별도 메뉴에서 조회·구독한다.

- 별도 SecureStore service에 `mobile + HTTPS origin + 실제 사용자`별 record/journal을 저장한다. iOS 접근은 `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`이며 개인키를 저장하지 않는다. 공개 설치 ID/키 지문·device/sid·JWT sub/platform/cnf/expiry가 일치해야 복원한다. AsyncStorage·legacy 세션·Bearer로 대체하지 않는다. 서버가 JWT 서명과 현재 신뢰·권한·sid를 검증한다.
- 발급·회전·폐기 전에 token-free journal을 저장하고 읽어 확인한 뒤 기존 credential record를 삭제한다. 완료 결과는 새 credential 저장·readback을 마친 뒤 journal을 지운다. journal이 남은 충돌·저장 실패·취소·응답 유실·앱 종료에는 처리 중 기록이 다음 토큰 사용을 막는다. OS journal 삭제 시작 이후는 취소할 수 없는 commit으로 취급한다. 그때 계정/화면이 바뀌면 옛 화면 결과는 버리고, 원래 계정의 검증된 새 record만 다음 명시적 조회로 복원할 수 있다. 여러 화면 owner도 계정별 공통 lock을 사용한다.
- refresh에는 계정 Bearer를 보내지 않는다. 서버 세션 폐기는 현재 계정 비밀번호와 같은 하드웨어 키의 DPoP를 사용한다. DPoP는 네이티브에서 UUID jti·현재 iat·access hash·고정 method/HTTPS resource·공개 JWK를 조립하고 ES256으로 서명한다. 임의 body/route/원본 바이트 서명 API는 없다.
- 발급/폐기 버튼을 누르면 비밀번호 입력을 즉시 비우고, 백그라운드·계정/서버 변경·화면 이탈 때 요청을 취소하고 늦은 결과를 버린다. JS 문자열의 메모리 삭제를 보장하지는 않으며 토큰·비밀번호를 화면 상태나 진단에 기록하지 않는다.
- `pending_takeover`에는 토큰이 없다. 처리 중·인계 대기 결과는 PC 내 페이지에서 서버 세션을 확인·폐기한 후 `로컬 세션 기록만 삭제`로 복구한다. 로컬 삭제는 서버 폐기가 아니며 기기 키와 등록은 유지한다. 키가 없거나 손상돼도 현재 계정의 로컬 기록 삭제는 가능하다.

enrollment 전송과 별도 `sessionRequest` allowlist는 native login-key/refresh POST 및 현재 세션 폐기 DELETE만 허용한다. 같은 예약 ID·취소·TLS·Cookie/redirect/크기 경계를 공유한다. 서버 login/refresh complete는 Redis flow/challenge를 먼저 일회 소비하며, refresh DB 회전은 소비된 토큰 재사용을 거절한다. iOS URLSession의 내부 재전송은 exactly-once로 보장할 수 없다. 전송 결과를 받지 못하면 journal을 유지하고 이전 refresh로 다시 시도하지 않는다. Canonical GET는 별도 `readRequest` allowlist를 사용한다.

After enrollment and browser approval, **Settings → Mobile session** explicitly issues, inspects, rotates or revokes a separate Mobile Platform Session. SecureStore records are bound to the HTTPS account, installation/hardware key and server sid. A verified token-free journal is written before credentials are removed and any mutation starts; new credentials are written and read back before the journal is cleared. Interrupted or uncertain operations block reuse across owners/restarts. Refresh carries no account Bearer. Logout requires password and native ES256 DPoP for the stored access/sid. Local erasure preserves the hardware key and does not revoke the server session. Account/screen/background changes cancel and discard stale results. Existing chat remains on its current credential path. Physical-device storage/signing/UI validation and ACTIVE/takeover positive verification remain required; URLSession still provides no exactly-once delivery guarantee.

## 계정 Agent 포커스 / Canonical account focus

사용 가능한 휴대폰 세션을 발급·갱신한 뒤 **설정 → 계정 Agent 포커스**에서 `현재 Agent 포커스 조회` 또는 `포커스 변경 구독 시작`을 누른다. 서버의 현재 Agent 세션 ID와 포커스 버전을 표시한다. 메시지 목록·대화 선택·기존 채팅/WS 전환은 후속 단계다.

- 구독은 foreground에서 2초 간격으로 account events를 읽는다. 공통 snapshot/replay/gap·409 복구 규칙을 사용하며 step은 최대 10초·10페이지다. backlog는 간격 없이 다음 bounded step으로 이어간다.
- 각 step은 계정별 vault lock 안에서 record/journal을 새로 확인하고 현재 access와 하드웨어 DPoP를 사용한다. 정상 읽기 후 lock을 놓고 대기하므로 수동 갱신·폐기가 가능하다. 같은 sid의 token 회전은 커서를 유지하고 origin/사용자/로그인 수명/install/key/device/sid 변경은 snapshot부터 조회한다. 토큰·proof는 cursor/UI/진단에 담지 않는다.
- 읽기만 transport/408/429/5xx/timeout에 1·2·4·8·16·30초 backoff를 사용한다. 서버 인증 거절·만료·journal·키/저장소·protocol 오류는 중단하며 자동 refresh/legacy Bearer fallback이 없다. 재연결·중단 시 화면 포커스를 지운다.
- 화면 이탈·계정 변경·백그라운드·취소는 요청과 대기를 중단하며 늦은 결과를 버린다. 돌아와도 자동 재시작하지 않는다. 취소가 OS 완료 확인은 아니므로 실제 native Promise가 끝날 때까지 같은 module/origin의 새 GET을 막는다. source busy/native 예약 한도 busy가 연속 4번이면 중단한다. 이 대기는 vault lock을 무한히 유지하지 않으며 명시적 갱신·로컬 복구를 허용한다. 취소된 OS 요청 내부 헤더는 완료까지 남을 수 있다. bridge가 없거나 구형 native 앱이면 활성화를 거절하며 앱 업데이트가 필요하다.
- 별도 5인자 `readRequest`는 GET 고정·본문 없음·JSON Accept/DPoP Authorization/DPoP만 허용한다. query 순서/숫자 범위/canonical UUID를 두 OS와 JS에서 대조하고 DPoP `htu`에는 query를 제외한다. 기존 시스템 TLS·Cookie/redirect/cache·64 KiB 응답/UTF-8·예약/취소 경계를 재사용한다.

검증 명령: `npm test`, `npm run typecheck`(apps/mobile), `bash verify/run-native-enrollment-transport.sh`(macOS), 저장소 루트의 `node --import tsx scripts/native-platform-session-compose.mts --mobile-focus`. Compose enrollment mode에서는 login 503 → journal로 구독의 wire 이전 차단과 임시 자료 정리를 확인한다. replay 양성 테스트는 통제된 fixture이며 실기기 SecureStore/hardware/UI 및 실제 ACTIVE 서버 성공은 별도 관문이다.

**Settings → Account Agent focus** explicitly reads or starts foreground polling for the canonical focus ID/version using a ready Mobile session. Shared reconciliation recovers gaps/409 via snapshot, bounds each step to ten seconds/ten pages, and scopes the cursor to the verified login/installation/key/device/sid. Each step reloads the secure vault and signs fresh query-free GET DPoP; token rotation on the same sid preserves the cursor. Waits release the account lock. Only reads retry transient failures, with capped backoff; authentication, expiry, interruption journals, key/vault and protocol failures stop. Account/screen/background changes cancel and clear the view, with no automatic restart, refresh or legacy fallback. Native cancellation remains busy across owners until the actual OS Promise settles, and persistent busy stops after four attempts while explicit vault recovery remains available. Dedicated GET transport validates exact routes/ordered queries and reuses system TLS/cookie/redirect/size/cancel boundaries. Missing or outdated native bridges fail closed. Physical-device/UI and real ACTIVE positive validation remain required; enrollment-mode Compose verifies pre-wire rejection and cleanup, not a successful live subscription. Message/WS integration follows separately.


## 공유 대화 메시지 / Shared conversation messages

**설정 → 공유 대화 보기**에서 현재 Agent 대화, 최신 턴의 실행 상태와 서버 journal에 연결된 완결 메시지를 조회한다. `현재 공유 대화 조회`는 최대 10단계(단계당 메시지 1개씩 2페이지)를 읽으며, 기록이 더 있으면 일부 조회로 표시한다. `대화 변경 구독 시작`은 남은 기록을 이어 읽고 이후 foreground에서 변경을 확인한다. 모든 과거 이력을 표시한다는 의미는 아니며 진행 중 출력은 턴 완료 후 표시한다. null/비문자열/크기 제한으로 확인할 수 없는 내용은 미확인으로 표시한다.

- 실행 이벤트와 sparse message.created 커서를 따로 보관한다. 이벤트 gap/409는 한 번 snapshot으로 복구하고, 메시지 페이지/연결 무결성 오류와 네이티브 redirect/UTF8/응답 크기 오류는 중단한다. 본문을 읽는 동안 다른 플랫폼에서 대화 선택이 바뀌면 이전 본문을 폐기하고 새 대화를 이어 조회한다.
- 표시 상태는 메모리에만 두며 최대 100턴/본문 UTF8 4MiB다. 초과한 오래된 턴의 생략 개수를 표시한다. 화면 이탈·백그라운드·계정 변경·인증 실패 시 지우고 사용자가 직접 다시 시작한다. 실행 이벤트·인증 커서/토큰·raw ExecutionIO/tool envelope는 화면에 전달하지 않는다.
- Native GET `/api/agentflow/agent-sessions/{uuid}/messages?after_sequence=0&limit=1`을 허용한다. limit 1..20, safe integer sequence, canonical lowercase UUID, query-free DPoP를 검증한다. `/messages`만 최대 1MiB UTF8 응답이며 나머지는 64KiB다. native 모듈을 포함한 앱 빌드가 필요하다.

검증: `npm test`, `npm run typecheck`(apps/mobile), 루트 `npm --workspace @dex/protocol test`, `npm --workspace @dex/protocol run check`, `npm run contracts`, macOS `bash verify/run-native-enrollment-transport.sh`, opt-in `node --import tsx scripts/native-platform-session-compose.mts --mobile-messages`. Compose enrollment mode는 login_pending journal의 wire 이전 차단을 검증한다. 실제 ACTIVE/실기기 SecureStore·hardware·UI, native WS ticket/socket 및 기존 채팅 송신 이행은 다음 관문이다.

**Settings → Shared conversation messages** explicitly reads or polls the current Agent session, latest turn state and journal-linked terminal messages. Manual reads drain up to ten bounded steps (two single-message pages per step); remaining backlog is labeled partial and can be continued by polling. This is not a complete historical transcript or live output stream. Sparse message and continuous event cursors remain independent. Event gaps/409 can rehydrate once; linked-message integrity failures and native response contract failures stop. A final account-focus check discards content selected before a concurrent focus change. Views retain at most 100 turns/4MiB of text in memory, clear on account/screen/background/auth changes and require explicit restart. Native GET messages use query-free DPoP and a route-specific 1MiB UTF8 response cap; other routes retain 64KiB. Physical-device/UI, real ACTIVE/takeover success, native WS and chat sending remain separate gates. SDK/runtime is tested through the unreleased Workflow source overlay.
