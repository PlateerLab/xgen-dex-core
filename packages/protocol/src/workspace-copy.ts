/**
 * 기기 폴더 ↔ 에이전트 작업 공간 — 데스크톱·CLI·VSCode(엔진)와 모바일이 같은 계약으로 옮긴다.
 *
 * 폴더 도구는 기기 안에서만 돌았다. ReadFile 은 글만 읽으므로 사용자가 "카톡으로 받은 문서 세 개를 분석해
 * 줘" 라고 하면 에이전트는 docx·pdf·hwp 를 자기 작업 공간으로 가져올 길이 없었고(2026-10-02 사용자 지적),
 * 반대로 작업 공간에서 만든 보고서를 사용자의 폴더에 놓을 길도 없었다(WriteFile 은 글만 쓴다).
 *
 *   CopyToWorkspace     기기의 파일·폴더 → 이 대화의 첨부 폴더(uploads/…/<대화>/). 폴더는 구조째 옮긴다.
 *                       결과의 `structuredContent.workspaceFiles` 를 서버가 읽어 **그 턴의 sandbox 에 바로**
 *                       들인다 — sandbox 는 턴 시작에 한 번만 작업 공간을 받아 오므로, 그 일이 없으면 방금
 *                       올린 파일이 다음 턴에야 보인다.
 *   CopyFromWorkspace   작업 공간의 파일 → 기기 폴더. 기기는 sandbox 를 읽을 수 없으므로 서버가 그 파일을
 *                       임시 파일로 내어 `download` 인자로 실어 보내고, 기기는 그것을 받아 폴더에 쓴다.
 *
 * 도구 설명은 모델이 읽는다(영어). 사용자에게 보이는 결과 문장은 모델이 그대로 전할 수 있게 짧게 쓴다.
 */

export const COPY_TO_WORKSPACE_TOOL = 'CopyToWorkspace';
export const COPY_FROM_WORKSPACE_TOOL = 'CopyFromWorkspace';

/** 한 번의 복사가 옮길 수 있는 양. 넘는 것은 건너뛰고 결과에 이유를 적는다. */
export const WORKSPACE_COPY_LIMITS = {
  maxFiles: 300,
  /** 서버 채팅 첨부 한도(GENY_CHAT_ATTACHMENT_MAX_BYTES 기본)와 같다. */
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxDepth: 8,
} as const;

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean };
}

/**
 * 두 도구의 카탈로그 한 줄. `device` 는 설명에만 쓰인다("the user's computer" / "the user's phone").
 */
export function workspaceCopySchemas(device: 'computer' | 'phone'): ToolSchema[] {
  const where = device === 'phone' ? "the user's phone" : "the user's computer";
  return [
    {
      name: COPY_TO_WORKSPACE_TOOL,
      annotations: { readOnlyHint: false, openWorldHint: false },
      description:
        `Copy files or folders from ${where} (inside the folders connected to this conversation) into YOUR ` +
        'workspace, so you can work on them with your own tools (Read, ParseDocument, Bash, ...). Folders are ' +
        "copied recursively with their structure. Files land in this conversation's upload folder and the " +
        'result lists the exact path of each file in your sandbox. Use this for documents, spreadsheets, PDFs, ' +
        'images or any file you need to process; ReadFile only returns text.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: `Paths on ${where} of the files or folders to copy.`,
          },
        },
        required: ['paths'],
      },
    },
    {
      name: COPY_FROM_WORKSPACE_TOOL,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        `Save a file from YOUR workspace (sandbox) onto ${where}, inside a folder connected to this ` +
        'conversation. Use it to hand results (reports, spreadsheets, images) back to the user. Missing ' +
        'folders are created. An existing file is kept unless overwrite is true.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Path of the file in your workspace (sandbox).' },
          path: {
            type: 'string',
            description: `Destination on ${where}: a folder (the file keeps its name) or a full file path.`,
          },
          overwrite: { type: 'boolean', description: 'Replace an existing file (default false).' },
        },
        required: ['source', 'path'],
      },
    },
  ];
}

/** 작업 공간에 올린 파일 한 개 — `path` 는 작업 공간 기준(서버 업로드가 돌려준 workspace_path). */
export interface CopiedFile {
  /** 기기에서의 경로(모델이 준 모양 그대로 보이게). */
  source: string;
  path: string;
  size: number;
  sha256?: string;
}

export interface SkippedFile {
  source: string;
  reason: string;
}

export interface CopyResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** CopyToWorkspace 의 결과 — 모델이 읽는 글과 서버가 읽는 목록(`workspaceFiles`). */
export function copyToWorkspaceResult(copied: readonly CopiedFile[], skipped: readonly SkippedFile[]): CopyResult {
  const lines: string[] = [];
  if (copied.length) {
    lines.push(`Copied ${copied.length} file(s) into your workspace:`);
    for (const f of copied) lines.push(`- ${f.source} -> ${f.path} (${sizeText(f.size)})`);
  } else {
    lines.push('No file was copied.');
  }
  if (skipped.length) {
    lines.push(`Skipped ${skipped.length}:`);
    for (const s of skipped.slice(0, 50)) lines.push(`- ${s.source}: ${s.reason}`);
    if (skipped.length > 50) lines.push(`- ...and ${skipped.length - 50} more`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    ...(copied.length ? {} : { isError: true }),
    structuredContent: {
      workspaceFiles: copied.map((f) => ({ path: f.path, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}) })),
    },
  };
}

/** 기기 경로 → 첨부 폴더 안의 자리. 폴더를 통째로 옮길 때 그 폴더 이름부터 남긴다(`cp -r` 과 같다). */
export function copyTargetDir(rootName: string, relInsideRoot: string): string {
  const parts = [rootName, ...relInsideRoot.split('/')].map((p) => p.trim()).filter((p) => p && p !== '.' && p !== '..');
  return parts.slice(0, -1).join('/');
}

/** 서버가 CopyFromWorkspace 호출에 실어 보내는 받을 거리. */
export interface WorkspaceDownload {
  url: string;
  token?: string;
  name: string;
  size?: number;
}

/** 호출 인자의 `download` — 서버가 넣지 않았으면(옛 서버) null. */
export function workspaceDownloadOf(args: Record<string, unknown>): WorkspaceDownload | null {
  const raw = args.download;
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const url = typeof d.url === 'string' ? d.url.trim() : '';
  if (!url.startsWith('/api/agentflow/files/artifacts/')) return null;
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'file';
  return {
    url,
    name: name.replace(/[\\/]/g, '_'),
    ...(typeof d.token === 'string' && d.token ? { token: d.token } : {}),
    ...(typeof d.size === 'number' ? { size: d.size } : {}),
  };
}

/** 서버가 받을 거리를 싣지 않았다 — 이 서버는 아직 이 도구를 모른다. */
export const NO_DOWNLOAD_MESSAGE =
  'The server did not attach the workspace file to this call, so it cannot be saved on the device. Tell the user this server version does not support it yet.';

/** 기기 쪽 목록 한 줄의 수정 시각 — 기기의 현지 시각. "오늘 받은 파일" 을 고를 근거다. */
export function deviceTimeText(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
