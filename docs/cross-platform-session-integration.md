# Cross-Platform Session 통합 브랜치

- 기준 브랜치: `main` (`e0ceb040bf2c2722bfd306d046cc7f3c46706503`)
- 상태: 구현 중. 모든 클라이언트 동기화와 검증 전까지 상위 PR은 Draft로 유지한다.

## 현재 변경 묶음

Phase 0에서 Mobile의 access/refresh token을 AsyncStorage에서 SecureStore로 옮긴다. 기존 저장 데이터는 일회성으로 안전 저장소에 이관하고 평문 사본을 제거한다. 복원·회전·로그아웃 경로를 검증하고 진단 로그의 응답 본문 기록을 제거한다.

## 이후 통합 관문

Platform Session의 sid, trust 및 revoke 계약이 준비되면 Desktop·Mobile·CLI·VSCode의 공통 session 동기화로 확장한다. Mobile 테스트와 typecheck를 별도로 실행하고 실제 기기에서 OS 보안 저장소 동작을 확인한다.

`@dex/protocol/agent-session`에는 공통 Canonical Agent Session 읽기 클라이언트와 이벤트 cursor 검사를 추가했다. 계정 포커스, 본인 세션 목록, snapshot, 이벤트 페이지를 Gateway 경로에서 읽으며, 매 요청에 **ACTIVE Platform Session** access token과 해당 기기 키의 새 DPoP 증명을 요구한다. 서명할 `htu`에서는 query를 제외하고 HTTP 요청에는 cursor query를 포함한다. 기존 `XgenClient`의 Bearer 토큰을 재사용하거나 인증 실패 시 fallback하지 않는다. 연속되지 않은 sequence, 충돌한 중복 이벤트 또는 잘못된 cursor는 적용하지 않고 snapshot 재조정을 호출자에게 맡긴다.

`GET /api/agentflow/me/agent-events`도 같은 DPoP 경계로 읽고, `applyAccountEventPage`로 계정 포커스 변경을 순서대로 적용한다. 재연결 시 마지막으로 적용한 계정 version을 `after_sequence`에 전달한다. 이벤트의 이전 포인터가 로컬 포커스와 다르거나 이벤트가 누락·충돌하면 적용을 중단하고 `GET /api/agentflow/me/agent-state`로 포커스를 다시 읽는다. 이 공통 계약은 Desktop·CLI·VSCode의 인증된 watcher가 사용할 기반이다. CLI의 OS 키체인 공급자와 폴링 watcher에는 아래와 같이 연결했고 VSCode의 stdio 호스트와 명령 메뉴, Desktop 설정의 기기·세션 메뉴에도 연결했다. Mobile 앱 연결은 남아 있다.

공통 `reconcileAgentFocus`는 watcher의 한 번의 동기화 작업이다. 호출자는 검증된 계정·Platform Session이 바뀔 때 달라지는 비밀이 아닌 `authScope`를 제공하고, 이전 결과를 다음 호출에 전달한다. 범위가 바뀌면 이전 cursor를 버리고 포커스 스냅샷부터 읽는다. 같은 범위에서는 계정 이벤트를 최대 10페이지씩 재생해 남은 페이지가 있으면 `hasMore`를 반환한다. 409나 잘못된 이벤트 페이지는 스냅샷으로 복구하고, 인증·네트워크·취소 오류는 호출자에게 그대로 전달한다. 호출자는 폴링과 취소를 관리하며 계정 전환 시 이전 요청을 취소해야 한다.

이 공통 패키지는 자격증명을 발급·보관하지 않는다. CLI는 아래 OS 키체인 공급자로 일회성 Canonical 읽기와 폴링 구독을 연결했다. VSCode는 아래 stdio 호스트, Desktop은 메인 프로세스 IPC와 설정 화면에 연결했고 Mobile의 공급자 및 앱 watcher 연결은 남아 있다. 현재 Compose는 `enrollment` 모드이므로 실제 Canonical API의 양성 경로는 HTTPS `active` 환경에서 검증한다.

