# 오디오 런타임을 포함한 macOS 앱

## 지원 범위

기본 앱은 [다운로드 방식](audio-runtime-download.md)을 사용한다. `DEX_BUNDLE_AUDIO=1` 빌드에서만 **macOS ARM64** 앱/DMG에 Python, RNNoise, Silero를 동봉한다. 사용자는 Python·C 컴파일러·개발용 `.venv`를 설치할 필요가 없다. 전처리는 로컬이며 STT는 설정된 XGEN 서버와 로그인이 필요하다.

macOS x64/universal 빌드는 잘못된 ARM64 런타임을 넣지 않도록 중단한다. Windows/Linux 빌드는 기존대로 동작하며 이번 오디오 런타임을 포함하지 않는다. 해당 플랫폼 번들은 별도 구현·검증이 필요하다.

## 빌드

빌드 머신에는 macOS ARM64, Python 3.11(또는 `DEX_BUILD_PYTHON`으로 지정한 호환 Python), C 컴파일러, zstd를 읽는 `tar`, DEX Node 의존성 및 라이브러리 소스가 필요하다.
`DEX_AUDIO_SOURCE`를 생략하면 `xgen-dex-core` 옆의 `xgen-audio-preprecessing`을 사용한다. CI에서는 이 소스를 별도로 준비하고 경로를 지정해야 한다. 소스가 없으면 명확하게 빌드 실패하며, 없는 런타임을 조용히 생략하지 않는다.

```sh
cd /path/to/xgen-dex-core/apps/desktop
npm run build
DEX_BUNDLE_AUDIO=1 DEX_AUDIO_SOURCE=/path/to/xgen-audio-preprecessing \
  ./node_modules/.bin/electron-builder --mac --arm64 --publish never
```

`build/afterPack.cjs`가 서명 전에 `prepare-audio-runtime.py`를 실행한다.

- Python Build Standalone 3.11.16/20260901 전체 아카이브를 내려받아 고정 SHA-256을 검사한다. 전체 아카이브의 네이티브 의존성 라이선스도 보존한다.
- `python/install`을 앱 리소스에 복사하고 오디오 패키지를 비-editable로 설치한다. 개발용 Python이나 가상환경을 복사하지 않는다.
- `audio-runtime-constraints.txt` 버전으로 Python 의존성을 설치한다. 별도 소스의 RNNoise 빌드 스크립트는 소스·모델 해시를 확인한다.
- RNNoise를 빌드해 런타임에 복사하고 네 가지 소음 제거/VAD 조합을 점검한다. 설치·점검 실패는 패키징을 중단시킨다.
- 앱 밖을 가리키는 심볼릭 링크가 있으면 실패한다. macOS 서명은 기존 afterPack/electron-builder 절차를 사용한다.

## 설치 파일 내부

```text
XGen-Dex.app/Contents/Resources/audio-preprocessing/
  python/                      독립 Python + 패키지 + Silero 모델
  lib/librnnoise.dylib          RNNoise
  licenses/audio/              RNNoise 및 soxr 고지
  licenses/models/             Silero 모델 고지
  licenses/python/             Python 및 네이티브 의존성 고지
  THIRD_PARTY_NOTICES.txt       고지 파일 위치 안내
  manifest.json                플랫폼·Python 출처·설치 패키지 버전
```

NumPy/ONNX Runtime/soxr 등 Python wheel의 고지는 `python/lib/python3.11/site-packages/*.dist-info/`에 유지한다. RNNoise 라이선스 원문은 `licenses/audio/RNNoise-COPYING.txt`다.
Finder에서 앱의 **패키지 내용 보기**로 확인할 수 있다. 앱 리소스는 `app.asar` 밖에 있어 호환 라이브러리 교체가 가능하다.

실행 시 `audioRuntime()`은 이 내장 Python과 RNNoise를 선택한다. 워커의 `-I -B` 옵션으로 사용자 Python 경로의 영향을 차단하고 앱 내부에 bytecode를 쓰지 않는다.
명시적인 `DEX_AUDIO_ROOT`/`DEX_AUDIO_PYTHON`/`XGEN_RNNOISE_LIBRARY` 개발자 override는 유지한다. 일반 설치 사용자는 설정할 필요가 없다.

## 실제 산출물 검증

공개 샘플을 XGEN에 보내는 선택적 검사다. 기존 일반 DEX 프로필의 OS 키체인 로그인을 참조하되 토큰 파일을 복사하지 않는다. 임시 설정/dataRoot를 사용하고 기존 앱의 설정을 바꾸지 않는다. 프로필이 임시 경로가 아니면 검사 시작 전에 중단한다.

```sh
DEX_PACKAGED_APP=/path/to/XGen-Dex.app \
DEX_AUDIO_FIXTURE=/path/to/xgen-audio-preprecessing/tests/fixtures/speech.wav \
DEX_AUDIO_REAL_STT=1 \
node verify/packaged-audio-smoke.cjs
```

2026-10-19 결과 (현재 작업 트리, 앱 버전 1.96.0):

- 실제 DMG 생성, 읽기 전용 마운트 및 `codesign --verify --deep --strict` 통과.
- DMG 내부 RNNoise 라이선스가 소스의 원문과 바이트 단위로 일치. Python 의존성 라이선스 19개 및 wheel metadata 9개 포함 확인.
- DMG 안의 앱을 직접 실행. `app.isPackaged=true`, `process.resourcesPath`가 DMG 앱 내부임을 확인.
- 개발용 Python 환경변수를 제거하고 PATH를 시스템 디렉터리로 제한. 실제 preload/main IPC를 통해 번들 전처리 실행 성공.
- 소음 제거 OFF/ON × Silero OFF/ON의 네 조합에서 PCM 길이 보존. ON에서 시작·종료 이벤트, OFF에서 이벤트 없음 확인.
- **WebSocket STT 4회 + 파일 STT 4회**, 모두 “안녕하세요. 오늘 날씨가 정말 좋네요.”로 일치.
- 오디오 관련 테스트 11개·패키징 테스트 5개·타입 검사·앱 빌드 통과.

이 검사는 실제 앱의 전처리/STT IPC를 호출하지만 마이크 장치 대신 WAV 샘플을 주입한다. renderer `voice-loop` 구간 판단, 물리 마이크·AEC·COEX 정확도·새 OS에서의 설치는 별도 검증 대상이다.

이번 DMG는 ad-hoc 서명이다. Apple Developer ID 서명·공증 및 공개 릴리스 게시를 수행하지 않았다. Gatekeeper의 일반 사용자 설치 경험까지 검증한 결과는 아니다.
