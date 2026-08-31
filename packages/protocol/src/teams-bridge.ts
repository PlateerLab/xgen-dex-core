/**
 * teams-bridge — [Agent] 탭과 [Teams] 탭 **사이를 건너는 것들**의 형식.
 *
 * 두 탭은 일부러 분리되어 있다 (에이전트 대화는 1:1 작업 세션, Teams 는 N:N 사회적
 * 공간이라 한 목록에 섞으면 둘 다 망가진다). 대신 경계에 문을 둔다. 이 파일은 그
 * 문을 드나드는 두 가지의 **형식만** 정의한다:
 *
 *   ① Teams → Agent : 방 대화를 에이전트 프롬프트에 실어 보내는 봉투
 *                     (`<xgen_teams_context>` … `</xgen_teams_context>`)
 *   ② Agent → Teams : 에이전트 산출물을 방에 붙일 때 남기는 출처 표식
 *                     (첫 줄의 `⟨xgen:…⟩` 태그)
 *
 * 왜 봉투인가 — 브라우저 컨텍스트(`core/browser.ts`)가 이미 검증한 방식이다.
 * 사용자가 친 문장은 그대로 두고 기계용 정보를 봉투에 담아 앞에 붙이면,
 * 화면에는 사용자의 문장만 보이고 서버/LLM 만 봉투를 본다. 히스토리를 다시
 * 불러올 때는 `stripTeamsContext` 로 떼어낸다.
 *
 * 왜 출처 표식이 **본문 첫 줄**인가 — 서버 메시지에는 커넥터가 쓸 수 있는
 * 메타데이터 칸이 없다 (`SendMessageRequest` 는 content/attachments/reply_to_id
 * 뿐). 그래서 본문에 싣되, 웹 Teams 처럼 이 태그를 모르는 클라이언트에서도
 * **읽히는 문장**이 되도록 사람이 읽을 수 있는 문구를 함께 둔다. 커넥터는 그
 * 줄을 숨기고 [원본 대화 보기] 카드로 그린다.
 *
 * 이 파일은 순수하다 — Electron/React/브릿지를 모르고, node 에서 그대로
 * 단위 테스트된다 (`test/teams-bridge.test.ts`).
 */
import type { TeamsMessage } from './types';

// ─────────────────────────────────────────────────────────────
// ① Teams → Agent : 컨텍스트 봉투
// ─────────────────────────────────────────────────────────────

export const TEAMS_CONTEXT_START = '<xgen_teams_context>';
export const TEAMS_CONTEXT_END = '</xgen_teams_context>';

/**
 * 봉투에 담을 수 있는 최대 글자 수.
 *
 * 서버가 provider 별 정밀 절단을 하긴 하지만(execution_service), 그건 **잘라도
 * 되는 것**을 자르는 것이지 우리가 무한정 보내도 된다는 뜻이 아니다. 방 하나의
 * 잡담 200건이 통째로 실려 나가면 토큰 비용이 사용자 모르게 튄다. 여기서 먼저
 * 막고, 잘렸다는 사실을 봉투 안에 남겨 모델이 "앞부분이 없다" 를 알게 한다.
 */
export const TEAMS_CONTEXT_MAX_CHARS = 60_000;

/** 봉투에 실리는 메시지 한 줄. 화면 표시용 필드는 싣지 않는다. */
export interface TeamsContextEntry {
  at: string;
  from: string;
  /** user | agent | router | system — 누가 한 말인지 모델이 구분해야 한다. */
  role: string;
  text: string;
  /** 첨부가 있으면 파일 이름만. 본문은 서버가 따로 붙인다. */
  files?: string[];
}

export interface TeamsContextRoom {
  id: string;
  name: string;
  isDirect: boolean;
}

