/**
 * 사용자가 읽을 수 있는 오류 — 코드 체계.
 *
 * ## 왜 필요한가
 *
 * 실패는 어디서든 난다(서버 노드, 게이트웨이, 네트워크, 이 앱). 그런데 지금까지
 * 화면에 나간 것은 그 실패의 **기술 원문**이었다: `stream /api/agentflow/execute/
 * based-id/stream → 502`. 이 문장은 일반 사용자에게 아무 정보도 주지 못한다 —
 * 무엇이 잘못됐는지, 자기가 뭘 해야 하는지, 기다리면 되는지 알 수 없다. 지원에
 * 문의할 때 무엇을 말해야 하는지조차 알 수 없다.
 *
 * 그래서 모든 실패를 **하나의 구조**로 옮긴다:
 *
 *   코드   지원에 말할 식별자 (XGEN-921)
 *   제목   무슨 일이 있었나 — 사용자의 말로
 *   안내   이제 무엇을 하면 되나
 *   원문   기술 상세 — 접어 두고, 개발자·지원이 펼쳐 본다
 *
 * ## 코드 공간
 *
 * 001~599 는 **서버(xgen-workflow)의 것**이다. 서버는 이미 실행 중 오류를
 * `[ERRORnnn: 사용자용 메시지]` 마커로 내보내고 있고(배포 워크플로우는 관리자가
 * 코드별 문구를 덮어쓸 수도 있다), 그 메시지는 이미 사용자용 한국어다. 클라이언트가
 * 할 일은 마커를 **알아보고 코드와 메시지를 분리해 보여주는 것**이지, 새로 쓰는 게
 * 아니다. 예전에는 마커를 그대로 본문에 흘려보내 `[ERROR304: …]` 가 날것으로 보였다.
 *
 * 9xx 는 **접속·전송 계층**, 즉 서버가 말할 기회조차 없었던 실패의 몫이다. 서버가
 * 쓰지 않는 범위라 충돌하지 않는다.
 *
 * @see xgen-workflow/controller/helper/utils/workflow_helpers.py (ERROR_CODE_PATTERN)
 */

/** 사용자가 [정지]를 눌러 턴이 끊겼을 때의 문구 — 모든 표면이 이 하나를 쓴다. */
export const INTERRUPTED_TEXT = '작업이 중단되었습니다';

export interface XgenErrorInfo {
  /** 지원 문의용 식별자. 예: `XGEN-921`. */
  code: string;
  /** 사용자용 한 줄 — 무엇이 잘못됐는가. */
  title: string;
  /** 사용자가 지금 할 수 있는 일. 할 수 있는 게 없으면 생략. */
  hint?: string;
  /** 기술 원문(상태 코드·스택·응답 본문). 화면에서는 접어 둔다. */
  detail?: string;
  /** 같은 요청을 다시 해 볼 만한가 — UI 가 [다시 시도] 를 붙일지 정한다. */
  retryable: boolean;
}

/** 서버가 실행 중 오류에 붙이는 마커. `[ERROR510: 문서 검색 중 …]` */
export const SERVER_ERROR_MARKER = /\[ERROR(\d{3}):\s*([^\]]+)\]/;

/** 전송·클라이언트 계층 코드 (9xx — 서버가 쓰지 않는 범위). */
export const TRANSPORT_CODES = {
  UNKNOWN: 'XGEN-900',
  OFFLINE: 'XGEN-901',
  TIMEOUT: 'XGEN-902',
  BAD_REQUEST: 'XGEN-910',
  UNAUTHORIZED: 'XGEN-911',
  FORBIDDEN: 'XGEN-912',
  NOT_FOUND: 'XGEN-913',
  TOO_LARGE: 'XGEN-915',
  RATE_LIMITED: 'XGEN-916',
  CLIENT: 'XGEN-919',
  SERVER: 'XGEN-920',
  GATEWAY: 'XGEN-921',
  SERVER_OTHER: 'XGEN-929',
} as const;

