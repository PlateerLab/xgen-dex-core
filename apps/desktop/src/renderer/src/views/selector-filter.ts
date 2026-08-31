/**
 * 셀렉터 검색 필터 — 순수 로직 (React 없이 단위 테스트).
 *
 * xgen-frontend selector 의 계약과 동일하다: 검색 대상 텍스트는
 * `keywords ?? (문자열 label) ?? value`, 대소문자 무시 부분일치.
 */

export interface FilterableOption {
  value: string;
  label: unknown;
  keywords?: string;
}

export function optionText(option: FilterableOption): string {
  if (option.keywords) return option.keywords;
  return typeof option.label === 'string' ? option.label : option.value;
}

export function filterOptions<T extends FilterableOption>(options: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => optionText(o).toLowerCase().includes(q));
}
