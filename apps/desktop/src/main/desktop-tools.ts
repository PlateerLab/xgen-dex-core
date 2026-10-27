/**
 * 데스크탑 앱 도구 — 에이전트가 사용자 맥의 앱(PowerPoint·Finder·카카오톡 …)을 열고, 읽고, 조작한다.
 *
 * 브라우저 도구(browser-tools.ts)와 나란히 같은 카탈로그에 올라간다. "PPT 앱 열어줘" 를 웹 PowerPoint 가 아니라 이
 * 도구로 보내는 것은 단어 규칙이 아니라 에이전트가 도구 설명을 보고 고른다. 이 도구가 없던 동안 DeX 에서 한 앱
 * 요청은 갈 곳이 브라우저뿐이었다(10/18 dev: "PPT 앱 열어줘" → office.com 웹 PowerPoint).
 *
 *   DesktopApps      실행 중·설치된 앱 목록, 열기(실행하거나 앞으로), 숨기기
 *   DesktopSnapshot  앱의 초점 창 요소 + 메뉴바 항목(ref e1…). 읽기만 하고 초점을 바꾸지 않는다.
 *   DesktopInteract  누르기·글자 입력·입력칸 값 바꾸기·단축키. 입력·키·누르기는 그 앱을 먼저 앞으로 가져와
 *                    확인한 뒤 보낸다 — 다른 앱(특히 DeX 자신)에 글자가 들어가지 않게.
 *
 * 폴더 연결과 무관하다(파일을 다루지 않는다). 켜는 조건은 말로 하는 다른 앱 조작과 같다: 맥 + 설정 computerAct +
 * 접근성 도우미(mac-ax). 되돌릴 수 없을 수 있는 항목(닫기·종료·저장·삭제·보내기 …)과 그런 단축키는 누르지 않는다 —
 * 말로 하는 조작(fast-act-computer)과 같은 기준. 다른 기기에서 온 턴은 거부한다(이 PC 앞에 사람이 있어야 한다).
 */
import { matchApp, type InstalledApp } from '@dex/engine/app-launch';
import {
  openWithDefaultApp,
  type LocalToolCallContext,
  type LocalToolDelegate,
  type LocalToolResult,
  type LocalToolSchema,
} from '@dex/engine/local-tools';
import { DANGEROUS_BROWSER_TARGET as DANGEROUS } from './fast-act';
import { MAC_DANGEROUS } from './fast-act-computer';
import { installedApps } from './fast-act-desktop';
import {
  axActivate,
  axApps,
  axFocus,
  axFront,
  axHide,
  axKeys,
  axPress,
  axSetValue,
  axSnapshot,
  axTrusted,
  axType,
  macAxAvailable,
  type AxApp,
  type AxFront,
  type AxRef,
  type AxSnapshot,
} from './mac-ax';

export const DESKTOP_APPS_TOOL = 'DesktopApps';
export const DESKTOP_SNAPSHOT_TOOL = 'DesktopSnapshot';
export const DESKTOP_INTERACT_TOOL = 'DesktopInteract';
export const DESKTOP_TOOL_NAMES = new Set([DESKTOP_APPS_TOOL, DESKTOP_SNAPSHOT_TOOL, DESKTOP_INTERACT_TOOL]);

/** 스냅샷 한 번에 돌려줄 요소 줄 수 — 넘으면 filter 로 좁히라고 말한다. */
const MAX_LINES = 300;
/** 앱을 연 뒤 맨 앞에 오기를 기다리는 시간(처음 실행은 느리다), 이미 떠 있는 앱을 앞으로 가져오는 시간. */
const LAUNCH_WAIT_MS = 8_000;
const FRONT_WAIT_MS = 2_000;
/** 조작 뒤 앱 화면이 바뀌기를 기다리는 시간 — AX 에는 끝 신호가 없다. */
const SETTLE_MS = 300;

/** 되돌릴 수 없을 수 있는 단축키 — 종료·닫기·저장·삭제·강제 종료·잠금. */
const BLOCKED_COMBO = /^(cmd\+(q|w|s|delete|backspace)|cmd\+shift\+(w|s|delete)|cmd\+(alt|option)\+(escape|esc)|cmd\+ctrl\+q)$/;

