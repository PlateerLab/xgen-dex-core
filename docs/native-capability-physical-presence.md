# Physical OS presence acceptance / 실제 PC 잠금·절전 수용

2026-10-19. 기존 Desktop canonical presence 구현을 실제 macOS 잠금·절전 이벤트와 복귀 뒤
명시 연결/재선택으로 검증한다. 합성 이벤트를 물리 검증으로 집계하지 않는다.

검증 창과 secret-free event 기록을 준비한 뒤 사용자가 PC를 잠그고 직접 잠금 해제한다.
별도의 절전/깨우기에서도 실제 suspend/resume와 잠금 원인의 독립 해제를 확인한다.
기존 연결/확인은 종료되고 자동 재연결/권한 재사용/재실행은 없어야 한다.
새 연결/선택 후 새 요청만 현장 확인으로 실행하며, 기존 실행의 결과 불확실 상태를 보존한다.

발견한 문제는 같은 하위 브랜치에서 회귀와 함께 수정한다. DEX/Infra 하위 PR/MR은
기존 비보호 통합을 대상으로 하고 상위 Draft와 SDK/runtime 미배포·보호 브랜치를 유지한다.
환경변수/schema 추가는 예정하지 않는다. 실제 결과·정리·잔여/제한은 검증 후 기록한다.

English: Observe physical macOS events separately from synthetic fixtures. Resume must not reconnect,
reuse authority or replay effects automatically. Prepare before the user locks and wakes the machine.