## Native Platform Session 공통 클라이언트

`@dex/protocol/native-platform-session`의 `NativePlatformSessionClient`는 Desktop·Mobile·CLI·VSCode에서 사용할 등록, 등록 상태, 신뢰 기기 목록, 선택한 브라우저에 대한 승인 요청, 비밀번호·기기 키 로그인 및 refresh 회전 API를 제공한다. CLI 등록·세션 명령, VSCode와 Desktop 기기·세션 메뉴는 아래 OS 키체인 경로를 사용하고 Mobile 앱 연결은 남아 있다. `@dex/protocol/native-device-proof`는 호스트가 보유한 비추출 WebCrypto P-256 개인키로 Gateway의 ES256 challenge JWT를 서명하는 선택적 도우미다. 네이티브 OS 키 공급자도 동일한 `signChallenge` 인터페이스를 구현할 수 있다.

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
- 등록 명령은 Platform Session을 발급하지 않는다. 별도의 CLI 세션 명령을 아래에 연결했으며 실제 ACTIVE 발급·Canonical watcher 양성 검증은 후속 관문이다.

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
- `status`는 **로컬 보관 상태**다. `active` 출력은 access를 사용할 수 있다는 뜻이며 서버의 현재 sid·기기 신뢰를 확인한 결과가 아니다. `focus`는 고정된 HTTPS origin의 Canonical 읽기에만 새 ES256 DPoP를 보낸다. method·query 없는 `htu`·access `ath`·매회 새 `jti`를 묶으며 공급자는 현재 계정 잠금 callback 안에서만 사용할 수 있다. 만료·취소·다른 토큰/경로·callback 종료 이후에는 서명을 거절한다. 폴링 watcher는 아래 명령으로 연결했고 WebSocket과 기존 TUI 채팅의 이행은 남아 있다.
- `logout`은 유효한 access의 기기 DPoP와 현재 계정 비밀번호로 자기 sid의 `DELETE /api/me/platform-sessions/{sid}`를 호출하고 204 이후 세션 키체인 기록만 삭제한다. 설치 키는 보존한다. access가 만료되면 먼저 명시적인 refresh가 필요하다. 실패 시 토큰 없는 `logout_pending`이 남으며 서버 폐기를 완료한 것으로 보고하지 않는다. `forget-local`은 네트워크 호출 없이 로컬 기록만 지우고 JSON에 `server_revoked=false`를 표시한다.
- 키체인 부재·잠김·오류·timeout·`DEX_NO_KEYCHAIN=1`에서는 세션 작업도 차단한다. plain-file fallback을 사용하지 않는다. 키 공급자의 기존 timeout과 프로세스 잠금 경계가 세션 읽기·쓰기·삭제에도 적용된다.

### 검증 범위

2026-09-30: 엔진 133 통과·플랫폼 조건 제외 2, CLI 146 통과. 신규 엔진 17개·CLI 2개는 회전 전 저장 실패, 회전 결과 분실/저장 실패, 재실행 시 재사용 거절, 취소, 계정·기기·키 결합, provider 수명, access 부재·만료, takeover, 서버 폐기와 로컬 삭제를 검증했다.

`npm --prefix apps/cli run build` 후 `node --import tsx scripts/cli-platform-session-fixture.mts`는 통제된 HTTPS 서버와 실제 OS 키체인에서 별도 CLI 프로세스의 로그인·복원·회전·Canonical DPoP 서명·비밀번호 로그아웃을 검증했다. 서버가 회전 완료 후 연결을 끊으면 다음 CLI 프로세스는 옛 토큰을 재전송하지 않고 로컬 복구만 가능했다. fixture의 TLS는 기존 localhost 인증서와 공개 mkcert CA로 검증하며 임시 키체인 슬롯과 프로필을 정리했다. **이 검증은 실제 ACTIVE Gateway·Workflow 성공 검증이 아니다.**

