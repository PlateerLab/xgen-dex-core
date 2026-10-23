/**
 * 파일 올리기 — 빠른 조작용("대표 이미지에 001 상품 이미지 올려줘", "대표이미지를 INNO-20261016-001_대표이미지.png로 업로드해줘").
 *
 * 올리는 칸은 대개 숨은 `<input type=file>` 이고 화면에 보이는 것은 "업로드할 파일을 드래그 하거나 선택해 주세요" 영역이다.
 * 숨은 칸은 스냅샷에 없어서 판단 모델이 고를 수 없다(10/19 BO: 같은 줄의 비활성 대체 텍스트 칸을 0.918 로 골랐다). 그래서
 * 파일 칸마다 칸 이름을 찾아 `"대표이미지 파일 올리기"` 입력칸으로 화면 줄에 넣는다 — 칸 제목 바로 뒤에. 무엇을 할지(올릴지,
 * 어느 칸인지)는 판단 모델이 다른 요소와 같은 질문으로 정한다. 어느 파일인지도 판단 모델이 연결 폴더의 파일 목록에서 고른다.
 * 영역을 누르면 운영체제 파일 창이 뜨므로 누르지 않고 숨은 칸에 파일을 바로 넣는다(브라우저 도구 upload).
 *
 * 올라갔는지는 그 칸 영역이 바뀐 것으로 본다 — 미리보기 이미지가 새로 생겼거나 파일 이름이 보이면 올라간 것이다. 숨지 않은
 * 그냥 파일 칸은 파일을 고른 것 자체가 끝이다(폼을 보낼 때 같이 간다). 그 밖에는 올라갔다고 하지 않는다.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ElementRefs } from './fast-act';

/** 페이지의 파일 칸 하나 — 칸 이름과, 올라갔는지 볼 영역의 모습. */
export type FileField = {
  /** 칸에 붙인 표시(`data-dex-file`) — 브라우저 도구 upload 의 선택자로 쓴다. */
  n: number;
  label: string;
  /** 칸이 화면에 보이는가(숨은 칸이면 영역이 바뀌어야 올라간 것이다). */
  visible: boolean;
  /** 열린 층(서랍·모달)이 뒤 화면을 aria-hidden 으로 가렸다 — 스냅샷의 다른 칸처럼 후보에서 뺀다. */
  covered?: boolean;
  /** 칸이 받는 형식(`accept`) — 비면 아무 파일. */
  accept: string;
  /** 칸에 들어 있는 파일 이름. */
  files: string[];
  /** 영역 안 이미지 주소 — 불러오기를 마치고 그림이 있는 것만(불러오는 중이면 어느 쪽에도 없다). */
  imgs: string[];
  /** 불러오기를 마쳤는데 그림이 없는 이미지 주소(깨진 미리보기). */
  broken?: string[];
  /** 아직 불러오는 중인 이미지 주소 — 업로드 전부터 있던 것을 새 미리보기로 보지 않게. */
  loading?: string[];
  /** 영역 글자. */
  text: string;
};

/** 올라갔다고 볼 근거. */
export type Landed = 'preview' | 'name' | 'picked' | 'broken';

const FILE_EXT = 'png|jpe?g|gif|webp|bmp|svg|heic|mp4|mov|avi|webm|pdf|xlsx?|csv|docx?|pptx?|hwp|zip|txt';

/** 말에 든 파일 이름 — 공백 없는 `이름.확장자` 하나. 뒤에 붙은 조사("…png로")는 뺀다. */
export function fileNameIn(text: string): string | null {
  const m = text.match(new RegExp(`[^\\s"'“”‘’「」『』]+\\.(?:${FILE_EXT})(?![A-Za-z0-9])`, 'i'));
  return m ? m[0] : null;
}

