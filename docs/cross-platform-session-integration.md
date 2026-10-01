# Cross-Platform Session 통합 브랜치

- 기준 브랜치: `main` (`e0ceb040bf2c2722bfd306d046cc7f3c46706503`)
- 상태: 구현 중. 모든 클라이언트 동기화와 검증 전까지 상위 PR은 Draft로 유지한다.

## 현재 변경 묶음

Mobile 하드웨어 P-256 키 공급자에 이어 설정 화면에 서버 기기 등록·조회·선택 브라우저 승인 요청을 연결했다. 세션 발급·보관·DPoP 및 Canonical 구독은 후속 연결이다. 아래 Mobile 절에 검증 범위와 실제 기기 관문을 기록한다.

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

- `native-session-ipc.ts`가 현재 메인 창의 최상위 frame만 허용한다. 추가 창·webview·하위 frame 및 다른 주소로 이동한 메인 창은 native 자격증명 경계에 접근하지 못한다. 빌드된 index.html 또는 개발 Vite의 고정 index.html 주소를 대조한다. Renderer는 서버·사용자 ID·프로필·플랫폼·토큰·키를 재정의할 수 없다.
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
- `--desktop` HTTPS fixture는 **실제 Electron 메인 factory·빌드 preload·production 설정 컴포넌트**를 사용한다. 다른 창 및 다른 주소로 이동한 메인 창의 IPC 거절, 실제 버튼으로 상태 조회·자동 구독·중단, 빈 비밀번호 입력과 화면 캡처를 확인했다. 별도 Electron 재실행으로 키체인 복원·플랫폼 분리, cursor 재생/재연결, 409 복구, 다른 프로세스 회전, 401 중단, 정확한 unwatch, 회전 완료 유실 뒤 옛 refresh 재사용 거절을 통과했다. **통제된 ACTIVE fixture이며 실제 ACTIVE Gateway 양성 검증은 아니다.** 임시 키는 Electron이 생성·삭제한다.
- 실제 Compose `--cli --vscode --desktop`에서 Desktop·CLI·VSCode의 별도 호스트 재실행, 멱등 등록, 선택 브라우저 키/비밀번호 승인, trusted 조회, 실제 ACTIVE login 503, token-free login_pending, Canonical 구독 거절과 로컬 복구를 통과했다. Mobile은 공통 프로토콜만 검증했다. 임시 계정·기기·승인 요청·DB 이벤트·키체인·프로필을 정리했다.
- 실행 소스: Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `02bb512bba00908cc648dceaa6b1b12caf7313fd`, Frontend `7944120b99e8909f09100c802912839a19359589`; 네 서비스 모두 `feat/cross-platform-session`, `PLATFORM_SESSION_MODE=enrollment`. 컨테이너 Git/소스 마운트, `.env` 서비스별 브랜치와 실제 실행 모드를 확인했다. Workflow의 SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`·runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` 로컬 overlay import 경로도 확인했으며 패키지는 배포하지 않았다.
- 공통 엔진 150 통과·플랫폼 조건 제외 2, protocol 201 통과, VSCode 23 통과. CLI 전체는 150 통과·기존 TUI 중간 frame 타이밍 테스트 1개 실패했고, 동일 코드 한 번의 재실행에서도 같은 실패가 발생했다. 테스트/화면 코드를 이번 기능 변경에 섞지 않았으며 첫 실패와 재실행을 PR에 기록한다. 최신 Head CI에서 필수 검사를 확인한 뒤 통합한다.
- 새 환경변수는 없다. 기존 Desktop `XGEN_SERVER_URL`·개발용 `ELECTRON_RENDERER_URL` 및 native 키체인/CA 사용 범위를 Infra 환경변수 참조 문서에 반영했다.

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

## Mobile 하드웨어 기기 키 기반 (2026-09-30)

설정 → **기기 보안**에서 `기기 키 상태 확인` 또는 `인증 키 준비`를 실행한다. HTTPS 서버에 로그인한 실제 사용자별로 키와 설치 ID를 준비한다. 로컬 준비 성공은 서버 등록·신뢰 승인·Platform Session 발급을 의미하지 않는다. 기존 로그인·채팅은 현재 인증 경로를 사용한다.

