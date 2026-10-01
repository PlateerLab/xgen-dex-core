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
- 기존 채팅 입력창에서 명시적으로 켜는 Canonical **공유 대화** 송신·중단·동일 요청 재시도
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
**현재 공유 대화 읽기 / 현재 공유 대화 HTTP 폴링 / 현재 공유 대화 실시간 연결 / 대화 연결·폴링 중단**은 별도 Canonical 조회 기능이다. 읽기 전용 가상 문서에 최신 턴 상태·완전한 메시지·생략·불완전·추가 조회 상태를 표시한다. 실시간 연결은 CLI RPC 호스트의 receive-only DPoP WSS 알림 후 HTTP로 메시지를 검증하며 주기적으로 vault·포커스를 확인한다. 계정·서버 전환, 재연결 또는 중단 시 이전 본문을 비운다. 본문을 파일이나 로그에 저장하지 않는다. 읽기·폴링은 `canonicalConversation`, 실시간 연결은 `canonicalLive` capability가 있는 빌드된 CLI를 사용해야 한다.

### 기존 채팅의 공유 대화 모드

기기 및 플랫폼 세션에서 현재 공유 대화를 확인하면 Workspace 위쪽에 **공유 대화** 버튼이 나타납니다.
이 버튼을 눌러야만 기존 입력창이 Canonical 공유 대화 모드로 바뀝니다. 이 모드에서는 CLI가 검증한
VSCode 계정·프로필·HTTPS origin과 최신 대화 snapshot만 사용하며, 입력한 공백과 줄바꿈을 그대로
보냅니다. 접수 응답 뒤에는 HTTP 읽기와 네이티브 실시간 구독으로 실제 대화 상태를 다시 확인합니다.
결과가 불명확하면 입력 내용은 확장 호스트 메모리에만 남고 **같은 요청 다시 시도** 버튼이 나타납니다.
이 버튼은 같은 중복 방지 키와 버전을 다시 사용합니다. **응답 중지**는 최신 snapshot에서 검증된 실행 중
turn만 대상으로 합니다.

공유 대화 모드에서는 첨부 파일과 로컬 도구를 사용할 수 없습니다. **새 대화** 또는 **세션 선택**을 누르면
Canonical 세션 컨트롤이 열립니다. 목록에는 현재 계정이 소유한 서버 검증 세션만 표시되고, 새 세션은 사용자가
직접 입력한 Workflow ID와 선택 제목으로 생성합니다. Workflow 소유권은 서버가 검사하며 legacy 로그인이나
Agent 목록 조회로 우회하지 않습니다. 포커스 변경은 가장 최근 목록 응답의 버전만 사용합니다. 생성·전환 결과가
불명확하면 자동 재시도하지 않고, 사용자가 **새로 고침**으로 목록과 포커스를 다시 확인할 때까지 다른 세션 쓰기를
막습니다. 턴 요청이 불명확하거나 송신·중단 처리 중인 동안에도 세션 쓰기를 막습니다. 쓰기에는 `canonicalTurns`,
세션 선택에는 `canonicalSessions`, 실시간 동기화에는 `canonicalLive`, 읽기에는 `canonicalConversation` capability가
있는 같은 CLI 프로세스가 필요합니다.

The **Shared conversation** button explicitly switches the existing composer into Canonical mode after the native
session has verified a current conversation. Sends use only the CLI-verified VSCode account, profile, exact HTTPS
origin and authoritative snapshot, and preserve the input text byte-for-byte at the UI boundary. A receipt is followed
by an authoritative HTTP read and native live watch. If the outcome is unknown, **Retry same request** reuses the
host-memory request, including its idempotency key and version. **Stop response** targets only the exact running turn
from the latest verified snapshot.

Attachments and local tools are unavailable in Shared conversation mode. **New Chat** or **Select session** opens the
Canonical session controls. The selector accepts only active sessions from the latest verified owned-session page; creation
uses a manually entered workflow ID whose ownership is checked by the server. Focus writes use the verified focus version.
An unknown create or switch is never retried and blocks another lifecycle write until an explicit catalog refresh. The same
CLI process must advertise `canonicalConversation`, `canonicalLive`, `canonicalTurns`, and `canonicalSessions`; there is no
legacy chat fallback for Canonical writes.

The read-only virtual document follows explicit canonical reads, HTTP polling or native WSS notifications through the CLI RPC host. Live mode requires `canonicalLive`, preserves cursors across same-session rotation and uses HTTP as the display authority. Scoped envelopes and display projections are validated; stale watch acknowledgements are stopped by their exact IDs.
실제 ACTIVE 서버·전 표면 송수신 검증은 후속 작업입니다.

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