/** HTTP 상태 하나를 코드·문구로 옮긴다. */
export function describeHttpStatus(status: number): Omit<XgenErrorInfo, 'detail'> {
  switch (status) {
    case 400:
    case 422:
      return {
        code: TRANSPORT_CODES.BAD_REQUEST,
        title: '요청 내용을 서버가 이해하지 못했습니다.',
        hint: '입력한 내용을 줄이거나 첨부를 빼고 다시 보내 보세요. 계속되면 관리자에게 이 코드를 알려 주세요.',
        retryable: false,
      };
    case 401:
      return {
        code: TRANSPORT_CODES.UNAUTHORIZED,
        title: '로그인이 만료되었습니다.',
        hint: '다시 로그인한 뒤 이어서 대화해 주세요. 지금까지의 대화는 남아 있습니다.',
        retryable: false,
      };
    case 403:
      return {
        code: TRANSPORT_CODES.FORBIDDEN,
        title: '이 작업을 수행할 권한이 없습니다.',
        hint: '이 에이전트를 쓸 수 있는 권한이 계정에 있는지 관리자에게 확인해 주세요.',
        retryable: false,
      };
    case 404:
      return {
        code: TRANSPORT_CODES.NOT_FOUND,
        title: '대상을 찾을 수 없습니다.',
        hint: '에이전트가 삭제되었거나 이름이 바뀌었을 수 있습니다. 목록에서 다시 선택해 주세요.',
        retryable: false,
      };
    case 408:
      return {
        code: TRANSPORT_CODES.TIMEOUT,
        title: '서버가 제때 응답하지 않았습니다.',
        hint: '잠시 후 다시 시도해 주세요.',
        retryable: true,
      };
    case 413:
      return {
        code: TRANSPORT_CODES.TOO_LARGE,
        title: '보낸 내용이 너무 큽니다.',
        hint: '첨부 파일이나 이미지를 줄여서 다시 보내 주세요.',
        retryable: false,
      };
    case 429:
      return {
        code: TRANSPORT_CODES.RATE_LIMITED,
        title: '요청이 너무 잦아 잠시 제한되었습니다.',
        hint: '30초쯤 기다렸다가 다시 시도해 주세요.',
        retryable: true,
      };
    case 500:
      return {
        code: TRANSPORT_CODES.SERVER,
        title: '서버에서 오류가 발생했습니다.',
        hint: '잠시 후 다시 시도해 주세요. 계속되면 관리자에게 이 코드를 알려 주세요.',
        retryable: true,
      };
    case 502:
    case 503:
    case 504:
      return {
        code: TRANSPORT_CODES.GATEWAY,
        title: '서버에 연결하지 못했습니다.',
        hint: '서버가 재시작 중이거나 잠시 응답할 수 없는 상태입니다. 1~2분 뒤에 다시 시도해 주세요.',
        retryable: true,
      };
    default:
      if (status >= 500) {
        return {
          code: TRANSPORT_CODES.SERVER_OTHER,
          title: '서버에서 오류가 발생했습니다.',
          hint: '잠시 후 다시 시도해 주세요.',
          retryable: true,
        };
      }
      return {
        code: TRANSPORT_CODES.CLIENT,
        title: '요청을 처리하지 못했습니다.',
        hint: '잠시 후 다시 시도해 주세요. 계속되면 관리자에게 이 코드를 알려 주세요.',
        retryable: false,
      };
  }
}

/**
 * 서버 마커가 들어 있는 문자열을 코드·메시지로 가른다.
 *
 * 서버 메시지는 **이미 사용자용 한국어**이므로 다시 쓰지 않는다 — 그대로 제목으로
 * 올리고, 코드만 분리해 붙인다(관리자가 배포 워크플로우에서 문구를 덮어쓴 경우도
 * 그 문구가 그대로 존중된다).
 */
export function parseServerErrorMarker(text: string): { code: string; message: string } | null {
  const m = SERVER_ERROR_MARKER.exec(String(text ?? ''));
  if (!m) return null;
  return { code: `XGEN-${m[1]}`, message: m[2].trim() };
}

/** 마커를 걷어낸 나머지 본문(있으면). 서버가 마커 앞뒤에 설명을 덧붙이는 경우가 있다. */
function stripMarker(text: string): string {
  return String(text ?? '')
    .replace(new RegExp(SERVER_ERROR_MARKER.source, 'g'), '')
    .trim();
}

/** ApiError 처럼 status 를 실은 오류인지. (instanceof 는 번들 경계를 넘지 못한다) */
function statusOf(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number' && s >= 100 && s < 600) return s;
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err ?? '');
}

/** 응답 본문에서 서버가 남긴 설명을 찾는다 (JSON `detail`/`message`, 또는 평문). */
function bodyText(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const body = (err as { body?: unknown }).body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const d = parsed?.detail ?? parsed?.message ?? parsed?.error;
      if (typeof d === 'string') return d;
    } catch {
      /* 평문 본문 — 그대로 쓴다 */
    }
    return body;
  }
  return '';
}

/** 네트워크 자체가 안 된 실패인지 (fetch 는 TypeError 로 던진다). */
function looksOffline(err: unknown, message: string): boolean {
  if (err instanceof TypeError) return true;
  return /failed to fetch|networkerror|network request failed|econnrefused|enotfound|eai_again|ehostunreach|socket hang up/i.test(
    message,
  );
}

/**
 * 무엇이 왔든 사용자에게 보여줄 수 있는 형태로 옮긴다.
 *
 * 우선순위: 서버 마커(가장 구체적) → HTTP 상태 → 네트워크/타임아웃 → 알 수 없음.
 * 원문은 언제나 `detail` 에 보존한다 — 화면에서 지우는 게 아니라 **접는다**.
 */