`apps/mobile/modules/xgen-native-device`는 로컬 Expo 모듈이다. iOS는 Secure Enclave의 P-256 `SecKey`로 서명하며 키와 설치 ID를 `WhenPasscodeSetThisDeviceOnly`로 보관한다. Android 28 이상은 화면 잠금이 설정되고 해제된 상태에서 AndroidKeyStore 키를 사용한다. StrongBox를 우선 요청하고 StrongBox를 사용할 수 없는 경우 TEE로 생성하며, `KeyInfo`의 실제 하드웨어 보호 및 256비트 키를 확인한다. 소프트웨어 키, SecureStore에 개인키 인코딩 저장, 개인키 export/import API는 제공하지 않는다. Expo Go·웹·iOS 시뮬레이터·지원하지 않는 기기는 키 작업을 거절한다. 공급자 설계는 [Apple Secure Enclave](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave), [Android Keystore](https://developer.android.com/privacy-and-security/keystore), [Expo Modules](https://docs.expo.dev/modules/module-api/) API를 따른다.

- 키와 공개 설치 ID는 `mobile + HTTPS origin + 실제 사용자 ID`의 SHA-256 범위로 구분한다. 한쪽 기록이 없거나 손상되면 새 키로 자동 교체하지 않는다. 기존 승인 기기에 대한 관리자 복구·폐기 절차를 요구하며 아직 앱에 그 절차를 연결하지 않았다.
- JS에는 공개 JWK·설치 ID·저장소 분류와 서명만 반환한다. 네이티브는 `register`·`approval_request`·`login`·`native_refresh`와 32바이트 canonical base64url challenge만 서명한다. 현재 설치 ID와 공개키 thumbprint를 대조하고 ES256 JWT를 네이티브에서 조립하며 DER 서명을 P1363으로 엄격하게 변환한다. 하드웨어 분류는 앱의 로컬 검증 결과이며 서버에 대한 원격 attestation이 아니다.
- `native-device-key.ts`는 비밀키 없는 공급자다. HTTPS origin·실제 사용자 ID·로그인 수명에 묶이고 응답의 공개키·설치 ID·JWT 형식과 목적·challenge·발급 시각을 확인한다. 계정/서버 변경·같은 계정 재로그인·화면 이탈·백그라운드·취소 이후 결과를 적용하지 않는다. 이미 시작한 OS 키 생성을 취소할 수 없는 경우 생성된 키는 원래 계정 범위에만 남으며 서버 신뢰를 부여하지 않는다.
- 앱 오류에는 정해진 오류 코드의 메시지만 표시하고 OS 예외·응답 원문을 노출하지 않는다. Face ID/Touch ID/passkey ceremony나 비밀번호·Bearer·refresh 저장을 이번 공급자에 추가하지 않았다.

### 검증 범위와 다음 관문

검증 브랜치 `feat/cross-platform-mobile-native-key`, 기준 통합 SHA `b2b285642e878b88446d71ab059bad452d32a867`. 최신 PR Head의 CI도 통합 전 확인한다.

- Mobile TypeScript **57/57** 및 typecheck, 저장소 계약 검사 통과. 신규 8개는 실제 테스트 P-256 서명, 안전하지 않은 네이티브 응답/소프트웨어 저장소 거절, 손상 복원, 계정·서버·재로그인, 취소와 늦은 결과, 잘못된 proof 경계를 검증한다.
- Android 로컬 Expo 모듈 `compileDebugKotlin`과 JUnit **4/4** 통과. Swift 실제 iOS SDK typecheck 및 CryptoKit codec 통과. 두 codec은 각 400개의 실제 테스트 P-256 서명, 공통 scope·공개키 지문, 잘못된 DER·서명 목적·challenge를 검증한다. 테스트의 소프트웨어 키는 생산 공급자로 연결되지 않는다.
- Expo apple/android autolinking, iOS 앱 전체 Simulator Debug 빌드, iOS/Android Metro export 통과. CocoaPods가 생성한 프로젝트 변경은 검증 산출물로 보관하며 변경 묶음에 포함하지 않는다.
- 별도 Simulator 검증 앱에서 **생성·조회·서명 3개 모두 거절**을 직접 실행하고 결과 JSON `passed=true, rejected=3, software_fallback=false`와 화면을 확인했다. 임시 앱을 제거하고 이번에 시작한 시뮬레이터를 종료했다. 이 검증은 생산 앱 설정 화면이나 실제 Secure Enclave/TEE/StrongBox 키 성공 검증을 대체하지 않는다.
- CI에 Android 모듈 컴파일·JUnit과 Apple iOS SDK·codec 검사를 추가했다. 실제 iPhone/Android 기기가 연결되어 있지 않아 키 생성·앱 재실행 복원·잠금·백그라운드·서명 성공의 실기기 검증은 남는다.
- 다음은 Mobile의 HTTPS native 전송 경계, 기기 등록·선택한 승인 브라우저 연결, 계정별 세션 vault/journal·DPoP와 Canonical watcher다. 현재 범위에는 HTTP 호출이 없으며 기존 React Native fetch를 검증된 native 인증 전송으로 취급하지 않는다. 이번에는 Compose 서비스를 변경하거나 서버 통합 검증을 실행하지 않았다. SDK/runtime Workflow 로컬 overlay와 패키지 배포 상태도 변경하지 않았다.
- 환경변수 추가·변경·삭제가 없으므로 Infra 환경변수 참조 문서는 변경하지 않는다. 기존 Mobile 서버 URL의 HTTPS 요구는 새 키 준비 기능의 입력 검증이다.

### Remaining work estimate / 남은 작업 추정

| Phase | 남은 비율 | 주요 잔여 항목 |
|---|---:|---|
| 0 계약·보안 | 22% | 전체 이행 계약 및 최종 보안 검증 |
| 1 PlatformSession | 7% | Mobile 서버 연결·실기기, 실제 ACTIVE·takeover 수령과 다중 클라이언트 검증 |
| 2 CanonicalSession | 25% | Mobile 구독, 기존 채팅/WS 이행 및 실서버 양성 검증 |
| 3 Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 설정 | 95% | 개인 설정 동기화·충돌 처리 |
| 5 시크릿·Claude/Codex | 90% | 개인 시크릿 전달과 외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

These percentages estimate remaining design work, not test coverage or a delivery schedule. This increment adds a local hardware-key provider and readiness controls. It does not grant device trust or issue a server session. iOS Secure Enclave and Android hardware-backed P-256 keys remain inside their native providers; JavaScript receives public metadata and fixed ceremony proofs only. Missing or inconsistent key/identity records require explicit recovery. Simulator creation, lookup and signing are verified to fail closed. Physical-device success, Mobile HTTPS enrollment/session storage/DPoP, and Canonical subscriptions remain integration gates. The SDK/runtime Workflow overlay stays unchanged; no package release or Compose server validation was performed in this increment.

## Mobile 서버 기기 등록과 선택 브라우저 승인 (2026-10-01)

Mobile 설정 → **기기 보안**에서 로컬 키를 준비한 뒤 **휴대폰 기기 등록**에서 이름을 입력하고 등록한다. `등록·승인 상태 확인`은 자신의 설치 키에 바인딩된 서버 상태와 승인 가능한 신뢰 브라우저를 조회한다. 기본 승인 브라우저가 하나면 최초 조회에 선택해 표시하고, 기본값이 없으면 사용자가 직접 고른다. 선택한 브라우저가 현재 신뢰 목록에서 사라지면 다른 기기로 자동 전환하지 않는다. 신뢰 browser가 없거나 최초 등록·복구·이관이 필요한 경우 PC 브라우저에서 그 절차를 완료하도록 표시한다.

- 기존 Mobile 로그인 결과의 실제 사용자 ID·HTTPS origin·로그인 수명에 공급자를 바인딩한다. `buildClient.nativeAccount`는 logout 시작 시 동기적으로 무효화되며 같은 계정 재로그인도 별도 수명이다. 각 작업은 시작할 때의 Bearer를 고정하고, 중간 회전이나 계정 변경은 완료를 중단한다. 같은 로그인에서 토큰이 정상 회전한 뒤에는 새 토큰으로 명시적 상태 조회가 가능하다. 새 비밀번호 입력·자동 임시 로그인·legacy refresh fallback·자격증명 저장을 이 등록 기능에 추가하지 않았다.
- `native-device-enrollment.ts`는 공통 `NativePlatformSessionClient`를 사용한다. 기존 등록 상태가 있으면 등록 complete를 반복하지 않는다. pending 상태에서만 승인 요청을 만들고, 직전 신뢰 목록에서 선택한 web browser를 다시 확인한다. 서버는 별도로 현재 trust·기기 키·challenge를 검증한다. 새 요청은 이전 pending 선택을 대체할 수 있으므로 UI에 안내하고 6자리 대조 코드·만료 시각을 표시한다. 이 코드는 양쪽 화면 대조용이며 인증 수단이 아니다.
- 등록·승인·조회는 서버 session을 발급하거나 Canonical history를 읽지 않는다. 승인 브라우저에서 비밀번호·브라우저 키 검증을 완료한 뒤 Mobile에서 다시 조회해야 trusted로 표시된다. 응답 분실·잘못된 응답·timeout에는 이전 승인 코드를 지우고 결과 불확실 상태를 표시하며 자동 재시도하지 않는다. 사용자가 상태와 브라우저의 요청을 확인한 뒤 새 요청을 명시적으로 보낼 수 있다.
- 작업은 동시에 하나만 실행하고 전체 10초 제한을 둔다. 화면 이탈·백그라운드·로그아웃·계정/서버 변경 시 controller와 OS 요청을 취소하며 늦은 결과로 이전 화면 상태를 복원하지 않는다. foreground 복귀는 새 owner를 준비할 뿐 HTTP 요청을 자동 실행하지 않는다. snapshot에는 공개 등록/신뢰/승인 상태만 포함하고 Bearer·refresh·개인키·OS 오류 원문을 표시하지 않는다.

### Native TLS 전송과 재전송 경계

`native-enrollment-http.ts`는 enrollment 경로만 허용하는 fetch 어댑터이며 RN/global fetch를 호출하지 않는다. 로컬 Expo 모듈의 별도 전송은 HTTPS origin, GET/POST별 경로, 안전한 Bearer, JSON object와 요청 32 KiB/응답 64 KiB 제한을 OS 계층에서도 다시 확인한다. 잘못된 UTF-8과 3xx를 거절한다. Cookie/Origin/임의 사용자 헤더를 받지 않고, Cookie·캐시·기존 credential storage를 사용하지 않는다. 각 요청 ID는 OS가 예약한 UUID이며 만료/없는 예약·중복 실행·시작 전 취소는 socket 전에 거절한다. 시스템 TLS 신뢰·호스트 검증을 유지한다. 테스트 CA는 fixture에서만 사용한다.

- Android는 별도 OkHttp client의 connection retry/redirect/SSL redirect를 끄고 CookieJar·authenticator·proxy authenticator·cache를 비운다. 실제 TLS fixture에서 연결 분실 시 요청 1회, redirect·Set-Cookie·HTTP 인증·stream cap·취소 경계를 확인한다. 버전 4.9.2는 현재 React Native 0.79의 기존 OkHttp 계약과 동일하며 [OkHttp 공식 설정](https://github.com/square/okhttp/blob/parent-4.9.2/okhttp/src/main/kotlin/okhttp3/OkHttpClient.kt)을 사용한다.
- iOS는 요청마다 [ephemeral URLSession](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/ephemeral)을 만들고 Cookie/credential/cache를 비운다. redirect를 거절하고 기본 server trust 처리만 허용한다. POST는 one-shot body stream이며 [새 body stream 요청](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:neednewbodystream:))을 거절하고 앱 코드에서 자동 반복하지 않는다. **URLSession 공개 API는 OS 내부 재시도 전체를 끄는 보장을 제공하지 않으므로 exactly-once 네트워크 전달을 주장하지 않는다.** 서버의 1회 challenge/flow 소비와 설치 ID별 등록 상태 조회가 중복 부작용을 제한하고, 완료 결과 분실은 성공으로 처리하지 않는다. 이 공급자의 allowlist에는 login/refresh/logout/session/Canonical API가 없으며 세션 회전에 확장하기 전에 해당 전송 경계를 별도 검토해야 한다.

### 검증 증거와 남은 관문

작업 브랜치 `feat/cross-platform-mobile-enrollment`, 기준 통합 SHA `3dff400be278910f41855cc6e06cacf780254838`. 최신 Head CI 통과 후 하위 PR을 통합한다.

- Android production release AAR 빌드와 native JUnit **13/13**(키 codec 4 + TLS 전송 9), iPhoneOS 실제 SDK/deployment target 15.1 production typecheck, 새 HTTP Promise bridge를 포함한 iOS 앱 전체 Simulator Debug 빌드가 통과했다. 별도 실제 macOS URLSession TLS fixture는 고정 헤더·POST body, Cookie 미재사용, 302·chunked 65537·잘못된 UTF-8 거절, 활성 취소와 시작 전 취소, 연결 절단 POST 수신 1회를 확인했다. 테스트 TLS leaf anchor는 `NATIVE_ENROLLMENT_TRANSPORT_TESTING`으로 컴파일한 임시 verifier에만 주입하며 production 앱의 기본 TLS 신뢰를 변경하지 않는다. 검증 스크립트는 **apps/mobile에서** `bash verify/run-native-enrollment-transport.sh`로 실행하고 CI에서도 같은 TLS 경계를 검사한다.
- Mobile **70/70**, typecheck, 전체 계약 검사, iOS/Android Metro 번들 통과. 신규 13개는 멱등 등록·브라우저 선택·default 부재·신뢰 변경·작업 사이/진행 중 계정 변경·토큰 회전·취소·중복 실행·늦은 응답·크기/헤더/경로 경계와 비밀 미노출을 검증한다.
- 실제 Compose `scripts/native-platform-session-compose.mts --mobile-controller`에서 생산 Mobile controller와 JS 어댑터의 등록 → 같은 설치 재등록 조회 → 선택 브라우저 키/비밀번호 승인 → trusted 재조회 및 옛 대조 코드 삭제가 통과했다. Mobile 기기·승인 요청 각 1개, Platform Session 0개, ACTIVE login/refresh 503을 확인했다. 임시 일반 계정·기기·승인 요청·보안 이벤트/outbox·로그인 로그를 정리했다. **키는 소프트웨어 fixture이고 HTTP bridge는 검증된 Node TLS이므로 실기기 하드웨어·OS 전송·생산 Mobile UI의 성공 검증으로 취급하지 않는다.**
- 서비스별 `.env` override와 소스/실행 컨테이너의 통합 브랜치를 확인했다. Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Core `c9125cfd2302d28a44512b836b9340439142685e`, Workflow `02bb512bba00908cc648dceaa6b1b12caf7313fd`, Frontend `7944120b99e8909f09100c802912839a19359589`; 기본 인프라·core/gateway와 `workflow`·`frontend` 프로필, `xgen-local-https` 3443, `PLATFORM_SESSION_MODE=enrollment`. Frontend는 git 실행 파일이 없어 실제 `/app/.git/HEAD`와 branch ref 및 소스 bind mount로 확인했다. 이번 변경은 DEX Mobile 소스이며 서버 코드/브랜치를 새로 바꾸지 않았다.
- Workflow의 SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`·runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` 임시 source snapshot mount와 실제 import 경로(`/opt/xgen-local-sdk/src/xgen_sdk`, `/opt/xgen-local-runtime/src/xgen_agent_runtime`)를 확인했다. 패키지/앱 배포는 수행하지 않았다.
- 환경변수 추가·변경·삭제가 없어 Infra 참조 문서는 변경하지 않는다. 로컬 native 모듈이 없는 Expo Go/web와 Secure Enclave 없는 Simulator는 이전과 같이 키 작업을 차단한다. 실제 iPhone/Android 등록·복원·잠금·브라우저 승인과 Mobile UI 검증, ACTIVE/takeover 수령, Mobile vault/journal·DPoP·Canonical watcher가 남는다.

### Remaining work estimate / 남은 작업 추정

| Phase | 남은 비율 | 주요 잔여 항목 |
|---|---:|---|
| 0 계약·보안 | 22% | 전체 이행 계약 및 최종 보안 검증 |
| 1 PlatformSession | 6% | Mobile 실기기·세션 보관/DPoP, 실제 ACTIVE·takeover 수령과 다중 클라이언트 검증 |
| 2 CanonicalSession | 25% | Mobile 구독, 기존 채팅/WS 이행 및 실서버 양성 검증 |
| 3 Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 설정 | 95% | 개인 설정 동기화·충돌 처리 |
| 5 시크릿·Claude/Codex | 90% | 개인 시크릿 전달과 외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

These percentages estimate remaining design work rather than coverage or a delivery schedule. Mobile Settings now connects native enrollment, status reconciliation and an explicitly selected trusted browser through the common protocol. Account lifetime and cancellation boundaries discard stale results; enrollment neither issues a Platform Session nor grants trust automatically. The actual Compose test uses a software fixture key and a Node TLS bridge, so it does not prove physical-device hardware, native OS transport or production UI success. Android disables implicit connection retries; iOS refuses replacement POST streams and app retries, but URLSession does not guarantee exactly-once delivery. The narrow enrollment allowlist does not permit session rotation or Canonical access. Physical-device verification and Mobile session vault/DPoP/subscription wiring remain gates. Workflow SDK/runtime stays on its temporary local overlay without release.

## Mobile 세션 보관·회전 journal과 하드웨어 DPoP (2026-10-01)

작업 브랜치 `feat/cross-platform-mobile-session`, 기준 통합 SHA `63b40a5aca4e124119a4cc613c9cd97fef11e312`. 하위 PR137을 통합 브랜치에 반영하며 main 대상 상위 PR90은 Draft로 유지한다. 새로운 환경변수·패키지/앱 배포는 없다.

설정 → **휴대폰 세션**에서 등록·승인된 휴대폰을 현재 계정 비밀번호로 발급한다. 저장 상태 확인은 로컬 조회이며 서버의 현재 trust/sid 유효성 증거가 아니다. 수동 갱신과 비밀번호·기기 키를 사용한 서버 폐기, 경고 후 로컬 기록 삭제를 제공한다. 기존 로그인·채팅 자격증명과 분리했으며 자동 발급/갱신/재시도 및 Canonical watcher는 연결하지 않았다. 비밀번호 입력은 작업 시작·화면 이탈·백그라운드에서 지우고 오류/진단/저장소에 추가하지 않는다. JS 문자열 메모리 삭제를 보장하지 않는다.

### 보관과 중단 복구

- `native-session-vault-expo.ts`: 별도 `xgen-mobile-platform-v1` SecureStore service. iOS는 `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, Android는 Expo SecureStore의 Keystore 암호화 저장을 사용한다. 하드웨어 서명 키는 이 저장소에 인코딩하지 않는다. 보관 키는 mobile/HTTPS origin/실제 사용자별 SHA-256이며 legacy SecureStore와 AsyncStorage를 읽거나 대체하지 않는다. 실기기 잠금·복원·OS 저장 장애는 최종 검증 관문이다.
- 공개 설치 ID/키 thumbprint, mobile slot, device/sid, JWT의 sub/platform/token_use/cnf/expiry를 대조한다. 이는 로컬 구조 검사이며 JWT 서명·현재 신뢰·권한·sid는 서버가 검증한다. 손상·불일치·보안 저장 실패는 자동 삭제·재등록·기존 토큰 복원으로 처리하지 않는다.
- 같은 앱의 모든 controller가 계정별 공통 JS lock을 사용한다. 발급/갱신/폐기 전 **토큰 없는 journal 저장 → readback → 기존 credential record 삭제·readback**을 완료해야 wire를 시작한다. 완료는 **새 record 저장 → readback → journal 삭제·readback** 순서다. 취소·응답 유실·완료 저장 실패·앱 종료로 journal이 남으면 다음 owner/앱 실행도 옛 토큰이나 미확정 새 토큰을 사용하지 않는다. 보안 저장 오류 시 cached active 화면을 미확인 상태로 지운다. 서버 성공 응답과 새 record 검증·저장·readback 및 현재 권한 확인이 끝난 뒤 **OS journal 삭제 시작을 취소 불가 commit 지점**으로 정의한다. 삭제 중 화면/로그인 수명이 변경되면 옛 owner/UI 결과는 폐기하지만 원래 계정의 검증된 새 record는 다음 명시적 조회에서 복원할 수 있다. 다른 origin/사용자는 별도 vault다. 삭제 성공 후 최종 readback만 실패한 경우에도 같은 정책이며 옛 refresh로 되돌아가지 않는다.
- `pending_takeover`는 토큰 없이 저장한다. 중단/인계 대기 기록은 PC 내 페이지에서 서버 세션 확인·폐기 후 로컬 삭제로 복구한다. 로컬 삭제는 서버를 호출하지 않고 기기 등록/키를 유지하며, 현재 계정의 키가 없어도 기록 삭제는 가능하다. 계정/서버/같은 계정 재로그인·화면 이탈·백그라운드·timeout 이후 결과는 적용하지 않는다.

### DPoP와 별도 세션 전송

하드웨어 공급자는 현재 account/install/thumbprint를 다시 확인하고 네이티브에서 ES256 `dpop+jwt`를 조립한다. public JWK와 OS UUID jti/현재 iat, 고정 GET 또는 DELETE htm/동일 HTTPS htu, access SHA-256 ath를 포함한다. 임의 원본 바이트/개인키 반환 API는 없다. JS에서도 반환 claims/JWK/hash/시각/서명 크기를 대조한다. Canonical GET 서명 경계는 준비했지만 GET HTTP/watcher는 아직 연결하지 않았다.

enrollment의 `request`는 이전 allowlist를 유지하고, 별도 `sessionRequest`는 native login-key/refresh POST 및 세션 폐기 DELETE만 허용한다. login에는 계정 Bearer, refresh에는 Authorization 없음, DELETE에는 현재 Platform access의 DPoP와 JSON password를 요구한다. OS와 JS에서 origin/path/method/header/body를 확인하며 native 예약 ID·취소·TLS·Cookie/redirect/cache·요청 32 KiB/응답 64 KiB 경계를 공유한다. trailing newline이 regex anchor로 통과하지 않도록 전체 문자열도 검사한다.

서버 소스 `platform_native_login.rs`와 `platform_native_refresh.rs`에서 완료 flow/challenge를 Redis GETDEL로 소비한 뒤 proof/세션 발급·회전을 수행하는 것을 확인했다. DB 회전은 소비된 refresh 재사용을 거절하고 family를 폐기한다. Android는 connection retry를 끄고, iOS는 POST/DELETE one-shot stream과 replacement 거절을 유지한다. **URLSession 내부 재전송을 모두 끄거나 exactly-once 전달을 보장하지 않는다.** 결과 유실 시 journal을 유지하며 동일 completion/옛 refresh를 앱에서 재시도하지 않는다. 서버 DPoP replay 검증도 폐기 요청의 중복 수락을 제한한다.

### 검증과 한계

- Mobile **96/96** 및 typecheck, 계약 검사, strict/bundler Compose opt-in harness 타입 검사 통과. 발급·rotation·takeover 무토큰·DPoP 폐기·복원, 저장/삭제/readback 장애와 미확인 화면, 오래된 token 잔존 시 journal 우선, account/취소/늦은 응답·동시 owner·취소 불가 commit, JWT/key/sid binding과 경로/auth/헤더/크기 경계를 검증한다. 긍정 발급/회전/폐기는 통제된 software-key/HTTP fixture이며 실제 ACTIVE 서버 성공 증거가 아니다.
- Android production release AAR와 native JUnit **19/19**(device codec4, DPoP2, TLS13), 실제 iPhoneOS SDK/iOS15.1 production typecheck, 새 8인자 Expo session bridge를 포함한 전체 iOS Simulator Debug 앱 빌드 및 iOS/Android Metro 번들 통과. 실제 macOS URLSession TLS fixture는 login Bearer·refresh 무인증·DELETE DPoP/password body, Cookie 미재사용·취소·부적절한 auth/UUID/Canonical 경로 거절과 실제 P-256 DPoP 서명을 확인한다. 테스트 인증서는 verifier에만 주입하며 시스템/production trust를 변경하지 않는다. 최신 PR Head CI도 머지 전 확인한다.
- 실제 Compose `node --import tsx scripts/native-platform-session-compose.mts --mobile-session`: 임시 계정의 멱등 등록·선택 브라우저 승인·trusted → 생산 Mobile session controller login **503** → token-free `login_pending` → 새 owner의 조회/중복 발급·refresh 차단 → 명시적 로컬 복구를 통과했다. 로컬 삭제 후 trusted 기기는 유지되고 Platform Session 0개이며 임시 계정·기기·요청·DB 이벤트를 정리했다. **메모리 vault·소프트웨어 fixture 키·Node TLS bridge를 사용하므로 Expo SecureStore/물리 하드웨어/생산 Mobile UI의 결합 성공으로 보고하지 않는다.**
- Compose는 기본 인프라/core/gateway 및 workflow/frontend 프로필, `xgen-local-https`3443, `PLATFORM_SESSION_MODE=enrollment`. `.env` per-service branch와 clean source/실행 container를 대조했다. 모두 `feat/cross-platform-session`: Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Core `c9125cfd2302d28a44512b836b9340439142685e`, Workflow `02bb512bba00908cc648dceaa6b1b12caf7313fd`, Frontend `7944120b99e8909f09100c802912839a19359589`(실제 /app/.git/HEAD/ref와 source bind mount). 서버 코드를 바꾸거나 ACTIVE gate를 우회하지 않았다.
- Workflow의 SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`·runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` snapshot mounts/import 경로를 확인했다. 임시 overlay를 유지하고 패키지를 배포하지 않았다. 환경변수 변경이 없어 Infra 참조 문서도 변경하지 않는다.
- 로그: `/tmp/cross-sync-mobile-session-tests.log`, `-types.log`, `-android-native-final.log`, `-native-transport-final.log`, `-iphoneos.log`, `-ios-build.log`, `-metro.log`, `-compose.log`. Android JUnit XML은 모듈의 `android/build/test-results/testDebugUnitTest/TEST-*.xml`에 있다. CocoaPods 생성물은 검증 산출물이며 커밋에서 제외한다.

### Remaining work estimate / 남은 작업 추정

| Phase | 남은 비율 | 주요 잔여 항목 |
|---|---:|---|
| 0 계약·보안 | 22% | 전체 이행 계약 및 최종 보안 검증 |
| 1 PlatformSession | 5% | Mobile 실기기 보관/서명/UI, 실제 ACTIVE·takeover 수령과 다중 클라이언트 검증 |
| 2 CanonicalSession | 25% | Mobile 구독, 기존 채팅/WS 이행 및 실서버 양성 검증 |
| 3 Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 설정 | 95% | 개인 설정 동기화·충돌 처리 |
| 5 시크릿·Claude/Codex | 90% | 개인 시크릿 전달과 외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

Percentages estimate remaining design work, not test coverage or delivery dates. Mobile Settings now supports explicit session issuance, local inspection, rotation, password/DPoP server revocation and local recovery through a separate SecureStore vault. A durable token-free journal gates every credential read; new verified records precede journal removal. Existing chat remains unchanged. Dedicated native session transport enforces Bearer-only login, authorization-free refresh and DPoP/password DELETE while sharing reservation/cancellation/TLS boundaries with enrollment. Native DPoP stays within the hardware key provider. URLSession does not guarantee exactly-once delivery; server flow consumption and local interruption markers prevent old credential fallback. Tests/typechecks, Android release AAR/native TLS, iOS full Simulator build/real iPhoneOS SDK, Metro and enrollment-mode Compose rejection/recovery pass. Compose uses memory storage/software key/Node TLS seams, so physical SecureStore/hardware/UI and real ACTIVE/takeover positive verification remain gates. Canonical watcher is next. SDK/runtime continues as an unreleased Workflow source overlay and parent PR90 remains Draft.

## Mobile Canonical 포커스 조회·foreground 구독 (2026-10-01)

작업 브랜치 `feat/cross-platform-mobile-canonical`, 기준 통합 SHA `4a5befc07851f247f9311421c266d3c8f35e0676`, 하위 PR138 → `feat/cross-platform-session`. main 대상 상위 PR90은 Draft로 유지한다. 환경변수·SDK/runtime 배포 변경은 없다.

### 구현과 동작

- `NativeAgentFocusCard`는 설정에서 현재 Agent 포커스의 ID/version 조회와 명시적 구독 시작·중단을 제공한다. 화면 이탈/계정 변경/백그라운드에서 owner를 폐기하고 요청·대기·포커스를 지우며 자동 재시작하지 않는다. 기존 메시지/WS는 후속 이행 작업이다.
- `native-agent-focus.ts`는 공통 `AgentSessionReadClient`/`reconcileAgentFocus`를 사용한다. bounded step마다 하드웨어 identity 및 vault record/journal을 새로 확인하고 현재 계정별 공통 lock 안에서 서명·요청·응답을 검사한다. callback 종료 후 proof source를 무효화하고 로컬 record 참조를 버린다. JWT 서명/현재 권한/trust/sid는 서버가 검증한다.
- cursor scope는 mobile/HTTPS origin/실제 user/로그인 수명/install/key/device/Platform sid의 hash다. access/refresh token과 회전 generation은 포함하지 않으므로 같은 sid의 명시적 갱신 뒤 새 access로 replay를 계속한다. sid 교체/재로그인은 snapshot부터 다시 조회한다. scope/cursor는 실행 동안만 유지하고 UI/진단에는 자격증명 없이 focus/source만 공개한다.
- `native-agent-focus-watch.ts`는 RN timer 기반 2초 polling, step 전체 10초 deadline, 최대 10페이지 후 yield, 갭/409 snapshot 복구를 연결한다. 정상 step은 lock을 놓은 뒤 대기한다. transport/408/429/5xx/timeout 읽기만 1·2·4·8·16·30초 backoff하고 unchanged poll은 반복 표시하지 않는다. 인증/만료/journal/키/저장소/protocol 오류는 중단한다. 모든 재연결·중단 표시에서 오래된 focus를 지우며 자동 refresh/변경 작업 retry/legacy Bearer fallback은 없다.
- 전송 취소가 OS 완료 확인은 아니다. 실제 native Promise가 settle될 때까지 module/origin별 public request ID latch를 남겨 새 GET과 기기 proof 준비를 거절한다. UI owner/adapter를 바꿔도 같은 module latch를 사용한다. source settling 또는 native reservation cap busy가 연속 4회면 구독을 중단한다. vault lock을 무한히 유지하지 않아 명시적 갱신·폐기/로컬 복구를 허용하며, 취소된 OS 요청 내부의 기존 헤더는 완료까지 남을 수 있다. late response는 cursor/UI에 적용하지 않는다. 새 bridge 함수가 없는 구형 native 앱과 native contract-invalid는 permanent failure로 처리한다.

### 고정 Canonical GET 전송

별도 `readRequest(id, origin, pathWithQuery, accessToken, dpop)`가 GET/body 없음/JSON Accept/DPoP Authorization/DPoP만 구성한다. JS와 양 OS에서 같은 경로·query 순서를 검사하며 서명 `htu`는 query를 제외한다. 허용 경로는 아래 다섯 가지다.

| 경로 | 허용 query |
|---|---|
| `/api/agentflow/me/agent-state` | 없음 |
| `/api/agentflow/me/agent-events` | `after_sequence=N&limit=N` |
| `/api/agentflow/me/agent-sessions` | `limit=N` 뒤 선택적 `&before_id=UUID` |
| `/api/agentflow/agent-sessions/UUID/snapshot` | 없음 |
| `/api/agentflow/agent-sessions/UUID/events` | `after_sequence=N&limit=N` |

seq는 0..9007199254740991, limit은 1..200(list는 1..100), decimal의 leading zero 없음, UUID는 lowercase version1..8/variant다. duplicate/unknown/reordered/encoded query, hash/backslash/URL rewrite/foreign 또는 noncanonical origin, JWT newline/oversize를 거절한다. list/session snapshot/event 경계는 공통 read client용으로 준비했으며 Mobile UI는 이번에 account focus만 연결했다. 기존 enrollment/session mutation allowlist는 유지하고 shared 예약·취소·기본 시스템 TLS·Cookie/redirect/cache 거절·64 KiB UTF-8 응답을 재사용한다. 앱 retry와 URLSession exactly-once는 별개이며 내부 OS 재전송의 완전 차단을 보장하지 않는다.

### 검증과 제한

- Mobile **118/118** tests 및 typecheck, 공통 계약 검사와 strict/bundler Compose harness 타입 검사 통과. 실제 ES256/ath/GET htu·fresh jti, snapshot/replay/gap·409/invalid JSON 복구, token rotation/sid·로그인 수명 변경, journal/expiry/corruption, lock을 놓은 대기 중 rotation, background/dispose/cancel·late 결과, whole-step deadline, capped backoff/unchanged suppression, 실제 adapter의 미정 OS call·새 owner·명시적 복구, 구형 bridge/permanent invalid와 native reservation cap busy를 검증했다. ACTIVE record/read 양성 테스트는 software-key/HTTP fixture이며 생산 서버 성공으로 취급하지 않는다.
- Android release AAR와 native JUnit **22/22**(device4/DPoP2/TLS16), 실제 iPhoneOS SDK/deployment15.1 typecheck, 새 5인자 Expo GET bridge를 포함한 전체 iOS Simulator Debug 앱 빌드 및 iOS/Android Metro 번들 통과. macOS 실제 URLSession `::1` TLS fixture는 고정 GET/query/DPoP headers/body 없음/Cookie 미재사용/취소/invalid 경계를 확인했다. verifier의 임시 인증서는 production/system trust에 추가하지 않는다.
- 실제 Compose `node --import tsx scripts/native-platform-session-compose.mts --mobile-focus`: 임시 일반 계정 등록·선택 브라우저 승인/trusted → login **503** → token-free `login_pending` → 생산 source와 watcher의 wire 이전 인증 중단(Canonical GET 0회) → owner 복원/중복 발급·refresh 차단/명시적 로컬 복구·trusted 유지 및 임시 DB 자료 정리를 통과했다. memory vault/software key/Node TLS seams이므로 실제 SecureStore/hardware/production Mobile UI 성공 증거는 아니다.
- Compose 기본 인프라/core/gateway, workflow/frontend 및 local HTTPS3443, `PLATFORM_SESSION_MODE=enrollment`을 유지했다. clean source와 실행 container branch/ref/SHA 및 /app mounts를 직접 대조했다. 모두 `feat/cross-platform-session`: Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Core `c9125cfd2302d28a44512b836b9340439142685e`, Workflow `02bb512bba00908cc648dceaa6b1b12caf7313fd`, Frontend `7944120b99e8909f09100c802912839a19359589`. Mobile 자체는 Compose 서비스가 아니며 이 하위 브랜치의 실제 native/JS 빌드로 별도 검증했다. ACTIVE parser gate를 우회하지 않았다.
- Workflow snapshot mounts와 실제 import는 SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`(`/opt/xgen-local-sdk/src/xgen_sdk/__init__.py`), runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06`(`/opt/xgen-local-runtime/src/xgen_agent_runtime/__init__.py`)이며 임시 overlay를 유지한다. 환경변수 변경이 없어 Infra 참조 문서는 변경하지 않는다.
- 증거 로그: `/tmp/cross-sync-mobile-canonical-tests.log`, `-types.log`, `-android.log`, `-swift-fixture.log`, `-iphoneos.log`, `-ios-build.log`, `-metro.log`, `-contracts.log`, `-compose-types.log`, `-compose.log`. Pod/Metro 생성물은 커밋에서 제외한다. 최종 PR Head CI와 diff/review를 통합 직전에 확인한다.

### Remaining work estimate / 남은 작업 추정

| Phase | 남은 비율 | 주요 잔여 항목 |
|---|---:|---|
| 0 계약·보안 | 22% | 전체 이행 계약 및 최종 보안 검증 |
| 1 PlatformSession | 5% | Mobile 실기기 보관/서명/UI, 실제 ACTIVE·takeover 수령과 다중 클라이언트 검증 |
| 2 CanonicalSession | 23% | Mobile 메시지 snapshot/event·기존 채팅/WS 이행 및 실서버 양성 검증 |
| 3 Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 설정 | 95% | 개인 설정 동기화·충돌 처리 |
| 5 시크릿·Claude/Codex | 90% | 개인 시크릿 전달과 외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

These are remaining-work estimates, not coverage or delivery dates. Mobile Settings now explicitly reads and polls the canonical account focus through ready, scoped Platform credentials and native GET DPoP. Shared reconciliation preserves same-sid cursors across token rotation and recovers gaps/409 with a snapshot. Every bounded step reloads the vault; waits release the lock. Authentication, interrupted journals, key/vault/protocol failures stop, while read-only transient failures use capped backoff. Account/screen/background changes discard the cursor and require explicit restart. Cancelled native reads remain busy across owners until OS completion; persistent source/reservation busy stops, while local recovery remains available. Exact routes/ordered queries use the existing system TLS/cookie/redirect/UTF-8/cancel boundaries. Tests/native builds/Metro and enrollment-mode Compose rejection pass. Real ACTIVE/takeover, physical SecureStore/hardware/UI and message/WS integration remain gates. Parent PR90 stays Draft and SDK/runtime stays on the unreleased Workflow overlay.


## Mobile 공유 대화 snapshot·event·완결 메시지 조회 (2026-10-01)

작업 브랜치 `feat/cross-platform-mobile-messages`, 기준 통합 SHA `1bef897b0f9f73441a88358b3608e8acc7c5fd56`, 하위 [PR140](https://github.com/PlateerLab/xgen-dex-core/pull/140) → `feat/cross-platform-session`. main 대상 상위 PR90은 Draft로 유지한다.

### 범위와 통신

```text
Mobile Settings 공유 대화 보기
  → 계정 수명 + hardware identity + SecureStore vault/journal 확인
  → native GET /me/agent-state · /me/agent-events (query-free DPoP)
  → 선택된 Agent /snapshot (latest_turn)
  → /events (연속 실행 커서) + /messages (독립 sparse 커서)
  → 최신 snapshot + account focus 재확인
  → 완료 메시지/실행 상태 메모리 표시
```

- 공통 protocol에 메시지 display projection과 latest_turn parser, bounded conversation recovery를 추가했다. raw ExecutionIO/tool 값은 전달하지 않는다. snapshot의 `message_history_complete=false`를 유지하며 전체 과거 이력 완성을 주장하지 않는다. 진행 중 출력은 완료 후 journal-linked 메시지로 확인한다.
- 단계당 이벤트 최대 2페이지×100, 메시지 최대 2페이지×1, 단계 deadline 10초다. 단발 조회는 최대 10단계 뒤 남은 기록을 일부 조회로 표시한다. 명시적 polling은 backlog를 이어 읽고 안정화 후 2초 간격으로 확인한다. 최대 100턴/본문 UTF8 4MiB를 보관하며 오래된 턴 생략 개수를 표시한다.
- 같은 sid의 token rotation은 두 커서를 유지하고 다음 단계에서 vault를 다시 읽어 새 proof를 만든다. focus/auth scope 변경은 이전 본문을 폐기한다. 본문 요청 뒤 final focus를 확인하고 concurrent 변경 시 빈 화면 상태와 새 pointer를 반환하여 다음 단계에서 재조회한다.
- 이벤트 gap/409는 한 번 재수화한다. 메시지 무결성 실패/409는 중단하여 첫 정상 페이지와 잘못된 후속 페이지의 반복 재조회를 막는다. native redirect/UTF8/응답 크기 실패는 protocol recovery와 구분하는 영구 오류다. 네트워크/서버 임시 실패만 기존 capped backoff를 사용한다. 계정/화면/백그라운드/취소·늦은 결과 폐기와 실제 OS completion 이전 새 GET 차단은 기존 경계를 유지한다.
- 두 OS/JS에 `/messages?after_sequence=N&limit=N` exact route를 추가했다. limit 1..20, sequence 0..9007199254740991, canonical decimal/lowercase UUID를 대조한다. query는 DPoP htu에서 제외한다. 해당 응답만 1MiB, 나머지 GET와 enrollment/session mutation은 기존 64KiB로 제한한다. 인증·Cookie·TLS·redirect·예약/취소 경계는 유지한다.

### 검증과 실제 실행 환경

- Mobile **125/125**, protocol **210/210**, 각 타입 검사·계약 검사·strict/bundler Compose harness 타입 검사 통과. sparse/빈 페이지/중복·잘못된 본문·UTF8 제한, event/message 독립 커서, bounded paging·100턴/4MiB retention, focus 변경, rotation, callback mutation isolation, journal 차단, account/background/cancel·late 결과, 메시지 무결성 실패 중단을 검증했다.
- Android release AAR와 native tests **23/23**(device4/DPoP2/TLS17), 실제 iPhoneOS SDK typecheck(deployment target15.1), 전체 iOS Simulator Debug 앱 빌드, iOS/Android Metro export 통과. 실제 URLSession `::1` TLS fixture에서 messages >64KiB 성공, 다른 경로 64KiB 거절, 1MiB 초과 fixed/chunked 응답·invalid UTF8·redirect 거절과 취소를 검증했다. 임시 인증서는 테스트 verifier에만 주입한다.
- 실제 Compose opt-in `--mobile-messages`: 임시 계정 등록·선택 브라우저 승인·trusted, login **503**과 durable token-free login_pending, 생산 focus/conversation source와 watcher의 인증 중단(Canonical GET **0회**), 재시작 후 중복 발급/refresh 차단, 명시적 로컬 복구와 임시 DB 자료 정리 통과. **memory vault/software key/Node TLS seams**이며 실제 ACTIVE 양성·SecureStore/hardware/production Mobile UI 결합 성공 증거는 아니다.
- `.env` 서비스별 branch override와 clean source/container HEAD/ref·`/app` mount를 확인했다. 전부 `feat/cross-platform-session`: Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `ee007d09c0f5548d6a069648a655ef70ecfcf3db`, Frontend `7944120b99e8909f09100c802912839a19359589`. Workflow는 기존 `02bb512b`에서 최신 integration으로 fast-forward하고 기존 Compose container/overlay 설정을 유지하여 재시작했다. 기본 인프라/core/gateway, workflow/frontend 프로필과 local HTTPS3443, enrollment mode를 사용했다.
- SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`와 runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06`의 snapshot marker·실제 `/opt/xgen-local-sdk` 및 `/opt/xgen-local-runtime` import를 확인했다. 배포는 하지 않았다. 환경변수 추가·변경·삭제가 없어 Infra 참조 문서 변경은 없다.
- 증거: `/tmp/cross-sync-mobile-messages-{mobile,protocol,types,protocol-types,android,iphoneos,swift-fixture,ios-build,metro,compose-types,compose}.log`. Pod/Metro 생성물은 커밋에서 제외한다. 통합 전 최종 Head CI와 diff/review를 확인한다.

### 잔여 추정치

| Phase | 남은 비율 | 주요 잔여 |
|---|---:|---|
| 0 기반/계약 | 22% | 운영 계약·보안 관문·통합 검증 |
| 1 PlatformSession | 5% | Mobile 실기기·UI, 실제 ACTIVE/takeover 수령 |
| 2 CanonicalSession | 21% | Native WS ticket/socket·기존 채팅 송신 이행·실서버 양성 검증 |
| 3 Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 개인 설정 | 95% | 동기화·충돌 처리 |
| 5 개인 시크릿·Claude/Codex | 90% | 시크릿 전달과 외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 검증 후 단계적 제거 |

These percentages estimate remaining work, not coverage or delivery dates. Mobile now explicitly reads and polls session snapshots, contiguous execution events and sparse linked terminal messages using scoped native DPoP. Bounded paging/retention, final focus checks, callback isolation, journal/expiry/cancellation and permanent native response failures protect the display. Invalid message links stop instead of replaying earlier pages repeatedly. JS/protocol tests, Android native release tests/AAR, real iPhoneOS typecheck, full iOS Simulator build, Metro exports and enrollment-mode Compose rejection/cleanup pass. All actual server branches/mounts were verified; Workflow advanced to ee007d09 while preserving unreleased SDK/runtime source overlays. Real ACTIVE/takeover, physical SecureStore/hardware/UI, native WS and existing chat send migration remain gates. Parent PR90 stays Draft.

## Mobile 인증 WebSocket 수신 및 HTTP 재조회 (2026-10-01)

작업 브랜치 `feat/cross-platform-mobile-ws`, 기준 통합 SHA `37e25740b47ad6debe5ed8981a925351a5b4b26b`, 하위 [PR143](https://github.com/PlateerLab/xgen-dex-core/pull/143) → `feat/cross-platform-session`. 상위 PR90은 Draft 유지.

```text
Mobile Settings 대화 변경 구독 시작
  → 계정/hardware identity/SecureStore journal 확인
  → bounded HTTP snapshot/events/messages 및 최종 focus 확인
  → native WSS /agent-sessions/{UUID}/events?after_seq=N
      Authorization: DPoP + 새 GET proof (HTTPS/query-free htu)
  → 연속 프레임 검증 → HTTP 재조회 → 검증된 대화 표시
  → 조용할 때도 기본 2초 HTTP 확인
  → focus/vault 세대 변경은 종료 확인 후 최신 연결
```

### 구현과 복구 경계

- iOS URLSessionWebSocketTask/Android OkHttp + Expo 6인자 open/pull next/close를 추가했다. canonical HTTPS origin/lowercase UUID/safe decimal cursor/JWT 형식을 검증하고 native가 exact WSS route를 구성한다. 브라우저 전용 WS ticket을 Mobile에 사용하지 않는다. Cookie/Origin/subprotocol/cache/ambient authenticator/redirect/app retry 및 앱 데이터 송신은 제공하지 않는다. OS TLS/hostname 검증은 유지한다.
- JS와 native가 같은 서버의 연결 종료를 확인할 때까지 새 연결을 차단한다. 예약/active/closing은 OS별 최대 64개다. 예약 TTL60초, 확인된 종료 tombstone도 제한/정리한다. native close 실패에는 JS latch를 해제하지 않으며 OS 완료 대신 timeout을 종료 증거로 취급하지 않는다. Android graceful close는 peer 무응답 시 약 60초 취소 대기가 가능하고 watcher의 반복 busy는 bounded 중단한다.
- text UTF8 1MiB, iOS 단일 pending receive/maximumMessageSize, Android 8프레임/2MiB 전달 queue를 적용했다. Android frame 검사는 OkHttp 디코딩 후 적용되므로 OS 내부 할당 전 상한을 보장하지 않는다. U+FFFD도 보수적으로 거절한다. binary/잘못된 UTF8/queue overflow/protocol close는 영구 오류로 중단한다.
- WS는 receive-only wakeup이며 화면 본문/상태는 기존 HTTP 검증 projection을 사용한다. 한 번의 pending next를 quiet timer 이후에도 유지해 중복 pull을 막는다. 단발 조회는 WS를 열지 않는다. HTTP backlog는 먼저 읽고 focus/account 변경, 화면 이탈/백그라운드, 취소, 늦은 프레임은 이전 연결과 표시를 폐기한다. vault lock은 연결 수명 동안 보유하지 않는다.
- HTTP마다 vault를 다시 읽고 token generation이 바뀌면 연결을 교체한다. 기존 WS의 인증 종료가 회전과 겹치면 기존 vault/HTTP를 한 번 확인하며 자동 발급/refresh는 하지 않는다. 인증 실패/진전 없는 반복 종료는 중단한다. handshake와 live cursor 충돌 모두 한 번 snapshot 복구를 거치고 반복 no-progress 충돌은 중단한다. HTTP/WS 커서 진전 또는 scope/session 변경은 복구 예산을 갱신한다. HTTP408/429/5xx·네트워크는 기존 capped backoff를 사용한다.

### 검증과 실제 환경

- Mobile **144/144** 및 타입 검사, strict/bundler Compose harness 타입 검사 통과. 실제 소프트웨어 P-256 DPoP의 HTTPS query-free htu/ath 서명, 연결 중 vault lock 해제, generation rotation, journal pre-wire 차단, 중복/늦은 결과와 실제 close ack, WS wakeup/quiet checks, transient reconnect, handshake/live conflict 복구, close 지연 중 snapshot 의도 유지, HTTP 진전·focus 해제/재연결, 인증 회전 경쟁·반복 실패를 검증했다.
- Android release native **36/36**(device4/DPoP2/HTTP17/WS13) 및 AAR, 실제 iPhoneOS SDK typecheck(deployment target15.1), 전체 iOS Simulator Debug 앱 빌드 통과. iOS/Android Metro export도 확인한다. iOS TLS fixture는 실제 `::1`에서 canonical URL/header, cookie/origin/protocol 부재, 101/redirect·401/403/408/409/429/5xx, close codes/terminal 오류 보존, network disconnect, binary/oversize/invalid UTF8/정확1MiB, cap/예약/취소·late callback/origin latch/idempotent close/teardown을 검증한다. 인증서 주입은 테스트 컴파일에만 존재한다.
- 실제 Compose `--mobile-ws`: 임시 계정 등록·선택 브라우저 승인/trusted → login503 → durable token-free login_pending → 생산 source/live watcher의 인증 중단과 Canonical GET **0회**, native socket 예약/handshake **0회** → 명시적 로컬 복구·trusted 유지 및 임시 DB 자료 정리 통과. **memory vault/software key/Node TLS seams**이며 ACTIVE 서버의 WSS 성공이나 물리 기기 결합 검증으로 보고하지 않는다.
- `.env` branch overrides, clean source/container HEAD/ref와 `/app` mount를 직접 확인했다. 모두 `feat/cross-platform-session`: Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `ee007d09c0f5548d6a069648a655ef70ecfcf3db`, Frontend `7944120b99e8909f09100c802912839a19359589`. 기본 인프라/core/gateway + workflow/frontend 프로필, HTTPS3443, enrollment mode를 사용했고 이 작업은 서비스 소스를 변경하지 않는다.
- SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`/runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` snapshot과 실제 `/opt/xgen-local-sdk`/`/opt/xgen-local-runtime` import를 재확인했다. 패키지 배포 및 환경변수 변경은 없다.
- 증거: `/tmp/cross-sync-mobile-ws-{tests,types,android,iphoneos,swift-fixture,ios-build,metro,compose-types,compose,environment,overlay}.log`. Pod/Metro 생성물 제외. 최종 Head CI와 diff/review 확인 후 하위 PR만 통합한다.

### 잔여 추정치 (설계 11절의 Phase 기준)

| Phase | 남은 비율 | 주요 잔여 |
|---|---:|---|
| 0 계약·보안 | 22% | 운영 계약·최종 보안 관문·통합 검증 |
| 1 Platform Session | 5% | 실제 ACTIVE/takeover 수령·Mobile 실기기/UI |
| 2 Canonical Agent Session | 19% | 기존 채팅 송신 이행·다른 native WS·실서버 양성 검증 |
| 3 Global Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 개인 설정 | 95% | 동기화·충돌 처리 |
| 5 개인 시크릿·Claude/Codex | 90% | 개인 시크릿 전달·외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

These estimates describe remaining design work, not test coverage or delivery dates. Mobile now receives DPoP-authenticated native WSS notifications and wakes bounded HTTP conversation recovery, with periodic focus/vault checks. Reserved IDs, bounded native state, exact routes, system TLS, receive-only APIs and actual terminal acknowledgements constrain the transport. Snapshot recovery covers upgrade and live cursor conflicts; an old socket authentication close rechecks existing credentials once to handle rotation without automatic session issuance. JS/native fixtures, iOS full build and enrollment-mode Compose rejection validate their seams. Real ACTIVE/takeover, physical SecureStore/hardware/UI, other native WS surfaces and existing chat send migration remain gates. Parent PR90 stays Draft; SDK/runtime remain unreleased Workflow overlays. Phase names follow design section11.

## CLI·VSCode·Desktop 공유 대화 조회 기반 (2026-10-01)

작업 브랜치 `feat/cross-platform-native-messages`, 기준 통합 SHA `5cbabb5f93e4f1e227eb1d75a3ce71eca03b5d21`, 하위 [PR144](https://github.com/PlateerLab/xgen-dex-core/pull/144) → `feat/cross-platform-session`. 상위 [PR90](https://github.com/PlateerLab/xgen-dex-core/pull/90) → main은 Draft 유지.

```text
CLI conversation/watch-conversation
VSCode native/conversation · native/watch-conversation → 읽기 전용 가상 문서
Desktop 공유 대화 읽기·폴링·중단 → main 전용 계정/origin → OS keychain
  → ready vault/journal/account/access 확인
  → GET DPoP /me/agent-state · /me/agent-events
  → 선택된 /snapshot · /events · /messages → 최종 focus 재확인
  → 표시 projection만 전달 → bounded HTTP polling
```

### 구현과 경계

- 다른 native 표면은 포커스만 조회하고 있어, WS 연결에 앞서 대화 조회 선행 조건을 보완했다. Mobile의 공통 protocol recovery를 사용하며 snapshot/latest_turn, 연속 실행 이벤트, sparse 완결 메시지의 두 커서를 유지한다. 단계당 이벤트 2×100/메시지 2×1, deadline 10초, 단발 최대 10단계, retention 최대 100턴/본문 UTF8 4MiB다. 같은 sid의 rotation은 커서를 유지하고 다음 단계에서 새 vault/proof를 사용한다.
- native HTTP read adapter는 canonical HTTPS origin/exact GET route/ordered query를 제한하며 query-free htu·ath를 서명한다. Cookie/ambient credentials/redirect를 사용하지 않는다. messages 1MiB, 그 외 64KiB, fatal UTF8과 stream 크기를 제한한다. 응답 헤더 이후·본문 진입·chunk마다 인증/취소를 확인하며 실패 시 unread body를 취소한다. 이벤트 gap/409 복구는 기존 bounded snapshot 경로를 사용하고 메시지 무결성 실패는 중단한다.
- RPC는 `canonicalConversation:true` capability와 별도 conversation 알림을 추가했다. 표시 snapshot/messages/omittedMessages와 has_more만 전달하며 credential/authScope/cursor/raw tool 값은 제외한다. watch 간격 오류는 ACK 전에 거절한다. VSCode/Desktop은 malformed projection을 중단하고 pending 취소·late ACK의 정확한 watch ID 정리로 새 watch를 보존한다. Desktop renderer는 raw ACK를 먼저 게시하지 않는다.
- VSCode의 가상 plain-text 문서는 명시적으로 열고 폴링 결과를 갱신한다. 파일/로그 저장은 없으며 표시 문자열은 5×1024×1024자 상한을 둔다. Desktop 버튼은 완결 메시지·최신 턴·생략/불완전/추가 조회 상태를 표시한다. 계정/서버 변경, 취소, 중단·재연결은 이전 본문을 비운다. 기존 채팅 송신 이행과 다른 native WS는 다음 작업이다.

### 검증과 실행 환경

- Protocol **212/212**, engine 초기 전체 **161 pass / 2 skip**와 후속 응답 취소·has_more 회귀를 포함한 대상 **33/33**, VSCode 전체 **30/30**, Desktop 초기 전체 **530/530**와 후속 renderer 대상 **7/7** 통과. 관련 타입 검사·계약 검사·CLI/VSCode/Desktop 빌드와 두 opt-in harness strict 타입 검사 통과. Engine 두 skip은 OS별 지원 조건이다.
- 로컬 Node24 CLI 전체는 최종 **153/153** 통과했다. 기존 TUI 이력 표시 테스트가 답변만 먼저 그려진 중간 frame을 읽어 실패하던 조건을 질문·답변이 함께 그려진 실제 frame을 기다리도록 좁혔다. 임의 sleep이나 TUI 구현 변경은 없다. 최종 Head CI 전체 테스트 결과도 별도 확인한다.
- 초기 Head CI에서 Android WS test의 client onOpen 완료와 MockWebServer peer onOpen 완료 사이 경쟁 조건으로 null peer close가 발견됐다. peer의 실제 onOpen을 latch로 확인한 뒤 close하도록 테스트만 수정했고 대상 Gradle test 통과. native 제품 코드는 변경하지 않았다.
- 실제 HTTPS fixture `scripts/cli-platform-session-fixture.mts --conversation` 및 `--vscode`/`--desktop`: 별도 빌드 CLI/RPC/Electron main·preload·renderer, 일회용 OS keychain, 실제 P-256 proof 검증, >64KiB 메시지 두 개의 sparse 커서(2/4), 표시 projection, 다른 프로세스 rotation과 다음 GET의 새 token, Ctrl+C/unwatch·요청 중단 통과. Desktop 실제 컴포넌트의 읽기·폴링·본문 표시·중단 후 제거와 screenshot을 확인했다. 하네스는 local pre-wire busy만 최대 10회×100ms 대기하며 HTTP/journal/transport 실패는 재시도하지 않는다. **ACTIVE Gateway 성공 증거는 아니다.**
- 실제 Compose `--cli --vscode --desktop --native-messages`: 임시 계정·기기 등록/신뢰 브라우저 승인 → login503 → durable login_pending → 각 conversation read/poll auth_required → 명시적 로컬 복구·DB/키체인 정리 통과. enrollment 모드를 유지했다. 기본 인프라/core/gateway와 workflow/frontend 프로필, HTTPS3443을 사용했다.
- `.env`의 서비스별 override, clean source/container HEAD/ref와 `/app` mount 확인: 모두 `feat/cross-platform-session`. Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `ee007d09c0f5548d6a069648a655ef70ecfcf3db`, Frontend `7944120b99e8909f09100c802912839a19359589`. 실제 Gateway `PLATFORM_SESSION_MODE=enrollment`을 확인했다. DEX 클라이언트 검증은 이 하위 브랜치의 빌드/소스를 사용한다.
- SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`/runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` snapshot marker와 실제 `/opt/xgen-local-sdk`/`/opt/xgen-local-runtime` import 확인. 배포 및 환경변수 변경은 없다.
- 증거: `/tmp/cross-sync-native-messages-*.log`, `/tmp/cross-sync-native-conversation-desktop-ui.png`. 최종 Head CI/review를 확인한 뒤 하위 PR만 통합한다. 실제 ACTIVE/takeover·Mobile 물리 기기·전 표면 송수신 검증은 후속 관문으로 유지한다.

### 잔여 추정치 (설계 11절)

| Phase | 남은 비율 | 주요 잔여 |
|---|---:|---|
| 0 계약·보안 | 22% | 운영 계약·최종 보안 관문·통합 검증 |
| 1 Platform Session | 5% | 실제 ACTIVE/takeover·Mobile 실기기/UI |
| 2 Canonical Agent Session | 18% | CLI/VSCode/Desktop native WS·기존 채팅 송신 이행·실서버 양성 검증 |
| 3 Global Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 개인 설정 | 95% | 동기화·충돌 처리 |
| 5 개인 시크릿·Claude/Codex | 90% | 개인 시크릿 전달·외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

These are remaining-work estimates, not coverage or delivery dates. CLI, VSCode and Desktop now read and explicitly poll bounded canonical conversation snapshots, execution events and sparse linked terminal messages. The common OS-vault engine validates exact read routes, scoped DPoP and bounded UTF8 streams; cancellation and credential loss cancel unread bodies. RPC/UI boundaries project display fields, stop stale watch acknowledgements by exact ID, and clear transcripts on scope/connection changes. Actual HTTPS/software-key OS-keychain fixtures and Electron UI verify positive client contracts; enrollment-mode Compose verifies rejection and recovery on the actual integration branches. The CLI suite passes 153/153 after its existing history assertion waits for both question and answer instead of an intermediate frame. Final Head CI remains a gate. ACTIVE Gateway, physical Mobile, other native WebSocket and chat-send integration remain pending. SDK/runtime stay as unreleased Workflow overlays and PR90 remains Draft.

## CLI·VSCode·Desktop 네이티브 실시간 연결 (2026-10-01)

작업 브랜치 `feat/cross-platform-native-ws`, 기준 통합 SHA `ec516b8d655add02f83754ffa122fbce58438832`, 하위 [PR145](https://github.com/PlateerLab/xgen-dex-core/pull/145) → `feat/cross-platform-session`. 상위 [PR90](https://github.com/PlateerLab/xgen-dex-core/pull/90) → main은 Draft 유지.

```text
CLI session watch-live
VSCode native/watch-live → 읽기 전용 대화 문서
Desktop 공유 대화 실시간 연결 → main의 계정/origin·OS CA
  → ready OS vault/journal/access 확인 → GET DPoP (query-free HTTPS htu)
  → WSS /api/agentflow/agent-sessions/{id}/events?after_seq=N
  → 연속 이벤트 검증 → bounded HTTP 대화 복구 → 표시 projection
  → 조용한 연결도 vault/focus 재확인 → 새 generation이면 소켓 교체
  → 취소·인증 상실·기기/계정 변경 → 실제 close 확인 후 종료
```

### 구현과 경계

- 공통 엔진에 receive-only native WSS 전송과 `NativeAgentLiveWatcher`를 추가했다. browser ticket을 사용하지 않고 OS vault의 Platform access와 실제 P-256 GET DPoP로 인증한다. 전송은 canonical HTTPS origin/lowercase UUID/safe cursor/JWT·query-free proof 경로를 확인하며 Cookie/Origin/subprotocol/redirect/compression/앱 데이터 송신을 제공하지 않는다. 인증서/hostname 검증은 항상 활성화하며 기본 Node 신뢰와 Desktop main의 시스템 CA를 사용한다.
- 프레임 1MiB, 대기 큐 8프레임/2MiB, 단일 pending receive, handshake 10초로 제한한다. 신뢰된 호스트 CA provider는 최대 2048개·각128KiB·전체16MiB이며 renderer/RPC로 전달하지 않는다. 정상 OS 인증서 목록이 64개를 넘는 실제 Electron 실패를 발견해 수정하고 TLS 회귀로 검증했다.
- 이벤트는 HTTP 복구를 깨우는 용도이며 메시지/화면의 권위는 기존 bounded HTTP parser/recovery에 둔다. 빈·중복 프레임은 HTTP 주기를 앞당기지 않고 backlog를 HTTP로 비운 뒤 연결한다. quiet timer는 기본2초, CLI interval은200..60000ms다. 매 단계 새 vault를 읽고 대기 중 키체인 잠금을 보유하지 않는다.
- 같은 sid의 token generation 변경은 두 커서를 보존하고 이전 소켓을 닫는다. 동일 host의 로그인 journal·refresh·logout·로컬 삭제는 자격증명 변경 전에 소켓을 즉시 닫으며 다른 프로세스의 변경은 다음 주기에서 재확인한다. account/sid 전환과 HTTP recovered 결과는 이전 연결을 폐기하고 새 after_seq로 연결한다. 취소된 늦은 open/frame은 표시하지 않는다.
- upgrade/peer cursor conflict는 snapshot으로 한 번 복구하고, 이전 소켓 인증 실패는 새 자격증명 발급 없이 vault를 한 번 재확인한다. 같은 scope/sid/sequence에서 반복하면 중단한다. WSS 전송 실패도 진행 없는 세 번 재시도 뒤 중단해 HTTP 성공마다 실패 예산이 초기화되는 반복 연결을 막았다. 정상 이벤트·HTTP cursor 진행 또는 범위 변경 때 예산을 초기화한다.
- 같은 프로세스의 factory 간 origin latch를 공유하며 실제 underlying close 전에는 해제하지 않는다. 명시적 close는 큐를 즉시 비우고 ACK 없는 peer를1초 뒤 terminate하되 실제 close event까지 기다린다. 실패/취소된 handshake도 실제 close 뒤 거절하며 watcher 종료는 진행 중 close를 기다린다.
- RPC `canonicalLive:true`와 별도 `native/watch-live`를 추가했다. CLI JSONL/SIGINT, VSCode capability gate·가상 문서, Desktop main-only TLS와 실시간 연결·중단 UI를 연결했다. 기존 HTTP 읽기/폴링은 선택할 수 있다. ACK 전 account/interval 검증, pending 취소, exact watch ID의 stale ACK 정리, 표시 필드 projection과 stopped/reset 본문 삭제를 유지했다.

### 검증과 실행 환경

- 제품 코드 검증 SHA `29987932779c9633dc3f64065ce565b940fe35de`. 최종 엔진 전체 **191 pass / 2 OS 조건 skip**, CLI **153/153**, VSCode **31/31**, Desktop **531/531** 통과. native transport 실제 TLS 대상 **13/13**, live/session 후속 회귀 **42/42** 통과. engine/RPC/CLI/VSCode/Desktop 타입 검사, 계약 검사와 CLI/VSCode/Desktop 빌드, 두 opt-in harness strict 타입 검사 통과. 최종 Head CI 결과는 PR145에서 확인한 뒤 병합한다.
- 실제 HTTPS fixture `scripts/cli-platform-session-fixture.mts --live` 및 `--vscode --live`/`--desktop --live`: 빌드된 CLI/RPC/Electron, 일회용 OS keychain, 실제 P-256 proof/ath와 query-free htu, 이벤트로 HTTP 갱신, >64KiB 메시지와 sparse 커서, 다른 프로세스 rotation 후 새 WSS 인증, Ctrl+C/unwatch·actual close 통과. 실제 Electron 컴포넌트의 실시간 연결/메시지 표시/중단 후 본문 제거와 screenshot을 확인했다. **실제 ACTIVE Gateway 성공 증거는 아니다.**
- 실제 Compose `--cli --vscode --desktop --native-ws`: 일회용 계정/기기 등록 → 신뢰 브라우저 승인 → enrollment login503과 login_pending journal → HTTP read/poll 및 native live auth_required → 명시적 로컬 복구·DB/키체인 정리 통과. 기본 인프라/core/gateway와 workflow/frontend 프로필, HTTPS3443을 사용하며 enrollment를 유지했다.
- `.env`의 서비스별 override와 clean source/container branch/HEAD·`/app` mount 확인: Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `ee007d09c0f5548d6a069648a655ef70ecfcf3db`, Frontend `7944120b99e8909f09100c802912839a19359589`, 모두 `feat/cross-platform-session`. 실제 Gateway `PLATFORM_SESSION_MODE=enrollment`을 읽어 확인했다. DEX는 이 하위 브랜치의 제품 코드 빌드를 사용한다.
- Workflow overlay의 SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540`/runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` marker 및 실제 `/opt/xgen-local-sdk`/`/opt/xgen-local-runtime` import를 재확인했다. 패키지 배포·환경변수 추가/변경/삭제는 없다.
- 증거: `/tmp/cross-sync-native-ws-{engine-tests,cli-tests,vscode-tests,desktop-tests,cli-fixture,vscode-fixture,desktop-fixture,compose,environment,overlay}.log`, `/tmp/cross-sync-native-ws-desktop-ui.png`. 실제 ACTIVE/takeover, Mobile 실기기와 기존 채팅 송신 이행은 후속 관문이다.

### 잔여 추정치 (설계 11절)

| Phase | 남은 비율 | 주요 잔여 |
|---|---:|---|
| 0 계약·보안 | 22% | 운영 계약·최종 보안 관문·통합 검증 |
| 1 Platform Session | 5% | 실제 ACTIVE/takeover·Mobile 실기기/UI |
| 2 Canonical Agent Session | 16% | 기존 채팅 송신 이행·실서버 양성 검증 |
| 3 Global Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 개인 설정 | 95% | 동기화·충돌 처리 |
| 5 개인 시크릿·Claude/Codex | 90% | 개인 시크릿 전달·외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

These are remaining-work estimates, not coverage or delivery dates. CLI, VSCode and Desktop now use receive-only native GET DPoP WSS to wake authoritative HTTP conversation recovery, with periodic scoped vault/focus checks. Same-session token rotation preserves cursors and replaces the socket; local credential mutations immediately stop existing sockets. Recovered HTTP snapshots replace old streams, no-progress socket failures have finite budgets, and cancellation awaits actual teardown. Frame/queue/CA bounds, default/system TLS and a shared origin latch constrain the transport. Real HTTPS/software-key OS-keychain and Electron UI fixtures pass, while integration-branch enrollment-mode Compose verifies rejection and recovery. Actual ACTIVE/takeover, physical Mobile and migration of existing chat sends remain gates. SDK/runtime remain unreleased Workflow overlays; PR90 stays Draft.

## CLI Canonical 턴 송신·공통 RPC 기반 (2026-10-01)

작업 브랜치 `feat/cross-platform-cli-canonical-turns`, 기준 통합 SHA `52a6efc5f7b81b9ea9ab8fc54581f9cc36617f4a`, 하위 [PR146](https://github.com/PlateerLab/xgen-dex-core/pull/146) → `feat/cross-platform-session`. 상위 [PR90](https://github.com/PlateerLab/xgen-dex-core/pull/90) → main은 Draft 유지.

```text
dex chat --canonical (기존 server-issued session ID + snapshot version + stable key)
  → UTF-8 메시지 그대로 검증·복사 → scoped ready OS vault
  → POST DPoP /api/agentflow/agent-sessions/{id}/turns
  → bounded 202 접수 ACK (AI 완료 아님) → 별도 conversation/watch-live에서 확인
  → 응답 유실/dispatch 후 취소: unknown + 안전한 요청 식별 정보
  → 사용자가 동일 메시지·원래 버전·key로 다시 실행 → 서버 replay ACK

native/submit-turn, native/stop-turn → 공통 native host (VSCode/Desktop 기반)
  → stop ACK는 requested:true → 실제 종료는 대화 이벤트/메시지로 확인
```

### 구현과 경계

- `AgentSessionMutationClient`는 정확한 HTTPS origin과 lowercase UUID, safe version, printable ASCII idempotency key 1..128, 선택적 origin ID 1..128 codepoint를 검증한다. 메시지는 정상 Unicode·UTF-8 최대262144바이트이며, async credential 조회 전에 primitive body를 복사·직렬화한다. `--stdin`은 BOM·개행·끝 공백까지 보존한다. 임의의 origin ID를 실행마다 생성하지 않아 명시적 재시도의 요청 해시가 바뀌지 않는다.
- OS vault의 ready/현재 계정/access 만료를 확인하고 현재 token·정확한 `/turns` 또는 `/stop` 경로에만 POST proof를 허용한다. 외부 read-only proof callback은 POST를 서명할 수 없다. 네이티브 전송은 정확한 네 헤더, query-free URL, no Cookie/Origin/redirect를 확인하고 async vault check 전에 init/header/body를 복사한다. 키·토큰·비밀번호·메시지는 ACK/오류에 포함하지 않는다.
- ACK는64KiB, fatal UTF-8 및 필드 불변식으로 제한한다. 접수 state version은 원래 expected+1이고 replay에서도 유지한다. fresh ACK는 accepted만 허용하며 stop ACK는 요청한 turn ID·version·requested:true와 일치해야 한다. 추가 서버 필드는 제거한다. redirect/URL 변경은 4xx 판정보다 먼저 확인한다.
- 수신된4xx(408 제외)는 명시적 거절로 처리하며409의 code/current version/turn ID만 allowlist로 노출한다. fetch loss·408·5xx·잘못된 ACK·dispatch 후 취소/timeout은 unknown이다. 자동 재전송·갱신·새 key 생성·legacy fallback을 하지 않는다. abort를 무시하는 fetch와 멈춘 reader도 취소 시 unknown으로 끝내고 늦은 본문/reader를 정리한다. 호스트 요청 제한은10초다.
- `dex chat --canonical`은 기존 chat entry에서 legacy engine 생성 전에 분기한다. `--user-id`, `--session-id`, `--expected-state-version`, `--idempotency-key`와 `--message`/`--stdin` 중 하나가 필수다. `--json`은 안전한 요청 식별 정보와 접수 결과만 출력한다. SIGINT/SIGTERM은 진행 중 HTTP만 취소하며 서버 턴 stop을 의미하지 않는다.
- RPC는 flat `native/submit-turn`/`native/stop-turn`과 `canonicalTurns:true` capability를 추가했다. `mutation` envelope를 사용해 기존 `result`의 session/enrollment 타입을 유지한다. 계정/origin/platform은 기존 host 경계를 따른다. 새 작업은 기존 watch를 중단하므로 소비자는 접수 뒤 별도 watch를 다시 시작해야 한다. VSCode/Desktop 채팅 입력 UI·Mobile 송신 이행, 새 Canonical session 생성, 첨부/로컬 도구/TUI 전환은 후속 작업이다.

### 검증과 실행 환경

- 제품 코드 SHA `b791cbc8d4fbbae5e49067d780615986c24956b7`. 엔진 전체 **201 pass / 2 OS 조건 skip**, protocol **228/228**, CLI **161/161**(RPC 회귀 포함), VSCode **31/31**, Desktop **531/531** 통과. 전체 workspace와 Desktop 타입 검사, 계약 검사, CLI/VSCode/Desktop 빌드 및 opt-in harness strict 타입 검사 통과. 최종 Head CI와 리뷰를 확인한 뒤 하위 PR만 통합한다.
- `scripts/cli-platform-session-fixture.mts --turns` / `--vscode --turns`: 빌드된 별도 CLI/stdio 프로세스와 일회용 OS keychain, 실제 TLS/P-256 POST DPoP·ath, >64KiB 다국어 stdin과 끝 개행 보존, 동일 key 한 번 실행/replay, 다른 메시지 동일 key·stale version409, 서버 접수 후 응답 유실·명시적 원래 body/key/version 복구,401 자동 갱신 없음, RPC stop 요청 바인딩·안전한 ACK/오류를 검증했다. **실제 ACTIVE Gateway 성공 검증은 아니다.**
- `scripts/native-platform-session-compose.mts --cli --vscode --native-turns`: 실제 Gateway enrollment 모드의 일회용 계정·기기 등록/브라우저 승인, login503·login_pending journal, CLI submit/VSCode submit·stop auth_required, Canonical session 미생성·journal 유지·명시적 로컬 복구 및 DB/키체인 정리를 확인했다. 기본 인프라/core/gateway와 workflow/frontend 프로필, HTTPS3443을 사용했다.
- `.env` 서비스별 override·clean source/container HEAD/ref·`/app` mount를 확인했다. Core `c9125cfd2302d28a44512b836b9340439142685e`, Gateway `e2eb9cbe13c2cefc9420b1cfa2e85b115ce71c78`, Workflow `ee007d09c0f5548d6a069648a655ef70ecfcf3db`, Frontend `7944120b99e8909f09100c802912839a19359589`, 모두 `feat/cross-platform-session`. 실제 Gateway `PLATFORM_SESSION_MODE=enrollment` 유지. DEX는 이 하위 브랜치의 제품 코드를 빌드했다.
- Workflow overlay SDK `e4c8f032b7cb69a72a7450791db7bb84dd1e6540` / runtime `ddbd581e013e5c57cfe0819bb7ae8ce565cfaf06` marker 및 `/opt/xgen-local-sdk`·`/opt/xgen-local-runtime` 실제 import를 확인했다. 패키지 배포와 환경변수 추가·변경·삭제는 없다.
- 증거: `/tmp/cross-sync-canonical-turns-{tests,engine-tests,desktop-tests,check,desktop-check,build,desktop-build,contracts,harness-check,cli-fixture,vscode-fixture,compose,environment,overlay}.log`. 실제 ACTIVE/takeover와 Web↔native 실행 성공, UI 송신 및 Mobile 물리 기기 검증은 후속 관문이다.

### 잔여 추정치 (설계 11절)

| Phase | 남은 비율 | 주요 잔여 |
|---|---:|---|
| 0 계약·보안 | 22% | 운영 계약·최종 보안 관문·통합 검증 |
| 1 Platform Session | 5% | 실제 ACTIVE/takeover·Mobile 실기기/UI |
| 2 Canonical Agent Session | 15% | UI 송신·session 생성 연결·실서버 양성 검증 |
| 3 Global Capability Registry | 95% | 등록·검색·lease·호출 경계 |
| 4 비시크릿 개인 설정 | 95% | 동기화·충돌 처리 |
| 5 개인 시크릿·Claude/Codex | 90% | 개인 시크릿 전달·외부 도구 연결 |
| 6 Legacy 제거 | 100% | 새 경로 전체 검증 후 단계적 제거 |

These are remaining-work estimates, not coverage or delivery dates. The existing CLI chat entry now supports explicit Canonical turn submission for an existing server-issued session. Native OS-vault POST DPoP and shared submit/stop RPC validate copied inputs and bounded acknowledgements without retries, refresh or legacy fallback. Lost acknowledgements and post-dispatch cancellation expose an unknown outcome with safe explicit-retry identifiers; stop acknowledgements only confirm a request. Actual HTTPS/software-key OS-keychain CLI/VSCode fixtures verify replay, CAS and loss recovery. Integration-branch enrollment-mode Compose verifies rejection and recovery. ACTIVE Gateway success, session creation and UI/Mobile chat migration remain gates. SDK/runtime stay as unreleased Workflow overlays and PR90 stays Draft.
