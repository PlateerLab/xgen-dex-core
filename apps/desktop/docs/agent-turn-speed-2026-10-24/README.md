# 에이전트 브라우저 작업 속도 — BO 진입 100초 분석과 개선

2026-10-24 KST 시작. 10/23 데모 영상(`데모_수정.mov`)에서 "bo.x2bee.com 들어가서 로그인하고 상품등록 화면까지"가 약 100초 걸린 문제를 DeX와 서버 하네스(XGeny: xgen-workflow + xgen-agent-runtime)를 같이 놓고 본다. 사이트별 분기는 넣지 않고, 모든 브라우저 작업에 듣는 범용 수정만 한다.

기준 코드: DeX develop `245f334`, xgen-workflow develop `5e52aa44`, xgen-agent-runtime `v4.100.0`(develop 이 쓰는 휠). 2b 는 런타임 main `2f5e37e`(v4.101.0) 기준.

10/24 push·PR: DeX [#235](https://github.com/PlateerLab/xgen-dex-core/pull/235)(Draft, 4단계가 이어서 쌓임), 런타임 [#174](https://github.com/PlateerLab/xgen-agent-runtime/pull/174), xgen-workflow [!2302](http://gitlab.x2bee.com/xgen2.0/xgen-workflow/-/merge_requests/2302). **병합·배포하지 않음.**

## 먼저 볼 핵심

- 하네스가 한 턴에 더하는 고정 대기는 없다(sleep·폴링·루프 안 DB 쓰기 없음). 100초는 거의 **"LLM 호출 수 × 약 3초 + 기기 도구 시간"** 이다. 줄일 곳은 한 턴의 군살이 아니라 **턴 수와 도구 대기**다.
- 도구 대기: BrowserNavigate 가 페이지의 모든 리소스(load)를 끝까지 기다려 25.2초, 이어서 15.2초 만에 실패했다 → 0단계에서 수정.
- 턴 수: 서버 안내문(BrowserGuide)에 **BrowserFill·BrowserFormValues 가 빠져** 있어 모델이 로그인 칸을 BrowserInteract 로 하나씩 채웠다. 실패하면 서버가 사유를 지워 모델이 고칠 정보가 없었다 → 1단계에서 수정.
- 턴 수: 이동·클릭 결과에 화면이 없어 모델이 BrowserSnapshot 을 따로 불렀다 → 2단계에서 결과에 새 화면을 붙이고(DeX), 같은 탭·같은 주소의 지난 화면은 하네스가 요청 사본에서 접는다.
- 남은 큰 몫은 에이전트 지침이다(브라우저를 열기 전 엑셀 재읽기·복사 실패 26초, 메뉴를 눌러 찾아가기). 지침 제안은 아래 "에이전트 지침 제안".

## 영상의 도구 18회 (OCR 로 다시 셈)

모델은 OpenRouter `Qwen3.8 Flash`, 생각 끄기. 도구 사이 간격은 2.5~7초(LLM 호출 + 하네스).

| # | 도구 | 시간 | 원인 | 범용 수정 |
|---|---|---|---|---|
| 1 | BrowserGuide | 2ms | 브라우저 도구가 문 뒤에 접혀 있어 메시지마다 처음 한 번 열어야 한다 | (3단계 후보) 첫 화면 노출 — 위험 있어 보류 |
| 2–7 | UserPc·명령 실행 6회 | 각 0.1~0.4초, 실패 2 | 폴더·엑셀 다시 읽기, 샌드박스 복사 실패 | 에이전트 지침 |
| 8–9 | BrowserTabs 2회 | 26·22ms | 탭 목록·공유 탭 만들기 | (필요한 호출 — 손대지 않음) |
| 10 | BrowserNavigate | **25.2초** | load(모든 하위 리소스)까지 기다림 | **0단계** |
| 11 | BrowserSnapshot | 59ms | Navigate 결과에 화면이 없어 따로 봐야 함 | **2단계** |
| 12–14 | BrowserInteract 3회 | 69~88ms | 아이디·비밀번호·로그인을 하나씩. 안내문에 BrowserFill 없음, 여러 호출을 한 응답에 내라는 안내 없음 | **1단계** |
| 15 | BrowserNavigate 실패 | **15.2초** | 로드 중 페이지가 주소를 옮겨 ERR_ABORTED. 모델은 "Connector MCP tool execution failed" 만 받음 | **0단계**, **1단계** |
| 16 | BrowserSnapshot | 7.7초 | 원인 미상(실행 기록 필요) | — |
| 17 | BrowserInteract | 157ms | 메뉴 클릭으로 상품등록 찾아가기 | 에이전트 지침 |
| 18 | BrowserSnapshot | 142ms | Interact 결과에 화면이 없음 | **2단계** |

## 한 턴의 구조 (하네스 코드로 확인)

반복 1회 = Stage 9 Parse → 10 Tool → 16 Loop → 2 Context → 3 System → 4 Guard → 5 Cache → 6 API (`rt/core/pipeline.py:3044-3167`).

- 첫 LLM 호출 전 계획 단계·AgentRouter 같은 별도 LLM 호출은 지금 경로에 없다. 메시지당 한 번 준비 작업(쿼터·카탈로그·메모리 검색 상한 10초 등)만 있다.
- 도구 왕복: 런타임 → 브리지(`controller/tools/connectorMcpWebSocket.py`, `event.wait()`) → WS → DeX `mcp-bridge.ts` → 도구 → 결과. 다른 파드면 Redis 중계. sleep·폴링 없음.
- 실행 기록은 메모리에 모았다가 턴 끝에 한 번 쓴다(`agent_traces` 1건 + `agent_trace_spans` N건).
- 한 응답에 tool_call 여러 개를 받으면 **응답 순서대로 차례로** 실행한다(기기 도구는 동시 실행 안 함) — 브라우저에는 맞는 동작.
- OpenRouter 경로는 `cache_control` 을 안 붙이고 upstream 자동 접두 캐시에만 기댄다. 실제 적중은 `agent_traces.metadata.usage.cache_read_tokens` 로 봐야 한다.
- 옛 BrowserSnapshot 결과는 접히지 않고 매 호출 다시 보내진다 → 반복마다 입력이 커진다(2b 에서 다룸).

턴을 LLM/하네스/도구로 쪼개 보려면: `GET /api/agentflow/trace/by-interaction/{interaction_id}` → 다음 tool_call 의 `started_at` − 직전 tool_output 의 `finished_at` = LLM 1회 + 하네스. LLM 호출별 시간은 geny 경로에서 기록되지 않는다(`agent_geny.py:2490`).

## 0단계 — DeX: Navigate 가 느린 리소스 하나를 끝까지 기다리지 않는다 (완료)

- 브랜치 `fix/browser-navigate-ready`, 커밋 `54b419f1`. 파일 `apps/desktop/src/main/browser-runtime.ts`(`loadUntilReady`), 테스트 `apps/desktop/test/browser-security.test.ts`.
- 바뀐 것: goto 가 `contents.loadURL()`(load 까지, 시간 제한 없음) 대신 **새 문서의 dom-ready 뒤 load 를 2초만 더** 기다린다. 페이지가 스스로 주소를 옮긴 ERR_ABORTED 는 실패로 보지 않고 옮겨 간 문서를 최대 15초 기다린다. 주소를 못 찾는 등 다른 오류는 그대로 실패.
- 실측(dev 앱): 20초 걸리는 이미지가 있는 페이지 Navigate 20,027ms → 2,009ms. 로드 중 주소가 바뀌는 페이지 ERR_ABORTED 실패 → 2,009ms 성공. BO 이동은 이 맥에서 원래도 0.3~0.8초라 그대로.
- 테스트 27개 통과(새 4개: 느린 리소스, 이전 문서의 dom-ready 무시, 스스로 이동, 진짜 오류).
- 뒤따른 수정(4단계 실측 중 발견): Electron 이 설명 없이 번호만 주는 중단(`" (-3) loading"`, code 빈 문자열·errno -3)이 있어 실패로 처리됐다. 로그인이 풀린 상태로 BO 상품등록을 열자 로그인 화면으로 옮겨 가며 이렇게 끝났다. errno -3 도 중단으로 본다(테스트 추가).
- 남은 위험: load 를 덜 기다리므로 늦게 그려지는 SPA 는 Navigate 직후 Snapshot 이 얇을 수 있다(357자 사례, 수정 전에도 있던 경합). → 2a 의 요청 대기로 보완했다(BO 메인 321자 → 1,638자). 영상 당시 어느 리소스가 늦었는지는 그 맥에서만 알 수 있다 — 재현되면 바로 설정의 진단 로그를 복사(앱 메모리에만 남음).

## 1단계 — 하네스: 안내문에 브라우저 도구 전부 + 실패 코드 안내 (코드 완료, 서버 반영 전)

xgen-workflow 브랜치 `fix/connector-browser-guide`, 커밋 `f2110196` (develop `5e52aa44` 기준).

1. **브라우저 도구 판정을 접두 규칙으로** (`service/connector_mcp/injector.py`)
   - 전: 손으로 적은 6종 목록 `CONNECTOR_BROWSER_TOOL_NAMES`. DeX 가 광고하는 8종 중 BrowserFill·BrowserFormValues 가 안내문에서 빠졌다(도구 자체는 문의 접두 규칙으로 열렸지만 모델은 지도만 보고 고른다).
   - 후: `is_connector_browser_tool()` — `local` 서버의 `Browser*` 전부(문 `BrowserGuide` 제외). 런타임 문 표(`tools.gates` 의 BrowserGuide 가족)와 같은 규칙이라 DeX 가 도구를 늘려도 어긋나지 않는다. 미리보기 화면(`editor/geny_bridge/basic_info.py`)도 같은 판정을 쓴다.
2. **안내문** (`_browser_guide_text`)
   - 도구 설명은 첫 문장만(최대 200자). DeX 설명은 한 줄로 길게 온다(BrowserFill 은 수천 자) — 전문은 문이 연 도구 스키마에 있다.
   - 추가 문구: 오류 뒤에는 같은 호출을 되풀이하지 말 것, browser_stale_ref 면 새 스냅샷.
   - BrowserFill 이 광고될 때만: "공유 탭의 폼은 칸마다 BrowserInteract 말고 BrowserFill 한 번에(칸당 한 step). 값만 채운다 — 버튼·이동은 BrowserInteract/Navigate."
   - 같은 스냅샷의 여러 칸 입력은 한 응답에 여러 호출로(차례로 실행), 버튼은 그 결과를 본 뒤 따로.
   - 바꾸지 않은 것: "Usual order: BrowserTabs → …". 탭 목록 생략을 권하면 page_id 없는 호출이 사용자에게 안 보이는 백그라운드 탭으로 가고, BrowserFill 은 공유 탭이 필요해서 오히려 되돌아오는 턴이 생길 수 있다.
3. **실패 사유** (`service/connector_mcp/device_errors.py`, `connectorMcpWebSocket.py` `handle_result`)
   - 전: DeX 가 보낸 실패 원문을 전부 "Connector MCP tool execution failed" 로 바꿈(로컬 경로·명령 출력 유출 방지).
   - 후: 원문은 여전히 버리고, **맨 앞의 알려진 코드만** 서버가 쓴 문구로 바꾼다. 코드는 DeX 의 `browser_stale_ref / browser_no_page / browser_page_not_found / browser_timeout / browser_disabled / browser_denied`(`BrowserRuntimeError`)와 `[LOCAL_TIMEOUT]`(`LocalDeadlineError`). 예: `Connector MCP tool execution failed — browser_stale_ref: the element handles are from an older state of the page. Take a new BrowserSnapshot …`. 모르는 코드·코드 없음은 예전과 똑같이 머리말만.
   - 서버만 바뀌므로 **이미 설치된 DeX 에도 바로 적용**된다.
   - 한계: `browser_denied` 는 DeX 에서 여러 사유(인자 오류, 단계 대기, 확인 창 거부 등)를 묶은 코드라 문구가 일반적이다. 사용자 거부를 런타임 denial_guard 로 보내려면 DeX 가 `user_denied:` 코드를 보내야 한다(별도 작업).
4. 테스트: 커넥터 관련 33개 통과(새 7개 — 늘어난 도구가 지도에 오름, BrowserFill 안내 조건, 첫 문장만, 판정, 코드 → 문구, LOCAL_TIMEOUT, 원문 미노출). 전체 테스트의 실패 목록은 develop `5e52aa44` 와 같다(DB·외부 서비스가 없는 환경이라 원래 실패하는 384건).
5. 실제 DeX 도구 설명(develop `245f334` 의 `browserToolSchemas()`)으로 만든 안내문은 2,102자, 8개 도구가 모두 오른다. 렌더 결과:

```text
Tools:
  - mcp_local_BrowserTabs — Manage XGEN browser pages on the user desktop.
  - mcp_local_BrowserNavigate — Navigate one XGEN browser page: goto/back/forward/reload/stop/wait.
  - mcp_local_BrowserSnapshot — Return the accessibility snapshot and fresh @eN refs for a page.
  - mcp_local_BrowserInteract — Interact with a page using refs from BrowserSnapshot: click/fill/type/keypress/select/check/uncheck/hover/drag/scroll/mouse.
  - mcp_local_BrowserCapture — Capture screenshot/full screenshot/PDF or inspect console/page errors.
  - mcp_local_BrowserAdvanced — Advanced browser controls: cookies, storage, upload/download, ...
  - mcp_local_BrowserFill — Fill many fields of a form on a shared browser tab fast — pass that tab's page_id (BrowserTabs list, mode shared); it is brought to the front while filling.
  - mcp_local_BrowserFormValues — Read every field of the form on a page: field label, current value, ...

Usual order: BrowserTabs (what is open) → BrowserNavigate (go) → BrowserSnapshot (...) → BrowserInteract (...).
Element handles come from a snapshot — never guess a selector. After browser_stale_ref take a new snapshot; after any error, change something instead of repeating the identical call.
Forms: put all the fields of a form on a shared tab into ONE BrowserFill call (one step per field) instead of one BrowserInteract per field. It fills values only — buttons and going to another page stay with BrowserInteract / BrowserNavigate.
Typing into several fields of the same snapshot can go out as several calls in one response (they run in order); press a button in a separate step after you see those results.
BrowserCapture takes a screenshot; BrowserAdvanced is the escape hatch.
```

6. 남은 확인: 서버(dev)에 반영한 뒤 같은 요청으로 BrowserFill 선택·한 응답 다중 호출·오류 뒤 행동이 실제로 바뀌는지 측정.

## 2단계 — 조작 결과에 새 화면 + 옛 스냅샷 접기 (코드 완료, 반영 전)

영상 11·18번은 이동·클릭 뒤 화면을 보려고 BrowserSnapshot 을 따로 부른 턴이다(LLM 한 턴 약 3초씩). 2a 는 그 턴을 없애고, 2b 는 결과가 커진 만큼 입력이 쌓이지 않게 한다. 둘은 짝이다.

### 2a. DeX: 페이지를 옮긴 이동·클릭의 결과에 새 화면 스냅샷

브랜치 `fix/browser-navigate-ready`, 커밋 `a3267ad8`. 파일 `browser-tools.ts`(navigate·interact·pageAfter), `browser-runtime.ts`(settle·requestMark·요청 추적), 테스트 `test/browser-page-after.test.ts`(11개).

- **붙이는 때**
  - BrowserNavigate goto/back/forward/reload: 항상.
  - BrowserInteract click/double_click/keypress: 조작 뒤 generation 이 바뀌었을 때만(새 문서, SPA 경로 이동). 페이지가 그대로면 붙이지 않는다 — 스냅샷을 뜨면 generation 이 올라 모델이 들고 있는 ref 가 만료되기 때문이다.
  - fill/type/select/check/hover/scroll: 뜨지 않는다(다음 칸의 ref 를 살려 둔다).
  - 새 탭이 열렸거나(opened_pages) 팝업이 닫혔으면: 예전처럼 그 안내만.
- **언제 읽나** (`BrowserRuntime.settle`)
  1. 조작 뒤 200ms 안에 새 문서로의 이동이 시작되면(did-start-navigation, 같은 문서 이동 제외) 그 문서의 dom-ready 까지.
  2. 조작 전에 받아 둔 `requestMark()` 뒤에 이 페이지가 보낸 XHR·fetch 가 끝나고 300ms 조용할 때까지. 요청은 브라우저 partition 의 `webRequest` 관찰 이벤트(onSendHeaders·onCompleted·onErrorOccurred)로 센다 — 요청을 붙잡는 onBeforeRequest 는 쓰지 않는다. 조작 전부터 열려 있던 요청(폴링)·이미지·스크립트는 기다리지 않는다.
  3. 이동·경로 이동 뒤에는 500ms 틈을 더 둬서 새 화면의 스크립트가 첫 데이터 요청을 보내게 하고, 그 요청도 기다린다. Playwright MCP 도 조작 뒤 500ms 를 두고, 조작이 보낸 요청을 최대 5초 기다린 뒤 화면을 읽는다(`@playwright/mcp` 0.0.83 `waitForCompletion`).
  - 각 대기 상한 5초. 사용자가 멈추면 바로 그만두고 조작 결과만 돌려준다.
- **크기**: interactive·compact 스냅샷(`snapshot -i -c`). 20,000자에서 줄 단위로 자르고 `snapshot_truncated` 로 알린다. 스냅샷이 실패해도 끝난 조작의 결과는 돌려준다(진단 로그에 남김).
- **도구 설명**: Navigate·Interact 에 "결과의 snapshot·generation 을 바로 쓰고 BrowserSnapshot 을 또 부르지 말 것 / 페이지가 그대로면 앞 ref 가 유효" 를 더했다.
- **실측** (숨긴 dev 앱, 이 맥, 10/24)

| 동작 | 시간 | 붙은 화면 | 비교 |
|---|---|---|---|
| goto BO 상품등록(로그인 상태) | 1.96초 | 14,439자, 버튼 55 | 따로 읽은 스냅샷 14,440자 |
| goto BO 메인 | 0.8~1.7초 | 1,638자, 버튼 35 | 요청 대기 전에는 321자, 버튼 7 |
| 클릭 공지 '더보기'(SPA 경로 이동) | 1.23~1.39초 | 5,645자, 표 행 5 | 3번 대기 전에는 22자 |
| 클릭 '최근 7일'(요청만, 화면 그대로) | 0.28~0.31초 | 없음 | |
| 클릭 아이디 칸 / 입력 2회 | 0.27초 / 0.05~0.07초 | 없음 | |
| goto 위키백과 / 네이버 | 0.8~1.2초 / 0.9초 | 9,511자 / 10,500~12,000자 | |

  - 이동·클릭 한 번이 0.5~1.5초 길어지는 대신 LLM 한 턴(약 3초 + 스냅샷)이 빠진다.
  - 로그인 버튼은 새 코드로 다시 재지 못했다(이 테스트 프로필에 로그인 상태가 남아 로그아웃이 되지 않음). 예전 코드에서는 클릭 280ms 뒤에도 주소가 그대로였고 1.5초 뒤 메인(1,638자)이었다 — 2번 대기가 이 경우를 위한 것이다. dev 반영 뒤 로그아웃 상태에서 확인해야 한다.
- **위험·한계**
  - 끝나지 않는 요청(롱폴링, 스트리밍 fetch)을 조작 뒤에 여는 페이지는 클릭마다 상한까지 기다린다(최대 약 11초 + 스냅샷).
  - 요청 없이 타이머·애니메이션 뒤에 그리는 화면은 얇게 잡힐 수 있다.
  - 주소는 그대로이고 모달만 뜨는 클릭은 화면을 붙이지 않는다(generation 그대로) — 모델이 필요하면 BrowserSnapshot 을 부른다.
  - 큰 페이지는 잘린다(위키백과 문서 23,569자). 전체가 필요하면 BrowserSnapshot.

### 2b. 하네스: 같은 탭·같은 주소의 옛 스냅샷 접기

xgen-agent-runtime 브랜치 `feature/fold-superseded-snapshots`, 커밋 `5ba1db6` (origin/main `2f5e37e` = v4.101.0 기준, push 전). xgen-workflow 코드는 바꿀 것이 없다. CHANGELOG 에 `[Unreleased]` 항목을 적어 두었다.

- `core/message_repair.fold_superseded_results(messages, spec)` — 범용 함수. 지정한 도구의 결과 중 JSON 객체인 것을 `key` 필드 값으로 묶어, 가장 새 결과만 큰 필드(`fields`)를 남기고 앞 결과의 그 필드는 한 줄 `note` 로 바꾼다. 호출과 결과의 나머지(page_id·url·generation 등)는 그대로라 짝·순서가 바뀌지 않는다.
- Stage 6 `_call_kwargs` 가 **요청 사본에만** 적용한다(기록은 그대로). 이번 루프의 결과(extra_messages)까지 본다. 폴더 도구가 없는 턴에 옛 호출을 평문으로 바꾸는 `retire_tool_calls_by_name` 과 같은 방식이다.
- `SharedKeys.FOLDED_TOOL_RESULTS` — 호스트가 넣는 spec. `host/turn_executor` 가 이번 턴에 기기 브라우저 도구가 있으면 `host/device_tools.browser_snapshot_fold_spec()` 값을 넣는다:
  - names: `mcp_(local|mobile|web)_Browser*`(문 `BrowserGuide` 제외)
  - key: `page_id`, `url`
  - fields: `result.snapshot`(2a 의 Navigate·Interact), `result.data.snapshot`(BrowserSnapshot)
  - note: `[folded: this tab showed the same address again later in the conversation. Use that newer snapshot; the element refs of this one have expired.]`
- **왜 주소까지 key 인가**: 같은 탭이라도 주소가 다르면 앞 페이지에서 읽은 내용(목록의 값 등)이 그 글에만 있을 수 있다. 런타임은 4.97.0 에서 비용 기준 context_prune 을 껐다("정확도 우선") — 그와 맞춰, 같은 주소의 더 새 스냅샷이 뒤에 있을 때만 접는다. 그때 앞 것은 ref 도 이미 만료됐고(스냅샷마다 generation +1) 글도 낡은 사본이다.
- 스냅샷이 없는 결과(화면이 그대로인 클릭)는 "더 새 것" 으로 치지 않는다. 오류 결과, JSON 이 아닌 결과, 다른 도구는 건드리지 않는다.
- 효과 예: BO 상품등록 폼(14,440자)을 입력 중에 다시 읽을 때마다 앞 사본이 접힌다. 로그인 화면 → 메인 → 상품등록처럼 주소가 바뀌는 흐름은 접히지 않는다(대신 그 화면들은 작다: 265자, 1,638자).
- **캐시**: 접힌 메시지부터 뒤로는 접두 캐시가 한 번 깨진다. 접히는 것은 대개 바로 앞 몇 메시지라 깨지는 꼬리는 짧다. OpenRouter 경로는 `cache_control` 이 없어 upstream 자동 캐시만 해당한다. 실측은 `agent_traces.metadata.usage.cache_read_tokens`.
- CLI provider(claude_code·codex)는 기록을 CLI 가 들고 있어 적용되지 않는다.
- 테스트: 새 11개(접기 9 — 같은 주소 접힘, 다른 주소·탭 유지, 여러 개 중 마지막만, 스냅샷 없는 결과는 더 새 것 아님, 오류·다른 도구·JSON 아님, 브리지 접두·목록 모양 유지, 잘못된 spec, Stage 6 요청 사본·이번 루프 / 호스트 2). 전체 6,272개 통과, 16개 건너뜀, ruff 통과.
- **반영하려면** 런타임 릴리스(4.102.0 예상) → xgen-workflow 의 휠 고정을 올린다.

## 3단계 — 측정 뒤 판단

- BrowserInteract 에 동작 배열(fill, fill, click) 받기 — 중간 실패 처리 필요.
- connector 대화에서 브라우저 핵심 도구를 문 없이 첫 화면에 노출 — 메시지당 1턴 줄지만 모든 호출의 고정 접두가 커지고, 09/09 "안내만 100회" 사고 이력이 있다.

## 4단계 — 박소민 시스템 프롬프트의 규칙을 범용 수정으로

박소민의 BO 상품 등록 에이전트 프롬프트(10/23 시연)에는 도구가 못 하는 것을 문장으로 막은 규칙이 있다. 도구가 스스로 맞게 하면 그 문장 없이도 된다. 규칙을 셋으로 나눴다.

| 프롬프트 규칙 | 분류 | 실행 기록 근거(10/22~23) | 할 일 |
|---|---|---|---|
| 임시저장 뒤 대화상자에서 멈춤·승인요청 금지 | 범용 수정(안전) | **실제 사고.** 54448 에서 승인요청을 3번 눌렀다. 앞 2번은 검색키워드 필수 검사에 조용히 막혀 클릭 결과에 아무 표시가 없었고, 3번째 "승인요청하시겠습니까?" 창의 확인까지 눌러 실제로 제출됐다. 54403 은 임시저장 확인창의 확인을 눌렀다 | **4g 완료** — 확인창(확인·취소)의 확정 버튼은 채팅 카드로 사용자 확인을 받고 누른다. 클릭 결과에 떠 있는 창·경고 문구를 싣는다 |
| 칸은 한 번에 모아서(상세·대표이미지·배송비정책 포함) | 1·2단계 + 범용 수정 | 규칙이 있어도 54600 Fill 17회. 25~28 은 첫 Fill 에 26~27줄을 모았지만 재시도로 3~5회. 재시도의 큰 원인은 앞 칸의 검증 알림("협력사를 먼저", 정상가, 마진율)이 다음 줄의 클릭을 가로챈 것(최소 8줄) | **4e 완료** — 알림을 닫고 실패한 줄은 먼저 채울 칸의 줄 뒤나 바로 한 번 다시 한다 |
| 입력 결과로만 확인, 화면 다시 읽지 않기 | 1·2단계가 다룸 | Fill 직후 Snapshot 이 run 마다 1~4회. Fill 결과에 이미 `form_values` 가 있다 | 반영 뒤 측정. 필요하면 결과에 "다시 읽을 필요 없음" 표시 |
| 이미 원하는 값인 칸은 다시 입력하지 않기 | 범용 수정 | 54606 한 Fill 에서 약 21칸 재입력(38s), "그대로 두어줘" 줄도 눌렀다. 반대로 배송비정책은 placeholder "선택" 을 값으로 봐 done 을 냈다(거짓 성공, 3건) | **4a 완료**(「」 값). 4h(placeholder·할 일 없는 줄)는 조사만 — placeholder 거짓 성공 3건은 모두 박소민 수정 bb54f23d(10/22 18:07, 말에서 뽑은 값으로 비교) 이전 실행이고 10/23 에는 다시 없었다. "그대로 두어줘" 줄은 전체 Fill 입력에서 1번(이미 선택된 라디오를 눌러 피해 없음)이라 규칙을 더하지 않았다 |
| 자료는 처음 한 번만, 엑셀 열은 한 번에 | 도구·설정 문제 | (a) fast-act-* 는 `enable_memory` 가 꺼져 매 턴 이전 대화가 없다 — 다시 읽을 수밖에 없다. (b) 켠 run 은 내용이 남아 있었지만 첫 읽기가 셀 좌표 형식이고 날짜가 serial(46327)이라 다시 읽었다. 54628 은 serial 을 못 바꿔 틀린 판매기간을 넣고 done | **4f 코드 완료** — 엑셀 한 장을 읽기까지 턴마다 도구 4.6번. 가져오기(UserPc get)의 경로 처리와 한글 파일 이름 두 가지를 고쳤다. serial 날짜는 기기 python 으로 읽은 3번에서만 나왔다. memory 설정은 박소민 확인 |
| 표준카테고리는 전체 경로로 | 범용 수정 | 끝 이름만 줘서 3번 실패(54583, 54585) | **4d 완료(작게)** — BrowserFill 설명이 이미 전체 경로를 시킨다. 끝 이름만 온 줄이 트리 맨 위에서 실패하면 전체 경로로 보내라고 결과에 적는다. 트리를 다 펼쳐 찾기는 하지 않았다 |
| 판매시작일은 오늘 이후 | 범용 수정 | 1번(54567), 알림을 보고 모델이 스스로 고쳤다 | 낮음 — 알림이 모델에 닿는 것은 확인됨 |
| 결제수단은 없는 것만 해제, "전체" 는 건드리지 않기 | 범용 수정 | 확인 불가(1줄, 결과가 잘림). 결제수단의 실제 문제는 알림 가로채기와 요소 확신 낮음(0.52~0.59) | 4b — 낮음 |
| 공급원가는 비워 둔다(자동 계산) | 범용 수정 | 1번, 피해 없음(비활성 칸이라 누르지 않음). 다만 그 1줄 때문에 `complete=false` | 4c — 낮음 |
| 역할·자료·BO 주소, 검색키워드·상세는 직접 작성, 협력사·브랜드·카테고리·마진율 필수, 짧게 답하기 | 업무 지시 | — | 프롬프트에 남긴다 |

근거 범위: user 128 의 trace 54400–54684(span 3,853개). 10/23 오후부터는 도구 입력이 `args_digest` 로만 남고, 도구 출력은 약 4,000자에서 잘린다. demo-test-1~24 의 프롬프트 원문은 workflow 가 지워져 없다. 그 밖에 반복된 실패: 약 300초에서 취소된 run 17개, 배송비정책 실패 6건 이상, 대표이미지 실패 6건 이상, 장치 python 오류 6건, BrowserNavigate `http://bo/` 오류 6건.

DeX 에도 BO 전용 문구가 있다: `fast-act-labels.ts:360` 의 `/협력사|브랜드/` 정규식, BrowserFill 설명의 BO 예시 문장들(4d).

### 4a. DeX: BrowserFill 이 이미 그 값인 칸은 손대지 않는다 (완료)

- 파일 `apps/desktop/src/main/fast-act-batch.ts`(`heldValue`, `runSteps`), 도구 설명 `browser-tools.ts`, 테스트 `test/fast-act-brief.test.ts`.
- 바뀐 것: 배치를 시작할 때 폼 값을 한 번 읽는다(BrowserFormValues 와 같은 스크립트, BO 에서 수 ms). 줄이 `X에 「값」` / `X를 「값」으로 …` 꼴이고 칸 X 가 이미 그 값이면 판단 모델을 부르지 않고 `done` + `unchanged: true` 로 남긴다. 앞 줄이 화면을 바꾼 뒤에는 읽어 둔 값이 낡았을 수 있어, 건너뛸 것 같은 줄에서만 다시 읽어 확인한다.
- 건너뛰는 조건(틀리게 건너뛰면 칸이 비고, 실행하면 같은 값을 다시 넣을 뿐이라 좁게 잡았다):
  - 「」 값이 하나뿐이고 비어 있지 않다. 검색하라는 줄은 뺀다(값이 같아도 검색할 일이 남는다).
  - 이름이 같은 칸이 하나뿐이다. 없으면 이름을 품거나 품기는 칸이 하나뿐일 때. 체크박스 무리처럼 여럿이면 판단 모델에 맡긴다.
  - 값이 같다. 띄어쓰기 차이와 숫자의 쉼표(`12,900` = `12900`)만 같은 값으로 본다.
  - 「」 없이 쓴 줄은 예전처럼 판단 모델로 간다. 선택 상자 `(현재: …)`, 이미 체크된 체크박스, 펼쳐진 구역의 기존 처리가 이어서 맡는다.
- 실측(숨긴 dev 앱, BO 상품등록, 기본값 그대로인 7칸 + 모델명 1칸):

| | 전 | 후 |
|---|---|---|
| 8줄 BrowserFill 전체 | 11,324ms | 1,347ms |
| 이미 그 값인 줄 하나 | 1,244~1,675ms | 0ms |
| 값을 넣는 줄(모델명) | 1,379ms | 1,331ms |
| 같은 9줄을 다시 보냄(전부 이미 그 값) | — | 7ms |

- 앞 줄이 칸을 바꾼 경우(10/24 판단 서버 복구 뒤 실측): `선물하기를 「해당없음」` → `선물하기를 「해당」` 순서로 보내면, 처음 읽은 값(해당)으로는 둘째 줄이 건너뛸 줄로 보이지만 다시 읽어 해당없음을 확인하고 판단 모델로 넘긴다(틀린 건너뛰기 없음).
  - 그 줄은 판단 모델이 "요소 확신 낮음 0.55" 로 실패했다. 화면에 "해당"·"해당없음" 라디오가 여러 무리에 있어 생긴 기존 문제다(이번 수정과 무관, 라우팅 평가셋 후보).
  - 같은 배치에 같은 칸을 두 번 보내면 둘째 줄도 실행된다(처음 읽은 값에는 아직 없으니). 해가 없고 드문 경우라 그대로 둔다.
- 10/24 14:55 dev 판단 서버가 죽은 것은 GPU0 메모리 부족 때문이다(PaddleOCR 이 쓰면서 6.3GB 로 늘어 ASR·판단 모델과 합이 32GB 를 넘음). infra !493 으로 xgen-model 에 GPU 2장을 주고 판단 모델을 GPU1 로 옮겼다.
- 테스트: desktop 731개 중 725개 통과·실패 0(나머지는 건너뜀), typecheck·typecheck:node 통과.

### 4g. DeX: 사이트 확인창의 확정 버튼은 사용자에게 묻고 누른다 (완료)

- 왜: 10/22 trace 54448 에서 에이전트가 승인요청 확인창의 확인까지 눌러 시연 상품이 실제로 승인요청됐다. 그날 13:51 에 저장 가드(`browser-action-guard`, db036ea2)를 걷어낸 뒤였다 — 버튼 이름(저장·등록·승인요청)과 사용자 메시지를 해석해 허락을 정했는데, 직접 "임시저장해줘" 라고 해도 해석이 빗나가 매번 되물었다.
- 이번 판단은 이름이 아니라 화면 구조다. 맨 위 대화상자(`role=dialog`·`alertdialog`·`dialog[open]`)에 입력칸이 없고, 버튼이 2~3개이며 취소·닫기류와 그 밖의 버튼이 같이 있으면 확인창이다. 그 창이 떠 있을 때
  - 취소·닫기류가 아닌 버튼을 클릭하거나(스냅샷에서 역할을 모르면 묻는다, 트리·목록 항목은 고르기라 묻지 않는다), Enter·Space 를 누르거나, 마우스를 누르면 묻는다. 취소·닫기·Escape·입력·스크롤은 묻지 않는다.
  - 저장 버튼 자체는 확인창을 띄울 뿐이라 묻지 않는다. 버튼 하나뿐인 알림(fast-act-notice 가 닫는 것)과 입력칸이 있는 조회 팝업(협력사 검색), 버튼이 4개 이상인 고르기 팝업(카테고리 트리의 펼치기·선택·닫기)은 확인창이 아니다.
  - BrowserFill 은 확인창이 떠 있으면 남은 줄을 멈추고 까닭을 남긴다(줄의 판단 모델이 그 창을 묻지 않고 누를 수 있다). 단계 실행(step)도 거절하고 BrowserInteract 로 넘긴다.
- 묻는 방법: 채팅 입력창 위 카드(Claude Code 의 확인과 같은 세 가지). 숫자키 1·2·3, Esc 는 말 없이 누르지 않기.
  1. 누르기(이번만)
  2. 누르기, 이 대화에서 같은 창은 다시 묻지 않기 — 대화(workflowId·interactionId)와 창 문구별로 기억한다.
  3. 누르지 않고 다르게 하라고 말하기 — 적은 말이 도구 결과로 모델에 간다(`browser_denied: … 사용자의 말: "…"`). 말 없이 거절하면 `user_denied:` 로 돌려준다. 런타임은 이 머리말을 사람의 거부로 보고 같은 턴에 같은 호출을 다시 하지 않는다(xgen-agent-runtime `host/tools.py`, `denial_guard.py`).
- 기다리는 시간은 90초다. 턴 전체가 시작부터 300초 예산이고 기다리는 동안에도 줄어든다(xgen-workflow `execution_budget`) — 그 안에 "답이 없어 누르지 않음" 을 돌려준다. 다른 화면(웹·휴대폰)에서 보낸 턴은 이 PC 앞에 사람이 없을 수 있어 묻지 않고 누르지 않는다. DeX 창이 가려져 있으면 알림만 띄운다(포커스는 뺏지 않는다, 누르면 그 대화로 간다).
- 클릭 결과에 화면 문구: 누른 뒤 떠 있는 대화상자(`dialog: {text, buttons}`)와 보이는 `role=alert` 문구(`alerts`)를 싣는다. 54448 의 처음 두 번은 필수 칸 검사에 막혔는데 결과에 아무것도 없어 다시 누르고 스크린샷을 반복했다.
- 파일: `src/main/browser-confirm.ts`(판단·카드 대기열), `browser-tools.ts`(`confirmGate`, 결과 문구), `fast-act-batch.ts`(Fill 멈춤), `browser-runtime.ts`(스냅샷 ref 의 역할·이름 기억), `index.ts`·`ipc.ts`·`preload`(채널 `browser:confirmList`·`confirmEvent`·`confirmResolve`), renderer `browser-confirm-store.ts`·`views/ConfirmCard.tsx`·`Chat.tsx`, protocol `BrowserConfirmRequest`.
- 실측(숨긴 dev 앱 + 로컬 시험 페이지: 검색키워드 필수 검사와 "승인요청하시겠습니까?" 확인·취소 창, 카드 답은 renderer 의 preload → IPC 로 보냄):

| 조작 | 결과 |
|---|---|
| 검색키워드 비우고 승인요청 클릭 | `alerts: ["검색키워드는 필수입니다"]` |
| 채우고 승인요청 클릭 | `dialog: {text: "승인요청하시겠습니까?", buttons: [취소, 확인]}` |
| 확인 클릭 → 카드에서 말 없이 거절 | `user_denied: …`, 제출 0 |
| 확인창이 뜬 채 BrowserFill | 1ms 에 멈춤, 줄은 skipped("확인창이 떠 있어 멈춤…") |
| Enter → 거절하며 "검색키워드 먼저 바꿔" | `browser_denied: … 사용자의 말: …`, 제출 0 |
| 확인 클릭 → 이번만 | 제출 1 |
| "이 대화에서 다시 묻지 않기" 뒤 같은 창 확인 | 두 번째는 묻지 않고 누름 |
| 취소 클릭 | 묻지 않음 |

- 한계: 확인창 없이 첫 클릭에 저장하는 사이트는 막지 못한다. iframe 안의 확인창과 브라우저 기본 `confirm()` 창은 보지 않는다. 음성 빠른 조작(사용자가 직접 말한 "확인 눌러")은 묻지 않는다 — 대상은 서버 에이전트의 도구 호출이다.
- 테스트: `test/browser-confirm.test.ts` 10개. desktop 741개 중 735개 통과·실패 0(나머지는 건너뜀), typecheck·typecheck:node 통과.

### 4e. DeX: 알림을 닫고 실패한 줄은 BrowserFill 이 한 번 다시 한다 (완료)

- 왜: 10/22~23 기록에서 알림을 닫고 실패한 줄이 13개다. 그 줄의 값이 거절된 것은 1개("익일 이후로 판매기간을…" ← 판매기간 줄)뿐이고, 12개는 다른 칸 때문이었다.
  - 먼저 채울 칸이 비어 있음: "가격정보 입력전에 협력사를 먼저 입력해 주세요." 가 판매가·마진율 줄에 떴다(협력사는 다른 Fill 에서 따로 채움).
  - 앞 칸의 검사가 이 줄의 클릭을 가로챔: 앞 줄에서 넣은 판매가·마진율이 이 줄의 클릭으로 포커스를 잃을 때 검사 알림("판매가보다 큰 정상가를…", "구간 내 마진율을…")이 떠서, 누른 체크박스·선택 상자가 그대로였다. 54628 에서는 가로채인 체크박스 바로 다음 체크박스 둘이 그대로 됐다 — 알림을 닫은 뒤에는 같은 검사가 다시 뜨지 않는다.
  - 줄마다 LLM 이 BrowserFill 을 다시 불러 첫 Fill 뒤에 3~5회가 더 들었다.
- 규칙(`noticeRetry`, 알림 문구에 든 칸 이름으로만 판단 — 사이트 분기 없음). 줄마다 한 번만 다시 한다.
  - 알림이 뒤 줄의 칸을 부르면 그 줄 뒤로 미룬다. 그 줄이 성공했을 때만 다시 한다.
  - 알림이 앞에서 못 한 줄의 칸을 부르면 다시 하지 않는다(먼저 채울 칸이 여전히 비어 있음).
  - 알림이 이 줄의 칸을 부르면 넣은 값이 거절된 것이라 다시 하지 않는다 — 부른 LLM 이 값을 고친다.
  - 그 밖은 바로 다시 한다. 파일 올리기 줄은 다시 하지 않는다(같은 파일이 두 번 올라갈 수 있음). 남은 시간이 15초 미만이면 다시 하지 않는다.
  - 결과 줄에 `retried: true`, 알림은 두 번 것 모두 남긴다. 체크박스는 다시 할 때 이미 원하는 상태면 누르지 않으므로(기존 `want` 검사) 두 번 눌러 되돌리지 않는다.
- 실측(숨긴 dev 앱 + 로컬 시험 페이지: 협력사 없이 가격을 넣으면 값을 지우고 알림, 판매가가 정상가 이상이면 포커스를 잃을 때 알림, 지난 날짜면 지우고 알림. 알림은 화면을 덮는 확인 하나짜리 창):

| 배치 | 전 | 후 |
|---|---|---|
| A 판매가 → 체크 해제 → 협력사 → 정상가 | 판매가 실패, `complete=false` (4.7초) | 판매가를 협력사 뒤로 미뤄 성공, `complete=true` (5.6초, 3회 같음) |
| B 협력사 → 정상가 30000 → 판매가 32900 → 체크 해제 | 체크박스가 알림에 가로채여 실패 (7.0초) | 바로 다시 해서 성공, `complete=true` (5.5초) |
| C 판매기간 지난 날짜 | 실패 (1.6초) | 다시 하지 않음 (1.3초) |
| D A 와 같은데 협력사 칸이 잠김 | — | 협력사 실패 → 미룬 판매가·정상가 모두 다시 하지 않음 (4.7초) |

  - 처음 A 를 돌렸을 때 협력사 줄이 판단 서버 8초 시간 초과("This operation was aborted")로 실패했는데, 미룬 판매가와 정상가를 그대로 다시 해 4초를 버렸다. 그래서 "먼저 채울 칸의 줄이 성공했을 때만" 규칙을 더했다(D).
- 한계: 알림 문구가 칸 이름을 쓰지 않으면("가격 정보를 확인해 주세요") 바로 다시 한 번 하고 끝난다. 먼저 채울 칸이 이 배치에 없으면 다시 해도 같은 알림이다 — 54628 처럼 협력사를 따로 채우는 순서는 LLM 이 알림을 보고 고친다.
- 테스트: `test/fast-act-brief.test.ts` 2개 추가. desktop 743개 중 737개 통과·실패 0(나머지는 건너뜀), typecheck·typecheck:node 통과.

### 4f. 자료 읽기: 가져온 파일이 모델이 적은 그 경로에 있게 한다 (코드 완료, 반영 전)

- 왜: 10/22~23 기록에서 엑셀을 읽은 턴이 42개다. 처음 제대로 읽기까지 턴마다 파일 도구를 평균 4.6번 불렀다(목록 보기 → 가져오기 → python, 사이에 실패). 도구 실행은 턴마다 합쳐 0.5~3.9초지만 호출마다 LLM 왕복이 하나씩 붙는다(그 run 들의 왕복 평균 2~27초).
- 실패를 종류별로 셌다. 앞의 둘이 도구 쪽 버그다.

| 실패 | 횟수 | 원인 |
|---|---|---|
| python 이 `prod.xlsx` 를 열다 `IsADirectoryError`, 다시 가져오다 `cannot overwrite directory` | 8턴 10번 + 3턴 | `UserPc get` 이 `sandbox_path` 를 늘 폴더로 만들었다. 모델은 cp 처럼 파일 경로(`prod.xlsx`, `/tmp/a.xlsx`, `data.xlsx`)를 줘서 `prod.xlsx/신상품_정보.xlsx` 가 됐다 |
| `FileNotFoundError: '…/신상품_정보.xlsx'` | 9턴 11번(12번 중) | 맥이 주는 한글 이름(NFD, 자모 분리)이 sandbox 에 그대로 남았다. 모델이 다시 적는 이름은 NFC 라 리눅스에서는 다른 파일이다. 채팅 첨부는 이미 NFC 로 맞추고 있었고, 기기 폴더 복사만 빠져 있었다. 10/23 오전부터 파일 이름이 영어(`new_product_info.xlsx`)로 바뀐 뒤에는 이 실패가 없다 |
| `could not move into /workspace/…: Permission denied` | 4턴 | 모델이 sandbox 밖 절대 경로(`/workspace/…`, 기기 경로)를 줬다. 파일은 이미 sandbox 에 있는데 실패만 돌려줬다 |
| 기기 python 오류(`init_import_site`, `No module named 'encodings'`, `xcrun: unable to load libxcrun`) | 7턴 10번 | 박소민 맥의 UserPc 셸 안에서 python 이 뜨지 않았다. 원인은 확인하지 못했다(아래 "확인되지 않은 것") |

- serial 날짜(46327)는 기기 python 으로 읽은 3번(54599, 54627, 54628)에서만 나왔다. python 이 안 떠서 모델이 xlsx 의 XML 을 직접 풀었기 때문이다. sandbox 의 openpyxl 로 읽은 30여 번에는 serial 이 한 번도 없었다(날짜는 `2026-11-01` 이나 datetime 으로 나왔다). 그래서 날짜를 바꿔 주는 새 읽기 도구는 만들지 않았다 — 가져오기만 제대로 되면 모델은 sandbox 에서 읽는다.
- 바꾼 것
  - xgen-workflow `editor/geny_bridge/user_pc.py` `_move_in_sandbox`(브랜치 `fix/connector-browser-guide` c19bdebe): 파일 하나를 가져오면서 `sandbox_path` 가 그 파일과 같은 확장자로 끝나면 그 이름의 파일로 놓는다. 그 이름의 폴더가 이미 있으면 그 안에 넣는다(mv 와 같다). 그 밖에는 지금처럼 폴더. 옮기지 못하면 실패 글에 파일이 지금 있는 sandbox 경로를 적는다. 결과 경로는 정규화한다(`…/workspace/./data/…` → `…/workspace/data/…`).
  - DeX `packages/protocol/src/agent-data.ts` `workspaceUpload`(1185242f): 작업 공간에 올리는 이름과 하위 폴더를 NFC 로 맞춘다. 모든 올리기(데스크톱 엔진의 CopyToWorkspace, 모바일, 채팅 첨부)가 이 한 곳을 지난다.
- 설정(박소민): fast-act-* workflow 는 `enable_memory` 가 꺼져 있어 매 턴 첫 요청이 5.3~6.0k 토큰으로 시작한다 — 앞 턴에 읽은 엑셀이 없으니 매 턴 다시 읽는다. 여러 턴에 걸친 등록이면 memory 를 켜야 "처음 한 번만 읽기" 가 가능하다. 켠 run(demo-test-20~28)은 둘째 턴부터 대부분 0~1번이었다.
- 한계: 목록 보기 → 가져오기 → python 의 3번은 남는다. 반영 뒤 같은 요청으로 턴당 파일 도구 수를 다시 세야 한다. 기기 python 오류는 그대로다.
- 테스트: xgen-workflow `tests/test_user_pc_host.py` 3개 추가(옮기기 스크립트를 실제 bash 로 돌림: 파일 이름, 이미 있는 폴더·보통 폴더·여러 파일, 옮기기 실패). 관련 테스트 110개 통과. DeX protocol 테스트 1개 추가, 374개 통과, typecheck 통과.

### 4d. DeX: 끝 이름만 준 트리 줄은 전체 경로로 보내라고 알린다 (완료)

- 근거: 끝 이름만 준 표준카테고리 줄의 실패는 3번이고 모두 10/23 오전 한 세션(demo-test-19, 54583·54585)이다. 엑셀에는 전체 경로(`문구/오피스>사무용품 전문관`)가 있었는데 LLM 이 줄였다. 전체 경로를 준 줄은 경로 때문에 실패한 적이 없다(실패 3번은 다른 칸 알림 2번, 이미 값이 든 표 칸을 고른 1번).
  - 실패 뒤의 흐름: "「사무용품 전문관」을 검색하고 적용해줘" → `고를 항목을 정하지 못했어요. 후보: 문구/오피스, 가전디지털, 생활용품` → LLM 이 "표준카테고리 조회 버튼을 눌러줘" 로 한 번 더 실패 → 그다음에 전체 경로로 성공.
  - 트리 고르기(`fast-act-voice.ts` `pickInTree`)는 보이는 항목 가운데 판단 모델이 고른다. 펼치지 않은 항목의 하위는 화면에 없어서, 끝 이름만으로는 맨 위에서 어느 항목인지 알 수 없다.
- 바꾼 것: 맨 위에서 못 골랐고 줄에 경로 구분(>)이 없으면, 결과 글에 "트리는 맨 위 항목부터 전체 경로로 보내 주세요(예: 「상위 > 하위」)" 를 붙인다(`fast-act-labels.ts` `treeMissNote`). 전체 경로를 준 줄은 예전 글 그대로다.
- 하지 않은 것
  - 트리를 하나씩 펼쳐 끝 이름 찾기: 맨 위 항목마다 펼치기·스냅샷에 0.5~1초가 들어 한 줄이 수십 초가 될 수 있다. 실패 근거가 한 세션 3번뿐이라 보류했다.
  - BrowserFill 설명의 BO 예시(협력사, 표준카테고리, `INNO-001_대표이미지.png`, 임시저장·승인요청)와 `popupSearchValue` 의 `/협력사|브랜드/`: 사이트 말이지만, 이것 때문에 실패한 기록이 없다. 예시는 LLM 이 줄을 쓰는 모양을 정하므로 바꾸려면 같은 요청으로 전후를 재야 한다. 정리할 때 함께 볼 것으로 남긴다.
- 테스트: `test/fast-act-labels.test.ts` 1개 추가. desktop 744개 중 738개 통과·실패 0(나머지는 건너뜀), typecheck·typecheck:node 통과.

## 측정 방법 — 반영 뒤 박소민 프롬프트 A 와 규칙 뺀 B 를 같은 요청으로

4단계의 목표는 "규칙 문장 없이도 같은 결과가 나오고 빨라진다" 이다. 반영(런타임 #174 릴리스와 휠 고정, xgen-workflow !2302 배포, DeX #235 빌드 설치)이 끝나면 아래대로 잰다. 파일은 `measure/` 에 있다.

| 파일 | 내용 |
|---|---|
| `prompt-a-baseline-28.txt` | 박소민의 마지막 기준 실행 `fast-act-baseline-28` 의 system_prompt 원문 |
| `prompt-b-no-rules.txt` | A 에서 위 표의 "범용 수정" 규칙을 빼고 업무 지시(역할·자료·주소, 필수 칸, 검색키워드·상세 작성, 임시저장, 답하는 법)만 남긴 판 |
| `measure-turns.sql` | 턴과 도구 기록을 한 줄에 하나씩 JSON 으로 내보낸다. 도구 입력은 내보내지 않는다(로그인 칸 값) |
| `measure-turns.mjs` | 내보낸 줄에서 턴마다 시간·LLM 호출·도구 쓰임을 세어 표로 찍는다. 도구 출력은 분류에만 쓰고 찍지 않는다 |

B 에서 뺀 것과 그것을 대신하는 수정: 한 번만 읽기(4f, memory), 한 번에 모아 입력(1·2단계, 4e), 결과로만 확인(1·2단계), 이미 그 값인 칸(4a), 카테고리 전체 경로(4d), 임시저장 뒤 창에서 멈춤(4g), 판매시작일(알림이 모델에 닿음). 결제수단 "전체"(4b)와 공급원가(4c)는 수정 없이 뺐다 — 그 칸의 결과를 따로 본다.

**설정**: 둘 다 `fast-act-baseline-28` 과 같게 — openrouter `qwen/qwen3.8-flash`, temperature 0, max_iterations 20, max_tokens 4096, thinking auto, tool_exposure hierarchy, memory_map 켬, enable_memory 끔, enable_compaction 끔. 프롬프트만 다르게 해서 workflow 두 개(예: `fast-act-measure-a`, `fast-act-measure-b`)를 만든다. enable_memory 를 켠 B 는 따로 세 번째 판(C)으로 잰다 — 두 변수를 섞지 않는다.

**자료 폴더**: 박소민과 같은 `new_product_v2`(엑셀, 이미지, 로그인 정보 파일). 로그인까지 재야 0·1·2단계의 효과가 보이고 기준선과 바로 비교된다. 다만 로그인 정보 파일을 읽은 출력은 지금처럼 dev DB 의 실행 기록에 평문으로 남는다. 남기지 않으려면 BO 에 미리 로그인해 두고 두 프롬프트의 첫 줄을 똑같이 "BO 는 DeX 브라우저에 로그인돼 있어" 로 바꾼다(이때는 로그인 구간이 빠져 기준선과 직접 비교할 수 없다).

**순서**: 판마다 새 대화에서 폴더를 연결하고, 다음 두 메시지를 그대로 보낸다.

1. `연결한 폴더의 신상품 자료를 읽고, 002번 상품 소개문과 검색키워드를 써 줘. 내 확인을 받아 백오피스에 상품 등록까지 해 줘.`
2. `진행해줘`

- 매번 같은 상태에서 시작한다: BO 로그아웃 상태(로그인은 DeX 안의 쿠키라 DeX 를 다시 켜면 풀린다), 열린 BO 탭 없음.
- 임시저장 뒤 BO 의 확인창은 4g 가 채팅 카드로 묻는다. 측정에서는 카드에서 거절한다 — 확인 버튼을 누르지 않으므로 저장되지 않는다. 승인요청 확인창이 카드로 오면 그것도 거절하고 기록한다(B 에는 "승인요청은 누르지 마" 가 없다).
- 카드가 떠 있는 동안 화면의 칸 값을 엑셀과 사람이 대조한다(정확성). 특히 결제수단·공급원가·판매시작일·표준카테고리·배송비정책.
- A, B 를 번갈아(A, B, A, B, …) 판마다 3번. 같은 판을 몰아 돌리면 시간대에 따른 OpenRouter 지연 차이가 판 차이로 보인다.

**세기**: 돌린 계정의 user_id 와 시작 시각으로 내보낸다. 내보낸 파일에는 자료 내용이 있으니 저장소 밖에 두고 다 본 뒤 지운다.

```bash
# go50901 의 cnpg 에서 읽기만 한다. 변수는 SQL 앞에 \set 으로 붙인다.
{ printf "\\\\set uid <user_id>\n\\\\set since '2026-10-27 01:00+00'\n\\\\set wf 'fast-act-measure-%%'\n"; cat measure-turns.sql; } \
  | ssh home 'ssh go50901 "kubectl -n xgen-system exec -i cnpg-cluster-1 -c postgres -- psql -U postgres -d plateerag -At"' > /tmp/spans.jsonl
node measure-turns.mjs /tmp/spans.jsonl            # 턴마다 한 줄 + workflow 마다 합
node measure-turns.mjs /tmp/spans.jsonl --iid conn-wf_…   # 한 대화만
```

열: 초(턴 전체), 도구 초(그중 Navigate·Fill), LLM 호출, 도구 호출, 요청 토큰(첫 호출·가장 큰 호출·캐시 읽기 합), Fill 횟수(결과의 줄: 실패·다시 함·이미 그 값), Fill 바로 뒤 Snapshot·FormValues, Snapshot, Interact, 파일 도구(엑셀 한 장을 읽어 낸 것이 몇 번째인지), 파일 실패 종류(4f 의 표와 같은 잣대), 도구 오류, 확인 카드 거절. 도구는 하나씩 도므로 "초 − 도구 초" 가 대략 LLM 과 하네스 시간이다(geny 경로는 LLM 호출별 시간을 남기지 않는다). DB 의 도구 출력이 약 4,000자에서 잘려 Fill 의 줄 수는 덜 셀 수 있다.

**기준선** — `fast-act-baseline-28`(A, 수정 전), 10/23 18:27~18:32 KST 한 번, trace 54682·54683. 54683 은 10/23 데모 영상의 그 턴이다(앞 18번 도구의 순서·시간이 영상과 같다).

| 턴 | 초 | 도구 초(Navigate·Fill) | LLM | 도구 | 요청 k토큰(첫/최대/캐시 읽기) | Fill(줄) | Fill 뒤 다시 읽기 | Snapshot | Interact | 파일 도구(엑셀까지) | 파일 실패 | 도구 오류 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 (자료 읽고 소개문) | 39.4 | 1.6 (0·0) | 5 | 4 | 5.6 / 9.9 / 23.6 | 0 | 0 | 0 | 0 | 4 (4번째) | 폴더 1 | 1 |
| 2 (진행해줘) | 257.0 | 135.6 (65.5·59.2) | 30 | 31 | 5.6 / 45.1 / 631.8 | 4 (31) | 1 | 5 | 8 | 6 (6번째) | 옮기기 1, 기타 1 | 5 |

- 둘째 턴 257초 가운데 도구가 136초, 나머지 121초가 LLM 30번과 하네스(한 번에 약 4초)다. 도구 시간의 대부분은 Navigate 3번(25.2·15.2(실패)·25.1초)과 Fill 4번(첫 번째 50.4초)이다.
- memory 가 꺼져 있어 둘째 턴이 엑셀을 처음부터 다시 읽었다(파일 도구 6번, 실패 2번).
- 두 턴 모두 상태가 `partial` 이다(둘 다 도구 오류가 있었다). 한 번뿐인 실행이라 흔들림의 크기는 모른다 — A 도 다시 돌리는 까닭이다.

## 에이전트 지침 제안 (BO 상품 등록 에이전트, 사이트 전용)

범용 수정과 별개로 이 에이전트의 system_prompt 에 넣을 문장. 영상 기준 도구 18회 → 5회 안팎.

1. "진행해줘" 뒤에는 앞 단계에서 읽은 엑셀 값을 그대로 쓴다. 폴더와 엑셀을 다시 읽지 않는다.
2. 이미지 파일은 이미지를 올리는 단계에서만 다룬다. 그 전에 복사하거나 옮기지 않는다.
3. BO 는 상품등록 주소로 바로 연다: `https://bo.x2bee.com/goods/goods-mgmt/general-goods-reg/`. 메뉴를 눌러 찾아가지 않는다.
4. 로그인 화면이 나오면 아이디·비밀번호 입력 두 개를 **한 응답에** 같이 보내고, 결과를 본 뒤 로그인 버튼을 누른다. 로그인 뒤 상품등록 주소를 다시 연다.
   - BrowserFill 은 쓰지 않는다: 공유 탭 전용이고 칸마다 판단 모델이 몇 초씩 돌며, 버튼은 누르지 않는다. 칸이 많은 상품 정보 입력에 쓴다.
5. 이미 열린 BO 탭이 있으면 새 탭을 만들지 말고 그 탭(page_id)을 쓴다. 로그인은 쿠키라 같은 DeX 안에서는 유지된다(DeX 를 다시 켜면 다시 로그인).

## 확인되지 않은 것

- 영상 당시 25.2초를 만든 리소스, Snapshot 7.7초의 원인.
- Qwen3.8 Flash(OpenRouter)가 한 응답에 여러 tool_call 을 실제로 내는지, upstream 캐시가 맞는지.
- 1단계 안내문 변경이 실제 모델 행동(BrowserFill 선택, 한 응답 다중 호출)을 바꾸는지 — 서버 반영 뒤 같은 요청으로 측정해야 한다.
- 2a: 로그아웃 상태에서 로그인 버튼 클릭이 메인 화면을 붙여 오는지. 모델이 붙은 화면을 쓰고 BrowserSnapshot 을 안 부르는지.
- 2b: 접기가 캐시 적중(`cache_read_tokens`)과 정확도에 주는 영향 — 같은 요청을 접기 전후로 돌려 비교.
- 4f: 박소민 맥의 UserPc 셸에서 python 이 뜨지 않은 까닭. 가두기 프로필(`workspace-shell.ts`)은 `/Library/Frameworks` 읽기를 허용하지만 `/Applications/Xcode.app` 은 허용하지 않는다 — `/usr/bin/python3` 이 Xcode 를 가리키면 xcrun 이 실패한다(이 맥의 engine 테스트에서도 같은 libxcrun 실패를 봤다). python.org 3.14 의 `init_import_site` 실패는 그 기기에서 재현해야 한다.