export function describeError(err: unknown): XgenErrorInfo {
  const message = messageOf(err);
  const body = bodyText(err);
  const detail = [message, body].filter(Boolean).join('\n').trim() || undefined;

  // 1) 서버가 코드를 붙여 보냈다면 그 판정이 가장 정확하다 (본문 쪽도 본다).
  const marked = parseServerErrorMarker(message) ?? parseServerErrorMarker(body);
  if (marked) {
    return {
      code: marked.code,
      title: marked.message,
      detail,
      // 재시도 안내는 서버 문구가 이미 담고 있다 — 중복해서 덧붙이지 않는다.
      retryable: /다시 시도|잠시 후/.test(marked.message),
    };
  }

  // 2) HTTP 상태 — 게이트웨이 502 처럼 서버가 말할 기회조차 없던 경우.
  const status = statusOf(err);
  if (status !== null) {
    const base = describeHttpStatus(status);
    // 서버가 본문에 사람이 읽을 설명을 담았다면 그것을 제목으로 올린다.
    const explained = stripMarker(body);
    const useBody =
      explained &&
      explained.length <= 200 &&
      /[가-힣]/.test(explained) &&
      !/^\s*[{[<]/.test(explained);
    return { ...base, title: useBody ? explained : base.title, detail };
  }

  // 3) 네트워크가 아예 닿지 않았다.
  if (looksOffline(err, message)) {
    return {
      code: TRANSPORT_CODES.OFFLINE,
      title: '서버에 연결할 수 없습니다.',
      hint: '네트워크 연결과 서버 주소를 확인한 뒤 다시 시도해 주세요.',
      detail,
      retryable: true,
    };
  }

  // 4) 시간 초과 (사용자가 누른 [정지]는 오류가 아니므로 호출부에서 이미 걸러진다).
  if (/timeout|timed out|시간이 초과|ETIMEDOUT/i.test(message)) {
    return {
      code: TRANSPORT_CODES.TIMEOUT,
      title: '응답을 기다리다 시간이 초과되었습니다.',
      hint: '잠시 후 다시 시도해 주세요. 질문이 길면 나눠서 물어보면 더 잘 됩니다.',
      detail,
      retryable: true,
    };
  }

  // 5) 정체를 모르는 실패 — 원문은 접어 두고, 코드로 추적할 수 있게 한다.
  return {
    code: TRANSPORT_CODES.UNKNOWN,
    title: '예기치 않은 오류가 발생했습니다.',
    hint: '잠시 후 다시 시도해 주세요. 계속되면 아래 코드와 함께 관리자에게 알려 주세요.',
    detail,
    retryable: true,
  };
}

/**
 * 스트림의 `type:"error"` 프레임 본문을 옮긴다.
 *
 * 서버 실행 중 오류라 대개 마커가 들어 있다. 마커가 없으면 그 문장을 그대로 제목으로
 * 쓰되(서버가 사용자용으로 쓴 문장일 수 있다), 기계적인 문자열이면 일반 문구로 덮는다.
 */
export function describeStreamError(detail: string): XgenErrorInfo {
  const text = String(detail ?? '').trim();
  const marked = parseServerErrorMarker(text);
  if (marked) {
    const rest = stripMarker(text);
    return {
      code: marked.code,
      title: marked.message,
      detail: rest && rest !== marked.message ? `${text}` : text,
      retryable: /다시 시도|잠시 후/.test(marked.message),
    };
  }
  // 사람이 읽는 문장으로 보이는가.
  //
  // **한글이 있어야 한다**: 이 파이프라인에서 사용자에게 보여줄 문구는 서버가 쓴
  // 한국어뿐이고, 라틴 문자만으로 된 문자열(`Execution failed: 502`)은 예외 없이
  // 기술 부산물이다. 그 조건이 없으면 영문 조각이 "짧으니 사람 문장" 으로 통과한다.
  const humane =
    text.length > 0 &&
    text.length <= 200 &&
    /[가-힣]/.test(text) &&
    !/^\s*[{[<]/.test(text) &&
    !/\bat \w+.*:\d+:\d+/.test(text) &&
    !/^[A-Za-z]+Error:/.test(text) &&
    !/https?:\/\//.test(text);
  if (humane) {
    return {
      code: TRANSPORT_CODES.UNKNOWN,
      title: text,
      detail: text,
      retryable: /다시 시도|잠시 후/.test(text),
    };
  }
  return {
    code: TRANSPORT_CODES.UNKNOWN,
    title: '응답을 생성하지 못했습니다.',
    hint: '잠시 후 다시 시도해 주세요. 계속되면 아래 코드와 함께 관리자에게 알려 주세요.',
    detail: text || undefined,
    retryable: true,
  };
}

/**
 * 마크다운/평문 한 덩어리로 — 리치 UI 가 없는 표면(CLI·VSCode·알림)용.
 * 원문은 넣지 않는다: 여기서까지 원문을 흘리면 애초에 고치려던 그 화면이 된다.
 */
export function formatErrorLine(info: XgenErrorInfo): string {
  return info.hint ? `${info.title} (${info.code})\n${info.hint}` : `${info.title} (${info.code})`;
}
