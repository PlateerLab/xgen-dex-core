/**
 * 실시간 음성 → 말하는 도중 실행 (실험).
 *
 * 렌더러가 마이크 소리(PCM16 16 kHz 모노)를 보내면 XGEN 실시간 STT(`WS /api/audio/stt/stream`,
 * 서버가 슬라이딩 창으로 다시 받아 적고 Silero VAD 로 토막을 끊는다)로 흘리고, 중간 결과를
 * Segmenter에 전달한다. 끝나면 최종 글자·실행 목록·못 한
 * 부분을 돌려주고 장부(voice-turns)에 남긴다 — 그 글자가 채팅으로 들어오면 고속 경로가 이어받는다.
 *
 * 서버 계약 (xgen-core): → {"type":"start","format":"pcm16","sample_rate":16000,"language":"ko","mode":"partials"}
 *   ← ready / partial / final / done / error. partial 은 세션에서 들은 전체(누적), final 은 방금 끝난
 *   토막만이다(10/5 원문 확인 — 둘을 같은 것으로 이어 붙이면 앞 토막이 두 번 들어간다). stop 을 보내면 done(전체).
 *
 * 켜는 조건: 빠른 브라우저 조작(설정 fastAct 또는 개발용 DEX_FAST_ACT_URL) + E13 형식, DEX_VOICE_STREAM=0 이면 끈다.
 * DEX_VOICE_TEST=1 이면 녹음 파일을 실제 말 속도로 흘려 넣는 시험 경로가 열린다.
 *
 * 호출어로만 듣기(설정 voiceWake)를 켜면 호출어를 듣기 전의 말은 판단·표시하지 않고 버린다. 호출어 뒤의 말만
 * 조작·채팅으로 넘기고, 호출어만 말하고 멈추면 다음 말 하나는 호출어 없이 받는다(voice-wake.ts).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { xgenWebSocketTlsOptions, type XgenServerTrust } from '@dex/engine/connection-security';
import { diag } from './diag-log';
import { FORMAT } from './fast-act-e13';
import { fastActEnabled } from './fast-act-runner';
import { BrowserVoiceAgent, type VoiceAction } from './fast-act-voice';
import { Segmenter, norm } from './voice-segmenter';
import { rememberVoiceTurn } from './voice-turns';
import { findWake, restAfter, sttHint, WAKE_WINDOW_MS } from './voice-wake';

const SCOPE = 'voice-stream';
const FRAME = 640; // 20 ms @ 16 kHz PCM16
/** stop 뒤 done 을 기다리는 최대 시간. */
const DONE_WAIT_MS = 2_500;

export type VoiceStreamDeps = {
  baseUrl: () => string;
  token: () => Promise<string>;
  allowPrivateCertificate: () => boolean;
  serverTrust?: () => readonly XgenServerTrust[];
  /** 호출어 목록 — null 이면 호출어로만 듣기가 꺼져 있다. */
  wakeWords: () => string[] | null;
  /** 중간 인식의 조작을 보류하고 최종 글자만 돌려준다(시험용 — 데스크톱은 말하는 도중 실행한다). */
  planBeforeAct?: (interactionId?: string) => boolean;
};

export type VoiceStreamEvent =
  | { sessionId: string; type: 'ready' }
  | { sessionId: string; type: 'utterance_end' }
  | { sessionId: string; type: 'partial'; text: string }
  | { sessionId: string; type: 'act'; action: VoiceAction }
  | { sessionId: string; type: 'wake' }
  | { sessionId: string; type: 'error'; error: string };

export type TimelineEntry = { t: number; type: string; text?: string; detail?: string };

export type VoiceStreamResult = {
  text: string;
  actions: VoiceAction[];
  unhandled: string | null;
  /** 세션 시작부터 소리 끝(end 호출)까지. */
  audioEndMs: number | null;
  timeline: TimelineEntry[];
  /**
   * 호출어로만 듣기 — off: 꺼짐, ignored: 호출어 없는 말이라 버렸다(text 비움), called: 호출어만 들었다
   * (다음 말 하나는 호출어 없이 받는다), heard: 호출어 뒤의 말(또는 호출어에 이어진 말)을 처리했다.
   */
  wake: 'off' | 'ignored' | 'called' | 'heard';
};

