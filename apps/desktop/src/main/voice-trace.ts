import { diag } from './diag-log';

const STAGES = ['start', 'ready', 'stt', 'gate', 'drop', 'finalize', 'result', 'deliver', 'carry', 'route'] as const;
const TEXT_LIMIT = 300;

export type VoiceTrace = {
  id: string;
  stage: typeof STAGES[number];
  text?: string;
  afterWake?: string | null;
  carry?: string;
  context?: string;
  source?: string;
  reason?: string;
  requestId?: string | null;
  waitMs?: number;
};

/** One opt-in sink for main and renderer traces; renderer payloads cross IPC. */
export function traceVoice(input: VoiceTrace): void {
  if (process.env.DEX_WAKE_DEBUG !== '1' || !input || typeof input.id !== 'string' || !input.id || input.id.length > 128 || !STAGES.includes(input.stage)) return;
  const data: Record<string, unknown> = { id: input.id, at: new Date().toISOString() };
  for (const key of ['text', 'afterWake', 'carry', 'context'] as const) {
    const value = input[key];
    if (value === null) data[key] = null;
    else if (typeof value === 'string') {
      data[key] = value.slice(0, TEXT_LIMIT);
      data[`${key}Chars`] = value.length;
      data[`${key}Truncated`] = value.length > TEXT_LIMIT;
    }
  }
  for (const key of ['source', 'reason', 'requestId'] as const) {
    if (typeof input[key] === 'string') data[key] = input[key].slice(0, 128);
  }
  if (typeof input.waitMs === 'number' && Number.isFinite(input.waitMs) && input.waitMs >= 0) data.waitMs = input.waitMs;
  diag('voice-trace', input.stage, data);
}
