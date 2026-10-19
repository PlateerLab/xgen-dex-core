# Physical OS presence acceptance / 실제 PC 잠금·절전 수용

2026-10-19. macOS15.7.3 / Electron43.4.1의 실제 OS 이벤트와 공개 HTTPS ACTIVE에서
잠금 해제 오류를 재현·수정하고 절전/복귀·명시 재연결·새 요청 실행을 검증했다.

## 실제 관측

| 단계 | 관측과 판정 |
|---|---|
| 최초 잠금/해제 | 실제 lock-screen 01:34:28Z → unlock-screen 01:34:39Z. 즉시 idle probe가 stale locked를 반환해 available true→false로 되돌아가고 15초 뒤에도 버튼이 차단됨. 수정 전 결함 증거 |
| 수정 후 잠금/해제 | 실제 lock-screen 01:38:51Z → unlock-screen 01:39:03Z → 약250ms 후 available. main 상태는 closed, UI 재연결 가능. 자동 연결 없음 |
| 연결 중 실제 절전 | 새 ready/선택 01:39:53Z → pmset sleepnow → suspend 01:40:14.890Z → lock-screen 01:40:15.117Z → resume 01:40:17.737Z → unlock-screen 01:40:18.006Z |
| 독립 차단 | suspend 후 suspended, resume 후에도 locked, fresh OS 관측 뒤 약258ms 후 available. 복귀 뒤 main connection closed·서버 catalog capabilities=[]·effect0. 자동 재연결/실행 없음 |
| 단독 활성 연결 잠금 | 별도 계정15의 authoritative ready 01:47:37Z → 실제 lock-screen 01:48:38.842Z(연결 후62초, 기한 만료 전) → unlock-screen 01:48:50.381Z → 약252ms 후 available. main closed·server catalog=[]·effect0·자동 연결 없음. 명시 연결 후 ready |
| 명시 복귀 | production UI의 이 PC 연결 → 기기/승인 새로 고침 → 선택 저장 → 별도 새 턴 → exact args 현장 허용. 임시 폴더 WriteFile append exact1, 턴 completed, durable admitted→completed |
| 정리 | 정확한 native origin/user/platform logout·OS key/vault 삭제, 임시 폴더/창 종료. 테스트 계정11~16 status9·non-admin. 모델 fixture 복원. 기존 사용자 trust/원본 앱 DB는 미변경 |

처음 두 수동 잠금은 각각 target의 약90초 연결 기한이 먼저 만료했다. 따라서 lock/unlock 이벤트와
해제 오류·복구의 증거로만 판정하며 **활성 socket을 잠금으로 끊은 증거로 합산하지 않는다**.
절전 수용은 별도의 authoritative ready checkpoint 후21초에 시작했고 그 사이 failed가 없었다.
OS suspend와 lock-screen이 함께 발생했다. 이어 별도 계정/세션에서 활성 연결만 둔 단독 화면잠금을
추가 실행했다. authoritative ready 뒤 만료 전 lock을 확인하고 그 사이 failed가 없음을 대조했다.
사용자가 필요 시 직접 연결을 누르고 대기 상태를 확인한 직후 잠그는 절차로 준비 대기와 기한을 분리했다.

## 수정 계약

`unlock-screen`에서 locked를 먼저 해제하지 않는다. main에서 fresh OS 상태가 active/idle일 때만
한 번에 clear한다. macOS가 unlock 직후 이전 locked를 반환하면250ms마다 최대48회/12초 관측한다.
unknown/예외는 잠금 해제 근거가 아니다. 새 lock·새 unlock·dispose가 generation으로 이전 timer를
무효화한다. 이 관측은 네트워크/효과 재시도가 아니며 자동 reconnect/선택/승인/실행을 하지 않는다.
잠금만 해제하므로 suspended/inactive 원인은 독립적으로 남는다. 12초 동안 상태가 계속 불명확하면
fail closed로 남는다. 새 unlock 또는 앱 재시작 전 회복되지 않을 수 있는 가용성 한계는 남긴다.