/** 호출어로만 듣기 — awake: 이 세션은 호출어 없이 받는다(호출어 직후의 말·앞 말에서 이어진 말). */
type WakeGate = { words: string[]; awake: boolean };

export function voiceStreamAvailable(): boolean {
  return fastActEnabled() && FORMAT === 'e13' && process.env.DEX_VOICE_STREAM !== '0';
}

const now = (): number => performance.now();

const SEP = /[\s.,!?。…]/;
/**
 * short 가 full 의 잘린 앞 토막인가 — full 의 어절 가운데서 끊겼거나, 문장 끝 부호 없이 끝났다. 띄어쓰기·문장부호는
 * 보지 않고 맞춘다. 문장을 맺고 끝난 앞 토막은 서버가 끝의 환청을 걷어낸 것일 수 있어 잘린 것으로 보지 않는다.
 */
const truncated = (short: string, full: string): boolean => {
  const s = bare(short);
  const f = bare(full);
  if (!s || s.length >= f.length || !f.startsWith(s)) return false;
  if (!/[.?!。…]$/.test(short.trim())) return true;
  let n = 0;
  let i = 0;
  for (; i < full.length && n < s.length; i++) if (!SEP.test(full[i])) n++;
  return i < full.length && !SEP.test(full[i]);
};

class VoiceSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private early: Buffer[] = [];
  private pending = Buffer.alloc(0);
  private closedText = '';
  private lastFinal = '';
  /** 정지 뒤 서버가 같은 토막을 다시 확정해 보낸 것을 버렸다 — 서버 done 도 그 중복을 담고 있으니 쓰지 않는다. */
  private droppedRepeat = false;
  private lastText = '';
  /** 서버가 적은 그대로의 마지막 글자(호출어 포함). */
  private lastHeard = '';
  /** 가장 많이 들은 중간 결과(누적) — 뒤 중간 결과가 그 잘린 앞 토막으로 줄면 그대로 둔다(truncated). */
  private fullPartial = '';
  private doneText: string | null = null;
  private stopSent = false;
  private ended: Promise<VoiceStreamResult> | null = null;
  private closed = false;
  private wakeDone: (() => void) | null = null;
  private readonly t0 = now();
  private readonly agent: BrowserVoiceAgent;
  private readonly seg: Segmenter;
  private readonly deferActions: boolean;
  private readonly timeline: TimelineEntry[] = [];
  private audioEndMs: number | null = null;
  /** 받는 중인가 — 호출어로만 듣기가 꺼져 있거나, 호출어를 들었거나, 호출어 없이 받는 세션. */
  private woke: boolean;
  /** 이 세션에서 호출어를 들었다. */
  private heardWake = false;
  /** 호출어가 끝난 글자 위치 — 인식기가 고쳐 써서 호출어를 못 찾을 때 이 뒤부터 쓴다. */
  private wakeEnd = 0;

  constructor(
    readonly id: string,
    readonly workflowId: string,
    private deps: VoiceStreamDeps,
    private emit: (e: VoiceStreamEvent) => void,
    /** 앞 발화에서 처리 못 하고 넘어온 말 — 말 사이에 잠깐 쉬어 끊긴 경우("기획전 좀 [쉼] 보여줘") 앞에 붙인다. */
    private carry = '',
    /** 받아 적기만 한다(판단·조작 없음) — 시험 경로에서 STT 결과를 모을 때. */
    private sttOnly = false,
    private wake: WakeGate | null = null,
    interactionId?: string,
  ) {
    this.woke = !wake || wake.awake;
    this.deferActions = sttOnly || deps.planBeforeAct?.(interactionId) === true;
    this.agent = new BrowserVoiceAgent(workflowId, this.t0, (action) => emit({ sessionId: id, type: 'act', action }), interactionId);
    if (!this.deferActions && this.woke) this.agent.prefetch();
    this.seg = new Segmenter(
      this.agent,
      (e) => {
        if (e.type === 'decide') {
          const o = e.outcome;
          this.mark('decide', e.text, o.acted ? `실행 ${o.target}` : o.reason);
        }
      },
      () => now() - this.t0,
    );
  }

  mark(type: string, text?: string, detail?: string): void {
    this.timeline.push({ t: Math.round(now() - this.t0), type, text, detail });
  }

  async open(): Promise<void> {
    const base = this.deps.baseUrl().replace(/\/+$/, '').replace(/^http/, 'ws');
    const token = await this.deps.token();
    if (!base || !token) throw new Error('XGEN 로그인이 필요합니다');
    const ws = new WebSocket(`${base}/api/audio/stt/stream?session_key=${encodeURIComponent(`dex-voice-${this.id}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
      ...xgenWebSocketTlsOptions(base, this.deps.serverTrust?.()),
    });
    this.ws = ws;
    // 호출어로만 듣기면 호출어를 인식 힌트로 준다 — 힌트를 모르는 서버는 이 키를 무시한다.
    const context = this.wake ? sttHint(this.wake.words) : '';
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'start',
          format: 'pcm16',
          sample_rate: 16000,
          language: 'ko',
          mode: 'partials',
          ...(context && { context }),
        }),
      ),
    );
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('error', (err) => this.fail(String(err)));
    ws.on('close', (code) => {
      this.closed = true;
      if (code !== 1000 && !this.stopSent) this.fail(`STT 연결 끊김 ${code}`);
      this.wakeDone?.();
    });
  }

  /**
   * 호출어로 거른 말 — 받을 말이면 호출어 뒤(호출어가 없으면 그대로), 아직 호출어를 못 들었으면 null.
   * 호출어 없이 받는 세션에서는 말머리의 호출어만 뗀다(되풀이해 부른 경우) — 말 중간의 것은 명령의 일부일 수 있다.
   */
  private gate(heard: string): string | null {
    if (!this.wake) return heard;
    const m = findWake(heard, this.wake.words);
    if (m && (!this.wake.awake || m.start <= 3)) {
      if (!this.heardWake) {
        this.heardWake = true;
        this.mark('wake', heard.slice(m.start, m.end));
        this.emit({ sessionId: this.id, type: 'wake' });
      }
      this.woke = true;
      this.wakeEnd = m.end;
      return restAfter(heard, m.end);
    }
    if (!this.woke) return null;
    return this.wakeEnd ? restAfter(heard, this.wakeEnd) : heard;
  }

  private fail(error: string): void {
    this.mark('error', undefined, error);
    diag(SCOPE, 'error', { id: this.id, error });
    this.emit({ sessionId: this.id, type: 'error', error });
  }

  private onMessage(raw: string): void {
    let m: { type?: string; text?: string; code?: string; message?: string; context?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === 'ready') {
      this.ready = true;
      // 서버가 적용한 인식 힌트 — 키가 없으면 힌트를 모르는 서버다.
      this.mark('ready', undefined, m.context === undefined ? undefined : `힌트 "${m.context}"`);
      // shortcut: 500ms 무음을 앞에 붙여 테스트 녹음의 첫 인사말 누락을 우회한다. 서버 시작 구간 원인 해결 후 제거를 검토한다.
      // 서버 VAD가 원인인지는 미확인이고 실제 마이크에서의 필요성도 미검증이다. 대기 없이 무음 PCM을 먼저 전송한다.
      for (let i = 0; i < 25; i++) this.ws?.send(Buffer.alloc(FRAME));
      for (const b of this.early.splice(0)) this.ws?.send(b); // 준비 전에 들어온 소리부터 (버리면 첫 단어가 잘린다)
      this.emit({ sessionId: this.id, type: 'ready' });
      if (this.ended) this.sendStop();
    } else if ((m.type === 'partial' || m.type === 'final') && m.text) {
      if (process.env.DEX_VOICE_TEST === '1') this.mark(`raw_${m.type}`, m.text); // 서버 원문 (시험 빌드만)
      // XGEN STT 는 토막을 확정(final)한 뒤 정지(stop)를 받으면, 그사이 방 소음이 들어온 경우 같은 토막을 한 번 더 확정해
      // 보내고 done 도 두 번 이어 붙인다("창을 닫아줘. 창을 닫아줘." — 그러면 되풀이 환각으로 걸러져 말이 무시됐다).
      // 정지 뒤에 바로 앞 확정과 같은 글자가 오면 버린다.
      if (m.type === 'final' && this.stopSent && bare(m.text) === bare(this.lastFinal)) {
        this.droppedRepeat = true;
        this.mark('repeat_final_dropped', m.text);
        return;
      }
      // 서버가 말 끝을 잃기도 한다 — 중간 결과는 "해이엑스젠 가전 디지털 펼쳐줘." 까지 들었는데 확정·done 은 "해",
      // "…테스트 상품입니다. 입력해줘." 가 "…테스트 상", "헤이 엑스젠 전시 카테고리 추가해줘." 가 "헤이 엑스젠"
      // 이었다(10/16 합성 음성 24문장 중 5개 — 모두 문장 끝 부호 없이 끝났고, 온전한 확정 19개는 모두 부호로 맺었다).
      // 가장 많이 들은 중간 결과의 잘린 앞 토막인 확정·중간 결과는 버리고, 끝에는 그 중간 결과를 쓴다.
      if (truncated(m.type === 'final' ? `${this.closedText} ${m.text}` : m.text, this.fullPartial)) {
        this.mark(`cut_${m.type}_dropped`, m.text);
        return;
      }
      if (m.type === 'final') this.lastFinal = m.text;
      else this.fullPartial = m.text.trim();
      // 서버의 partial 은 이 세션에서 들은 전체(누적), final 은 방금 끝난 토막만이다.
      const heard = m.type === 'partial' ? m.text.trim() : (this.closedText = `${this.closedText} ${m.text}`.trim());
      this.lastHeard = heard;
      // 호출어 전의 말은 화면에도 내지 않는다(입력창에 사람에게 한 말이 적히지 않게).
      const said = this.sttOnly ? heard : this.gate(heard);
      if (said === null) {
        if (m.type === 'final') this.emit({ sessionId: this.id, type: 'utterance_end' });
        return;
      }
      const full = this.carry ? (said ? `${this.carry} ${said}` : this.carry) : said;
      if (full !== this.lastText) {
        this.lastText = full;
        this.mark('partial', full);
        this.emit({ sessionId: this.id, type: 'partial', text: full });
      }
      if (m.type === 'final') this.emit({ sessionId: this.id, type: 'utterance_end' });
      if (this.deferActions) return;
      this.agent.prefetch(); // 화면을 뒤에서 새로 읽어 둔다(1초 지났으면)
      // 토막 끝(final)은 마지막 단어까지 확정 — 글자가 같아도 확정 신호로 넘긴다.
      if (m.type === 'final') this.seg.confirm(full);
      else this.seg.partial(full);
    } else if (m.type === 'done') {
      this.doneText = (m.text ?? '').trim();
      this.mark('done', this.doneText);
      this.wakeDone?.();
    } else if (m.type === 'error') {
      this.fail(`${m.code ?? ''} ${m.message ?? ''}`.trim());
    }
  }

  /** 마이크 소리 — 20 ms 프레임으로 잘라 보낸다. 준비 전 소리는 10초까지 모아 둔다. */
  audio(bytes: Uint8Array): void {
    if (this.stopSent) return;
    this.pending = Buffer.concat([this.pending, Buffer.from(bytes)]);
    while (this.pending.length >= FRAME) {
      const frame = Buffer.from(this.pending.subarray(0, FRAME));
      this.pending = this.pending.subarray(FRAME);
      if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
      else if (this.early.length < 500) this.early.push(frame);
    }
  }

  private sendStop(): void {
    if (this.stopSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // The processor can end on any sample boundary; send its tail before stop.
    if (this.pending.length) { this.ws.send(this.pending); this.pending = Buffer.alloc(0); }
    // shortcut: 기존 300ms 종료 무음을 유지한다. 뒤의 stop과 별개로 필요한지는 미검증이며 분리 검증 후 제거를 검토한다.
    for (let i = 0; i < 15; i++) this.ws.send(Buffer.alloc(FRAME));
    this.ws.send(JSON.stringify({ type: 'stop' }));
    this.stopSent = true;
  }

  /** 소리 끝 — 서버의 마지막 결과를 받고 남은 말까지 판단·실행한 뒤 돌려준다. */
  end(): Promise<VoiceStreamResult> {
    if (!this.ended) this.ended = this.finish();
    return this.ended;
  }

  private async finish(): Promise<VoiceStreamResult> {
    this.audioEndMs = Math.round(now() - this.t0);
    this.mark('audio_end');
    if (this.ready) this.sendStop(); // 아직 준비 전이면 ready 에서 보낸다
    await new Promise<void>((resolve) => {
      if (this.closed || this.doneText !== null) return resolve();
      this.wakeDone = resolve;
      setTimeout(resolve, DONE_WAIT_MS);
    });
    const done = this.droppedRepeat ? this.closedText : this.doneText;
    const raw = (truncated(done ?? '', this.fullPartial) ? this.fullPartial : done) || this.lastHeard;
    const heard = this.sttOnly ? raw : this.gate(raw);
    if (heard === null) {
      // 호출어 없는 말 — 판단·실행·기록 없이 버린다(글자도 돌려주지 않는다). 사람에게 한 말이라 로그에도
      // 글자를 남기지 않는다 — 시험 빌드에서만 원문을 남긴다.
      this.close();
      const test = process.env.DEX_VOICE_TEST === '1' ? { heard: raw } : {};
      diag(SCOPE, 'end', { id: this.id, wake: 'ignored', chars: raw.length, ...test });
      return { text: '', actions: [], unhandled: null, audioEndMs: this.audioEndMs, timeline: [], wake: 'ignored' };
    }
    const text = norm(heard ? (this.carry ? `${this.carry} ${heard}` : heard) : '');
    if (!this.deferActions) await this.seg.final(text);
    this.close();
    const result: VoiceStreamResult = {
      text,
      actions: [...this.agent.actions],
      unhandled: this.seg.unhandled,
      audioEndMs: this.audioEndMs,
      timeline: this.timeline,
      wake: !this.wake ? 'off' : this.heardWake && !text ? 'called' : 'heard',
    };
    if (text && !this.deferActions) rememberVoiceTurn({ workflowId: this.workflowId, text, actions: result.actions, unhandled: result.unhandled, at: Date.now() });
    diag(SCOPE, 'end', {
      id: this.id,
      text,
      wake: result.wake,
      acted: result.actions.map((a) => `${a.label}@${a.at}${a.partial ? '(말하는 중)' : ''}`),
      unhandled: result.unhandled,
      audioEndMs: this.audioEndMs,
      // 판단마다 이유 — 실행 못 한 말을 나중에 분석할 수 있게
      decisions: this.timeline.filter((e) => e.type === 'decide').map((e) => `${e.t}ms ${e.text} → ${e.detail}`),
    });
    return result;
  }

  /** 시험 전용: STT 없이 글자로 바로 판단·실행 — 인식 오류를 뺀 판단만 잴 때. */
  async decideText(text: string): Promise<VoiceStreamResult> {
    this.audioEndMs = 0;
    const t = norm(text);
    if (!this.deferActions) await this.seg.final(t);
    const actions = [...this.agent.actions];
    return { text: t, actions, unhandled: this.seg.unhandled, audioEndMs: 0, timeline: this.timeline, wake: 'off' };
  }

  close(): void {
    try {
      this.ws?.close(1000);
    } catch {
      /* 이미 닫힘 */
    }
  }
}

