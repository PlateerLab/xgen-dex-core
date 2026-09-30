# Cross-Platform Session 통합 브랜치

- 기준 브랜치: `main` (`e0ceb040bf2c2722bfd306d046cc7f3c46706503`)
- 상태: 구현 중. 모든 클라이언트 동기화와 검증 전까지 상위 PR은 Draft로 유지한다.

## 현재 변경 묶음

Phase 0에서 Mobile의 access/refresh token을 AsyncStorage에서 SecureStore로 옮긴다. 기존 저장 데이터는 일회성으로 안전 저장소에 이관하고 평문 사본을 제거한다. 복원·회전·로그아웃 경로를 검증하고 진단 로그의 응답 본문 기록을 제거한다.

## 이후 통합 관문

Platform Session의 sid, trust 및 revoke 계약이 준비되면 Desktop·Mobile·CLI·VSCode의 공통 session 동기화로 확장한다. Mobile 테스트와 typecheck를 별도로 실행하고 실제 기기에서 OS 보안 저장소 동작을 확인한다.

`@dex/protocol/agent-session`에는 공통 Canonical Agent Session 읽기 클라이언트와 이벤트 cursor 검사를 추가했다. 계정 포커스, 본인 세션 목록, snapshot, 이벤트 페이지를 Gateway 경로에서 읽으며, 매 요청에 **ACTIVE Platform Session** access token과 해당 기기 키의 새 DPoP 증명을 요구한다. 서명할 `htu`에서는 query를 제외하고 HTTP 요청에는 cursor query를 포함한다. 기존 `XgenClient`의 Bearer 토큰을 재사용하거나 인증 실패 시 fallback하지 않는다. 연속되지 않은 sequence, 충돌한 중복 이벤트 또는 잘못된 cursor는 적용하지 않고 snapshot 재조정을 호출자에게 맡긴다.

`GET /api/agentflow/me/agent-events`도 같은 DPoP 경계로 읽고, `applyAccountEventPage`로 계정 포커스 변경을 순서대로 적용한다. 재연결 시 마지막으로 적용한 계정 version을 `after_sequence`에 전달한다. 이벤트의 이전 포인터가 로컬 포커스와 다르거나 이벤트가 누락·충돌하면 적용을 중단하고 `GET /api/agentflow/me/agent-state`로 포커스를 다시 읽는다. 이 공통 계약은 Desktop·CLI·VSCode의 인증된 watcher가 사용할 기반이며, 아직 해당 앱에 실제 연결되지는 않았다.

공통 `reconcileAgentFocus`는 watcher의 한 번의 동기화 작업이다. 호출자는 검증된 계정·Platform Session이 바뀔 때 달라지는 비밀이 아닌 `authScope`를 제공하고, 이전 결과를 다음 호출에 전달한다. 범위가 바뀌면 이전 cursor를 버리고 포커스 스냅샷부터 읽는다. 같은 범위에서는 계정 이벤트를 최대 10페이지씩 재생해 남은 페이지가 있으면 `hasMore`를 반환한다. 409나 잘못된 이벤트 페이지는 스냅샷으로 복구하고, 인증·네트워크·취소 오류는 호출자에게 그대로 전달한다. 호출자는 폴링과 취소를 관리하며 계정 전환 시 이전 요청을 취소해야 한다.

이 공통 패키지는 자격증명을 발급·보관하지 않는다. CLI는 아래 OS 키체인 공급자로 일회성 Canonical 읽기를 연결했다. Desktop·VSCode·Mobile의 공급자 및 앱 watcher 연결은 남아 있다. 현재 Compose는 `enrollment` 모드이므로 실제 Canonical API의 양성 경로는 HTTPS `active` 환경에서 검증한다.

## Native Platform Session 공통 클라이언트

`@dex/protocol/native-platform-session`의 `NativePlatformSessionClient`는 Desktop·Mobile·CLI·VSCode에서 사용할 등록, 등록 상태, 신뢰 기기 목록, 선택한 브라우저에 대한 승인 요청, 비밀번호·기기 키 로그인 및 refresh 회전 API를 제공한다. CLI 등록과 세션 명령은 아래 OS 키체인 경로를 사용하고, 다른 앱의 로그인 화면·키 공급자 연결은 남아 있다. `@dex/protocol/native-device-proof`는 호스트가 보유한 비추출 WebCrypto P-256 개인키로 Gateway의 ES256 challenge JWT를 서명하는 선택적 도우미다. 네이티브 OS 키 공급자도 동일한 `signChallenge` 인터페이스를 구현할 수 있다.