/** 봉투 안의 JSON 모양. 서버가 아니라 **모델**이 읽는다. */
export interface TeamsContextEnvelope {
  source: 'xgen-teams';
  room: TeamsContextRoom;
  /** 실제로 실린 메시지 수. 사용자에게 고지한 수와 같아야 한다. */
  count: number;
  /** 글자 수 상한에 걸려 앞쪽(과거)이 잘렸는가. */
  truncated: boolean;
  messages: TeamsContextEntry[];
}

/**
 * 방 메시지를 봉투용으로 줄인다.
 *
 * · 낙관적(아직 서버가 모르는) 메시지는 제외 — 호출자가 걸러 넘긴다.
 * · 시스템 안내(입장/퇴장)는 남긴다. "누가 언제 들어왔나" 가 요약에 필요하다.
 * · 빈 본문이면서 첨부도 없는 메시지는 버린다 (모델에게 줄 게 없다).
 */
export function toContextEntries(messages: TeamsMessage[]): TeamsContextEntry[] {
  const out: TeamsContextEntry[] = [];
  for (const m of messages) {
    const files = (m.attachments ?? []).map((a) => a.filename).filter(Boolean);
    const text = (m.content ?? '').trim();
    if (!text && files.length === 0) continue;
    out.push({
      at: m.createdAt,
      from: m.senderName,
      role: m.senderType,
      text,
      ...(files.length > 0 ? { files } : {}),
    });
  }
  return out;
}

/**
 * 봉투를 만든다. 상한을 넘으면 **가장 오래된 것부터** 버린다 — 대화는 최근이
 * 문맥이고, 요약을 시켜도 최근이 결론에 가깝다.
 */
export function buildTeamsContext(
  room: TeamsContextRoom,
  entries: TeamsContextEntry[],
  maxChars: number = TEAMS_CONTEXT_MAX_CHARS,
): string {
  let kept = entries;
  let truncated = false;
  const render = (list: TeamsContextEntry[], cut: boolean): string => {
    const envelope: TeamsContextEnvelope = {
      source: 'xgen-teams',
      room,
      count: list.length,
      truncated: cut,
      messages: list,
    };
    return JSON.stringify(envelope);
  };
  let json = render(kept, truncated);
  // 한 줄씩 앞에서 덜어낸다. 이진 탐색을 쓸 만큼 큰 목록이 아니고(최대 200건),
  // 한 건이 통째로 상한을 넘는 병적인 경우에도 빈 배열로 수렴해 멈춘다.
  while (json.length > maxChars && kept.length > 0) {
    kept = kept.slice(1);
    truncated = true;
    json = render(kept, truncated);
  }
  return `${TEAMS_CONTEXT_START}\n${json}\n${TEAMS_CONTEXT_END}`;
}

/**
 * 사용자가 친 문장 **앞에** 봉투를 붙인다. 봉투가 비었으면 입력을 그대로 둔다
 * (붙일 게 없는데 구분자만 남기면 모델이 빈 컨텍스트를 사실로 오해한다).
 */
export function prependTeamsContext(input: string, envelope: string): string {
  if (!envelope) return input;
  return `${envelope}\n${input}`;
}

/**
 * 화면에 보이기 전에 봉투를 떼어낸다 — 히스토리(io-logs)를 다시 불러오면
 * 서버가 저장해 둔 **봉투 포함 원문**이 오기 때문이다. 브라우저 컨텍스트와
 * 같은 이유·같은 처리(`stripBrowserContext`).
 */
export function stripTeamsContext(text: string): string {
  if (typeof text !== 'string' || !text.startsWith(TEAMS_CONTEXT_START)) return text;
  const end = text.indexOf(TEAMS_CONTEXT_END);
  if (end < 0) return text;
  return text.slice(end + TEAMS_CONTEXT_END.length).replace(/^\r?\n/, '');
}

// ─────────────────────────────────────────────────────────────
// ② Agent → Teams : 출처 표식
// ─────────────────────────────────────────────────────────────

