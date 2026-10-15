/**
 * FilestoreApi — XGen **파일 저장소**(xgen-documents filestore)의 조회 표면.
 *
 * 항목/폴더 목록·원바이트와 오피스 문서 서버 렌더(filestore-preview — 웹
 * [파일 저장소] 뷰어와 동일 계약)를 다룬다. 데스크톱 탐색기가 서버의 파일
 * 저장소를 그대로 보여 주고, 파일 뷰어가 "경로 → 항목 id" 를 풀어 바이트와
 * 문서 페이지 이미지를 받을 때 쓴다 — 앱은 서버 경로를 직접 부르지 않는다는
 * 계약 규칙의 이행처다.
 */
import type { HttpClient } from './client';

export interface FilestoreFolder {
  id: number;
  folder_name: string;
  full_path: string;
  parent_folder_id: number | null;
}

export interface FilestoreItem {
  id: number;
  file_name: string;
  file_size: number;
  folder_id: number | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** 폴더 한 쪽 — 서버는 하위 폴더를 먼저 늘어놓고 그 뒤에 파일을 잇는다. */
interface FilestorePage {
  folders?: FilestoreFolder[];
  items?: FilestoreItem[];
  has_more?: boolean;
}

/** 한 쪽의 크기 — 서버 상한(500)과 같다. 폴더 하나를 적은 요청으로 끝까지 읽는다. */
const PAGE_SIZE = 500;
/** 폴더 하나에서 읽는 최대 쪽 수 — 서버가 has_more 를 잘못 줘도 끝이 있게. */
const MAX_PAGES = 200;

export interface FilestoreOfficePreview {
  /** 페이지 파일명(slide_NNN.svg | page-N.png) — officePreviewPage 로 가져온다. */
  pages: string[];
}

export class FilestoreApi {
  constructor(private http: HttpClient) {}

  /** 전체 폴더 평면 목록 — full_path 로 경로를 푼다. */
  async tree(): Promise<{ folders: FilestoreFolder[] }> {
    const res = await this.http.get<{ folders?: FilestoreFolder[] }>('/api/filestore/tree');
    return { folders: res.folders ?? [] };
  }

  /**
   * 폴더 하나의 내용 전부 — 하위 폴더 + 파일. ``folderId`` 가 null 이면 루트.
   * 서버는 한 쪽씩 주므로 ``has_more`` 가 꺼질 때까지 이어 읽는다(첫 쪽만 읽으면
   * 파일이 많은 폴더의 뒷부분이 보이지 않는다).
   */
  async list(
    folderId: number | null,
  ): Promise<{ folders: FilestoreFolder[]; items: FilestoreItem[] }> {
    const base =
      folderId == null ? '/api/filestore/root' : `/api/filestore/folders/${folderId}/items`;
    const folders: FilestoreFolder[] = [];
    const items: FilestoreItem[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.http.get<FilestorePage>(
        `${base}?page=${page}&page_size=${PAGE_SIZE}`,
      );
      folders.push(...(res.folders ?? []));
      items.push(...(res.items ?? []));
      if (!res.has_more) break;
    }
    return { folders, items };
  }

  /** 루트 내용 — 루트 바로 밑 폴더/파일. */
  root(): Promise<{ folders: FilestoreFolder[]; items: FilestoreItem[] }> {
    return this.list(null);
  }

  /** 폴더 내용 — 하위 폴더 + 파일. */
  folderItems(
    folderId: number,
  ): Promise<{ folders: FilestoreFolder[]; items: FilestoreItem[] }> {
    return this.list(folderId);
  }

  /** 저장소 상대 경로("a/b") → 폴더. 루트('')면 null, 없으면 undefined. */
  async folderByPath(path: string): Promise<FilestoreFolder | null | undefined> {
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (!clean) return null;
    const { folders } = await this.tree();
    return folders.find((f) => String(f.full_path ?? '').replace(/^\/+|\/+$/g, '') === clean);
  }

  /** 저장소 상대 경로("a/b.txt") → 항목. 없으면 null. */
  async resolveItemByPath(path: string): Promise<FilestoreItem | null> {
    const clean = path.replace(/^\/+/, '');
    const slash = clean.lastIndexOf('/');
    const dirPath = slash === -1 ? '' : clean.slice(0, slash);
    const fileName = slash === -1 ? clean : clean.slice(slash + 1);
    const folder = await this.folderByPath(dirPath);
    if (folder === undefined) return null;
    const { items } = await this.list(folder?.id ?? null);
    return items.find((it) => it.file_name === fileName) ?? null;
  }

  /** 항목 원바이트. */
  download(itemId: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.http.getBinary(`/api/filestore/items/${itemId}/download`);
  }

  /**
   * 오피스 문서(pptx/docx/xlsx + hwp/hwpx/doc/xls/ppt) 서버 렌더 — 페이지 목록.
   * 콜드 렌더는 수십 초까지 걸린다 (웹 파일 저장소와 동일 계약).
   */
  async officePreview(itemId: number): Promise<FilestoreOfficePreview> {
    const res = await this.http.get<{ pages?: string[] }>(
      `/api/agentflow/filestore-preview/${itemId}`,
      { timeoutMs: 300_000 },
    );
    return { pages: Array.isArray(res.pages) ? res.pages : [] };
  }

  /** 렌더된 페이지 이미지 바이트. */
  officePreviewPage(
    itemId: number,
    page: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.http.getBinary(
      `/api/agentflow/filestore-preview/${itemId}/page/${encodeURIComponent(page)}`,
    );
  }
}
