/**
 * 턴 준비 단계. 답의 첫 글자 전에 서버가 하는 준비를 한 줄씩 보이는 규칙.
 *
 * 채팅을 보내면 서버(xgen-workflow)는 런타임을 부르기 전에 이 사용자의 실행 환경(Sandbox 워커)을
 * 확보하고, 워크스페이스를 붙이고(보관본·색인 복원), 설치했던 패키지를 다시 깔고, 기억을 연다.
 * 워커 파드를 새로 띄우면 수십 초가 걸리는데, 그동안 화면에는 커서나 점만 있어 멈춘 것인지 고장인지
 * 알 수 없었다. 서버가 단계마다 `turn_phase` 를 보내고(2026-10-20), 모든 앱이 이 규칙으로 같은 줄을
 * 그린다. 모양은 작업 과정 타임라인의 도구 줄과 같다.
 *
 * - 0.7초 안에 끝나는 단계는 보이지 않는다. 워커가 이미 떠 있는 턴은 예전처럼 커서만 보인다.
 * - 답이 한 글자라도 오거나 도구가 하나라도 돌면 이 줄들은 물러난다(로딩 표시일 뿐이다).
 *   서버도 이 알림을 기록하지 않으므로, 대화를 다시 열었을 때의 모습과 같다.
 * - 웹(xgen-frontend main-chat-current turn-phases.ts)과 같은 문구·같은 경계다.
 */
import type { ToolIcon } from './process-timeline';

export type TurnPhaseName = 'sandbox' | 'workspace' | 'packages' | 'memory';
export type TurnPhaseState = 'start' | 'done' | 'retry' | 'error';

/** 서버가 보낸 준비 단계 알림 하나. */
export interface TurnPhaseSignal {
  phase: TurnPhaseName;
  /** start · done · retry(붙기를 다시 시도한다) · error(끝내 못 붙었다, 턴은 계속된다). */
  state: TurnPhaseState;
  /** done · retry · error 에서 그 단계에 걸린 시간. */
  elapsedMs?: number;
  /** 몇 번째 시도인가(1부터). */
  attempt?: number;
  /** 시도 상한. */
  attempts?: number;
}

/** 화면의 한 줄. run 은 하는 중, ok 는 끝남, retry 는 다시 시도하는 중, err 는 끝내 못 함. */
export interface TurnPhaseRow {
  phase: TurnPhaseName;
  state: 'run' | 'ok' | 'retry' | 'err';
  startedAt: number;
  durationMs?: number;
  attempt?: number;
  attempts?: number;
}

const PHASES: readonly TurnPhaseName[] = ['sandbox', 'workspace', 'packages', 'memory'];
const STATES: readonly TurnPhaseState[] = ['start', 'done', 'retry', 'error'];

/**
 * `turn_phase` payload → 알림. 그릴 수 없는 값(모르는 단계·상태)이면 null 이다. 서버의 화이트리스트
 * (`phase`·`state`·`elapsed_ms`·`attempt`·`attempts`)만 읽는다.
 */
export function parseTurnPhase(raw: unknown): ({ kind: 'phase' } & TurnPhaseSignal) | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const phase = PHASES.find((p) => p === r.phase);
  const state = STATES.find((s) => s === r.state);
  if (!phase || !state) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const out: { kind: 'phase' } & TurnPhaseSignal = { kind: 'phase', phase, state };
  const elapsedMs = num(r.elapsed_ms);
  const attempt = num(r.attempt);
  const attempts = num(r.attempts);
  if (elapsedMs !== undefined) out.elapsedMs = elapsedMs;
  if (attempt !== undefined) out.attempt = attempt;
  if (attempts !== undefined) out.attempts = attempts;
  return out;
}

/** 이만큼 넘게 걸린 단계만 보인다. 도구 줄의 "실행 중" 기준과 같다(번쩍이지 않게). */
export const PHASE_VISIBLE_MS = 700;

/** 알림 하나를 줄 목록에 반영한다. 같은 단계는 한 줄이다(다시 시도하면 그 줄이 다시 돈다). */
export function applyTurnPhase(
  rows: readonly TurnPhaseRow[],
  signal: TurnPhaseSignal,
  now: number,
): TurnPhaseRow[] {
  const i = rows.findIndex((r) => r.phase === signal.phase);
  const prev = i >= 0 ? rows[i] : undefined;
  let next: TurnPhaseRow;
  if (signal.state === 'start') {
    next = { phase: signal.phase, state: 'run', startedAt: now, attempt: signal.attempt, attempts: prev?.attempts };
  } else {
    const startedAt = prev?.startedAt ?? now - (signal.elapsedMs ?? 0);
    next = {
      phase: signal.phase,
      state: signal.state === 'done' ? 'ok' : signal.state === 'retry' ? 'retry' : 'err',
      startedAt,
      durationMs: signal.elapsedMs ?? Math.max(0, now - startedAt),
      attempt: signal.attempt ?? prev?.attempt,
      attempts: signal.attempts ?? prev?.attempts,
    };
  }
  if (i < 0) return [...rows, next];
  const out = rows.slice();
  out[i] = next;
  return out;
}

