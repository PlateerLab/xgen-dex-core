# Native capability UI and delayed approvals

2026-10-17. 작업 상태: 구현·검증 진행 중. 현재 비보호 통합 브랜치에서 하위 브랜치로 작업한다.

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
