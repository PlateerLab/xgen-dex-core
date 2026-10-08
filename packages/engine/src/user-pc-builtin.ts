/**
 * 내장 bash 해석기 — Windows 에 Git Bash 가 없을 때 UserPc 명령을 bash 문법으로 돌린다.
 *
 * just-bash(Vercel, Apache-2.0)가 bash 를 해석하고, 연결 폴더마다 실제 폴더를 `/<폴더 이름>` 으로
 * 붙인다(ReadWriteFs — 쓰기는 그 폴더에 그대로 간다). `ls`·`find`·`grep`·`sed`·`awk`·`jq`… 같은 파일·글
 * 명령은 해석기 안에서 돌고, 설치된 프로그램은 `powershell`·`pwsh`·`cmd` 로 넘겨 실제 프로세스로 돈다.
 *
 * 해석기는 붙인 폴더 밖을 보지 못한다(`cd /` 해도 붙인 폴더뿐이다).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { uniqueMountNames } from '@dex/protocol/user-pc-shell';

export interface BuiltinRequest {
  command: string;
  /** 실제 경로(연결 폴더 안). */
  cwd: string;
  roots: string[];
  names: string[];
  maxRuntimeMs: number;
  signal: AbortSignal;
}

export interface BuiltinResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 해석기 안의 마지막 위치를 실제 경로로. */
  cwd: string;
}

/** 붙일 이름 — 이름이 없으면 폴더 이름, 겹치면 번호(휴대폰·브라우저와 같은 규칙). */
export function mountNames(roots: string[], names: string[]): string[] {
  return uniqueMountNames(roots.map((root, i) => names[i] || basename(root)));
}

/** 실제 경로 ↔ 해석기 경로. */
export function pathMaps(roots: string[], mounts: string[]) {
  const toVirtual = (real: string): string => {
    for (let i = 0; i < roots.length; i += 1) {
      const rel = relative(roots[i], real);
      if (rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith(sep))) {
        const tail = rel ? `/${rel.split(sep).join('/')}` : '';
        return `/${mounts[i]}${tail}`;
      }
    }
    return `/${mounts[0]}`;
  };
  const toReal = (virtual: string): string | null => {
    const clean = virtual.replace(/\/+$/, '') || '/';
    for (let i = 0; i < mounts.length; i += 1) {
      const head = `/${mounts[i]}`;
      if (clean === head) return roots[i];
      if (clean.startsWith(`${head}/`)) return join(roots[i], ...clean.slice(head.length + 1).split('/'));
    }
    return null;
  };
  return { toVirtual, toReal };
}

/**
 * 앱 번들에 싣지 않는 명령 — 이것들만 큰 패키지를 따로 부른다(sqlite3 → sql.js,
 * html-to-markdown → turndown). 앱 빌드가 그 패키지를 빼므로 명령도 등록하지 않는다
 * (`which sqlite3` 가 없다고 정직하게 답한다). 뺄 패키지 목록(user-pc-bundle)과 짝이다.
 */
export const BUILTIN_LEFT_OUT_COMMANDS = ['sqlite3', 'html-to-markdown'];

const PASSTHROUGH = [
  { name: 'powershell', file: 'powershell.exe', prefix: ['-NoProfile', '-NonInteractive'] },
  { name: 'pwsh', file: 'pwsh.exe', prefix: ['-NoProfile', '-NonInteractive'] },
  { name: 'cmd', file: 'cmd.exe', prefix: [] as string[] },
];

export async function startBuiltinBash(req: BuiltinRequest): Promise<BuiltinResult> {
  const jb = (await import('just-bash')) as typeof import('just-bash');
  const mounts = mountNames(req.roots, req.names);
  const { toVirtual, toReal } = pathMaps(req.roots, mounts);
  const fs = new jb.MountableFs({ base: new jb.InMemoryFs() });
  req.roots.forEach((root, i) => fs.mount(`/${mounts[i]}`, new jb.ReadWriteFs({ root })));

  const passthrough = PASSTHROUGH.filter((p) => p.name !== 'pwsh' || existsSync(join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')))
    .map((p) =>
      jb.defineCommand(p.name, async (args, ctx) => {
        const cwd = toReal(ctx.cwd) ?? req.roots[0];
        return new Promise((resolve) => {
          const child = spawn(p.file, [...p.prefix, ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          child.stdout?.setEncoding('utf8');
          child.stderr?.setEncoding('utf8');
          child.stdout?.on('data', (d: string) => (out += d));
          child.stderr?.on('data', (d: string) => (err += d));
          const stop = () => {
            if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
          };
          ctx.signal?.addEventListener('abort', stop, { once: true });
          child.on('error', (e) => resolve({ stdout: out, stderr: `${err}${e.message}\n`, exitCode: 127 }));
          child.on('close', (code) => {
            ctx.signal?.removeEventListener('abort', stop);
            resolve({ stdout: out, stderr: err, exitCode: code ?? 1 });
          });
          // just-bash 의 stdin 은 바이트 문자열이다 — 글로 풀어 넘긴다.
          if (ctx.stdin) child.stdin?.end(Buffer.from(jb.decodeBytesToUtf8(ctx.stdin), 'utf8'));
          else child.stdin?.end();
        });
      }),
    );

  const bash = new jb.Bash({
    fs,
    cwd: toVirtual(req.cwd),
    commands: jb.getCommandNames().filter((name) => !BUILTIN_LEFT_OUT_COMMANDS.includes(name)) as import('just-bash').CommandName[],
    customCommands: passthrough,
    executionLimits: { maxExecutionTimeMs: req.maxRuntimeMs },
  });
  // 마지막 위치를 실제 경로로 알려 준다 — `cd` 한 결과가 다음 명령의 시작 위치가 되지는 않는다(ssh 와 같다).
  const r = await bash.exec(req.command, { signal: req.signal });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, cwd: req.cwd };
}
