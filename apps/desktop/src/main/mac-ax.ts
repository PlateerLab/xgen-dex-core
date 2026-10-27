/**
 * dex-ax(맥 접근성 도우미) 클라이언트 — 말로 다른 앱을 조작하는 빠른 조작(fast-act-computer)과 에이전트의 데스크탑 앱
 * 도구(desktop-tools)가 쓴다.
 *
 * 도우미는 처음 쓸 때 띄워 두고 JSON 한 줄씩 주고받는다(명령마다 기동 비용이 없고, 스냅샷의 요소 핸들을 들고 있다).
 * 설치본은 Contents/Resources/mac-ax/dex-ax(afterPack 이 빌드), 개발 실행은 native/mac-ax/bin/dex-ax
 * (`npm run build:mac-ax`). macOS 가 아니거나 도우미가 없으면 macAxAvailable() 이 false 다.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { diag } from './diag-log';

const SCOPE = 'mac-ax';
const TIMEOUT_MS = 4_000;

export type AxFront = { app: string; bundleId: string; pid: number; presenting: boolean };
/** frame 은 화면 전역 좌표 [x, y, w, h](왼쪽 위 원점). 메뉴 항목에는 없다. */
export type AxRef = { ref: string; role: string; name: string; frame?: number[]; /** 입력칸의 지금 값(200자까지). */ value?: string };
export type AxApp = { app: string; bundleId: string; pid: number; path: string; front: boolean; hidden: boolean; presenting?: boolean };
export type PresentationAction = 'next' | 'previous' | 'hide' | 'show';
export type AxSnapshot = AxFront & {
  /** 스냅샷 번호 — 도우미는 마지막 스냅샷의 요소만 들고 있어 그 뒤 스냅샷이 오면 번호(e1…)가 다른 요소를 가리킨다. */
  gen: number;
  window?: string;
  windowFrame?: number[];
  /** refs 중 창 안 요소의 수 — 나머지는 메뉴바 항목. */
  windowCount: number;
  refs: AxRef[];
  ms: number;
};

type Reply = { ok: boolean; error?: string; id?: number; [k: string]: unknown };

function helperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'mac-ax', 'dex-ax')
    : join(app.getAppPath(), 'native', 'mac-ax', 'bin', 'dex-ax');
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

let child: ChildProcessWithoutNullStreams | null = null;
let buffer = '';
let seq = 0;
/** 마지막으로 보낸 스냅샷 번호 — 도우미는 명령을 차례로 처리하므로 보낸 순서가 곧 처리 순서다. */
let snapGen = 0;
const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function failAll(err: Error): void {
  for (const w of waiting.values()) {
    clearTimeout(w.timer);
    w.reject(err);
  }
  waiting.clear();
}

function ensure(): ChildProcessWithoutNullStreams {
  if (child && child.exitCode === null && !child.killed) return child;
  const path = helperPath();
  if (!path) throw new Error('맥 접근성 도우미 없음');
  const p = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  buffer = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let r: Reply;
      try {
        r = JSON.parse(line) as Reply;
      } catch {
        continue;
      }
      const w = typeof r.id === 'number' ? waiting.get(r.id) : undefined;
      if (!w) continue;
      waiting.delete(r.id as number);
      clearTimeout(w.timer);
      w.resolve(r);
    }
  });
  p.stderr.on('data', (d: Buffer) => diag(SCOPE, 'stderr', { text: d.toString().slice(0, 300) }));
  p.on('exit', (code, signal) => {
    if (child === p) child = null;
    failAll(new Error(`맥 접근성 도우미 종료 (${code ?? signal})`));
  });
  p.on('error', (err) => {
    if (child === p) child = null;
    failAll(err);
  });
  child = p;
  return p;
}

async function call(cmd: string, args: Record<string, unknown> = {}, timeoutMs = TIMEOUT_MS): Promise<Reply> {
  const p = ensure();
  const id = ++seq;
  const reply = await new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`맥 접근성 도우미 응답 없음 (${cmd})`));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    p.stdin.write(`${JSON.stringify({ ...args, cmd, id })}\n`);
  });
  if (!reply.ok) throw new Error(reply.error ?? `${cmd} 실패`);
  return reply;
}

export function macAxAvailable(): boolean {
  return helperPath() !== null;
}

/** 접근성 권한 — prompt 면 시스템 권한 창을 띄운다(권한은 이 앱이 받는다). */
export async function axTrusted(prompt = false): Promise<boolean> {
  return (await call('trusted', { prompt })).trusted === true;
}

export async function axFront(): Promise<AxFront> {
  const r = await call('front');
  return { app: String(r.app ?? ''), bundleId: String(r.bundleId ?? ''), pid: Number(r.pid ?? 0), presenting: r.presenting === true };
}

