/**
 * 로컬 WebDAV 서버 — 가상 드라이브의 **공통 핵심**.
 *
 * 세 플랫폼이 같은 서버를 서로 다른 방식으로 마운트한다:
 *
 *     Windows  WebClient 내장 클라이언트 (`net use X: http://127.0.0.1:.../`)
 *     macOS    `mount_webdav` (내장)
 *     Linux    FUSE (내장 WebDAV 클라이언트가 DE 독립적으로는 없다)
 *
 * 그래서 **프로토콜 하나, 백엔드 하나**로 끝난다 — 파일시스템 의미론이 여기
 * 한 곳에만 있고, 플랫폼별 코드는 "이 URL 을 마운트해라" 뿐이다.
 *
 * ── 보안: 인증 대신 비밀 경로 ────────────────────────────────────────
 *
 * Windows WebClient 는 **HTTP 위의 Basic 인증을 기본 차단**한다
 * (BasicAuthLevel 기본값 = SSL 전용). 로컬 루프백에 TLS 를 붙이는 것도
 * 인증서 신뢰 문제로 깨끗하지 않다. 그래서:
 *
 *   * 서버는 **127.0.0.1 에만** 바인딩한다 (다른 기기에서 접근 불가).
 *   * 모든 경로 앞에 프로세스마다 새로 만드는 **비밀 토큰**을 붙인다.
 *     토큰이 틀리면 404 — 같은 컴퓨터의 다른 프로세스가 우연히 훑어도
 *     아무것도 못 본다.
 *
 * ── 클라이언트 요구사항 (이걸 빠뜨리면 마운트가 조용히 실패한다) ────
 *
 *   * ``DAV: 1, 2`` — macOS/Windows 는 **class 2(잠금)** 가 없으면 읽기
 *     전용으로 붙거나 아예 거부한다. 실제 잠금 의미론까지는 필요 없고
 *     LOCK/UNLOCK 에 형식만 맞는 응답을 주면 된다 (단일 사용자 로컬 마운트).
 *   * ``MS-Author-Via: DAV`` — Windows 가 이걸 안 보면 읽기 전용으로 붙는다.
 *   * OPTIONS 에 Allow 목록.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';

/** 백엔드가 다루는 항목 하나. */
export interface DavNode {
  /** 부모 기준 이름 (루트는 ''). */
  name: string;
  isDir: boolean;
  size: number;
  mtime: Date;
  /** 내용 식별자 — 있으면 ETag 로 그대로 나간다. */
  etag?: string;
}

/**
 * 파일시스템 뒤편. 경로는 항상 ``/`` 로 시작하는 POSIX 형태이고 루트는 ``/``.
 * 없는 경로는 :meth:`stat` 이 null 을 돌려준다 (예외 아님).
 */
export interface WebdavBackend {
  stat(path: string): Promise<DavNode | null>;
  readdir(path: string): Promise<DavNode[]>;
  read(path: string): Promise<Buffer>;
  /**
   * 선택 구현 — **부분 읽기**. 있으면 Range 요청에 이걸 쓴다.
   *
   * 없으면 전체를 읽어 잘라 보내는데, 그건 조각마다 파일 전체를 서버에서
   * 내려받는다는 뜻이다 (macOS/Windows 는 큰 파일을 조각으로 읽는다).
   */
  readRange?(path: string, start: number, end: number): Promise<Buffer>;
  write(path: string, data: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  move(from: string, to: string, overwrite: boolean): Promise<void>;
}

export interface DavServerHandle {
  server: Server;
  port: number;
  token: string;
  /** 마운트에 쓸 URL (끝에 / 포함). */
  url(): string;
  close(): Promise<void>;
}

const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK';

/** XML 텍스트 이스케이프 — 파일명에 &, <, > 가 들어가면 응답이 깨진다. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 경로 정규화 — 토큰 접두사를 떼고 POSIX 경로로.
 *
 * ``..`` 를 걷어내 백엔드가 루트 밖을 보지 못하게 한다 (경로 탈출 방어는
 * 백엔드가 아니라 **여기서** 끝낸다 — 백엔드 구현이 여러 개가 되어도
 * 방어가 한 곳에 남는다).
 */
export function decodePath(rawUrl: string, token: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname);
  } catch {
    return null;
  }
  const prefix = `/${token}`;
  if (p !== prefix && !p.startsWith(`${prefix}/`)) return null;
  p = p.slice(prefix.length) || '/';
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  // ⚠ **NFC 로 정규화한다.**
  //
  // macOS 는 파일명을 NFD(자모 분해)로 다룬다. "장하렴.pdf" 를 Finder 에서
  // 만들면 NFD 로 오고, Linux/웹에서 만든 같은 이름은 NFC 다. 정규화하지
  // 않으면 **같은 이름이 서로 다른 두 파일**이 되어 목록에 두 번 뜨고,
  // 한쪽에서 지워도 다른 쪽이 남는다. 레플리카 엔진(sync-fs)은 이걸 이미
  // 알고 정규화하는데, 가상 드라이브 경로에는 그 지식이 안 넘어와 있었다.
  return (`/${parts.join('/')}`.replace(/\/+$/, '') || '/').normalize('NFC');
}