/** 지금 보일 줄. 빨리 끝난 단계·막 시작한 단계는 뺀다. 다시 시도·실패는 늘 보인다. */
export function visiblePhaseRows(rows: readonly TurnPhaseRow[], now: number): TurnPhaseRow[] {
  return rows.filter((r) => {
    if (r.state === 'retry' || r.state === 'err') return true;
    if (r.state === 'run') return now - r.startedAt >= PHASE_VISIBLE_MS;
    return (r.durationMs ?? 0) >= PHASE_VISIBLE_MS;
  });
}

/** 아직 안 보이는 줄이 보이게 될 때까지 남은 시간(ms). 그럴 줄이 없으면 null. 그 순간에 한 번 다시 그린다. */
export function nextPhaseReveal(rows: readonly TurnPhaseRow[], now: number): number | null {
  let soonest: number | null = null;
  for (const r of rows) {
    if (r.state !== 'run') continue;
    const left = r.startedAt + PHASE_VISIBLE_MS - now;
    if (left > 0 && (soonest === null || left < soonest)) soonest = left;
  }
  return soonest;
}

/**
 * "답변을 준비하고 있습니다" 줄을 이을 때인가. 모든 단계가 끝났고(하는 중·다시 시도가 없다), 마지막이
 * 끝난 지 {@link PHASE_VISIBLE_MS} 가 지났을 때다. 단계 사이의 짧은 틈에 줄이 번쩍이지 않게 한다.
 */
export function awaitingAnswer(rows: readonly TurnPhaseRow[], now: number): boolean {
  if (rows.length === 0 || rows.some((r) => r.state === 'run' || r.state === 'retry')) return false;
  return now - phasesSettledAt(rows) >= PHASE_VISIBLE_MS;
}

/** 마지막 단계가 끝난 시각("답변을 준비하고 있습니다" 줄의 경과를 여기서 센다). */
export function phasesSettledAt(rows: readonly TurnPhaseRow[]): number {
  return rows.length ? Math.max(...rows.map((r) => r.startedAt + (r.durationMs ?? 0))) : 0;
}

/** 준비 단계마다의 이름표(하는 중 · 끝남 · 다시 시도 · 못 함). 웹과 같은 문구다. */
const LABELS: Record<TurnPhaseName, Record<TurnPhaseRow['state'], string>> = {
  sandbox: {
    run: 'Sandbox를 불러오고 있습니다',
    ok: 'Sandbox를 불러왔습니다',
    retry: 'Sandbox에 다시 연결하고 있습니다',
    err: 'Sandbox에 연결하지 못했습니다. 도구를 쓸 때 다시 연결합니다',
  },
  workspace: {
    run: '워크스페이스를 불러오고 있습니다',
    ok: '워크스페이스를 불러왔습니다',
    retry: '워크스페이스를 다시 불러오고 있습니다',
    err: '워크스페이스를 불러오지 못했습니다. 도구를 쓸 때 다시 연결합니다',
  },
  packages: {
    run: '설치한 패키지를 다시 준비하고 있습니다',
    ok: '설치한 패키지를 다시 준비했습니다',
    retry: '설치한 패키지를 다시 준비하고 있습니다',
    err: '설치한 패키지를 다시 준비하지 못했습니다',
  },
  memory: {
    run: '기억을 불러오고 있습니다',
    ok: '기억을 불러왔습니다',
    retry: '기억을 불러오고 있습니다',
    err: '기억을 불러오지 못했습니다',
  },
};

export function phaseLabel(row: TurnPhaseRow): string {
  const base = LABELS[row.phase][row.state];
  // 두 번째 시도부터는 몇 번째인지 붙인다. 같은 줄이 오래 돌면 그 이유가 보인다.
  if (row.state === 'run' && (row.attempt ?? 1) > 1) {
    return `${base} (다시 시도 ${row.attempt}${row.attempts ? `/${row.attempts}` : ''})`;
  }
  return base;
}

/** 준비가 다 끝났는데 첫 글자가 아직이면 잇는 줄(모델의 첫 응답을 기다린다). */
export const AWAITING_ANSWER_LABEL = '답변을 준비하고 있습니다';

/** 준비 단계별 아이콘. 도구 줄과 같은 색 배지를 쓴다. "답변을 준비" 줄은 list 다. */
export const PHASE_ICON: Readonly<Record<TurnPhaseName, ToolIcon>> = {
  sandbox: 'terminal',
  workspace: 'file',
  packages: 'package',
  memory: 'search',
};

/**
 * 한 줄 요약(CLI 상태 줄·VS Code 상태처럼 줄을 하나만 그리는 화면용). 보일 줄이 없으면 null 이다.
 * 하는 중인 단계가 있으면 그 줄, 다시 시도·실패가 있으면 그 줄, 다 끝났고 답이 아직이면 답변 준비 줄.
 */
export function phaseHeadline(rows: readonly TurnPhaseRow[], now: number): { label: string; sinceMs: number } | null {
  const visible = visiblePhaseRows(rows, now);
  if (visible.length === 0) return null;
  const live = [...visible].reverse().find((r) => r.state === 'run' || r.state === 'retry' || r.state === 'err');
  if (live) return { label: phaseLabel(live), sinceMs: Math.max(0, now - live.startedAt) };
  if (awaitingAnswer(rows, now)) return { label: AWAITING_ANSWER_LABEL, sinceMs: Math.max(0, now - phasesSettledAt(rows)) };
  return null;
}
