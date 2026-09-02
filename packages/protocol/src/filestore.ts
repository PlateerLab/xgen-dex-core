/**
 * FilestoreApi — XGen **파일 저장소**(xgen-documents filestore)의 조회 표면.
 *
 * 동기화 전송(`/api/filestore/sync/*`)과 별개로, 항목/폴더 메타와 오피스 문서
 * 서버 렌더(filestore-preview — 웹 [파일 저장소] 뷰어와 동일 계약)를 다룬다.
 * 데스크톱 파일 뷰어가 "경로 → 항목 id" 를 풀고 문서 페이지 이미지를 받을 때
 * 쓴다 — 앱은 서버 경로를 직접 부르지 않는다는 계약 규칙의 이행처다.
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
}

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

  /** 루트 내용 — 루트 바로 밑 폴더/파일. */
  async root(): Promise<{ folders: FilestoreFolder[]; items: FilestoreItem[] }> {
    const res = await this.http.get<{ folders?: FilestoreFolder[]; items?: FilestoreItem[] }>(
      '/api/filestore/root',
    );
    return { folders: res.folders ?? [], items: res.items ?? [] };
  }

  /** 폴더 내용. */
  async folderItems(folderId: number): Promise<{ items: FilestoreItem[] }> {
    const res = await this.http.get<{ items?: FilestoreItem[] }>(
      `/api/filestore/folders/${folderId}/items`,
    );
    return { items: res.items ?? [] };
  }

  /** 저장소 상대 경로("a/b.txt") → 항목. 없으면 null. */
  async resolveItemByPath(path: string): Promise<FilestoreItem | null> {
    const clean = path.replace(/^\/+/, '');
    const slash = clean.lastIndexOf('/');
    const dirPath = slash === -1 ? '' : clean.slice(0, slash);
    const fileName = slash === -1 ? clean : clean.slice(slash + 1);
    let items: FilestoreItem[];
    if (!dirPath) {
      items = (await this.root()).items;
    } else {
      const { folders } = await this.tree();
      const folder = folders.find(
        (f) => String(f.full_path ?? '').replace(/^\/+|\/+$/g, '') === dirPath,
      );
      if (!folder) return null;
      items = (await this.folderItems(folder.id)).items;
    }
    return items.find((it) => it.file_name === fileName) ?? null;
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
