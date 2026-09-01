/**
 * 모바일 도구 — 에이전트가 이 **안드로이드 기기**를 조작하는 도구 카탈로그.
 *
 * 데스크톱의 LocalTools 와 같은 레일(connector-mcp hello/mcp_call)을 타되,
 * 서버 네임스페이스를 'mobile' 로 분리한다 — 에이전트에게는
 * `mcp_mobile_<Tool>` 로 보이며, 데스크톱의 `mcp_local_*` 과 이름이 충돌하지
 * 않는다. (connector-mcp WS 는 사용자당 1연결 last-writer-wins 다 — 모바일
 * 앱이 전면일 때는 모바일 카탈로그가 데스크톱 카탈로그를 대체한다.)
 *
 * 파일 도구의 루트는 기기의 공용 Documents/XGenDex 폴더다 — 사용자가 파일
 * 앱에서 직접 볼 수 있고, 앱 삭제 후에도 남는다. 경로는 전부 이 루트 기준
 * 상대 경로이며 `..` 탈출은 거부한다.
 *
 * 결과 계약은 데스크톱 LocalToolResult 와 동일:
 *   { content: [{type:'text', text}], isError? } — mcp_result.result 로 실려
 * 에이전트에게 그대로 간다.
 */

export const MOBILE_SERVER = 'mobile';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolAdvert {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 기기 기능 포트 — Capacitor 어댑터(capacitor-port.ts)가 구현하고,
 *  테스트는 인메모리 가짜로 구현한다. 모든 경로는 루트 상대 경로다. */
export interface DevicePort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, append: boolean): Promise<void>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean; size: number }>>;
  deleteFile(path: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  deviceInfo(): Promise<Record<string, unknown>>;
  batteryInfo(): Promise<{ level?: number; isCharging?: boolean }>;
  networkStatus(): Promise<{ connected: boolean; connectionType: string }>;
  share(title: string, text: string, url?: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  vibrate(): Promise<void>;
  /** 카메라 촬영 → 루트 아래 저장, 저장된 상대 경로 반환. */
  takePhoto(fileName: string): Promise<string>;
}

const str = (desc: string): Record<string, unknown> => ({ type: 'string', description: desc });

/** 카탈로그 — hello 프레임에 그대로 실린다. 스키마는 JSON Schema. */
export function advertiseMobileTools(): ToolAdvert[] {
  const t = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): ToolAdvert => ({
    server: MOBILE_SERVER,
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  });
  return [
    t('ReadFile', '휴대폰의 XGenDex 문서 폴더에서 텍스트 파일을 읽습니다.', {
      path: str('루트 상대 경로 (예: "메모/할일.txt")'),
    }, ['path']),
    t('WriteFile', '휴대폰의 XGenDex 문서 폴더에 텍스트 파일을 쓰거나 덧붙입니다.', {
      path: str('루트 상대 경로'),
      content: str('파일 내용'),
      append: { type: 'boolean', description: 'true 면 끝에 덧붙임 (기본 false = 덮어쓰기)' },
    }, ['path', 'content']),
    t('ListDir', '휴대폰의 XGenDex 문서 폴더 내용을 나열합니다.', {
      path: str('루트 상대 경로 (비우면 루트)'),
    }),
    t('DeleteFile', '휴대폰의 XGenDex 문서 폴더에서 파일을 삭제합니다.', {
      path: str('루트 상대 경로'),
    }, ['path']),
    t('Notify', '휴대폰에 로컬 알림을 표시합니다.', {
      title: str('알림 제목'),
      body: str('알림 내용'),
    }, ['title', 'body']),
    t('Clipboard', '휴대폰 클립보드를 읽거나 씁니다.', {
      action: { type: 'string', enum: ['read', 'write'], description: 'read 또는 write' },
      text: str('write 일 때 넣을 텍스트'),
    }, ['action']),
    t('DeviceInfo', '휴대폰 기기 정보(모델/OS/배터리/네트워크)를 조회합니다.', {}),
    t('Share', '안드로이드 공유 시트를 엽니다 (다른 앱으로 텍스트/링크 전달).', {
      title: str('공유 제목'),
      text: str('공유할 텍스트'),
      url: str('공유할 링크 (선택)'),
    }, ['text']),
    t('OpenUrl', '휴대폰 브라우저로 URL 을 엽니다.', {
      url: str('열 주소 (http/https)'),
    }, ['url']),
    t('Vibrate', '휴대폰을 짧게 진동시킵니다.', {}),
    t('TakePhoto', '카메라를 열어 사진을 찍고 XGenDex 문서 폴더에 저장합니다.', {
      fileName: str('저장 파일명 (예: "현장사진.jpg", 비우면 자동)'),
    }),
  ];
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** 경로 검증 — 루트 밖 탈출/절대경로 거부. 반환은 정규화된 상대 경로. */
export function safeRelPath(raw: unknown): string {
  const p = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = p.split('/').filter((s) => s.length > 0);
  if (parts.some((s) => s === '..' || s === '.')) {
    throw new Error(`허용되지 않는 경로: ${String(raw)}`);
  }
  return parts.join('/');
}

export async function callMobileTool(
  port: DevicePort,
  tool: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  try {
    switch (tool) {
      case 'ReadFile': {
        const path = safeRelPath(args.path);
        if (!path) return err('path 가 필요합니다.');
        return ok(await port.readFile(path));
      }
      case 'WriteFile': {
        const path = safeRelPath(args.path);
        if (!path) return err('path 가 필요합니다.');
        await port.writeFile(path, String(args.content ?? ''), args.append === true);
        return ok(`저장했습니다: ${path}`);
      }
      case 'ListDir': {
        const path = safeRelPath(args.path ?? '');
        const entries = await port.listDir(path);
        if (entries.length === 0) return ok('(비어 있음)');
        return ok(
          entries
            .map((e) => (e.isDir ? `${e.name}/` : `${e.name} (${e.size}B)`))
            .join('\n'),
        );
      }
      case 'DeleteFile': {
        const path = safeRelPath(args.path);
        if (!path) return err('path 가 필요합니다.');
        await port.deleteFile(path);
        return ok(`삭제했습니다: ${path}`);
      }
      case 'Notify': {
        await port.notify(String(args.title ?? '알림'), String(args.body ?? ''));
        return ok('알림을 표시했습니다.');
      }
      case 'Clipboard': {
        if (args.action === 'read') return ok(await port.clipboardRead());
        if (args.action === 'write') {
          await port.clipboardWrite(String(args.text ?? ''));
          return ok('클립보드에 복사했습니다.');
        }
        return err("action 은 'read' 또는 'write' 여야 합니다.");
      }
      case 'DeviceInfo': {
        const [info, battery, net] = await Promise.all([
          port.deviceInfo(),
          port.batteryInfo(),
          port.networkStatus(),
        ]);
        return ok(JSON.stringify({ ...info, battery, network: net }, null, 2));
      }
      case 'Share': {
        await port.share(String(args.title ?? ''), String(args.text ?? ''),
          args.url ? String(args.url) : undefined);
        return ok('공유 시트를 열었습니다.');
      }
      case 'OpenUrl': {
        const url = String(args.url ?? '');
        if (!/^https?:\/\//.test(url)) return err('http/https URL 만 열 수 있습니다.');
        await port.openUrl(url);
        return ok(`열었습니다: ${url}`);
      }
      case 'Vibrate': {
        await port.vibrate();
        return ok('진동했습니다.');
      }
      case 'TakePhoto': {
        const name = safeRelPath(args.fileName ?? '') || `photo-${Date.now()}.jpg`;
        const saved = await port.takePhoto(name);
        return ok(`사진을 저장했습니다: ${saved}`);
      }
      default:
        return err(`알 수 없는 도구: ${tool}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