## 재현과 파일

- DEX `apps/desktop/verify/native-capability-active.cjs --presence=physical`은 실제 production React·
  preload IPC·NativeSessionRpcHost·TLS/DPoP·OS keychain·default provider를 사용한다.
  실제 powerMonitor에 production binder를 연결하고 event 시각/공개 presence/state만 기록한다.
  이 모드에는 synthetic emit이나 OS 잠금/절전 명령이 없다. `presence`는 현재 main 상태도 읽는다.
  event의 prior_connection은 마지막 알림 cache이며 authoritative 현재 상태와 혼동하지 않는다.
- 사용자는 세 번 실제 잠금/해제를 수행하고 실제 절전 후 직접 깨워 해제했다. sleepnow는
  연결 준비 직후 한 번 실행했으며 전원 설정·예약은 변경하지 않았다.
- 모델 선택과 test-owned 임시 폴더의 사전 연결만 fixture다. 실제 인증/현재 권한·cluster·턴·
  SDK 정책·native 실행·파일 변경·감사는 실제 서비스다. 물리 folder picker 수용은 아니다.
- 격리 clone `xgen_broker_active_20261015`/전용 Redis, 미배포 SDK991ab9e8/runtime38debf54,
  기존 Compose branch/SHA를 preflight77/77로 대조했다. 서버 제품 코드와 env/schema를 바꾸지 않았다.
- 재선택 전의 관찰용 새 턴은 모델 fixture400으로 종료했고 effect0였다. 이를 별도 서버 거절이나
  성공한 도구 실행으로 집계하지 않는다. 재선택 뒤 다른 새 턴에서만 effect1/감사2건을 확인했다.

소유 파일: `apps/desktop/src/main/native-capability-presence.ts`와 Desktop native-session 회귀,
기존 ACTIVE driver의 물리 이벤트 기록/상태/screenshot 확장. env/DB schema/SDK 배포 없음.
작업 폴더의 `design/verification/native-physical-presence-2026-10-19`가 정확한 로그·시각·후보 SHA·
계정 정리·CI·병합 결과의 정본이다. 비밀번호·개인키·access/refresh token·승인 코드를 기록하지 않는다.

## 검증과 남은 작업

Desktop 전체601/601, 잠금 회귀17/17, 기존 native 관련 선택 회귀48/48(수정 전 기준) 및
최신 선택 회귀50/50·Desktop check/build/contracts·Electron 합성 회귀를 검증했다. 개수는 중복 합산하지 않는다.
별도 보안 리뷰와 root diff 검토에서 수정 후 남은 확정 P1/P2는 없다.

물리 테스트는 이 macOS의 짧은 sleep/resume 한 번이다. pmset 로그 조회에는 해당 구간이 없어
독립 kernel power log 증거는 확보하지 못했다. 실제 Electron OS 이벤트/사용자 확인/명령 성공으로
관측한 범위만 주장한다. deep sleep/장시간 절전, 사용자 전환,
다른 OS·CLI/VSCode·다중 client, 실행 도중 실제 잠금에 의한 부분 효과/remote cleanup 증명은 남는다.
기존 browser/MCP adapter, 감사 outbox/UI, low-risk/step-up, Core rollout·Kubernetes chaos/SLO,
개인 설정/시크릿·legacy 종료도 별도 범위다. 전체 Phase 완료율로 환산하지 않는다.

English: Physical macOS unlock reproduced a stale idle-state bug. Bounded main-process observation
fixes it without transient availability or automatic reconnect. A fresh real ACTIVE connection survived
until OS suspend, was closed, and remained disconnected after wake/unlock. Explicit reconnect/reselection
and one on-device confirmation produced exactly one file append and a completed durable audit. Short
sleep on this Mac is separate from other OS, deep sleep and remote cleanup tests. A separate active-connection screen lock also closed the real target and required explicit reconnect.
