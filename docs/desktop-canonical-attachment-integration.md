# Desktop Canonical 첨부 연결 / Desktop canonical attachment integration

## 작업 경계 / Scope

메인 프로세스의 명시적 파일 선택을 Canonical native host 첨부 API에 연결한다. renderer에는 로컬 경로나 원본 bytes를 전달하지 않고, 계정·origin·로그인 소유권·Agent Session·workflow에 묶인 불투명 선택 핸들과 표시 메타데이터만 제공한다.

Connect explicit main-process file selection to canonical native attachment APIs. The renderer receives opaque selection handles and display metadata bound to account, origin, login ownership, Agent Session and workflow, never local paths or raw file bytes.

- 파일 읽기와 메모리 사용을 최대 10개·합계 100 MiB로 제한한다. / Bound file reads and retained bytes to ten files and 100 MiB in total.
- 예약·PUT·receipt 복구·취소는 기존 HTTPS 및 DPoP 경계를 유지한다. / Preserve the existing HTTPS and DPoP boundaries for reservation, PUT, receipt recovery and cancellation.
- 턴 원문의 CAS·idempotency key·첨부 순서를 보존하고 결과 불명 시 원래 요청만 재시도한다. / Preserve original CAS, idempotency key and attachment ordering for explicit uncertain-outcome retries.
- 실제 ACTIVE 서버·원격 runner·다른 플랫폼 파일 선택은 별도 완료 관문이다. / Actual ACTIVE server, remote runner and other platform file pickers remain separate completion gates.

검증 결과는 구현 후 기록한다. 새 환경변수와 패키지 배포는 계획하지 않는다. / Record results after implementation. No new environment variables or package releases are planned.