/** 비교용 — 띄어쓰기·문장부호를 뺀 글자. */
const bare = (t: string): string => t.replace(/[\s.,!?。…]+/g, '');

let seq = 0;

export class VoiceStreamHub {
  private sessions = new Map<string, VoiceSession>();
  /** 에이전트별 — 호출어만 들은 뒤 다음 말을 호출어 없이 받는 기한. */
  private wakeUntil = new Map<string, number>();

  constructor(private deps: () => VoiceStreamDeps | null) {}

  async start(workflowId: string, emit: (e: VoiceStreamEvent) => void, carry = '', sttOnly = false, interactionId?: string): Promise<string> {
    const deps = this.deps();
    if (!deps) throw new Error('XGEN 로그인이 필요합니다');
    const id = `${Date.now().toString(36)}-${++seq}`;
    const words = sttOnly ? null : deps.wakeWords();
    // 앞 말에서 이어진 말(carry 는 받은 말에서만 생긴다)과 호출어 직후의 말은 호출어 없이 받는다.
    const awake = !!carry.trim() || Date.now() < (this.wakeUntil.get(workflowId) ?? 0);
    const s = new VoiceSession(id, workflowId, deps, emit, carry.trim(), sttOnly, words ? { words, awake } : null, interactionId);
    this.sessions.set(id, s);
    try { await s.open(); }
    catch (error) { s.close(); this.sessions.delete(id); throw error; }
    diag(SCOPE, 'start', { id, workflowId });
    return id;
  }