- 클라이언트 인스턴스는 HTTPS origin·플랫폼·설치 ID·공개키를 고정한다. URL 경로·query·userinfo, `web` 플랫폼 및 개인키가 포함된 JWK는 받지 않는다. 네이티브 호스트의 HTTP transport에서 실행해야 하며 브라우저가 자동으로 보내는 Origin은 Gateway에서 거절한다.
- 등록과 승인 요청은 현재 계정 Bearer를 사용한다. 등록은 `pending`만 반환하고, 승인 요청은 선택한 웹 기기와 일치하는 응답 및 6자리 비교 코드만 반환한다. 조회 결과나 기본 승인 기기 표시만으로 신뢰를 결정하지 않는다.
- 호스트는 `account.current()`에 검증한 현재 계정의 `authScope`와 계정 access token을 제공한다. 로그아웃·재로그인·계정 전환 시 동일 계정이어도 범위를 바꾸고 이전 요청을 취소한다. Bearer가 바뀌거나 범위가 바뀌면 진행 중인 등록·승인·로그인 완료 및 응답 사용을 중단한다.
- 로그인 `pending_takeover`에는 자격증명이 없어야 한다. `active`인데 access 서명에 실패한 경우에는 refresh만 반환될 수 있으며, 호스트가 이를 보안 저장소에 보관한 뒤 새 challenge를 통한 refresh로 access를 받을 수 있다.
- refresh에는 Authorization·Origin·쿠키를 보내지 않는다. 계정 Bearer 없이도 현재 `authScope`로 실행할 수 있다. 응답의 sid, 회전된 refresh 및 access 준비 상태를 검사한다. 새 refresh는 다음 사용 전 저장해야 한다. 완료 결과를 모르는 네트워크 실패에서 옛 refresh를 다시 사용하면 서버가 전체 family를 폐기할 수 있으므로 자동 재시도하지 않는다.
- HTTP 응답 본문과 transport·키 공급자의 오류 원문은 오류 객체에 넣지 않는다. 비밀번호는 로그인 완료 본문에만 보내고 디스크에 쓰지 않는다. 동일 인스턴스의 쓰기 ceremony를 겹쳐 실행하지 않으며, 여러 프로세스·인스턴스의 회전 직렬화는 호스트 책임이다.

다음 앱 연결 작업에는 **파일 fallback 없는 기기 키 공급자**, 계정·origin·install별 보안 저장, 회전 결과 저장, 계정 전환·로그아웃 시 취소/삭제 및 ACTIVE access의 DPoP 공급자가 필요하다. 브라우저는 비추출 키, Mobile은 OS의 secure hardware key 저장을 사용하며 CLI 소프트웨어 키의 보관 방식은 아래에 설명한다. 기존 `SystemCredentialStore`의 평문 파일 fallback을 이 자격증명 저장소로 재사용하지 않는다. 공통 클라이언트 추가로 `active` 모드 관문이 열리지는 않는다.

### 로컬 Compose 실사용 계약 검증

```sh
# 저장소 루트에서 실행. Docker Compose 전체 스택 및 mkcert localhost 인증서가 먼저 준비되어야 한다.
node --import tsx scripts/native-platform-session-compose.mts
```

이 스크립트는 `https://localhost:3443`을 사용하고 mkcert root CA로 인증서를 검증한다. `full-stack-postgresql-1`에 임시 일반 계정과 사전 신뢰 브라우저 fixture를 만든 뒤, 네 플랫폼 각각의 등록 → 상태 조회 → 승인 브라우저 선택 → 실제 브라우저 키·비밀번호 승인 → trusted 상태 조회를 검증한다. 실제 기존 사용자와 기기는 변경하지 않는다. 종료 시 임시 계정의 legacy 세션을 로그아웃하고 계정·기기·승인 요청·DB 보안 이벤트·outbox·로그인 로그를 제거한다. 계정별 횟수 제한 Redis 키는 짧은 TTL로 만료된다. fixture의 사전 신뢰 브라우저는 최초 기기 bootstrap 검증을 대체하지 않는다.