export async function axSnapshot(pid: number, budgetMs = 1_500): Promise<AxSnapshot> {
  const gen = ++snapGen;
  const r = await call('snapshot', { pid, budgetMs, menus: true }, budgetMs + TIMEOUT_MS);
  return {
    gen,
    app: String(r.app ?? ''),
    bundleId: String(r.bundleId ?? ''),
    pid: Number(r.pid ?? pid),
    presenting: r.presenting === true,
    window: typeof r.window === 'string' ? r.window : undefined,
    windowFrame: Array.isArray(r.windowFrame) ? (r.windowFrame as number[]) : undefined,
    windowCount: Number(r.windowCount ?? 0),
    refs: Array.isArray(r.refs) ? (r.refs as AxRef[]) : [],
    ms: Number(r.ms ?? 0),
  };
}

/** 스냅샷 gen 의 요소를 누른다 — 그 뒤 다른 스냅샷을 떴으면 거절한다(STALE). */
export const AX_STALE = 'ax_stale_ref';
export async function axPress(ref: string, gen: number): Promise<void> {
  fresh(gen);
  await call('press', { ref });
}

/** 키 보내기 — 맨 앞 앱으로 간다. 예: "escape", "right", "cmd+h". */
export async function axKeys(combo: string): Promise<void> {
  await call('keys', { combo });
}

export async function axHide(pid: number): Promise<void> {
  await call('hide', { pid });
}

export async function axMinimize(pid: number): Promise<void> {
  await call('minimize', { pid });
}

export async function axActivate(pid: number): Promise<void> {
  await call('activate', { pid });
}

export async function axPresentation(pid: number, action: PresentationAction): Promise<{ verified: boolean; reason?: string; visibleWindows?: number; hideAttempts?: number; settleMs?: number }> {
  // Isolate the show-exit/hide sequence from the helper that owns AX element handles.
  const reply = action === 'hide' ? await hidePresentation(pid) : await call('presentation', { pid, action }, 8_000);
  if (reply.pid !== pid || reply.action !== action || typeof reply.verified !== 'boolean')
    throw new Error('발표 조작 결과의 대상과 상태를 확인하지 못했습니다.');
  return {
    verified: reply.verified,
    ...(typeof reply.reason === 'string' ? { reason: reply.reason } : {}),
    ...(typeof reply.visibleWindows === 'number' && Number.isInteger(reply.visibleWindows) && reply.visibleWindows >= 0 ? { visibleWindows: reply.visibleWindows } : {}),
    ...(typeof reply.hideAttempts === 'number' && Number.isInteger(reply.hideAttempts) && reply.hideAttempts >= 1 && reply.hideAttempts <= 3 ? { hideAttempts: reply.hideAttempts } : {}),
    ...(typeof reply.settleMs === 'number' && Number.isInteger(reply.settleMs) && reply.settleMs >= 0 ? { settleMs: reply.settleMs } : {}),
  };
}

async function hidePresentation(pid: number): Promise<Reply> {
  const path = helperPath();
  if (!path) throw new Error('맥 접근성 도우미 없음');
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const worker = execFile(path, [], { timeout: 12_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(error); return; }
      try {
        const reply: Reply = JSON.parse(stdout.trim());
        if (!reply || reply.id !== id || reply.ok !== true) throw new Error(reply?.error ?? 'PPT 숨김 도우미 응답 오류');
        resolve(reply);
      } catch (error) { reject(error); }
    });
    worker.stdin?.on('error', reject);
    worker.stdin?.end(`${JSON.stringify({ cmd: 'presentation', pid, action: 'hide', id })}\n`);
  });
}

/** 실행 중인 일반 앱(Dock 에 보이는 앱). */
export async function axApps(): Promise<AxApp[]> {
  const r = await call('apps');
  return Array.isArray(r.apps) ? (r.apps as AxApp[]) : [];
}

function fresh(gen: number): void {
  if (gen !== snapGen) throw new Error(`${AX_STALE}: 화면을 새로 읽어 번호가 바뀜`);
}

export async function axFocus(ref: string, gen: number): Promise<void> {
  fresh(gen);
  await call('focus', { ref });
}

/** 입력칸 값을 통째로 바꾼다 — 다시 읽어 같지 않으면 실패. */
export async function axSetValue(ref: string, gen: number, text: string): Promise<void> {
  fresh(gen);
  await call('setvalue', { ref, text });
}

/** 글자 입력 — 맨 앞 앱의 초점 요소로 간다. 16자씩 보내므로 긴 글은 시간이 걸린다. */
export async function axType(text: string): Promise<void> {
  await call('type', { text }, TIMEOUT_MS + Math.ceil(text.length / 16) * 30);
}

export function stopMacAx(): void {
  child?.kill();
  child = null;
}