export function desktopToolSchemas(): LocalToolSchema[] {
  const app = {
    type: 'string',
    description:
      'App name, e.g. "Microsoft PowerPoint", "Finder", "카카오톡". A partial name works when only one app matches. ' +
      'Omit to use the app you last opened or read.',
  };
  return [
    {
      name: DESKTOP_APPS_TOOL,
      annotations: { readOnlyHint: false, openWorldHint: false },
      description:
        "Desktop apps on the user's Mac: list running/installed apps, open or switch to one, hide one. " +
        'Use this for requests about the user\'s own desktop applications (PowerPoint, Excel, Finder, KakaoTalk…) — ' +
        'not web pages; web pages use the XGEN browser tools. open launches the installed app, or brings it to ' +
        'the front if it is already running. Then read it with DesktopSnapshot and operate it with DesktopInteract.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'hide'] },
          app,
        },
        required: ['action'],
      },
    },
    {
      name: DESKTOP_SNAPSHOT_TOOL,
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read a desktop app's window and menus on the user's Mac (refs e1… for DesktopInteract). " +
        'Lists the focused window\'s buttons, fields (with their current text), rows and tabs, then the menu bar items ' +
        'as paths like "파일 > 새로 만들기". Reading does not change focus. Items marked [직접] may be irreversible ' +
        '(close, quit, save, delete, send…) and cannot be pressed — ask the user to do those.',
      inputSchema: {
        type: 'object',
        properties: {
          app,
          filter: { type: 'string', description: 'Only list items whose name contains this text.' },
        },
      },
    },
    {
      name: DESKTOP_INTERACT_TOOL,
      annotations: { readOnlyHint: false, openWorldHint: false },
      description:
        "Operate a desktop app on the user's Mac: press a ref, type text, set a field's value, or send keys. " +
        'press clicks a ref (window item or menu path) from the latest DesktopSnapshot. type types text into the ' +
        "app's focused field — pass ref to focus that field first. set_value replaces a text field's whole value. " +
        'keys sends a shortcut like "cmd+n", "return", "escape", "right". The app is brought to the front first. ' +
        'Irreversible items and shortcuts (cmd+q, cmd+w, cmd+s …) are refused. Refs expire when the app is read ' +
        'again; after an action, read again to see the result.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['press', 'type', 'set_value', 'keys'] },
          app,
          ref: { type: 'string', description: 'Element ref from the latest DesktopSnapshot, e.g. "e12".' },
          text: { type: 'string', description: 'type / set_value: the text. Newlines press return.' },
          keys: { type: 'string', description: 'keys: e.g. "cmd+n", "shift+tab", "return", "escape", "down".' },
        },
        required: ['action'],
      },
    },
  ];
}

/** 누르면 안 되는(되돌릴 수 없을 수 있는) 요소 이름. */
export function isIrreversible(name: string): boolean {
  return DANGEROUS.test(name) || MAC_DANGEROUS.test(name);
}

export function isBlockedCombo(combo: string): boolean {
  return BLOCKED_COMBO.test(combo.toLowerCase().replace(/\s+/g, '').replace(/command/g, 'cmd'));
}

/** 스냅샷 → 에이전트가 읽는 글. 창 요소 먼저, 메뉴바 항목은 뒤에. */
export function formatSnapshot(ax: AxSnapshot, front: boolean, filter = ''): string {
  const f = filter.trim().toLowerCase();
  const pick = (r: AxRef) => !f || r.name.toLowerCase().includes(f) || (r.value ?? '').toLowerCase().includes(f);
  const line = (r: AxRef) =>
    `${r.ref} | ${r.role} | ${r.name}${r.value ? ` = "${r.value}"` : ''}${isIrreversible(r.name) ? ' [직접]' : ''}`;
  const win = ax.refs.slice(0, ax.windowCount).filter(pick);
  const menus = ax.refs.slice(ax.windowCount).filter(pick);
  const head = [
    `app: ${ax.app}${front ? ' (front)' : ' (behind — type/keys/press bring it to the front)'}`,
    `window: ${ax.window ? `"${ax.window}"` : '(none)'}${ax.presenting ? ' · full screen / presenting' : ''}`,
  ];
  const body: string[] = [];
  let left = MAX_LINES;
  const take = (title: string, rs: AxRef[]) => {
    if (!rs.length) return;
    body.push(title);
    for (const r of rs.slice(0, Math.max(0, left))) body.push(line(r));
    left -= rs.length;
  };
  take('## window', win);
  take('## menu bar', menus);
  if (left < 0) body.push(`… ${-left} more items — pass filter to narrow.`);
  if (!win.length && !menus.length) body.push(f ? `(nothing matches "${filter}")` : '(no items)');
  return [...head, ...body].join('\n');
}

