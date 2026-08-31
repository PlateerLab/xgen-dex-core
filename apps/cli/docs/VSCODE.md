# VS Code extension architecture

`vscode-extension/`은 `dex-cli`를 로컬 엔진으로 사용하는 얇은 VS Code 클라이언트입니다.

```text
       VS Code Webview View
              │
              │ typed commands and state
              ▼
      Extension Host controller
              │
              │ JSON-RPC 2.0 over UTF-8 NDJSON
              ▼
        dex serve --stdio
              │
              ▼
       DexEngine / OS keychain / XGEN
```

## 경계

- 확장은 XGEN HTTP/SSE endpoint를 직접 호출하지 않습니다.
- protocol version은 CLI와 동일한 `1`로 고정합니다.
- stdout은 protocol frame 전용이고 stderr는 `XGEN Dex` Output Channel로 전달합니다.
- profile, credential, 로컬 도구 설정의 실제 저장과 실행은 CLI가 소유합니다.
- 채팅 stream은 확장이 생성한 `streamId`로 notification을 라우팅합니다.

## UI

- `xgenDex.chat`: Agent 선택, 스트리밍 채팅, 계정·회사/환경·로컬 도구 설정을 전환하는 단일 Webview View
- Status Bar: 현재 사용자, 로그인 필요, 오프라인, CLI 오류 상태
- Command Palette: profile, auth, history, engine lifecycle 명령

Webview는 서버 문자열을 `innerHTML`로 넣지 않고 `textContent`만 사용합니다. 입력창은 브라우저의
composition event와 `KeyboardEvent.isComposing`을 확인해 한글 조합 완료 Enter를 메시지 전송으로
오인하지 않습니다.

설정 화면의 로컬 도구 카드는 `localTools/status`, `localTools/configure`, `localTools/start` RPC만
사용합니다. 활성화, 작업 폴더, 허용 경로, 차단 명령, 실행 제한 시간을 저장할 수 있고
`localTools/status` notification으로 브리지 연결 상태를 갱신합니다. 위험 명령 허용을 처음 켤 때는
VS Code의 modal 확인을 한 번 더 요구합니다.