/** 말한 파일 이름이 그 파일인가 — 이름만("a.png") 또는 연결 폴더 안 경로("상품이미지/a.png")로. */
export function namesFile(path: string, named: string): boolean {
  const p = `/${path.replace(/\\/g, '/')}`;
  return p.endsWith(`/${named.replace(/\\/g, '/').replace(/^\/+/, '')}`);
}

const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

const KIND: Record<string, string> = {
  png: 'image', jpg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', heic: 'image',
  mp4: 'video', mov: 'video', avi: 'video', webm: 'video',
  pdf: 'application',
};
const extOf = (path: string): string => (basename(path).match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase().replace(/^jpeg$/, 'jpg');

/** 칸의 `accept` 가 받는 파일인가 — `.pdf`, `image/*`, `image/png` 꼴. */
export function accepts(accept: string, path: string): boolean {
  const ext = extOf(path);
  const parts = accept.split(',').map((a) => a.trim().toLowerCase().replace(/jpeg/g, 'jpg')).filter(Boolean);
  if (!parts.length) return true;
  return parts.some((a) => (a.startsWith('.') ? a.slice(1) === ext : a.endsWith('/*') ? KIND[ext] === a.slice(0, -2) : a.split('/')[1] === ext));
}

const squashName = (s: string): string => s.replace(/[\s*]+/g, '');

/** 파일 칸 하나의 화면 줄 번호 — 페이지 요소(e1…)·브라우저 조작(e9001…)과 겹치지 않게. */
const fileRef = (n: number): string => `e8${String(n + 1).padStart(3, '0')}`;

/**
 * 화면 요소에 파일 칸을 `"<칸 이름> 파일 올리기"` 입력칸으로 넣는다 — 칸 이름과 같은 제목 바로 뒤에(판단 모델이 제목과 함께 본다),
 * 그런 제목이 없으면 맨 뒤에. files = 넣은 줄 번호별 파일 칸.
 */
export function withFileFields(refs: ElementRefs, all: FileField[]): { refs: ElementRefs; files: Record<string, FileField> } {
  // 가려진 칸은 넣지 않는다 — 서랍이 열린 채 입력칸은 스냅샷에서 빠지고 파일 칸만 남아 "모델명 …" 에 파일 칸을 골랐다(10/22 BO).
  const fields = all.filter((f) => !f.covered);
  if (!fields.length) return { refs, files: {} };
  const files: Record<string, FileField> = {};
  const line = (f: FileField): [string, ElementRefs[string]] => {
    files[fileRef(f.n)] = f;
    // 입력칸 모양으로 — 버튼이면 "a.png 넣어줘" 같은 입력 요청에서 옆 입력칸(대체 텍스트)에 밀린다(10/19 BO: 0.971 대 0.029).
    return [fileRef(f.n), { role: 'textbox', name: f.label ? `${f.label} 파일 올리기` : '파일 올리기' }];
  };
  const placed = new Set<number>();
  const out: Array<[string, ElementRefs[string]]> = [];
  for (const [k, r] of Object.entries(refs)) {
    out.push([k, r]);
    if (r.role !== 'heading') continue;
    const head = squashName(r.name ?? '');
    for (const f of fields) {
      if (placed.has(f.n) || !f.label || head !== squashName(f.label)) continue;
      placed.add(f.n);
      out.push(line(f));
    }
  }
  for (const f of fields) if (!placed.has(f.n)) out.push(line(f));
  return { refs: Object.fromEntries(out) as ElementRefs, files };
}

/** 올리기 전과 뒤의 같은 칸 — 올라갔다고 볼 근거, 없으면 null. */
export function uploadLanded(before: FileField, after: FileField, file: string): Landed | null {
  const seen = [...before.imgs, ...(before.broken ?? []), ...(before.loading ?? [])];
  if (after.imgs.some((src) => !seen.includes(src))) return 'preview';
  // 새 미리보기가 깨졌다 — 대체 글이 파일 이름이라 아래 'name' 으로 올라간 것처럼 보였다(10/23 BO: 저장된 상품의 대표이미지가 비어 있었다).
  if ((after.broken ?? []).some((src) => !seen.includes(src))) return 'broken';
  const name = squash(file);
  const stem = name.replace(/\.[^.]+$/, '');
  const shows = (t: string): boolean => squash(t).includes(name) || squash(t).includes(stem);
  if (shows(after.text) && !shows(before.text)) return 'name';
  if (after.visible && after.files.includes(file)) return 'picked';
  return null;
}

/** 연결된 폴더(하위 폴더 포함)의 파일들. 숨은 폴더·node_modules 는 보지 않는다. */
export async function listFiles(roots: string[], max = 2_000): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    // ponytail: 폴더를 통째로 훑는다(최대 max 개) — 큰 폴더가 연결되면 느려진다. 그때 깊이 한도를 둔다.
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const d of entries) {
      if (!d.isFile()) continue;
      const path = join(d.parentPath, d.name);
      if (path.slice(root.length).split(/[\\/]/).some((p) => p.startsWith('.') || p === 'node_modules')) continue;
      found.push(path);
      if (found.length >= max) return found;
    }
  }
  return found;
}

