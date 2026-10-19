# Native capability ACTIVE acceptance / 네이티브 실제 ACTIVE 수용

2026-10-17. 공개 HTTPS의 실제 ACTIVE 인증에서 Desktop 기기 선택·현장 확인·SDK 지연 승인·
명시 채택·새 턴 실행을 통과했다. 패키지 배포와 보호 브랜치 병합은 하지 않는다.

## 실제 통과 범위 / Live result

| 단계 | 관측 |
|---|---|
| 공개 계정·기기 등록 | 복제 DB에 별도 수용 계정 2개, 관리자 발급 코드와 브라우저 키 bootstrap, 실제 native 기기 승인·ACTIVE 로그인 |
| 네이티브 연결·선택 | 실제 TLS WSS·P-256 DPoP·OS keychain·production Electron renderer/IPC/engine/RPC, 기존 cluster의 실제 12개 built-in catalog에서 WriteFile만 선택 |
| 현장 거절 | exact 인자·Agent Session·만료 표시를 검사한 뒤 거절, 임시 파일 없음 |
| 지연 승인 | SDK capability.invoke 정책/결재선으로 pending 요청 생성, 원래 턴 completed, 파일 없음 |
| 승인·채택 | 별도 테스트 승인자가 SDK ledger 승인, 요청자 UI에서 ‘다음 턴에 한 번 사용’ 선택 |
| 새 턴·현장 허용 | 새 running turn과 현재 broker lease로 consume/발급, 현장 허용 전 파일 없음, 허용 후 지정 임시 파일에 한 번만 append |
| 결과·감사 | consumed 상태, marker exact=true/copies=1, 실제 DB 감사 admitted→completed와 source/fresh turn·approval/intent linkage 확인 |
| 만료·실패 | 이전 unknown 결과는 재실행하지 않음. 만료된 승인 intent를 재사용하지 않고 새 요청으로 검증 |
| 정리 | native logout, 해당 origin/user/platform OS key·vault 삭제, 임시 폴더·UI 종료, 테스트 계정 비활성화/관리자 권한 제거, 승인 정책 복원·임시 결재선 비활성화 |

기존 사용자 trust를 초기화하지 않았다. 원본 앱 DB가 아닌 `xgen_broker_active_20261015`와
전용 active-redis의 실제 peer를 사전 확인했다. 감사·테스트 턴 기록은 복제 DB에 보존한다.
최종 관측은 approval6, source `01a14911-b9d5-72a3-b300-cd192831a31c`, fresh
`01a14911-ed96-7e30-9bb9-6879851dada2`다. 별도 임시 폴더의 앞선 approval5 재검증도 동일 결과였다.

## 발견 및 수정 / Corrections

1. 서버 검증 Agent Session ID가 confirm/call에 없어서 실제 로컬 폴더 scope가 연결되지 않던 경로를
   수정했다. native provider는 해당 대화의 기존 폴더 ledger·remote origin·AbortSignal을 사용한다.
   Desktop 공유 대화에 기존 폴더 선택 UI를 연결하고 Desktop/VSCode 확인에 Agent Session을 표시한다.
2. 상태 API가 execution grant를 요구해401을 내던 경로를 분리했다. 서명 principal·현재 계정·trusted
   기기·owned session 검증은 유지하고 grant/parent header 혼입은 거절한다. 실제 실행의 delegation 요구는 유지한다.
3. 단일 Compose에서 multi-Pod 감지 때문에 Redis factory가 None이던 경로를 수정했다. 기존 client 우선,
   SDK 명시 Redis fallback·성공 pool cache·실패 close/1초 backoff, 1초 pub/sub polling을 사용한다.
4. 상태 조회의 계정 키 잠금과 target guard가 경합해 effect 없이 unknown이 되던 경로를 수정했다.
   read-only guard만 50ms 간격 최대240회(12초) 대기한 후 실제 vault·현재 generation을 재검증한다.
   다른 오류/취소/원래 만료는 닫힌다. 네트워크·도구 실행 재시도나 권위 연장은 없다.
5. 실행 중 Core/Workflow/Sandbox의 미배포 SDK가 달랐다. helper가 이미 실행 중인 Core/Sandbox를
   Workflow와 함께 동일 readonly SDK snapshot으로 재생성·검사한다. 중지된 서비스를 임의로 시작하지 않는다.
