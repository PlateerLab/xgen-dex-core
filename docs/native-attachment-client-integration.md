# Native 첨부 클라이언트 연결 / Native attachment client integration

## 연결 경계 / Integration boundary

Native host는 OS 자격증명 저장소의 계정·설치 lock 안에서 현재 ACTIVE 플랫폼 토큰을 읽고, 지정된 첨부 경로 하나에만 DPoP 증명을 발급한다. 파일 경로·저장소 URL·쿠키·legacy Bearer를 업로드 권한으로 사용하지 않는다. 파일 선택 UI는 별도 플랫폼 연결이 필요하다.

The native host reads the current ACTIVE platform credential under the account/install vault lock and issues DPoP only for the selected attachment endpoint. Local paths, storage URLs, cookies and legacy Bearer credentials do not authorize uploads. File selection requires a separate platform UI integration.

## 검증할 계약 / Contract to verify

- 예약 키와 파일 메타데이터는 비동기 인증 전에 복사한다. / Copy reservation keys and file metadata before asynchronous authentication.
- 원시 PUT의 bytes·길이·checksum과 receipt의 scope·메타데이터를 일치시킨다. / Bind raw PUT bytes, length and checksum to the scoped receipt metadata.
- PUT 응답 유실 후 receipt GET을 명시적으로 수행한다. 자동으로 업로드하거나 턴을 반복하지 않는다. / Explicitly read the receipt after a lost PUT response; never retry uploads or turns automatically.
- 턴 재시도는 원래 텍스트·CAS·키·첨부 ID와 SHA 순서를 보존한다. / Preserve original text, CAS, key and ordered attachment IDs/SHA values for turn retries.
- 서버 거절과 결과 미확정을 구분하며 계정·로그인 소유권 변경에서는 송신을 중단한다. / Distinguish server rejection from unknown outcome and block dispatch after account or login ownership changes.

실제 ACTIVE Gateway·플랫폼 파일 선택·원격 runner 검증은 단위 테스트와 별개의 완료 조건이다. / Actual ACTIVE Gateway, platform file selection and remote runner verification remain separate completion gates.
