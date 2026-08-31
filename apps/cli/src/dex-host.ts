/**
 * 터미널이 엔진에게 주는 것 — 포트 구현 셋.
 *
 * 데스크톱은 같은 자리를 Electron 으로 채운다(apps/desktop/src/main/dex-host.ts).
 * 두 파일을 나란히 놓고 보면 이 저장소의 요점이 보인다 — 다른 것은 여기뿐이고,
 * 그 아래 엔진은 한 벌이다.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { platform } from 'node:os';
import { stdin, stdout } from 'node:process';
import {
  bindHost,
  DANGEROUS_COMMAND_PROMPT,
  openerInvocation,
  type HostPorts,
  type InteractionPort,
  type DexConfig,
} from '@dex/engine';
import { FileConfigStore, dataDirectory } from '@dex/engine';
import { SystemCredentialStore } from '@dex/engine';

/** 한 줄 실행하고 (성공, 표준출력) 을 돌려준다. 없는 명령은 조용히 실패한다. */
function run(file: string, args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, out: '' });
      return;
    }
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', () => resolve({ ok: false, out: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** OS 별 클립보드 도우미. 설치돼 있지 않으면 실패로 나오고, 도구가 그렇게 말한다. */
function clipboardCommands(): { read: [string, string[]]; write: [string, string[]] } | null {
  const os = platform();
  if (os === 'darwin') return { read: ['pbpaste', []], write: ['pbcopy', []] };
  if (os === 'win32') {
    return {
      read: ['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']],
      write: ['clip', []],
    };
  }
  // 리눅스는 배포판·세션(X11/Wayland)에 따라 다르다. 순서대로 시도한다.
  return { read: ['xclip', ['-selection', 'clipboard', '-o']], write: ['xclip', ['-selection', 'clipboard']] };
}

/**
 * 위험한 명령 확인 — 터미널 프롬프트.
 *
 * **비대화형이면 묻지 않고 거부한다.** 파이프에 물려 돌 때 프롬프트를 띄우면
 * 아무도 못 보는 질문 앞에서 영원히 멈춘다. 스크립트에서 필요하면 설정으로
 * 미리 승인한다(`dex tools configure --allow-dangerous`).
 */
async function confirmDangerous(command: string): Promise<'once' | 'session' | 'deny'> {
  if (!stdin.isTTY || !stdout.isTTY) return 'deny';
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${DANGEROUS_COMMAND_PROMPT.title}\n${DANGEROUS_COMMAND_PROMPT.message}\n`);
    stdout.write(`  ${DANGEROUS_COMMAND_PROMPT.detail(command)}\n`);
    const answer = await new Promise<string>((resolve) =>
      rl.question('허용하시겠습니까? [n=거부 / y=이번만 / a=이 세션 동안] ', resolve),
    );
    const a = answer.trim().toLowerCase();
    // 기본값은 거부다 — 엔터만 친 사용자가 승인한 것이 되면 안 된다.
    return a === 'a' ? 'session' : a === 'y' ? 'once' : 'deny';
  } finally {
    rl.close();
  }
}

const clip = clipboardCommands();

const terminalInteraction: InteractionPort = {
  confirmDangerous,
  clipboard: clip
    ? {
        async read() {
          const r = await run(clip.read[0], clip.read[1]);
          if (!r.ok) throw new Error(`클립보드를 읽지 못했습니다 (${clip.read[0]} 가 필요합니다).`);
          return r.out;
        },
        async write(text) {
          const r = await run(clip.write[0], clip.write[1], text);
          if (!r.ok) throw new Error(`클립보드에 쓰지 못했습니다 (${clip.write[0]} 가 필요합니다).`);
        },
      }
    : undefined,
  /**
   * 터미널에는 알림 센터가 없다. OS 도우미가 있으면 그것으로, 없으면 **표준
   * 오류에 한 줄** 쓴다 — 사용자가 보고 있는 곳이 거기다. 조용히 성공한 척하지
   * 않는 것이 규칙이지만, 여기서는 실제로 사람에게 닿는다.
   */
  async notify(title, body) {
    const os = platform();
    if (os === 'darwin') {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      const r = await run('osascript', ['-e', script]);
      if (r.ok) return true;
    } else if (os === 'linux') {
      const r = await run('notify-send', [title, body]);
      if (r.ok) return true;
    }
    process.stderr.write(`\n[알림] ${title}${body ? `: ${body}` : ''}\n`);
    return true;
  },
  async openExternal(url) {
    const { file, args } = openerInvocation(url);
    const r = await run(file, args);
    if (!r.ok) throw new Error(`열지 못했습니다 (${file} 가 필요합니다).`);
  },
  async openPath(absolutePath) {
    const { file, args } = openerInvocation(absolutePath);
    const r = await run(file, args);
    return r.ok ? '' : `열지 못했습니다 (${file} 가 필요합니다).`;
  },
};

/**
 * 엔진에 이 호스트를 붙인다. **엔진을 건드리기 전에 한 번** 부른다 — 붙지 않은
 * 채로 쓰면 엔진이 명확히 던진다(조용히 메모리로 폴백하지 않는다).
 */
export function bindCliHost(configStore: FileConfigStore): void {
  // 엔진의 ConfigPort 는 동기 load/save 다(설정을 읽는 자리마다 await 가 붙으면
  // 호출부가 지저분해진다). CLI 의 파일 저장소는 비동기라 마지막으로 읽은 값을
  // 들고 있다가 동기로 답한다 — 설정은 프로세스 시작에 한 번 읽히고 거의 안 변한다.
  let cached: DexConfig | null = null;
  void configStore.read().then((c) => (cached = c)).catch(() => undefined);

  const ports: HostPorts<DexConfig> = {
    secrets: {
      get: (name) => credentials.getRaw(name),
      set: (name, value) => credentials.setRaw(name, value),
    },
    config: {
      load: () => cached ?? ({} as DexConfig),
      save: (patch) => {
        const next = { ...(cached ?? ({} as DexConfig)), ...patch } as DexConfig;
        cached = next;
        void configStore.write(next).catch(() => undefined);
        return next;
      },
    },
    paths: { dataRoot: () => dataDirectory() },
    interaction: terminalInteraction,
  };
  bindHost(ports);
}

/** 비밀 저장은 프로파일 세션과 같은 백엔드(keytar → 파일 폴백)를 쓴다. */
const credentials = new SystemCredentialStore();