현재 `enrollment` 환경에서는 세션이 발급되지 않고 native login/refresh가 503으로 차단되는지 확인한다. ACTIVE 로그인·takeover·refresh 성공 응답, 오류·계정 전환·취소·서명 경계는 `packages/protocol/test/native-platform-session.test.ts`에서 검증한다. 실제 ACTIVE 발급과 CLI 외 앱의 영속 키 저장은 후속 검증으로 남는다. SDK와 agent-runtime은 기존 Workflow 로컬 overlay 연결을 유지하며 이 작업에서 패키지를 배포하지 않는다.

2026-09-30 검증: Gateway 통합 브랜치 `ea1290464dc9f827661e44029c3e68a1db368254`, `PLATFORM_SESSION_MODE=enrollment`, 기본 Compose 서비스와 `workflow`·`frontend` 프로필 및 localhost HTTPS 프록시에서 네 플랫폼의 실서버 계약 검증을 통과했다. 이 검증은 변경한 DEX 소스에서 실행하며 Gateway·Core·Workflow 소스를 변경하지 않는다. ACTIVE 발급 또는 Workflow의 후속 변경을 검증한 것으로 취급하지 않는다.

## CLI 기기 등록·승인 연결

```sh
dex profile set corp --server https://xgen.example.com
dex device register --email me@example.com --profile corp --name "PC CLI"
dex device approvers --email me@example.com --profile corp
dex device request-approval --email me@example.com --profile corp --approver <browser-device-id>
dex device status --email me@example.com --profile corp
```

각 명령은 터미널 비밀 입력 또는 `--password-stdin`으로 현재 비밀번호를 확인한다. 비밀번호·Bearer·refresh를 명령 인자로 받지 않는다. 임시 legacy account login으로 받은 실제 사용자 ID에 CLI 키를 바인딩하고, native 요청에만 해당 Bearer를 사용한 뒤 account context를 logout한다. 이 임시 로그인은 기존 CLI credential 파일에서 읽거나 쓰지 않는다. logout 실패가 성공한 기기 작업 뒤에 발생하면 그 상태를 오류로 알리며, 기기 등록 자체는 이미 완료됐을 수 있으므로 상태를 조회한다. 기존 CLI/TUI `dex login`, 채팅 및 도구 브릿지의 인증 경로는 이 단계에서 바뀌지 않는다.

`NativeDeviceKeyStore`는 **OS 키체인으로 보호하는 소프트웨어 P-256 키**다. 최초 생성 시 PKCS#8 개인키를 OS 키체인에 한번 저장하고, 프로세스마다 비추출 WebCrypto 서명 handle로 import한다. 저장·복원 과정에는 메모리에 개인키 인코딩이 존재하며 OS 키체인 접근자는 이를 읽을 수 있다. 하드웨어 고정 키 또는 OS 저장소에서의 추출 불가를 주장하지 않는다. 서버에는 공개키와 서명만 보낸다. 키체인 계정은 HTTPS origin·플랫폼·서버의 실제 사용자 ID의 해시로 구분하고 같은 계정의 별도 CLI 프로필은 같은 설치 키를 복원한다. private PKCS#8을 callback이나 CLI 결과에 반환하지 않는다.

