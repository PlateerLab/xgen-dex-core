/**
 * 사용자 PC 접속(UserPc)의 휴대폰 쪽 — 서버의 내부 호출 `_UserPcRun`·`_UserPcJob` 을 받아 연결 폴더에서
 * bash 명령을 돌린다.
 *
 * 휴대폰은 프로세스를 띄울 수 없으므로 @dex/protocol 의 내장 셸(FolderShell, bash 해석기 just-bash)이
 * 명령을 해석한다. 연결 폴더는 `/<폴더 이름>` 으로 붙고(서버에 올린 가상 경로와 같다), 파일·글 명령이 돈다.
 *
 * 폴더는 문서 제공자(안드로이드)·보안 범위 폴더(iOS)라 기기 API(FolderFs)로 닿는다. 그 API 는 파일을 글로만
 * 읽고 쓴다 — 그래서 복사·이동은 기기의 복사(바이트 그대로)로 가고, 너무 큰 파일은 읽지 않는다.
 */
import {
  FolderShell,
  USER_PC_JOB_TOOL,
  USER_PC_RUN_TOOL,
  USER_PC_TOOL_NAMES,
  outcomeText,
  userPcToolSchemas,
  type JustBashModule,
  type ShellFolderOps,
  type UserPcOutcome,
} from '@dex/protocol';
import type { FolderFs, ToolResult } from './mobile-tools';
import { NO_FOLDER_MESSAGE, type MobileFolder } from './mobile-folders';

export { USER_PC_TOOL_NAMES };

/** 셸이 한 번에 읽는 파일 크기 상한 — 넘으면 읽지 않고 그렇다고 답한다(잘린 내용으로 일하지 않게). */
const READ_LIMIT = 16 * 1024 * 1024;

export const MOBILE_SHELL = {
  label: 'bash (built in: file and text commands)',
  note:
    'connected folders appear as /<folder name>; this is a phone, so only file and text commands run ' +
    '(no installed programs)',
};

/**
 * 휴대폰 번들에 싣지 않은 것을 부르는 명령 — metro.config.js 가 그 패키지를 껍데기로 바꿔 끼운다
 * (html-to-markdown → turndown, gzip 류 → node:zlib).
 */
const LEFT_OUT = ['html-to-markdown', 'gzip', 'gunzip', 'zcat'];

const shell = new FolderShell(
  async () => (await import('just-bash/browser')) as unknown as JustBashModule,
  MOBILE_SHELL,
  LEFT_OUT,
);

/** 카탈로그 항목(서버 이름은 붙이는 쪽이 붙인다). */
export function userPcSchemas() {
  return userPcToolSchemas(MOBILE_SHELL);
}

const utf8 = new TextDecoder('utf-8');

/** 연결 폴더 하나 → 셸의 파일 조작. */
export function folderOps(fs: FolderFs, folder: MobileFolder): ShellFolderOps {
  return {
    list: (rel) => fs.list(folder, rel),
    stat: (rel) => fs.stat(folder, rel),
    async read(rel) {
      const out = await fs.readText(folder, rel, READ_LIMIT);
      if (out.truncated) {
        throw new Error(`EFBIG: file too large for the shell on this phone (${out.size} bytes), read '/${rel}'`);
      }
      return out.text;
    },
    write: (rel, data, append) => fs.writeText(folder, rel, typeof data === 'string' ? data : utf8.decode(data), append),
    remove: (rel) => fs.remove(folder, rel),
    ...(fs.mkdir ? { mkdir: (rel: string) => fs.mkdir!(folder, rel) } : {}),
    ...(fs.copy ? { copy: (from: string, to: string) => fs.copy!(folder, from, to) } : {}),
  };
}

function result(outcome: UserPcOutcome): ToolResult {
  return {
    content: [{ type: 'text', text: outcomeText(outcome) }],
    structuredContent: outcome as unknown as Record<string, unknown>,
  };
}

/** `_UserPcRun`·`_UserPcJob` — 그 대화에 연결된 폴더 안에서만. */
export async function callUserPc(
  tool: string,
  args: Record<string, unknown>,
  scope: { folders: MobileFolder[]; fs: FolderFs; interactionId?: string; signal?: AbortSignal },
): Promise<ToolResult> {
  const key = scope.interactionId ?? '';
  if (tool === USER_PC_JOB_TOOL) {
    const action = args.action === 'stop' ? 'stop' : 'poll';
    return result(await shell.job(String(args.job_id ?? ''), key, action, Number(args.wait_ms) || undefined, scope.signal));
  }
  if (tool !== USER_PC_RUN_TOOL) throw new Error(`알 수 없는 도구: ${tool}`);
  if (!scope.folders.length) throw new Error(NO_FOLDER_MESSAGE);
  return result(
    await shell.run({
      command: String(args.command ?? ''),
      cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined,
      mounts: scope.folders.map((folder) => ({ name: folder.name, ops: folderOps(scope.fs, folder) })),
      key,
      waitMs: Number(args.wait_ms) || undefined,
      maxRuntimeMs: Number(args.max_runtime_ms) || undefined,
      signal: scope.signal,
    }),
  );
}

/** 폴더 연결이 바뀌었다 — 빠진 폴더에서 돌던 그 대화의 작업을 멈춘다. */
export function userPcFoldersChanged(interactionId: string, folders: MobileFolder[]): void {
  shell.stopOutside(interactionId, folders.map((folder) => folder.name));
}

/** 로그아웃·계정 전환 — 돌던 작업을 모두 멈춘다. */
export function stopAllUserPc(): void {
  shell.stopAll();
}
