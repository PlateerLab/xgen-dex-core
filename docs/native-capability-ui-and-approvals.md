# Native capability UI and delayed approvals

2026-10-17. 구현·후보 검증 완료. 하위 PR #210에서 비보호 통합 브랜치 대상으로 관리한다.

Desktop 공유 대화/기기 설정과 VSCode 명령 UI는 공통 native proof·protocol·RPC를 사용한다.
사용자는 Agent Session별 exact capability를 선택하고, 대상 PC에서는 도구와 정확한 인자를
확인한 후 한 번 허용하거나 거절한다. 계정 변경·취소·화면 종료·만료는 확인 권한을 닫는다.
비밀번호·개인키·access/DPoP는 renderer로 전달하지 않는다. native TLS 검증을 유지한다.

지연 승인은 원래 SDK 승인 ledger와 secret-free intent를 연결한다. 사용자의 명시적인
다음 턴 연결 CAS 이후 새 running turn의 현재 broker 권위로 발급한다. 원래 target/epoch/
schema/선택 version/args SHA/source SID와 원래 만료를 유지하고 consume+issuance를 원자화한다.
승인 worker가 effect를 실행하거나 이전 grant·turn을 재실행하지 않는다.

English: explicit per-session selection and on-device confirmation use the existing native trust
boundary. A delayed approved intent is armed by the requester, then consumed once under a fresh
running turn. It never extends the original deadline or resurrects an old execution grant.

검증 계획: protocol/current auth/TLS·확인 누락/변조/중복·취소·기기 선택 CAS·지연 승인
동시성/회수/만료·실제 Redis/PG·Desktop renderer 및 VSCode UI fixture. 전체 공개 ACTIVE와
실제 Kubernetes/다중 client 수용은 별도 기록한다. SDK/runtime 배포는 하지 않는다.

## 사용 위치 / User surfaces

- Desktop: 공유 Agent 대화와 설정의 기기·세션 → 기기 도구. 현재 Agent Session에서 기기/도구를
  명시 선택·저장/철회하고 승인 상태를 조회해 다음 턴 사용을 연결한다. ‘이 PC 연결’ 뒤
  도착하는 exact 도구/인자를 전체 scroll 영역에서 확인하고 한 번 허용/거절한다.
- VSCode: XGEN Dex 기기·세션 명령에서 현재 Agent Session의 기기 기능 선택/승인 가져오기,
  이 기기 연결/상태/중단. modal은 plain text이며 전체 인자를 표시할 수 없으면 거절만 제공한다.
- CLI: `dex session capabilities|select-capabilities|capability-approvals|adopt-capability-approval|connect-capabilities`.
  모든 명령은 `--profile`, `--user-id`를 명시한다. 목록/선택/승인에는 `--session-id`를,
  쓰기와 승인 목록에는 catalogue에서 얻은 `--auth-scope`를 사용한다. 선택은 JSON 배열
  `--capability-ids`와 UUID 또는 literal `null`인 `--expected-version`을 사용한다.
  adoption은 `--approval-id`, `--expected-version`이 필요하다. connect는 대화형 TTY만
  허용하고 요청마다 기본 거절 prompt를 표시한다. Ctrl+C/만료/계정 변경은 연결을 닫는다.

`auth_scope`는 renderer/CLI 쓰기의 현재 세션 결합용 비밀이 아닌 hash다. bearer·DPoP·키는
IPC/화면/명령 출력으로 전달하지 않는다. HTTP는 protocol, 로컬 실행은 engine, 경계는 RPC에서
공유한다. CLI/VSCode의 전체 인자 표시 한도를 넘으면 긍정 승인을 제공하지 않는다.
Native client는 JS 안전 정수 범위 밖 값을 거절해 signed args와 실제 실행 인자가 달라지지 않게 한다.

## 테스트 / Verification

Protocol4, bridge12, native host2, DPoP6, real loopback TLS16; RPC capability host6; Desktop focused22,
CLI 전체249, VSCode 전체99 통과. workspace/protocol/engine 및 Desktop/CLI/VSCode typecheck,
Desktop·CLI·VSCode build, contracts/diff check를 통과했다. 개수가 겹치는 focused/full 결과는 합산하지 않는다.
실제 Electron의 production React/model을 IPC port fixture로 조작해 선택·adopt·확인·거절·만료·reset,
외부 scope 차단·args의 HTML escape를 확인하고 화면을 검사했다. 실제 Python ASGI/Redis와 native
bridge Echo wire도 확인1회/effect1회와 숫자·한글 exact canonical bytes를 검증했다.

## 남은 수용 / Remaining acceptance

전체 공개 ACTIVE 로그인→SDK 결재→실제 local filesystem/shell 실행, 물리 TTY/실 VSCode host
및 각 OS의 실제 사용 acceptance는 남아 있다. fixture는 실제 사용자 비밀번호·기기 상태를 변경하지 않는다.
기본 native 광고는 기존 built-in LocalToolProvider.catalog만 사용한다. 취소 신호를 지원하지 않는
외부 MCP manager와 browser delegate는 제외했다. 이들 adapter·remote cleanup 완료 증명,
lock/suspend OS 이벤트·브라우저 cookie-only socket·Core SDK policy catalog rollout,
Kubernetes/다중 client chaos/SLO·감사 outbox/상태 UI는 후속이다. 상위 Draft·보호 main은 유지한다.

기본12개 built-in 도구를 실제 카탈로그로 검사했다. description은 서버 계약과 같은 Unicode
1200자 요약으로 광고하며 hello9001bytes로64KiB 안에 들어온다. 실행 인자는 요약하지 않는다.
