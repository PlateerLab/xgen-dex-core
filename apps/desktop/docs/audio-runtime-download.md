# 음성 전처리 다운로드 및 업데이트

## 사용자 화면

음성 설정의 `음성 전처리` 행은 미설치 시 `다운로드`, 설치 후에는 설치 버전과 `업데이트 확인`을 표시한다. 새 버전이 확인되면 `업데이트 하기`로 바뀐다. 설치된 경우에만 Silero 발화 감지와 소음 제거를 표시하며, 토글의 기존 설정을 보존한다. 처음 설치한 사용자의 기본값은 OFF다.

별도 업데이트 탭과 전처리 전체 토글은 없다. 행의 상하 여백은 기존 field-row의 12px다. VAD·소음 제거 사이에는 내부 구분선을 두지 않는다.

## 배포 계약

- 저장소: `PlateerLab/xgen-audio-preprecessing`
- GitHub 릴리스 태그: `audio-runtime-v1` (JSONL worker 프로토콜 v1)
- 파일명: `xgen-audio-runtime-<semver>-darwin-arm64.tar.gz`
- 현재 지원: macOS Apple Silicon. 다른 플랫폼은 다운로드 버튼을 비활성화하고 지원 범위를 표시한다.
- 릴리스는 기존 앱의 `latest`를 바꾸지 않도록 **prerelease 및 latest=false**로 게시한다. 코드는 지정 태그 API를 사용하므로 prerelease 파일도 확인할 수 있다.
- GitHub API의 asset `digest`에 SHA-256이 있어야 한다. 출처 URL, 플랫폼, 버전, 크기 및 digest가 유효한 파일 중 최신 버전을 선택한다.
- 프로토콜 호환성이 깨지면 새 태그/클라이언트 계약이 필요하다. 앱과 동일한 버전 번호라는 의미는 아니다.

현재 별도 라이브러리의 공개 배포 라이선스와 릴리스 게시 승인은 아직 확정되지 않았다. 자동 공개 게시하지 않는다.

## 패키징

기본 DEX 앱 빌드에는 전처리 런타임을 포함하지 않는다. 종전 동봉 빌드가 필요하면 `DEX_BUNDLE_AUDIO=1`을 지정한다. 라이브러리 소스에서 새 런타임을 만드는 방법은 `audio-packaging.md`를 참고한다.

```sh
python3.11 build/prepare-audio-runtime.py --source /path/to/xgen-audio-preprecessing --output /new/runtime
node build/package-audio-runtime.cjs /new/runtime 0.1.1 release/audio-runtime
```

준비된 아카이브는 Python, RNNoise, Silero, Python wheel 및 모델 라이선스 고지를 포함한다. 압축 파일과 `.sha256`을 함께 릴리스에 첨부한다. 게시 시 같은 버전 파일을 교체하지 않고 버전을 올린다.

## 설치

`app.getPath('userData')/audio-runtimes` 아래 임시 다운로드 → SHA-256/크기 확인 → 경로·링크 검사 → 압축 해제 → 라이선스 파일 확인 → RNNoise+Silero 실제 실행 검사 → 버전 폴더 이동 → `current.json` 원자적 교체 순서다.

실패하면 기존 활성 버전을 유지한다. 이전 폴더는 진행 중인 캡처가 계속 사용할 수 있도록 보존한다. 실행 중인 캡처에는 기존 워커가 유지되고 다음 캡처부터 새 버전을 사용한다. 개발자 환경변수 override는 그대로 지원한다. 최대 다운로드 512MiB, 해제된 파일 합계 2GiB, 100,000개 항목 제한이 있다.

## 검증 (2026-10-19)

- 오디오/설치 관련 15개 테스트 통과. GitHub 메타데이터 검증, 잘못된 압축 경로·링크 거부, SHA 불일치 시 활성화 포인터 보존, 실제 런타임 신규 설치/업데이트 포함.
- 설치 테스트는 GitHub 응답을 배포용 실제 아카이브로 대체한 transport fixture다. 공개 GitHub 다운로드 성공 증거는 아니다.
- 번들이 없는 실제 macOS 앱에 설치기 산출물을 임시 사용자 프로필로 주입하고 실제 preload/main IPC로 처리했다.
- 소음 제거 OFF/ON × VAD OFF/ON 네 조합의 실제 XGEN WebSocket STT 4회 + 파일 STT 4회 모두 “안녕하세요. 오늘 날씨가 정말 좋네요.”로 일치.
- VAD ON에서 발화 시작·종료 각각 1회, OFF에서 0회. 모든 조합에서 PCM 길이 유지.
- 기존 사용자 설정/키체인 파일을 복제하지 않고 임시 프로필과 기존 OS 키체인 인증을 사용했다.
- 추가 패키징 테스트 5개, 타입 검사와 앱 빌드 통과. 실제 VoiceSettings 컴포넌트를 mock IPC로 렌더링하여 다운로드 후 하위 설정 표시, 토글 변경, 업데이트 버튼 전환도 확인했다. 실제 마이크, COEX 소음, Windows/Linux, 공개 GitHub 설치는 검증하지 않았다.

검증 명령:

```sh
DEX_AUDIO_TEST_ARCHIVE="$PWD/release/audio-runtime/xgen-audio-runtime-0.1.1-darwin-arm64.tar.gz" node --import tsx --test test/audio-runtime-manager.test.ts test/audio-preprocessor.test.ts test/processed-capture.test.ts
DEX_PACKAGED_APP=/path/to/XGen-Dex.app DEX_AUDIO_INSTALLED_RUNTIME=/path/to/installer-output/runtime DEX_AUDIO_FIXTURE=/path/to/speech.wav DEX_AUDIO_REAL_STT=1 node verify/packaged-audio-smoke.cjs
```

### 최종 앱 재검증 추가 기록

최종 앱으로 네 조합을 다시 검사하던 중 마지막 조합에서 빈 STT 결과 1회가 발생했다. 해당 실패 당시 결과 전체를 출력하지 않아 WebSocket/파일 중 어느 응답이 비었는지는 확정하지 못했다. 이후 검사기는 assertion 전에 전체 결과를 기록하도록 수정했다. 동일 최종 앱의 VAD ON + 소음 제거 ON만 분리해 재검사한 결과 WebSocket·파일 STT 모두 정확한 문장으로 통과했다. 간헐적 빈 응답의 원인은 미확정이며, 완전한 무오류 결과로 보지 않는다. 기존 스트림의 종료 대기 2.5초는 조사 후보일 뿐 원인으로 확정하거나 수정하지 않았다.