- 새 키가 저장된 내용을 다시 읽어 검증하고, 개인키와 공개키의 서명을 대조한 뒤에만 서버 등록을 시작한다. 기록이 손상되거나 범위·키가 맞지 않으면 새 키로 덮어쓰지 않는다.
- 키체인 부재·잠김·읽기/쓰기 실패·2초 timeout 또는 `DEX_NO_KEYCHAIN=1`은 기기 작업을 차단한다. 기존 plain-file fallback은 사용하지 않는다.
- OS 키체인 서비스는 `xgen-dex-native-device`. 사용자 홈 `.xgen-dex-native-device-locks`에는 PID·작업 시작 시각만 저장한다. CLI 설정 폴더와 무관한 동일 계정 잠금으로 프로세스 간 생성·등록을 직렬화한다. timeout은 OS 작업을 취소하지 않으므로 실제 완료까지 잠금을 유지한다. 강제 종료로 남은 `.lock`은 기록된 프로세스의 종료를 확인한 뒤 해당 파일만 제거한다. 개인키가 지워진 경우 새 키가 기존 승인 기기를 대신한다고 취급하지 않고 기기 폐기·복구 절차를 따른다.
- `register` 재실행은 같은 설치 ID의 기존 상태를 반환한다. 승인 요청은 pending 기기만 만들 수 있고, 선택한 브라우저가 현재 신뢰 상태인지 서버에서 다시 확인한다. 출력하는 6자리 코드는 양쪽 화면 대조용이며 승인 인증 수단이 아니다.
- 등록 명령은 Platform Session을 발급하지 않는다. 별도의 CLI 세션 명령을 아래에 연결했으며 실제 ACTIVE 발급·Canonical watcher 연결은 후속 관문이다.

로컬 실사용 검증은 CLI 빌드 뒤 `node --import tsx scripts/native-platform-session-compose.mts --cli`로 실행한다. `--cli`는 CLI 플랫폼 테스트를 빌드한 CLI의 별도 프로세스로 바꾸고 실제 OS 키체인 저장·재실행 복원·중복 등록 방지·브라우저 승인·trusted 조회를 검증한다. 공개 mkcert root CA만 자식 Node의 `NODE_EXTRA_CA_CERTS`로 전달하며 TLS 검증은 유지한다. 임시 계정·서버 자료·OS 키체인 키·CLI 프로필 폴더는 종료 시 정리한다.