/**
 * 페이지에서 실행한다 — 파일 칸마다 `data-dex-file` 표시를 붙이고 칸 이름·영역을 돌려준다.
 * 영역 = 그 칸만 품은 조상을 칸 이름(제목·label·th·legend)이 들 때까지 올라간 곳. 이름은 영역 안 첫 제목, 없으면 영역 바로 앞
 * 형제 칸의 제목(이름 칸과 입력 칸이 나란한 표 — 10/19 BO), 그것도 없으면 aria-label.
 */
export const FILE_FIELDS_SCRIPT = `(() => {
  const NAME = 'h1,h2,h3,h4,h5,h6,label,th,legend,[role=heading]';
  // 접힌 영역은 innerText 가 비므로 textContent 로 읽는다. MUI 입력칸은 빈 legend(폭 맞춤용 ZWSP)를 품는다 — 글자 있는 것만 이름이다.
  const squash = (s) => (s || '').replace(/[\\s\\u200b]+/g, ' ').trim();
  const nameIn = (el) => [...el.querySelectorAll(NAME)].find((h) => squash(h.textContent));
  return [...document.querySelectorAll('input[type=file]')].map((input, n) => {
    input.setAttribute('data-dex-file', String(n));
    let area = input;
    while (area.parentElement && area.parentElement.querySelectorAll('input[type=file]').length === 1 && !nameIn(area)) area = area.parentElement;
    // 이름이 영역 밖 앞 칸에 있는 표 모양(이름 칸 | 입력 칸, th | td) — 바로 앞 형제들에서 찾는다.
    let side = null;
    for (let sib = area.previousElementSibling, k = 0; !nameIn(area) && sib && k < 3 && !side; sib = sib.previousElementSibling, k++) {
      side = sib.matches(NAME) && squash(sib.textContent) ? sib : nameIn(sib);
    }
    const own = input.labels && input.labels[0];
    const head = own || nameIn(area) || side;
    const label = squash(head ? head.textContent : input.getAttribute('aria-label')).replace(/\\s*\\*$/, '').slice(0, 30);
    return {
      n,
      label,
      accept: input.accept || '',
      visible: !!input.getClientRects().length && getComputedStyle(input).visibility !== 'hidden',
      covered: !!input.closest('[aria-hidden="true"]'),
      files: [...(input.files || [])].map((f) => f.name),
      imgs: [...area.querySelectorAll('img')].filter((img) => img.complete && img.naturalWidth).map((img) => img.currentSrc || img.src),
      broken: [...area.querySelectorAll('img')].filter((img) => img.complete && !img.naturalWidth).map((img) => img.currentSrc || img.src),
      loading: [...area.querySelectorAll('img')].filter((img) => !img.complete).map((img) => img.currentSrc || img.src),
      text: squash(area.textContent).slice(0, 2000),
    };
  });
})()`;