6. 고정 모델 fixture를 runtime의 정상 ToolSearch 발견→offered exact WriteFile 호출 순서에 맞췄다.
   제품 인증·정책·승인·turn·registry·native execution은 fixture로 대체하지 않는다.

## 재현과 검증 / Reproduction

- Compose 기본 `docker-compose.dev.yml`, workflow/frontend/mcp/documents 및 platform-sandbox 서비스,
  격리 broker-active Redis/model, HTTPS localhost3443. 모델 fixture는 `docker-compose.native-active.yml`로
  active-model에만 연결한다. 기존 Compose selector/actual checkout과 import SHA를 대조한다.
- `local-python-packages.sh start --env-file .env --env-file .local-active.env --env-file .local-broker-active.env`
  는 SDK991ab9e8/runtime38debf54를 readonly 연결한다. Core의 capability.invoke catalog도 실제 검사했다.
- `platform_session_preflight.py --broker --expected-test-database xgen_broker_active_20261015`는
  공개 topology·실제 DB/Redis peer·source/overlay·default canonical Redis factory까지77/77 PASS다.
  preflight 자체는 acceptance_verified=false이며 위 live evidence가 별도 수용 증거다.
- Infra `harness/native_active_control.py`는0600 credential 파일과 fresh PASS guard를 요구하며,
  공개 signup/admin 승인으로 만든 명시 계정 ID만 사용한다. 기존 등록이 있으면 bootstrap을 거절한다.
- DEX `apps/desktop/verify/native-capability-active.cjs`는 production React/IPC·OS vault·default provider를
  실행한다. 실제 폴더 picker 대신 test-owned mkdtemp 폴더 하나를 기존 ledger에 미리 연결한다.
  이 입력 경계와 물리 picker 상호작용을 혼동하지 않는다. exact args·확인 전 effect0를 검사한다.
- Workflow94 tests: 안정 Docker Python3.14.7, 앱 자격 없는 env-i source snapshot, 실제 전용 Redis
  fencing/2-Pod RPC/idle/replay/취소·지연 승인·현재 actor·socket/legacy 회귀. Starlette deprecation1건 유지.
- DEX73 focused tests: native platform/bridge/RPC·실제 임시 provider 폴더·실제3초 계정 잠금·지속 busy와
  인증 실패. Engine typecheck·Desktop build·driver syntax·contracts/diff check 통과. 앞선 focused 수와 중복 합산하지 않는다.
- Infra47 tests: source overlay/helper·Sandbox mapping·default registry preflight·control·model 발견 회귀.
- source/test/감사 projection·정리·CI·정확한 병합 SHA는 작업 폴더
  `design/verification/native-active-2026-10-17/`에 기록한다. 비밀·실제 계정 비밀번호·private key는 넣지 않는다.

## 통합 및 남은 작업 / Integration and remaining work

하위 DEX #211 / Workflow !2225 → 각 `feat/cross-platform-session`, Infra !499 →
`feat/cross-platform-session-compose`. 상위 Draft·main/develop 보호 기준과 SDK/runtime 미배포 원칙을 유지한다.
GitLab Head CI 진단은 지정 code-review 도구의 접근 거절로 확인하지 못한다. 일반 MR gate를 우회하지 않는다.
정확한 최신 Head CI/merge 결과는 위 evidence와 MR/PR을 따른다.

이번 macOS Desktop 실제 ACTIVE 기능 수용은 완료다. 물리 TTY·실 VSCode extension host·다른 OS·
다중 client·OS lock/suspend는 남는다. cookie-only browser socket·외부 MCP 취소/정리·remote cleanup
증명·감사 outbox/상태 UI·low-risk/step-up·운영 policy catalog rollout·Kubernetes chaos/SLO·개인 설정/
시크릿·legacy 종료도 별도 관문이다. 전체 Phase3가 완료됐다는 의미는 아니며 전체 Phase 백분율은 추정하지 않는다.

English: live public ACTIVE authentication, native explicit selection/deny/allow, real SDK delayed approval,
explicit adoption and a fresh turn produced one filesystem effect and a completed durable audit. Only the
LLM choice is deterministic. The test folder was preselected in the real ledger; no physical folder-picker,
other-OS, real VSCode/TTY or production Kubernetes acceptance is claimed.