2026-09-30 CLI 검증: Gateway 통합 브랜치 `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Core `c9125cfd2302d28a44512b836b9340439142685e`, `PLATFORM_SESSION_MODE=enrollment`, `workflow`·`frontend` 프로필과 HTTPS 프록시에서 위 흐름을 통과했다. 임시 CLI 로그인·로그아웃 이후에도 기존 승인 브라우저의 Bearer가 유효했고 CLI 기기·승인 요청이 각 1개인 것을 DB로 확인했다. 이 검증에는 같은 초의 legacy 토큰 충돌을 막는 Gateway `jti` 수정이 필요하다. SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`와 agent-runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06`은 Workflow 로컬 overlay로 연결한 상태였으며 패키지 배포나 실제 ACTIVE 세션 사용은 수행하지 않았다.

## CLI Platform Session 자격증명 수명주기

```sh
dex session login --email me@example.com --profile corp
# 로그인 응답의 실제 계정 ID를 이후 명령에 사용한다.
dex session status --user-id <id> --profile corp --json
dex session refresh --user-id <id> --profile corp
dex session focus --user-id <id> --profile corp
dex session logout --user-id <id> --profile corp
# 중단된 서버 세션을 내 페이지에서 폐기한 뒤 로컬 기록만 정리한다.
dex session forget-local --user-id <id> --profile corp
```

`NativeCliSession`은 승인된 CLI 설치 키와 별도 OS 키체인 서비스 `xgen-dex-native-session`을 사용한다. origin·실제 계정 ID·플랫폼으로 슬롯을 분리하고 install ID·device ID·sid·세대와 refresh/access를 결합한다. access의 계정·sid·기기·플랫폼·`cnf.jkt`·용도·만료를 대조하되 로컬 claim 파싱을 서버의 서명·현재 신뢰 검증으로 취급하지 않는다. Gateway 응답의 소수점 만료 시각과 JWT의 초 단위 `exp`를 일치시키고, 실제 사용 가능 시각은 JWT의 초 단위 만료를 따른다. JSON·터미널 출력에는 비밀번호·키·Bearer·refresh를 넣지 않는다. 기존 CLI/TUI 로그인·채팅 경로는 유지한다.

- login은 임시 계정 인증과 trusted 설치 상태를 확인한 뒤 비밀번호·키 증명 ceremony를 진행한다. `pending_takeover`에는 토큰을 저장하지 않는다. access 발급 실패로 refresh만 받은 경우 보관 후 명시적인 `refresh`를 요구한다.
- login·refresh·logout은 OS 키체인에 각각 `login_pending`·`refreshing`·`logout_pending`을 저장·재조회한 뒤 서버를 호출한다. 작업 중 기록에는 토큰이 없다. 완료 응답의 새 자격증명이 저장·재조회되기 전에는 사용하지 않는다. 등록과 같은 계정 잠금을 사용하여 여러 CLI 프로세스의 등록·갱신·읽기·삭제를 직렬화한다.
- 통신 중단·취소·잘못된 완료 응답·결과 저장 실패에는 이전 refresh/access를 복원하거나 자동 재시도하지 않는다. 다음 프로세스도 남은 작업 상태에서 회전·읽기를 거절한다. 서버 세션을 내 페이지에서 폐기하고 `forget-local` 후 다시 로그인한다. 현재 Compose의 503 차단에서도 보수적으로 `login_pending`을 남긴다.
- `status`는 **로컬 보관 상태**다. `active` 출력은 access를 사용할 수 있다는 뜻이며 서버의 현재 sid·기기 신뢰를 확인한 결과가 아니다. `focus`는 고정된 HTTPS origin의 Canonical 읽기에만 새 ES256 DPoP를 보낸다. method·query 없는 `htu`·access `ath`·매회 새 `jti`를 묶으며 공급자는 현재 계정 잠금 callback 안에서만 사용할 수 있다. 만료·취소·다른 토큰/경로·callback 종료 이후에는 서명을 거절한다. 폴링·watcher 및 WebSocket 연결은 남아 있다.
- `logout`은 유효한 access의 기기 DPoP와 현재 계정 비밀번호로 자기 sid의 `DELETE /api/me/platform-sessions/{sid}`를 호출하고 204 이후 세션 키체인 기록만 삭제한다. 설치 키는 보존한다. access가 만료되면 먼저 명시적인 refresh가 필요하다. 실패 시 토큰 없는 `logout_pending`이 남으며 서버 폐기를 완료한 것으로 보고하지 않는다. `forget-local`은 네트워크 호출 없이 로컬 기록만 지우고 JSON에 `server_revoked=false`를 표시한다.
- 키체인 부재·잠김·오류·timeout·`DEX_NO_KEYCHAIN=1`에서는 세션 작업도 차단한다. plain-file fallback을 사용하지 않는다. 키 공급자의 기존 timeout과 프로세스 잠금 경계가 세션 읽기·쓰기·삭제에도 적용된다.

### 검증 범위

2026-09-30: 엔진 133 통과·플랫폼 조건 제외 2, CLI 146 통과. 신규 엔진 17개·CLI 2개는 회전 전 저장 실패, 회전 결과 분실/저장 실패, 재실행 시 재사용 거절, 취소, 계정·기기·키 결합, provider 수명, access 부재·만료, takeover, 서버 폐기와 로컬 삭제를 검증했다.

`npm --prefix apps/cli run build` 후 `node --import tsx scripts/cli-platform-session-fixture.mts`는 통제된 HTTPS 서버와 실제 OS 키체인에서 별도 CLI 프로세스의 로그인·복원·회전·Canonical DPoP 서명·비밀번호 로그아웃을 검증했다. 서버가 회전 완료 후 연결을 끊으면 다음 CLI 프로세스는 옛 토큰을 재전송하지 않고 로컬 복구만 가능했다. fixture의 TLS는 기존 localhost 인증서와 공개 mkcert CA로 검증하며 임시 키체인 슬롯과 프로필을 정리했다. **이 검증은 실제 ACTIVE Gateway·Workflow 성공 검증이 아니다.**

실제 `scripts/native-platform-session-compose.mts --cli`도 같은 Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`와 Core `c9125cfd2302d28a44512b836b9340439142685e`, `feat/cross-platform-session`, `workflow`·`frontend` 프로필, HTTPS 3443, `enrollment`에서 등록·선택 브라우저 승인과 CLI ACTIVE 로그인 503·안전한 작업 기록·명시적 로컬 복구를 통과했다. ACTIVE 모드 관문, 다른 앱의 키 공급자, takeover 완료 자격증명 수령과 Canonical watcher·실제 서버 양성 검증은 남아 있다. SDK/runtime 패키지는 배포하지 않는다.
