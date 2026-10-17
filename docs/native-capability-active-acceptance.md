# Native capability ACTIVE acceptance / 네이티브 실제 ACTIVE 수용

2026-10-17. 실제 공개 HTTPS 인증·네이티브 기기 선택·현장 확인·SDK 지연 승인·fresh turn을 검증한다.
기존 통합 브랜치에서 독립 하위 브랜치/Draft로 관리한다. 보호 기준과 상위 Draft는 유지한다.

기존 복제 DB/전용 Redis의 실제 peer와 공개 topology를 먼저 검사한다. 기존 사용자 trust를 초기화하지
않고 공개 signup/admin 승인 API로 별도 테스트 계정을 만든다. 기존 사용자·기기·키체인 범위는 건드리지 않는다.
실제 native protocol/engine/RPC·OS keychain·Electron renderer와 기존 cluster·SDK approval ledger·
Geny/runtime을 사용한다. 외부 LLM 응답만 고정 model fixture로 제한한다. marker 전용 임시경로만 실행한다.

완료 조건: 현재 source SHA·ACTIVE readiness, 명시 선택·현장 거절/허용1회, pending 승인 무실행,
완료 source의 승인 채택→새 turn1회 실행·원래 만료/중복 방지, 감사/marker 관측 및 정리.
원격 CI·정확한 병합 SHA·실제 통과 범위·미통과/잔여는 실행 뒤 갱신한다.

English: live public authentication and real native/backend/approval execution are required. Only model
selection is deterministic. Disposable account state is isolated from existing users; no authority overrides.
