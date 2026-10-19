# Desktop native capability presence / PC 잠금·절전 연결 철회

2026-10-19. Desktop canonical 기기 도구의 OS presence 연결을 구현했다.
기존 로그인 자격과 Agent Session 정본, 원격 턴·일반 대화 watcher는 유지한다.

## 상태와 경계

- Electron `app.ready` 뒤 main process가 `lock-screen`/`unlock-screen`, `suspend`/`resume`,
  `user-did-resign-active`/`user-did-become-active`를 구독한다. 잠금·절전·비활성 원인은 독립적이다.
  resume는 잠금을 해제하지 않고 unlock은 비활성을 해제하지 않는다.
- 시작/복귀 시 idle state가 `locked`이면 잠금을 추가한다. `unknown`·probe 실패는 기존 잠금을
  해제할 근거로 삼지 않는다. Electron의 lock/unlock 이벤트는 macOS/Windows, user-active 이벤트는
  macOS에 제공된다. Linux의 화면 잠금을 보편적으로 감지한다고 주장하지 않는다.
  [공식 PowerMonitor 계약](https://www.electronjs.org/docs/latest/api/power-monitor)을 따른다.
- OS 차단이 생기면 현재 target socket·연결 준비·확인·실행 AbortSignal을 닫고,
  capability REST 4종의 진행 중 controller와 관련 proof drain만 기다린다. 정리 중에는 `closing`이다.
  일반 watch/turn/attachment 요청이나 로그인 비밀은 이 경로에서 취소/삭제하지 않는다.
- main gate는 발견/선택/승인 목록/채택/연결/확인을 거절한다. 상태 조회와 명시 해제는 허용한다.
  renderer에는 setter나 계정/플랫폼/origin override를 열지 않는다. 기존 main-frame IPC 검증을 유지한다.
- 연결 소유자 확인과 이전 연결 정리는 await 경계를 가진다. lifecycle epoch를 앞뒤에서 검사하여
  stop 이전에 시작된 요청이 stop 뒤 새 socket을 만들지 못하게 한다. Desktop capability epoch도
  이전 REST/확인 응답이 UI를 복구하지 못하게 한다. 계정 reset은 OS 차단 원인을 지우지 않는다.

## 화면과 실행 결과

초기 화면은 `checking`으로 잠그고 기존 `capability-status`의 trusted main presence를 읽는다.
차단 알림을 받으면 선택 catalog/auth scope·승인 목록·확인 UI를 비우고 새 작업을 막는다.
복귀 후 자동 재연결·재선택·확인·승인 채택·재실행은 없다. 사용자가 **이 PC 연결 → 기기 새로 고침 →
다시 선택**하고 필요한 다음 턴 승인을 명시적으로 채택한다. 이전 epoch의 선택은 서버 계약에 따라 무효다.

허용 송신/실행 중 연결이 끊기면 “일부 실행되었을 수 있음”을 복귀 후에도 표시한다.
AbortSignal 전달·local socket drain은 원격 부작용의 rollback/cleanup 증명이 아니다.
이미 발생한 파일 변경을 되돌렸거나 원격 턴이 취소 완료되었다고 표시하지 않는다.

## 파일과 검증

- DEX `apps/desktop/src/main/native-capability-presence.ts`, `main/native-session.ts`, `main/index.ts`:
  OS 구독, 독립 차단 원인, main gate, 정리 barrier.
- `packages/rpc/src/native-session-host.ts`, `native-capability-host.ts`: 좁은 REST abort/drain,
  target socket stop 및 lifecycle epoch.
- Desktop `native-session-types.ts`, renderer `native-capability-model.ts`, `views/NativeCapabilities.tsx`:
  안전한 presence notice/상태 응답·초기 차단·늦은 응답 무시·복귀/불확실 안내.
  기존 session model은 presence 알림으로 일반 대화를 초기화하지 않는다.
- Desktop 전체 회귀 599/599와 native 관련 engine/RPC/Desktop 선택 회귀를 통과했다.
  선택 회귀는 전체 회귀와 겹치므로 합산하지 않는다. 정확한 최신 개수와 SHA는 검증 기록을 따른다.
- 실제 Electron production React/model·IPC·powerMonitor binder/main gate를 임시 프로필에서 실행했다.
  합성 OS 이벤트로 겹친 차단/확인 제거/우회 거절/명시 복귀/결과 불확실 표시를 검증했다.
  인증·catalog/target 응답은 fixture이며 물리 PC 잠금·절전이나 전체 ACTIVE 수용은 아니다.
- Desktop/RPC typecheck, Desktop build, contracts, diff 검증을 수행했다.
  증거는 작업 폴더 `design/verification/native-presence-2026-10-19`에 있다.

## 완료와 남은 작업

이번 범위는 Desktop presence 구현과 후보 검증이다. 실제 물리 OS 잠금/절전·다른 OS·실 CLI/VSCode
presence 수용은 별도 관문이다. cookie-only browser adapter, 외부 MCP 취소/remote cleanup 증명,
감사 outbox/상태 UI, low-risk/step-up, 운영 Core catalog rollout·Kubernetes chaos/SLO,
개인 설정·시크릿 및 legacy 종료도 남는다. 전체 Phase 완료율로 환산하지 않는다.

새 환경변수·서버 DB schema·SDK/runtime 배포가 없다. Compose의 서버 소스/selector는 이번 Desktop
단위에서 변경하지 않는다. 상위 Draft/보호 기준은 유지하고 하위 PR/MR만 통합한다.

English: Main-process OS presence independently fences lock, suspend and inactive states. Scoped
capability stop preserves credentials and conversation watches, and epoch checks reject stale connects.
Resume requires explicit reconnect and reselection. An interrupted effect remains uncertain; local abort
is not remote cleanup proof. Real Electron synthetic-event verification is separate from physical OS
and end-to-end ACTIVE acceptance.
