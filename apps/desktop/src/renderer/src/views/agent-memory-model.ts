import type { MemoryFile } from '@dex/protocol';

export type MemorySort = 'recent' | 'oldest' | 'title';

const CONTEXT_BLOCK = /<xgen_(browser|teams)_context\b[^>]*>[\s\S]*?<\/xgen_\1_context>/gi;
const TRUNCATED_CONTEXT = /<xgen_(?:browser|teams)_context\b[\s\S]*$/gi;

/** Display only: keep the stored note and its raw copy intact, including truncated envelopes. */
export function cleanMemoryText(text: string): string {
  return text.replace(CONTEXT_BLOCK, '').replace(TRUNCATED_CONTEXT, '').trim();
}

export function memoryTitle(file: Pick<MemoryFile, 'filename' | 'title'>): string {
  const original =
    file.title?.trim() || file.filename.split('/').pop()?.replace(/\.md$/i, '') || '메모리 노트';
  const clean = cleanMemoryText(original)
    .replace(/\s+/g, ' ')
    .replace(/\s*[—–:]\s*$/, '')
    .trim();
  if (/^(대화|conversation)$/i.test(clean)) return '대화 기록';
  if (!clean) return '메모리 노트';
  return clean;
}

export function memoryPreview(text = ''): string {
  return cleanMemoryText(text)
    .replace(/<!--[^]*?(?:-->|$)/g, '')
    .replace(/[*`]/g, '')
    .replace(/^>[ \t]*/gm, '')
    .replace(/^(?:Duration|Session|Model):.*$/gim, '')
    .replace(/^Task:[ \t]*/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function filterMemoryFiles(
  files: MemoryFile[],
  options: { query: string; category: string; tag: string; sort: MemorySort },
): MemoryFile[] {
  const query = options.query.trim().toLocaleLowerCase();
  const timestamp = (file: MemoryFile) => {
    const value = Date.parse(file.modified ?? '');
    return Number.isFinite(value) ? value : null;
  };
  return files
    .filter((file) => {
      if (options.category && (file.category || 'root') !== options.category) return false;
      if (options.tag && !file.tags?.includes(options.tag)) return false;
      return (
        !query ||
        [
          memoryTitle(file),
          file.filename,
          memoryPreview(file.first_paragraph),
          ...(file.tags ?? []),
        ].some((value) => value.toLocaleLowerCase().includes(query))
      );
    })
    .sort((a, b) => {
      if (options.sort === 'title') return memoryTitle(a).localeCompare(memoryTitle(b), 'ko');
      const left = timestamp(a);
      const right = timestamp(b);
      // Notes without a valid timestamp always follow dated notes, including oldest-first sorting.
      if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
      return options.sort === 'oldest' ? left - right : right - left;
    });
}

export const CATEGORY_LABELS: Record<string, string> = {
  daily: '일일 기록',
  topics: '주제',
  projects: '프로젝트',
  insights: '인사이트',
  reference: '참고 자료',
  conversations: '대화',
  executions: '실행 기록',
  compactions: '압축 기록',
  root: '일반',
  critical: '중요',
};

export function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category;
}

export function clampMemoryWidth(width: number) {
  return Math.max(260, Math.min(520, width));
}