  audio(id: string, bytes: Uint8Array): void {
    this.sessions.get(id)?.audio(bytes);
  }

  async end(id: string): Promise<VoiceStreamResult | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    try {
      const r = await s.end();
      // 호출어만 들었으면 다음 말 하나를 기다리고, 말을 하나 받았으면 닫는다. 버린 말·잡음(취소)은 기한을 쓰지 않는다.
      if (r.wake === 'called') this.wakeUntil.set(s.workflowId, Date.now() + WAKE_WINDOW_MS);
      else if (r.wake === 'heard' && r.text) this.wakeUntil.delete(s.workflowId);
      return r;
    } finally {
      this.sessions.delete(id);
    }
  }

  cancel(id: string): void {
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
  }

  /** 시험 경로 (DEX_VOICE_TEST=1) — STT 없이 글자로 판단·실행. */
  async testText(workflowId: string, text: string, emit: (e: VoiceStreamEvent) => void): Promise<VoiceStreamResult> {
    if (process.env.DEX_VOICE_TEST !== '1') throw new Error('DEX_VOICE_TEST=1 일 때만 쓸 수 있습니다');
    const deps = this.deps();
    if (!deps) throw new Error('XGEN 로그인이 필요합니다');
    const s = new VoiceSession(`text-${Date.now().toString(36)}-${++seq}`, workflowId, deps, emit);
    return s.decideText(text);
  }

  /**
   * 시험 경로 (DEX_VOICE_TEST=1) — 녹음 파일을 마이크 대신 실제 말 속도(20 ms 프레임)로 흘려 넣는다.
   * 앞에 0.5초 무음, 뒤에 마이크 경로의 말 끝 대기와 같은 무음을 붙인다.
   */
  async testFile(
    workflowId: string,
    path: string,
    emit: (e: VoiceStreamEvent) => void,
    tailMs = 900,
    sttOnly = false,
  ): Promise<VoiceStreamResult | null> {
    if (process.env.DEX_VOICE_TEST !== '1') throw new Error('DEX_VOICE_TEST=1 일 때만 쓸 수 있습니다');
    const pcm = await decodeTo16k(path);
    const id = await this.start(workflowId, emit, '', sttOnly);
    const sleep = (t: number): Promise<void> => new Promise((r) => setTimeout(r, t));
    const silence = Buffer.alloc(FRAME);
    const t0 = now();
    let sent = 0;
    const pace = async (frame: Buffer): Promise<void> => {
      this.audio(id, frame);
      sent++;
      const wait = t0 + sent * 20 - now();
      if (wait > 0) await sleep(wait);
    };
    for (let i = 0; i < 25; i++) await pace(silence);
    for (let off = 0; off < pcm.length; off += FRAME) await pace(pcm.subarray(off, off + FRAME));
    this.sessions.get(id)?.mark('speech_end'); // 실행 시각(action.at)과 같은 세션 시계
    for (let i = 0; i < tailMs / 20; i++) await pace(silence);
    return this.end(id);
  }
}

/** 녹음 파일 → 16 kHz 모노 PCM16. WAV 는 직접 읽고, 그 밖의 형식은 ffmpeg 로 바꾼다(시험 경로 전용). */
async function decodeTo16k(path: string): Promise<Buffer> {
  if (path.toLowerCase().endsWith('.wav')) {
    const pcm = wavTo16k(readFileSync(path));
    if (pcm) return pcm;
  }
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))));
  });
}

/** WAV(PCM16, 임의 채널·샘플레이트) → 16 kHz 모노 PCM16 (선형 보간). PCM16 이 아니면 null. */
function wavTo16k(b: Buffer): Buffer | null {
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  let fmt = { ch: 1, rate: 16000, bits: 16 };
  let data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!data || fmt.bits !== 16) return null;
  const n = Math.floor(data.length / 2 / fmt.ch);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2);
    mono[i] = s / fmt.ch;
  }
  const outN = Math.floor((n * 16000) / fmt.rate);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = (i * fmt.rate) / 16000;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, n - 1);
    const v = mono[i0] + (mono[i1] - mono[i0]) * (x - i0);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}