/**
 * OS 가 제멋대로 만드는 메타데이터 파일인가.
 *
 * macOS 는 다른 파일시스템에 복사할 때 파일마다 ``._<이름>``(AppleDouble)을
 * 만들고 폴더마다 ``.DS_Store`` 를 남긴다. Windows 는 ``desktop.ini`` 와
 * ``Thumbs.db`` 를 남긴다. 그대로 두면 **사용자의 클라우드가 이 쓰레기로
 * 뒤덮이고 웹 화면에도 전부 보인다** (파일 수가 두 배가 된다).
 *
 * 레플리카 엔진의 무시 목록(sync-fs DEFAULT_IGNORE_GLOBS)과 같은 판단이다 —
 * 가상 드라이브에도 있어야 한다.
 */
export function isOsJunk(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!name) return false;
  if (name.startsWith('._')) return true; // macOS AppleDouble
  return /^(\.DS_Store|\.localized|\.Trashes|\.Spotlight-V100|\.fseventsd|\.TemporaryItems|\.DocumentRevisions-V100|Thumbs\.db|desktop\.ini|\.directory)$/i.test(
    name,
  );
}

/** ``Range: bytes=...`` 해석. null = 범위 없음, 'invalid' = 만족 불가(416). */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // 여러 범위/알 수 없는 단위는 전체를 준다 (RFC 허용)
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  let start: number;
  let end: number;
  if (rawStart === '') {
    // suffix range: 마지막 N 바이트
    const n = Number(rawEnd);
    if (n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start >= size || start < 0) return 'invalid';
  if (end >= size) end = size - 1;
  if (end < start) return 'invalid';
  return { start, end };
}

function href(token: string, path: string, isDir: boolean): string {
  const enc = path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
  const base = `/${token}${enc ? `/${enc}` : ''}`;
  return xmlEscape(isDir && !base.endsWith('/') ? `${base}/` : base);
}

