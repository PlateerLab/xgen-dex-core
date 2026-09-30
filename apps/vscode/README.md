# XGEN Dex for Visual Studio Code

XGEN Dex Agent를 Visual Studio Code 사이드바에서 사용하는 확장입니다. 확장은 XGEN 서버에
직접 연결하지 않고 `dex serve --stdio --native-platform vscode` 프로세스와 JSON-RPC로만 통신합니다.

## 현재 기능

- 개인·공유 Agent 목록과 검색
- 단일 Workspace에서 Agent 선택 → 채팅 화면 전환
- 채팅 중 Agent 변경
- 도구 실행 상태와 오류 표시
- 응답 취소와 새 대화
- 이전 대화 조회 및 이어서 대화
- 회사/환경 서버 프로필 생성·수정·전환
- 계정·로그인·연결 서버 정보를 확인하는 설정 화면
- 로컬 도구 활성화, 작업 폴더·허용 경로·차단 명령·타임아웃 설정과 브리지 상태 확인
- 비밀번호 로그인, 상태 표시, 로그아웃
- HTTPS 서버의 VSCode 기기 등록·선택 브라우저 승인 요청·플랫폼 세션·현재 대화 구독
- dex-cli 엔진 재시작과 전용 Output 로그
- 한글 IME 조합을 지원하는 네이티브 Webview 입력창

## 사전 준비

Node.js 20 이상과 빌드된 `dex-cli`가 필요합니다. 저장소 루트에서 다음을 실행하세요.

```bash
npm install
npm run build
npm link
```

전역 `dex` 명령 대신 특정 엔트리를 사용하려면 VS Code 설정의
`XGEN Dex: Cli Path`에 실행 파일 또는 `dist/cli.js` 경로를 지정하세요.

## 개발 실행

```bash
npm --prefix apps/cli run build
npm --prefix apps/vscode run verify
code apps/vscode
```

VS Code에서 `F5`를 누르고 **Run XGEN Dex Extension**을 선택합니다. Development 모드에서는
`apps/cli/dist/cli.js`를 자동으로 찾아 사용합니다. 배포 없이 테스트하려면
`xgenDex.cliPath`에 빌드한 해당 파일의 절대 경로를 지정합니다.

## 사용

1. Activity Bar에서 **XGEN Dex**를 엽니다.
2. Workspace 안내 화면에서 회사/환경 Gateway를 등록합니다.
3. 로그인한 뒤 Agent 선택 화면에서 대화할 Agent를 고릅니다.
4. 채팅 상단의 **Agent 변경** 또는 설정 버튼으로 Agent와 연결 환경을 변경합니다.

로컬 도구를 사용하려면 설정 화면의 **로컬 도구**에서 **사용**을 켜고 작업 폴더와 허용
경로를 확인한 뒤 **설정 저장**을 누릅니다. **현재 Workspace** 버튼으로 열린 VS Code 폴더를
작업 폴더와 허용 경로에 바로 적용할 수 있습니다. 활성화하면 CLI 엔진이 로그인된 XGEN
프로필에 로컬 도구 브리지를 연결합니다.

채팅 입력은 `Enter`로 전송하고 `Shift+Enter`로 줄을 바꿉니다. 한글 조합 중의 Enter는 전송으로
처리하지 않습니다.

### 기기 및 플랫폼 세션

명령 팔레트의 **XGEN Dex: 기기 및 플랫폼 세션** 또는 상태 표시줄의 **Dex 기기·세션**을 엽니다.
HTTPS origin으로 등록된 서버 프로필을 선택하고 다음 순서로 진행합니다.

1. **기기 등록**에서 계정 이메일과 현재 비밀번호를 입력합니다.
2. **기기 승인 요청**에서 승인받을 신뢰 브라우저를 선택합니다. 해당 브라우저의 내 페이지에서 비교 코드를 확인하고 승인합니다.
3. **기기 등록 상태**를 확인하고 **플랫폼 로그인**을 실행합니다.
4. ACTIVE 서버에서 로그인·갱신이 완료되면 현재 대화 포커스 구독이 시작됩니다. 상태 표시줄에서 재연결·인증 중단을 확인합니다.
5. **플랫폼 로그아웃**은 서버 세션도 폐기합니다. **중단된 로컬 세션 기록 삭제**는 서버 폐기 없이 로컬 기록만 삭제하므로 먼저 내 페이지에서 서버 세션을 폐기해야 합니다.

계정 식별자는 비밀번호 확인 응답의 실제 사용자 ID를 사용합니다. 플랫폼 세션 상태·갱신은 선택한 계정을 사용하고,
엔진 재시작 뒤에는 계정 확인을 다시 받습니다. 프로필 전환·기존 로그인 변경·엔진 종료 시 구독과 포커스를 지웁니다.
현재 Compose의 `enrollment` 모드에서는 기기 승인까지만 동작하고 플랫폼 로그인은 503으로 차단됩니다.
기존 Workspace 채팅은 기존 인증 경로를 사용하며, 이번 구독은 Canonical 포커스 표시 단계입니다.
Desktop·Mobile 연결과 실제 ACTIVE 서버 검증은 후속 작업입니다.

## 패키징

```bash
npm run package
```

생성된 `.vsix`는 VS Code의 **Extensions: Install from VSIX...** 명령으로 설치할 수 있습니다.

## 보안 경계

- 확장은 토큰을 읽거나 저장하지 않습니다.
- 로그인 비밀번호는 JSON-RPC 로그인 frame에만 포함되며 로그에 기록하지 않습니다.
- 세션과 토큰 저장은 dex-cli의 OS keychain 구현이 담당합니다.
- VSCode 네이티브 키·세션은 `HTTPS origin + 실제 사용자 ID + vscode`로 분리한 OS 키체인에 저장합니다.
  CLI의 키·sid를 공유하지 않고 JSON-RPC 결과에는 공개 상태·비밀이 아닌 구독 정보만 반환합니다.
  OS 키체인 접근 실패나 `DEX_NO_KEYCHAIN=1`에서는 차단하며 파일 저장으로 대체하지 않습니다.
- CLI는 shell 없이 별도 프로세스로 실행됩니다.
- 로컬 도구는 기본적으로 꺼져 있으며 파일 도구는 설정한 허용 경로 안에서만 동작합니다.
- `Shell`은 CLI를 실행한 OS 사용자 권한으로 동작합니다. 위험 명령 허용은 별도 확인 후에만 저장됩니다.
