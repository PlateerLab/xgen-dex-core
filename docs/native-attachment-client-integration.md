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

## 구현 / Implementation

`AgentSessionAttachmentClient`는 예약·원시 PUT·receipt GET·취소 POST를 제공한다. `NativeHostSession`의 `reserveAttachment`, `uploadAttachment`, `readAttachmentReceipt`, `cancelAttachment`는 호스트가 고정한 HTTPS origin과 계정에서 이 API를 호출한다. 읽기에도 원래 UI의 `expectedAuthScope`를 전달하면 변경된 로그인 소유권을 송신 전에 차단한다. 각 호출의 vault lock은 작업이 정리된 후 해제하며 자동 refresh는 하지 않는다.

The protocol client provides reservation, raw PUT, receipt GET and cancellation POST. Native host methods bind them to its fixed HTTPS origin and account. Supplying the UI's original `expectedAuthScope`, including for reads, rejects changed login ownership before dispatch. Each vault operation releases its lock after settlement and does not refresh automatically.

Desktop HTTPS 전송은 허용된 첨부 content 경로의 `Uint8Array` PUT만 받아 별도 복사본의 길이로 Content-Length를 계산한다. 실제 OS 인증서 검사와 기존 재시도 금지 동작을 사용한다. `native/submit-turn` RPC는 첨부 ID/SHA 참조만 받으며 비동기 watcher 종료 전에 순서를 복사한다. RPC를 통해 로컬 경로나 파일 bytes를 받는 업로드 명령은 아직 제공하지 않는다.

Desktop HTTPS accepts binary `Uint8Array` PUT only on the canonical content route and frames the copied bytes with their exact Content-Length. It retains OS certificate verification and no-retry transport behavior. Turn RPC accepts only ID/SHA references, copied in order before asynchronous watcher shutdown. RPC file picking and byte upload commands are not implemented yet.

## 로컬 검증 / Local verification

- 공통 워크스페이스 `npm run verify`: 타입 검사·빌드 통과, 테스트 831개 중 829개 통과·2개 조건부 skip. / Workspace type checks and builds pass; 829 of 831 tests pass with 2 conditional skips.
- 첨부·턴 프로토콜 124개, native engine 관련 59개, RPC 18개, Desktop 실제 localhost HTTPS 1개 통과. / 124 attachment/turn protocol tests, 59 native engine tests, 18 RPC tests and one real localhost HTTPS test pass.
- 현재 Compose는 `enrollment`이며 실제 ACTIVE 송신·원격 runner 성공을 검증한 결과가 아니다. / Current Compose runs in enrollment mode; these results do not establish actual ACTIVE dispatch or remote runner success.

새 환경변수와 SDK/runtime 배포는 필요하지 않다. / This increment requires no new environment variables or SDK/runtime release.