/** 실행 중인 앱의 이름들 — 보이는 이름("카카오톡")과 번들 파일 이름("KakaoTalk"). */
const runningNames = (a: AxApp) => [a.app, a.path.split('/').pop()?.replace(/\.app$/i, '') ?? ''];
/** 설치된 앱의 이름들 — 번들 이름("Calculator")과 사용자 언어로 보이는 이름("계산기"). */
const installedNames = (a: InstalledApp) => [a.name, a.displayName ?? ''];
const installedLabel = (a: InstalledApp) => (a.displayName ? `${a.displayName} (${a.name})` : a.name);

/** 도구가 쓰는 맥 기능 — 테스트가 바꿔 끼운다. */
export interface DesktopPort {
  trusted(): Promise<boolean>;
  apps(): Promise<AxApp[]>;
  installed(): Promise<InstalledApp[]>;
  front(): Promise<AxFront>;
  open(path: string): Promise<string>;
  activate(pid: number): Promise<void>;
  hide(pid: number): Promise<void>;
  snapshot(pid: number): Promise<AxSnapshot>;
  press(ref: string, gen: number): Promise<void>;
  focus(ref: string, gen: number): Promise<void>;
  setValue(ref: string, gen: number, text: string): Promise<void>;
  type(text: string): Promise<void>;
  keys(combo: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const realPort: DesktopPort = {
  trusted: () => axTrusted(false),
  apps: axApps,
  installed: installedApps,
  front: axFront,
  open: (path) => openWithDefaultApp(path),
  activate: axActivate,
  hide: axHide,
  snapshot: (pid) => axSnapshot(pid, 2_000),
  press: axPress,
  focus: axFocus,
  setValue: axSetValue,
  type: axType,
  keys: axKeys,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export type DesktopDeps = {
  enabled: () => boolean;
  /** DeX 메인 창을 보이고 앞으로 — 앱을 숨기기 전에(숨긴 뒤면 뒤에 있던 다른 앱에 밀린다). */
  showDex: () => void;
  /** DeX 자신의 pid — 여기에는 입력하지 않는다. */
  selfPid?: number;
  port?: DesktopPort;
};

const text = (t: string, isError = false): LocalToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) });

export class DesktopToolProvider implements LocalToolDelegate {
  private port: DesktopPort;
  private selfPid: number;
  /** 마지막으로 열거나 읽은 앱 — app 을 빼면 이 앱. */
  private lastPid: number | null = null;
  /** 마지막 스냅샷 — ref 의 이름(위험 항목 판정)과 번호(gen). */
  private last: AxSnapshot | null = null;

  constructor(private deps: DesktopDeps) {
    this.port = deps.port ?? realPort;
    this.selfPid = deps.selfPid ?? process.pid;
  }

  private available(): boolean {
    // 바꿔 끼운 기능(테스트)이면 OS 를 묻지 않는다.
    return this.deps.enabled() && (this.deps.port !== undefined || (process.platform === 'darwin' && macAxAvailable()));
  }

  advertise(): LocalToolSchema[] {
    return this.available() ? desktopToolSchemas() : [];
  }

  owns(tool: string): boolean {
    return DESKTOP_TOOL_NAMES.has(tool);
  }

  async callTool(tool: string, raw: unknown, context?: LocalToolCallContext): Promise<LocalToolResult> {
    if (!this.available()) throw new Error('데스크탑 앱 조작이 꺼져 있습니다 (DeX 설정 > 말로 다른 앱도 조작).');
    if (context?.remote) {
      throw new Error(`${tool} 은(는) 이 PC 앞에서 보낸 요청에서만 쓸 수 있습니다 — 이 요청은 ${context.originName || '다른 기기'}에서 왔습니다.`);
    }
    const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    try {
      if (tool === DESKTOP_APPS_TOOL) return await this.appsTool(str('action') || 'list', str('app'));
      if (tool === DESKTOP_SNAPSHOT_TOOL) return await this.snapshotTool(str('app'), str('filter'));
      if (tool === DESKTOP_INTERACT_TOOL) return await this.interactTool(str('action'), str('app'), str('ref'), str('text'), str('keys'));
    } catch (e) {
      return text(`${tool} 실패: ${(e as Error).message}`, true);
    }
    throw new Error(`unknown desktop tool: ${tool}`);
  }