/** 공유된 메시지가 어디서 왔는지. */
export interface TeamsShareRef {
  /** agent = 에이전트 답변/대화, file = 워크스페이스 파일 */
  kind: 'agent' | 'file';
  /** 사람이 읽는 출처 이름 (에이전트 이름 등). */
  label: string;
  /** kind==='agent' 일 때 원본 대화로 돌아가기 위한 좌표. */
  workflowId?: string;
  interactionId?: string;
}

/** 첫 줄 끝에 붙는 기계용 태그. 프로즈가 아니라 **이 태그**가 파싱 기준이다. */
const SHARE_TAG = /⟨xgen:([^⟩]*)⟩\s*$/;

function shareProse(ref: TeamsShareRef): string {
  return ref.kind === 'file'
    ? `📎 ${ref.label} · XGEN 워크스페이스에서 공유`
    : `🤖 ${ref.label} · XGEN 에이전트 답변 공유`;
}

/**
 * 출처 표식 한 줄을 만든다.
 *
 * 모양: `🤖 사내문서QA · XGEN 에이전트 답변 공유 ⟨xgen:k=agent&l=…&w=…&i=…⟩`
 *
 * 앞쪽 문장은 **사람용**이고 이 태그를 모르는 클라이언트(웹 Teams)에서도 그대로
 * 읽힌다. 뒤쪽 태그가 **기계용**이고, 값은 전부 percent-encoding 하므로 이름에
 * `·` 나 `⟨⟩` 가 들어가도 파싱이 깨지지 않는다. URLSearchParams 는 node 와
 * 렌더러 양쪽에 있어 이 파일의 순수성을 해치지 않는다.
 */
export function formatShareHeader(ref: TeamsShareRef): string {
  const params = new URLSearchParams();
  params.set('k', ref.kind);
  params.set('l', ref.label);
  if (ref.workflowId) params.set('w', ref.workflowId);
  if (ref.interactionId) params.set('i', ref.interactionId);
  return `${shareProse(ref)} ⟨xgen:${params.toString()}⟩`;
}

/** 표식 + 본문을 하나의 메시지 본문으로 합친다. */
export function buildSharedMessage(ref: TeamsShareRef, body: string): string {
  const text = body.trim();
  const header = formatShareHeader(ref);
  return text ? `${header}\n\n${text}` : header;
}

/** 공유 메시지를 해석한 결과 — 표식과 본문이 분리된 상태. */
export interface ParsedSharedMessage {
  ref: TeamsShareRef;
  body: string;
}

/**
 * 메시지 본문에서 출처 표식을 떼어낸다. 표식이 없으면 null (평범한 사람 메시지).
 *
 * 첫 줄만 본다 — 본문 아무 데나 있는 비슷한 문자열을 표식으로 오인하면 사람이
 * 쓴 글이 잘려 나간다.
 */
export function parseSharedMessage(content: string): ParsedSharedMessage | null {
  if (typeof content !== 'string' || !content) return null;
  const nl = content.indexOf('\n');
  const first = nl < 0 ? content : content.slice(0, nl);
  const match = SHARE_TAG.exec(first);
  if (!match) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(match[1] ?? '');
  } catch {
    return null;
  }
  const kind = params.get('k') === 'file' ? 'file' : 'agent';
  const label = params.get('l') ?? '';
  if (!label) return null;
  const rest = nl < 0 ? '' : content.slice(nl + 1);
  return {
    ref: {
      kind,
      label,
      workflowId: params.get('w') || undefined,
      interactionId: params.get('i') || undefined,
    },
    // 표식 다음의 빈 줄 하나는 표식이 만든 것이므로 함께 걷어낸다.
    body: rest.replace(/^\r?\n/, ''),
  };
}

/**
 * 공유 표식을 지운 순수 본문. 방 목록 미리보기·검색·안 읽음 계산처럼 "본문만"
 * 필요한 곳에서 쓴다.
 */
export function shareBodyOf(content: string): string {
  return parseSharedMessage(content)?.body ?? content;
}