function propfindEntry(token: string, path: string, node: DavNode): string {
  const iso = node.mtime.toUTCString();
  const created = node.mtime.toISOString().replace(/\.\d+Z$/, 'Z');
  const resourceType = node.isDir ? '<D:collection/>' : '';
  // 디렉터리에는 getcontentlength 를 주지 않는다 — 일부 클라이언트가 이를
  // 파일 신호로 받아들여 폴더를 열지 못한다.
  const len = node.isDir ? '' : `<D:getcontentlength>${node.size}</D:getcontentlength>`;
  const etag = node.etag ? `<D:getetag>"${xmlEscape(node.etag)}"</D:getetag>` : '';
  return (
    `<D:response><D:href>${href(token, path, node.isDir)}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(node.name)}</D:displayname>` +
    `<D:resourcetype>${resourceType}</D:resourcetype>` +
    `${len}${etag}` +
    `<D:getlastmodified>${iso}</D:getlastmodified>` +
    `<D:creationdate>${created}</D:creationdate>` +
    `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

function multistatus(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(
  res: ServerResponse,
  status: number,
  body = '',
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    // 모든 응답에 붙어야 하는 것들 — 빠지면 Windows 가 읽기 전용으로 붙는다.
    DAV: '1, 2',
    'MS-Author-Via': 'DAV',
    ...headers,
  });
  res.end(body);
}

/** 로컬 WebDAV 서버를 띄운다. 127.0.0.1 + 비밀 토큰 경로. */
export async function startDavServer(
  backend: WebdavBackend,
  opts: { token?: string; port?: number } = {},
): Promise<DavServerHandle> {
  // 마운트 원격 경로에 식별 마커('xgencloud')를 남겨 스테일 정리에서 우리 마운트를 안전히
  // 골라낸다. 랜덤 부분이 비밀 경로(127.0.0.1 바인딩 + 이 토큰)를 유지한다.
  const token = opts.token ?? `xgencloud-${randomBytes(15).toString('base64url')}`;

  /**
   * OS 메타데이터 파일의 **임시 보관소** — 클라우드로는 절대 안 나간다.
   *
   * 왜 거부하지 않고 받아 두나: `._foo` 쓰기를 실패로 돌려주면 Finder 가
   * 복사 전체를 중단한다. 그래서 받아 주되 **메모리에만** 둔다. 마운트가
   * 걷히면 같이 사라진다 — 원래 사라져야 할 것들이다.
   */
  const ghosts = new Map<string, { data: Buffer; mtime: Date }>();
  const ghostNode = (path: string, g: { data: Buffer; mtime: Date }): DavNode => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    isDir: false,
    size: g.data.length,
    mtime: g.mtime,
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      try {
        send(res, 500, String((e as Error)?.message ?? e));
      } catch {
        /* 응답이 이미 나갔다 */
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();
    const path = decodePath(req.url || '/', token);
    // 토큰 불일치 = 존재 자체를 알리지 않는다 (401 은 존재를 알려준다).
    if (path === null) return send(res, 404);

    // OS 메타데이터 파일은 백엔드(=클라우드)에 닿지 않는다.
    if (isOsJunk(path)) {
      const g = ghosts.get(path);
      if (method === 'PUT') {
        ghosts.set(path, { data: await readBody(req), mtime: new Date() });
        return send(res, g ? 204 : 201);
      }
      if (method === 'DELETE') {
        ghosts.delete(path);
        return send(res, 204);
      }
      if (method === 'HEAD' || method === 'GET') {
        if (!g) return send(res, 404);
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(g.data.length),
          'Last-Modified': g.mtime.toUTCString(),
        };
        if (method === 'HEAD') return send(res, 200, '', headers);
        res.writeHead(200, { DAV: '1, 2', 'MS-Author-Via': 'DAV', ...headers });
        return void res.end(g.data);
      }
      if (method === 'PROPFIND') {
        if (!g) return send(res, 404);
        return send(res, 207, multistatus(propfindEntry(token, path, ghostNode(path, g))), {
          'Content-Type': 'application/xml; charset=utf-8',
        });
      }
      if (method === 'LOCK' || method === 'UNLOCK' || method === 'OPTIONS') {
        /* 아래 공통 처리로 내려간다 */
      } else {
        return send(res, 204);
      }
    }

    if (method === 'OPTIONS') {
      return send(res, 200, '', { Allow: ALLOW, 'Content-Length': '0' });
    }

    // 잠금: 형식만 맞춘다. 로컬 단일 사용자 마운트라 실제 경합이 없고,
    // 클라이언트는 **응답 형식**만 보고 쓰기 가능 여부를 판단한다.
    if (method === 'LOCK') {
      const t = `opaquelocktoken:${randomBytes(12).toString('hex')}`;
      return send(
        res,
        200,
        `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery>` +
          `<D:activelock><D:locktype><D:write/></D:locktype>` +
          `<D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth>` +
          `<D:timeout>Second-3600</D:timeout>` +
          `<D:locktoken><D:href>${t}</D:href></D:locktoken>` +
          `</D:activelock></D:lockdiscovery></D:prop>`,
        { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${t}>` },
      );
    }
    if (method === 'UNLOCK') return send(res, 204);

    if (method === 'PROPFIND') {
      const node = await backend.stat(path);
      if (!node) return send(res, 404);
      const depth = String(req.headers.depth ?? '1');
      let body = propfindEntry(token, path, node);
      if (node.isDir && depth !== '0') {
        for (const child of await backend.readdir(path)) {
          // 예전 버전이 이미 올려 둔 OS 쓰레기도 여기서 가린다.
          if (isOsJunk(child.name)) continue;
          const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`;
          body += propfindEntry(token, childPath, child);
        }
      }
      return send(res, 207, multistatus(body), {
        'Content-Type': 'application/xml; charset=utf-8',
      });
    }

    if (method === 'GET' || method === 'HEAD') {
      const node = await backend.stat(path);
      if (!node) return send(res, 404);
      if (node.isDir) return send(res, 405);
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(node.size),
        'Last-Modified': node.mtime.toUTCString(),
        'Accept-Ranges': 'bytes',
      };
      if (node.etag) headers.ETag = `"${node.etag}"`;
      if (method === 'HEAD') return send(res, 200, '', headers);

      // Range 를 **전체를 읽기 전에** 판정한다. 백엔드가 부분 읽기를 지원하면
      // 필요한 조각만 가져온다 — 큰 파일에서 이게 전부다.
      const rangeHeader = String(req.headers.range ?? '');
      if (rangeHeader && backend.readRange) {
        const r = parseRange(rangeHeader, node.size);
        if (r === 'invalid') {
          return send(res, 416, '', {
            'Content-Range': `bytes */${node.size}`,
            'Content-Length': '0',
          });
        }
        if (r) {
          const slice = await backend.readRange(path, r.start, r.end);
          res.writeHead(206, {
            DAV: '1, 2',
            'MS-Author-Via': 'DAV',
            ...headers,
            'Content-Range': `bytes ${r.start}-${r.start + slice.length - 1}/${node.size}`,
            'Content-Length': String(slice.length),
          });
          return void res.end(slice);
        }
      }

      const data = await backend.read(path);
      // ⚠ **Range 를 실제로 지원한다.**
      //
      // 위에서 `Accept-Ranges: bytes` 를 광고하고 있으므로 클라이언트는 부분
      // 요청을 보낸다. macOS webdavfs 와 Windows WebClient 는 큰 파일을
      // 조각조각 읽는데, 여기서 매번 전체를 돌려주면 **조각 하나마다 파일
      // 전체가 서버에서 내려온다** — 100MB 파일을 여는 데 수 GB 가 오가고
      // 클라이언트 타임아웃에 걸린다. Linux 는 FUSE 가 한 번 통째로 읽어
      // 캐시하므로 이 결함이 드러나지 않았다.
      const range = parseRange(String(req.headers.range ?? ''), data.length);
      if (range === 'invalid') {
        // ⚠ 본문이 없으므로 Content-Length 를 물려주면 안 된다 — 클라이언트가
        // 오지 않을 바이트를 기다리며 멈춘다.
        return send(res, 416, '', {
          'Content-Range': `bytes */${data.length}`,
          'Content-Length': '0',
        });
      }
      if (range) {
        const slice = data.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
          ...headers,
          'Content-Range': `bytes ${range.start}-${range.end}/${data.length}`,
          'Content-Length': String(slice.length),
        });
        return void res.end(slice);
      }
      res.writeHead(200, {
        DAV: '1, 2',
        'MS-Author-Via': 'DAV',
        ...headers,
        'Content-Length': String(data.length),
      });
      return void res.end(data);
    }

    if (method === 'PUT') {
      const data = await readBody(req);
      const existed = await backend.stat(path);
      try {
        await backend.write(path, data);
      } catch (e) {
        // ⚠ 이유를 본문에 실어 보낸다. FUSE 자식 프로세스는 상태코드만 보고
        // EIO 로 바꾸므로, 여기서 안 실으면 원인이 **여기서 소멸**한다 —
        // 사용자에게는 "입력/출력 오류" 한 줄만 남는다.
        return send(res, 500, String((e as Error).message ?? e));
      }
      return send(res, existed ? 204 : 201);
    }

    if (method === 'MKCOL') {
      if (await backend.stat(path)) return send(res, 405);
      try {
        await backend.mkdir(path);
      } catch (e) {
        // PUT 과 같은 이유로 본문에 사유를 싣는다 — 안 실으면 승인 대기
        // 안내("관리자 승인이 필요합니다…")가 여기서 소멸하고 사용자에게는
        // 원인 없는 "폴더를 만들 수 없음"만 남는다.
        return send(res, 500, String((e as Error).message ?? e));
      }
      return send(res, 201);
    }

    if (method === 'DELETE') {
      if (!(await backend.stat(path))) return send(res, 404);
      await backend.remove(path);
      return send(res, 204);
    }

    if (method === 'MOVE' || method === 'COPY') {
      const dest = decodePath(String(req.headers.destination ?? ''), token);
      if (dest === null) return send(res, 400);
      const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase() !== 'F';
      const existed = await backend.stat(dest);
      if (existed && !overwrite) return send(res, 412);
      if (method === 'COPY') {
        const node = await backend.stat(path);
        if (!node) return send(res, 404);
        if (node.isDir) await backend.mkdir(dest);
        else await backend.write(dest, await backend.read(path));
      } else {
        await backend.move(path, dest, overwrite);
      }
      return send(res, existed ? 204 : 201);
    }

    return send(res, 405, '', { Allow: ALLOW });
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // ⚠ 127.0.0.1 에만 바인딩한다 — 0.0.0.0 이면 같은 네트워크의 아무나
    // 사용자의 파일을 읽는다.
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    server,
    port,
    token,
    url: () => `http://127.0.0.1:${port}/${token}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