  private async needTrust(): Promise<void> {
    if (!(await this.port.trusted())) {
      throw new Error('손쉬운 사용 권한이 없습니다 — 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 XGen Dex 를 허용해 달라고 사용자에게 알리세요.');
    }
  }

  private async appsTool(action: string, app: string): Promise<LocalToolResult> {
    if (action === 'list') {
      const [running, installed] = await Promise.all([this.port.apps(), this.port.installed()]);
      const shown = running.filter((a) => a.pid !== this.selfPid);
      const run = shown.map((a) => `${a.app}${a.front ? ' (front)' : ''}${a.hidden ? ' (hidden)' : ''}`).join(', ');
      return text(`Running: ${run || '(none)'}\nInstalled: ${installed.map(installedLabel).join(', ')}`);
    }
    if (!app.trim()) throw new Error('app 이 필요합니다.');
    if (action === 'open') return this.open(app);
    if (action === 'hide') {
      const target = await this.running(app);
      this.deps.showDex();
      await this.port.hide(target.pid);
      return text(`숨겼습니다: ${target.app}`);
    }
    throw new Error(`지원하지 않는 action: ${action}`);
  }

  /** 실행 중이면 앞으로, 아니면 설치된 앱을 실행 — 맨 앞에 올 때까지 기다린다. */
  private async open(app: string): Promise<LocalToolResult> {
    const running = (await this.port.apps()).filter((a) => a.pid !== this.selfPid);
    const hit = matchApp(app, running, runningNames);
    if (hit.kind === 'many') throw new Error(`'${app}' 에 맞는 실행 중인 앱이 여럿입니다: ${hit.apps.map((a) => a.app).join(', ')}`);
    let path: string;
    let name: string;
    if (hit.kind === 'one') {
      path = hit.app.path;
      name = hit.app.app;
    } else {
      const installed = await this.port.installed();
      const found = matchApp(app, installed, installedNames);
      if (found.kind === 'many') throw new Error(`'${app}' 에 맞는 앱이 여럿입니다: ${found.apps.map(installedLabel).join(', ')}`);
      if (found.kind === 'none') {
        return text(`'${app}' 앱을 찾지 못했습니다. 실행 중: ${running.map((a) => a.app).join(', ')}\n설치됨: ${installed.map(installedLabel).join(', ')}`, true);
      }
      path = found.app.path;
      name = found.app.displayName ?? found.app.name;
    }
    // `open <번들>` — 실행하거나, 떠 있으면(숨김 포함) 앞으로. LaunchServices 를 거쳐 다른 앱이 앞에 있어도 온다.
    // 번들 경로를 모르는 실행 중인 앱만 접근성으로 앞으로 가져온다.
    if (path) {
      const err = await this.port.open(path);
      if (err) throw new Error(err);
    } else if (hit.kind === 'one') {
      await this.port.activate(hit.app.pid);
    }
    const pid = hit.kind === 'one' ? hit.app.pid : null;
    const front = await this.waitFront((a) => (pid !== null ? a.pid === pid : a.path === path), hit.kind === 'one' ? FRONT_WAIT_MS : LAUNCH_WAIT_MS);
    if (front) this.lastPid = front.pid;
    return text(front ? `열었습니다: ${name} (맨 앞)` : `${name} 을(를) 실행했지만 아직 맨 앞에 오지 않았습니다 — 잠시 뒤 DesktopSnapshot 으로 확인하세요.`);
  }

  private async waitFront(match: (a: AxApp) => boolean, ms: number): Promise<AxApp | null> {
    for (let waited = 0; ; waited += 200) {
      const a = (await this.port.apps()).find(match);
      if (a?.front) return a;
      if (waited >= ms) return null;
      await this.port.sleep(200);
    }
  }

