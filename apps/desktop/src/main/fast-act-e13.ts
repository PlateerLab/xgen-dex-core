/**
 * E13 형식 — 말하는 도중 판단용 (sev docs/design/E13_REALTIME_FORMAT.md, 학습 행 sev.tasks.ui.rows13).
 *
 * state 는 화면이 먼저, 사용자 말이 마지막이다. 요소 질문의 선택지는 요소 번호만(이름·위치는 화면 줄).
 * 화면 줄 규칙은 학습 데이터와 글자까지 같아야 한다: 최대 60줄, 이름 32자, 3×3 위치, 읽는 순서(위→아래, 왼→오른).
 * DeX 고속 경로: DEX_FAST_ACT_FORMAT=e10 이면 예전(E10) 형식, 기본은 E13 (18120 이 E13 모델을 서빙).
 */
export const FORMAT: 'e10' | 'e13' = (process.env.DEX_FAST_ACT_FORMAT ?? 'e13') === 'e10' ? 'e10' : 'e13';

export const MAX_LINES = 60;
export const NAME_MAX = 32;
export const PICK_Q13 = 'Which listed screen element should be acted on (clicked or typed into) to carry out what the user said?';
export const READY_Q = 'Can the computer act on what the user has said so far?';
export const READY_OPTS: Record<string, string> = {
  act_now: 'yes — what to do is clear now',
  wait: 'not yet — the user has not finished saying what to do',
  not_ui: 'no screen action — a question, chat, or something to write',
};

export type ScreenRef = { ref: string; role: string; name: string; frame?: number[]; visible?: boolean };
/** text·ids 는 화면에 싣는 앞 60줄, all 은 읽는 순서의 전체(60줄이 넘으면 창으로 나눠 묻는다). */
export type Screen13 = { origin: string; text: string; ids: string[]; all: ScreenRef[]; size?: number[] };

export function position(f: number[], size: number[]): string {
  const x = (f[0] + f[2] / 2) / Math.max(size[0], 1);
  const y = (f[1] + f[3] / 2) / Math.max(size[1], 1);
  const v = y < 1 / 3 ? '위' : y < 2 / 3 ? '가운데' : '아래';
  const h = x < 1 / 3 ? '왼쪽' : x < 2 / 3 ? '가운데' : '오른쪽';
  return v === '가운데' && h === '가운데' ? '가운데' : `${h} ${v}`;
}

/**
 * 화면 줄 — rows13.Screen 과 같은 규칙. visible 이 있는 요소는 보이는 것만, 틀(frame)이 있으면 읽는 순서로.
 * head 는 정렬하지 않고 맨 앞에 둔다(화면 밖 조작 — 맥 앱 숨기기·발표 끝내기 같은 시스템 후보).
 */
export function buildScreen(origin: string, refs: ScreenRef[], size?: number[], head: ScreenRef[] = []): Screen13 {
  let keys = refs.filter((r) => r.visible !== false);
  const framed = size && keys.some((r) => r.frame);
  if (framed) {
    keys = [...keys].sort((a, b) => {
      const fa = a.frame ?? [1e9, 1e9];
      const fb = b.frame ?? [1e9, 1e9];
      return fa[1] - fb[1] || fa[0] - fb[0];
    });
  }
  keys = [...head, ...keys];
  const listed = keys.slice(0, MAX_LINES);
  const lines = listed.map((r) => {
    let name = `"${r.name ?? ''}"`;
    if (name.length > NAME_MAX + 2) name = name.slice(0, NAME_MAX + 1) + '…"';
    const pos = framed && r.frame ? ` | ${position(r.frame, size!)}` : '';
    return `${r.ref} | ${r.role} | ${name}${pos}`;
  });
  return { origin, text: lines.join('\n'), ids: listed.map((r) => r.ref), all: keys, size };
}

/**
 * 60줄이 넘는 화면을 읽는 순서대로 이어진 창 몇 개로 나눈다(크기를 고르게: 78 → 39 + 39).
 * 학습 때도 60줄 넘는 화면은 목표가 들어간 60줄 창으로 잘라 보였다 — 창마다 물어도 학습 분포 안이다.
 */
export function windowsOf<T>(items: T[], max = MAX_LINES): T[][] {
  if (items.length <= max) return [items];
  const n = Math.ceil(items.length / max);
  const size = Math.ceil(items.length / n);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 지정한 화면으로 만든 state — 창별·결승 질문용. */
export function stateWith(s: Screen13, said: string): string {
  return `Page: ${s.origin}\nScreen:\n${s.text}\nUser said: ${said}`;
}

let current: Screen13 | null = null;
/** 에이전트가 화면을 새로 읽을 때 정한다 — state 와 요소 질문이 이 화면을 쓴다. */
export function setScreen(s: Screen13 | null): void {
  current = s;
}
export function screen(): Screen13 | null {
  return FORMAT === 'e13' ? current : null;
}
export function state13(said: string): string | null {
  const s = screen();
  return s ? stateWith(s, said) : null;
}