실제 `scripts/native-platform-session-compose.mts --cli`도 같은 Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`와 Core `c9125cfd2302d28a44512b836b9340439142685e`, `feat/cross-platform-session`, `workflow`·`frontend` 프로필, HTTPS 3443, `enrollment`에서 등록·선택 브라우저 승인과 CLI ACTIVE 로그인 503·안전한 작업 기록·명시적 로컬 복구를 통과했다. ACTIVE 모드 관문, 다른 앱의 키 공급자, takeover 완료 자격증명 수령과 Canonical watcher의 실제 서버 양성 검증은 남아 있다. SDK/runtime 패키지는 배포하지 않는다.


## CLI Canonical focus watcher

```sh
dex session watch-focus --user-id <id> --profile corp --jsonl
# interval-ms: 정수 200~60000, 기본 2000. 환경변수를 추가하지 않는다.
dex session watch-focus --user-id <id> --profile corp --interval-ms 1000
```

`NativeCliSession.reconcileFocus`는 매 작업마다 OS 키체인에서 현재 자격증명을 복원하고 같은 계정 잠금 안에서 최대 10페이지를 재조정한다. origin·실제 사용자·플랫폼·install·device·sid 해시를 비밀이 아닌 cursor 범위로 쓰며 token/write generation은 포함하지 않는다. 따라서 정상 refresh 회전은 cursor를 유지하고 새 sid·기기·서버는 snapshot부터 읽는다. 로컬 저장/claim 확인을 서버 검증으로 취급하지 않고, 인증된 HTTP가 성공한 결과만 구독에 적용한다. 이전 범위는 출력하지 않는다.

`NativeAgentFocusWatcher`는 한 번에 한 작업만 진행한다. 요청 제한 시간은 전체 작업 10초이고 대기 시 계정 잠금을 해제한다. 네트워크·408·429·5xx·timeout에는 최대 30초 backoff로 GET만 재시도한다. busy 잠금은 최대 3회 대기하며 키체인 장애·손상·인증 만료·401·403·잘못된 snapshot에는 중단한다. refresh·logout·legacy Bearer fallback을 자동 호출하지 않는다. 같은 범위의 409·잘못된 JSON/sequence 페이지는 새 snapshot으로 복구하며 backlog는 작업 사이 이벤트 루프를 양보해 계속 읽는다.

엔진의 `select(source, userId)`는 계정·origin 교체와 같은 계정 재선택 시 즉시 reset을 출력하고 기존 요청·대기를 취소한다. 취소를 무시한 이전 응답도 새 범위에 적용하지 않는다. CLI 프로세스는 시작 시 선택한 계정·프로필을 고정하므로 다른 계정이나 서버를 보려면 해당 옵션으로 재실행한다. `--jsonl` 소비자는 reset·stopped에서 이전 대화 표시를 비워야 한다. 변경 없는 폴링은 출력하지 않으며 연결 복구 시에는 최신 focus를 다시 출력한다. Ctrl+C는 취소 후 정상 종료한다. 토큰·키·DPoP·오류 응답 원문은 출력하지 않고, CLI TUI 채팅·WebSocket·원격 도구를 이 명령에 연결한 것은 아니다.

### 이번 검증

- 신규 엔진 회귀 14개: cursor 보존/범위 초기화, 재연결/backoff, 계정 전환 중 늦은 응답, 즉시 reset, 요청 취소/timeout, bounded backlog, 인증 중단, busy 잠금 최대 재시도/잠금 폴더 장애 분류, 실제 공급자 refresh/logout 직렬화 및 JSON/409 snapshot 복구.
- `scripts/cli-platform-session-fixture.mts`: 실제 OS 키체인과 빌드된 별도 CLI 프로세스에서 HTTPS/새 DPoP, 연결 단절 후 같은 cursor 재생, 409 후 snapshot, 다른 CLI 프로세스의 refresh, 401 중단 및 Ctrl+C 정상 종료를 통과했다. 임시 키체인 슬롯·프로필은 정리했다. 통제된 fixture이며 실제 ACTIVE Gateway 성공 검증이 아니다.
- 실제 Compose의 `scripts/native-platform-session-compose.mts --cli`: login 503 뒤 남은 token-free login_pending에서 watch-focus가 auth_required/exit 3으로 종료하고 로컬 복구하는 검증을 통과했다. Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Core `c9125cfd2302d28a44512b836b9340439142685e`, Workflow `02bb512bba00908cc648dceaa6b1b12caf7313fd`, Frontend `7944120b99e8909f09100c802912839a19359589`의 실제 소스/실행 브랜치를 확인했다. 모든 서비스는 `feat/cross-platform-session`, 기본 인프라·Core·Gateway에 workflow/frontend 프로필과 HTTPS 3443을 사용했고 ACTIVE 발급 관문은 열지 않았다. Workflow overlay의 SDK/runtime import 위치도 확인했다. 다른 서비스의 최신 로컬 Head를 검증한 것으로 취급하지 않는다.
- 환경변수는 추가하지 않았고 기존 키체인/프로필/공개 CA 변수의 watcher 사용 범위는 Infra 참조 문서에 반영한다. SDK·agent-runtime은 Workflow 로컬 overlay로 사용하고 배포하지 않는다.

2026-09-30 전체 로컬 검사: 엔진 147 통과·플랫폼 조건 제외 2, CLI 146 통과, 엔진/CLI 타입 검사·계약 검사·CLI 빌드·두 opt-in 스크립트 타입 검사 통과. CLI 첫 실행의 기존 TUI `이전 대화를 고르면 그 내용이 대화창에 올라온다`는 답변이 먼저 렌더된 중간 frame에서 질문을 확인하여 실패했다. 해당 파일의 변경 없이 동일 코드 전체 테스트 한 번 재실행은 통과했으며 첫 실패와 재실행을 PR #129에 기록한다. 브라우저 화면과 실제 ACTIVE Gateway 양성 검증은 이번 검증 범위에 포함되지 않는다.


## VSCode native 호스트와 Canonical focus

`NativeHostSession`은 생성 시 플랫폼을 고정하며 `NativeCliSession`은 CLI 호환 래퍼다. VSCode는 `dex serve --stdio --native-platform vscode`를 실행한다. `initialize.capabilities.nativePlatformSession`으로 지원 여부를 확인하고, 구 엔진에는 native 요청을 보내지 않는다. 기본 `serve --stdio`는 기존 계약을 유지한다. Desktop은 아래 메인 프로세스 IPC와 기기·세션 메뉴에 연결했으며 같은 공급자의 별도 desktop 슬롯을 사용한다.

RPC의 `native/device`, `native/session`, `native/watch`, `native/unwatch`, `native/cancel`은 엄격한 입력 필드를 받는다. 플랫폼·토큰·키 재정의는 허용하지 않는다. 자식 엔진이 고정된 HTTPS origin·실제 계정 ID·`vscode`로 OS 키체인 키/세션을 분리한다. 공개 상태 및 scope 정보만 응답하며 비밀번호는 비밀 입력에서 RPC 요청으로만 전달한다. CLI의 기존 sid를 VSCode에서 사용하지 않는다. 기존 키체인·회전 journal·DPoP 경계를 그대로 사용한다.

VSCode 명령 **XGEN Dex: 기기 및 플랫폼 세션**은 등록, 등록 상태, 신뢰 브라우저 선택 승인, 로그인, 세션 상태·갱신, 포커스 구독, 서버 로그아웃과 명시적 로컬 정리를 제공한다. 엔진 재시작 이후 계정 식별자는 현재 비밀번호 확인으로 다시 조회한다. 정상 active 상태에서 구독을 자동 시작하며 상태 표시줄은 연결된 포커스, 재연결, 인증 중단을 표시한다. 프로필/계정 변경·취소·엔진 종료에서는 즉시 이전 포커스를 지우고 늦은 결과를 버린다. 구독 ACK와 같은 stdout chunk에 온 notification은 ACK 이후 scope를 확인한 뒤 적용한다. 잘못된 focus는 표시하지 않고 해당 watch ID만 종료한다.

호스트는 한 번에 한 native 작업만 허용한다. 기기/세션 작업 전에 기존 watcher를 취소하고 완료를 기다린다. 구독 중 다른 프로세스의 정상 refresh는 현재 키체인을 다시 읽어 같은 cursor를 유지한다. 같은 호스트의 세션 갱신 후에는 새 watcher가 snapshot부터 시작한다. 정확한 watch ID로 unwatch하여 이전 UI 작업이 새 구독을 종료하지 않는다. 종료·취소는 서버 logout이나 자동 자격증명 삭제로 취급하지 않으며 미완료 회전은 journal을 보존한다. 기존 Workspace 채팅은 아직 이 PlatformSession/Canonical 경로로 이행하지 않았다.

### 검증 및 제한 (2026-09-30)

- 신규 회귀 11개: 엔진 플랫폼 분리 1개, stdio RPC 5개, VSCode controller 5개. 기존 built-CLI RPC 테스트도 올바른 `apps/cli/dist/cli.js` 경로로 실제 실행한다.
- 엔진 148 통과·플랫폼 조건 제외 2, protocol 201 통과, VSCode 23 통과. CLI 전체 첫 실행은 이전 PR에서도 확인한 기존 TUI 중간 렌더 frame 검사에서 1개 실패했다. 동일 코드 전체 한 번 재실행에서 151개 모두 통과했으며 첫 실패 로그와 재실행을 PR에 함께 기록한다. 타입/계약 검사와 CLI/VSCode 빌드 및 두 opt-in 스크립트 타입 검사를 실행한다.
- `scripts/cli-platform-session-fixture.mts --vscode`: 실제 빌드된 stdio 엔진·HTTPS 인증서·OS 키체인으로 로그인/재시작 복원/refresh, 다른 프로세스 회전 중 cursor 유지, 연결 단절 replay, 409 snapshot, 401 중단, unwatch, 회전 결과 분실 journal/로컬 복구와 비밀 미노출을 통과했다. 통제된 fixture이며 실제 ACTIVE 서버 검증은 아니다. CLI 기본 모드도 공통 공급자 회귀로 실행한다.
- `scripts/native-platform-session-compose.mts --cli --vscode`: 실제 HTTPS 3443의 등록·엔진 재시작 후 키 복원·중복 방지·선택 브라우저 승인·trusted 조회, 로그인 503·안전한 login_pending·구독 거절·로컬 복구를 통과했다. 임시 계정·기기·요청·보안 이벤트와 키체인 슬롯을 정리했다. fixture는 기존 신뢰 브라우저를 준비하므로 최초 기기 bootstrap UI 검증으로 취급하지 않는다.
- Compose 기본 인프라·Core·Gateway, workflow/frontend 프로필과 HTTPS 프록시를 사용했다. `.env`의 서비스별 브랜치와 실제 깨끗한 소스/컨테이너 SHA: Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `02bb512bba00908cc648dceaa6b1b12caf7313fd`, Frontend `7944120b99e8909f09100c802912839a19359589`, 모두 `feat/cross-platform-session`. 실제 Gateway mode는 `enrollment`. 다른 저장소 최신 로컬 Head의 검증으로 보고하지 않는다.
- Workflow는 SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`, runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` 로컬 overlay를 사용했고 실제 import 경로를 확인했다. 패키지 배포는 하지 않았다. 새 환경변수 없이 기존 세 변수의 VSCode 자식 엔진 사용 범위를 Infra 환경변수 참조에 갱신한다.
- VSCode 직접 화면 검증은 Orca 제어 런타임이 `runtime_unavailable`로 시작되지 않아 완료하지 못했다. 명령 등록·상태 제어·실제 엔진 검증과 구분한다. 실제 ACTIVE 서버와 Desktop·Mobile 앱, takeover 결과 수령, Workspace 채팅 이행은 후속 관문이다.


## Desktop 기기·세션 설정과 Canonical focus (2026-09-30)

**설정 → 기기·세션**에서 현재 Desktop 계정의 기기 등록·상태, 승인할 신뢰 브라우저 선택과 비교 코드, PlatformSession 로그인·상태·갱신·로그아웃 및 Canonical 포커스 구독을 제공한다. 정상 active 상태 조회/갱신 뒤 구독을 자동 시작하며 연결·재연결·인증 중단을 표시한다. 중단된 로컬 기록 삭제는 별도 확인을 받고 `server_revoked=false`로 처리한다. 서버 세션 폐기는 브라우저 내 페이지에서 먼저 수행한다. 기존 Workspace 채팅·WebSocket 경로의 전환과 takeover 완료 자격증명 수령은 남아 있다.

- `native-session-ipc.ts`가 현재 메인 창의 최상위 frame만 허용한다. 추가 창·webview·하위 frame은 native 자격증명 경계에 접근하지 못한다. Renderer는 서버·사용자 ID·프로필·플랫폼·토큰·키를 재정의할 수 없다.
- `DesktopNativeSessions`가 현재 설정의 HTTPS origin과 메인 프로세스의 실제 로그인 사용자에 작업을 고정한다. 일회성 비밀번호 로그인 결과가 현재 계정과 다르면 **키 접근 전** 중단하고 임시 인증을 로그아웃한다. CLI 프로필과 legacy 파일 fallback을 사용하지 않는다.
- P-256 소프트웨어 키와 refresh/access는 OS 키체인의 `desktop` 슬롯에만 보관한다. 기존 CLI·VSCode 슬롯과 분리하며 공통 잠금·토큰 없는 회전 journal·새 DPoP·결과 저장 확인 규칙을 적용한다. 키체인 장애와 `DEX_NO_KEYCHAIN=1`은 native 작업을 차단한다.
- 계정/서버 변경·로그아웃·인증 실패·메인 navigation·renderer 종료·앱 종료에서 진행 중 작업과 watcher를 취소한다. 세대 및 계정·origin·watch ID 검사가 늦은 결과를 버린다. 화면을 떠날 때 listener와 구독을 정리하며 비밀번호 입력은 요청 직후 지운다. Renderer에는 공개 상태/포커스만 반환한다.
- Native 전송은 `native-session-network.ts`의 **자동 재시도 없는 Node HTTPS** 요청이다. 실제 Electron 검증에서 Chromium fetch가 단절된 GET DPoP 및 POST 회전 완료를 투명 재전송하는 문제가 발견되어 수정했다. DELETE 비밀번호 본문도 명시적인 Content-Length로 전송한다. 쿠키·Origin·redirect는 차단하고 인증서를 기본 및 OS 신뢰 CA로 검증한다. 기존 사설 인증서 예외를 적용하지 않는다. Chromium의 자동 프록시 설정은 연결하지 않아 프록시가 필수인 배포 환경 검증이 남아 있다.

### 실행과 검증 증거

```sh
npm --prefix apps/desktop ci
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test
npm --prefix apps/desktop run build
# 공개 localhost CA가 OS 신뢰 저장소에 등록된 개발 PC에서, 실제 Electron/키체인 사용
node --import tsx scripts/cli-platform-session-fixture.mts --desktop
# 기본 인프라·Core·Gateway 및 workflow/frontend 프로필, HTTPS 3443과 CLI 빌드 필요
node --import tsx scripts/native-platform-session-compose.mts --cli --vscode --desktop
```

- Desktop 전체 회귀 **527 통과**, 새 main/renderer/TLS 회귀 **11개**. 계정 오입력, scope 재정의 거절, IPC sender, 취소 후 journal 보존, ACK 앞 알림, 늦은 계정 응답, 잘못된 포커스, 구독 정리, DELETE 본문 및 전송 자동 재시도/redirect/쿠키/미신뢰 TLS/응답 크기 제한을 검증했다. Desktop 타입·빌드, 공통 계약 검사와 두 opt-in 스크립트 타입 검사도 통과했다.
- `--desktop` HTTPS fixture는 **실제 Electron 메인 factory·빌드 preload·production 설정 컴포넌트**를 사용한다. 다른 창의 IPC 거절, 실제 버튼으로 상태 조회·자동 구독·중단, 빈 비밀번호 입력과 화면 캡처를 확인했다. 별도 Electron 재실행으로 키체인 복원·플랫폼 분리, cursor 재생/재연결, 409 복구, 다른 프로세스 회전, 401 중단, 정확한 unwatch, 회전 완료 유실 뒤 옛 refresh 재사용 거절을 통과했다. **통제된 ACTIVE fixture이며 실제 ACTIVE Gateway 양성 검증은 아니다.** 임시 키는 Electron이 생성·삭제한다.
- 실제 Compose `--cli --vscode --desktop`에서 Desktop·CLI·VSCode의 별도 호스트 재실행, 멱등 등록, 선택 브라우저 키/비밀번호 승인, trusted 조회, 실제 ACTIVE login 503, token-free login_pending, Canonical 구독 거절과 로컬 복구를 통과했다. Mobile은 공통 프로토콜만 검증했다. 임시 계정·기기·승인 요청·DB 이벤트·키체인·프로필을 정리했다.
- 실행 소스: Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `02bb512bba00908cc648dceaa6b1b12caf7313fd`, Frontend `7944120b99e8909f09100c802912839a19359589`; 네 서비스 모두 `feat/cross-platform-session`, `PLATFORM_SESSION_MODE=enrollment`. 컨테이너 Git/소스 마운트, `.env` 서비스별 브랜치와 실제 실행 모드를 확인했다. Workflow의 SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`·runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` 로컬 overlay import 경로도 확인했으며 패키지는 배포하지 않았다.
- 공통 엔진 150 통과·플랫폼 조건 제외 2, protocol 201 통과, VSCode 23 통과. CLI 전체는 150 통과·기존 TUI 중간 frame 타이밍 테스트 1개 실패했고, 동일 코드 한 번의 재실행에서도 같은 실패가 발생했다. 테스트/화면 코드를 이번 기능 변경에 섞지 않았으며 첫 실패와 재실행을 PR에 기록한다. 최신 Head CI에서 필수 검사를 확인한 뒤 통합한다.
- 새 환경변수는 없다. 기존 Desktop `XGEN_SERVER_URL` 및 native 키체인/CA 사용 범위를 Infra 환경변수 참조 문서에 반영했다.

### 남은 작업 추정

| Phase | 남은 비율 | 주요 잔여 항목 |
|---|---:|---|
| 0 계약·보안 | 22% | 전체 이행 계약 및 최종 보안 검증 |
| 1 PlatformSession | 8% | 실제 ACTIVE·takeover 수령, Mobile 연결 및 다중 클라이언트 검증 |
| 2 CanonicalSession | 25% | Mobile 구독, 기존 채팅/WS 이행 및 실서버 양성 검증 |
| 3 Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 설정 | 95% | 개인 설정 동기화·충돌 처리 |
| 5 시크릿·Claude/Codex | 90% | 개인 시크릿 전달과 외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

비율은 남은 설계 항목에 대한 추정이며 테스트 통과율이나 일정 보장이 아니다.