  /** 대상 앱: 이름이 있으면 실행 중인 그 앱, 없으면 마지막 앱. DeX 자신은 대상이 아니다. */
  private async running(app: string): Promise<AxApp> {
    const running = (await this.port.apps()).filter((a) => a.pid !== this.selfPid);
    if (app.trim()) {
      const hit = matchApp(app, running, runningNames);
      if (hit.kind === 'one') return hit.app;
      if (hit.kind === 'many') throw new Error(`'${app}' 에 맞는 앱이 여럿입니다: ${hit.apps.map((a) => a.app).join(', ')}`);
      throw new Error(`'${app}' 은(는) 실행 중이 아닙니다 — DesktopApps open 으로 먼저 여세요. 실행 중: ${running.map((a) => a.app).join(', ')}`);
    }
    const last = running.find((a) => a.pid === this.lastPid) ?? running.find((a) => a.front);
    if (!last) throw new Error(`어느 앱인지 app 으로 알려 주세요. 실행 중: ${running.map((a) => a.app).join(', ')}`);
    return last;
  }

  private async snapshotTool(app: string, filter: string): Promise<LocalToolResult> {
    await this.needTrust();
    const target = await this.running(app);
    const ax = await this.port.snapshot(target.pid);
    this.last = ax;
    this.lastPid = target.pid;
    return text(formatSnapshot(ax, target.front, filter));
  }

  /** 그 앱을 맨 앞으로 — 확인되지 않으면 던진다(글자·키가 다른 앱으로 가지 않게). */
  private async bringFront(target: AxApp): Promise<void> {
    if ((await this.port.front()).pid === target.pid) return;
    if (target.path) await this.port.open(target.path);
    else await this.port.activate(target.pid);
    for (let waited = 0; waited <= FRONT_WAIT_MS; waited += 100) {
      if ((await this.port.front()).pid === target.pid) return;
      await this.port.sleep(100);
    }
    throw new Error(`${target.app} 을(를) 맨 앞으로 가져오지 못해 조작하지 않았습니다.`);
  }

  private async interactTool(action: string, app: string, ref: string, input: string, combo: string): Promise<LocalToolResult> {
    await this.needTrust();
    const target = await this.running(app);
    const snap = this.last && this.last.pid === target.pid ? this.last : null;
    const refOf = (r: string) => {
      if (!snap) throw new Error(`${target.app} 을(를) 아직 읽지 않았습니다 — DesktopSnapshot 을 먼저 부르세요.`);
      const el = snap.refs.find((x) => x.ref === r);
      if (!el) throw new Error(`${r} 은(는) 마지막 스냅샷에 없습니다 — DesktopSnapshot 으로 다시 읽으세요.`);
      return el;
    };
    let done: string;
    if (action === 'press') {
      if (!ref) throw new Error('press 에는 ref 가 필요합니다.');
      const el = refOf(ref);
      if (isIrreversible(el.name)) {
        return text(`'${el.name}' 은(는) 되돌릴 수 없을 수 있어 누르지 않았습니다 — 사용자에게 직접 누르도록 안내하세요.`, true);
      }
      await this.bringFront(target);
      await this.port.press(ref, snap!.gen);
      done = `눌렀습니다: ${ref} (${el.role} "${el.name}")`;
    } else if (action === 'type') {
      if (!input) throw new Error('type 에는 text 가 필요합니다.');
      await this.bringFront(target);
      if (ref) await this.port.focus(refOf(ref).ref, snap!.gen);
      await this.port.type(input);
      done = `입력했습니다: ${input.length}자${ref ? ` (${ref})` : ''}`;
    } else if (action === 'set_value') {
      if (!ref) throw new Error('set_value 에는 ref 가 필요합니다.');
      const el = refOf(ref);
      await this.port.setValue(ref, snap!.gen, input);
      done = `바꿨습니다: ${ref} (${el.role} "${el.name}")`;
    } else if (action === 'keys') {
      if (!combo.trim()) throw new Error('keys 에는 keys 가 필요합니다.');
      if (isBlockedCombo(combo)) {
        return text(`'${combo}' 는 닫기·종료·저장처럼 되돌릴 수 없을 수 있어 보내지 않았습니다 — 사용자에게 직접 하도록 안내하세요.`, true);
      }
      await this.bringFront(target);
      await this.port.keys(combo);
      done = `보냈습니다: ${combo}`;
    } else {
      throw new Error(`지원하지 않는 action: ${action}`);
    }
    this.lastPid = target.pid;
    await this.port.sleep(SETTLE_MS);
    return text(`${done} — ${target.app}. 결과는 DesktopSnapshot 으로 확인하세요.`);
  }
}
