/**
 * 칸 이름이 연결되지 않은 입력칸에 화면의 칸 이름을 붙인다 — 빠른 조작 화면 줄용.
 *
 * 관리자 화면 입력 폼은 칸 이름을 입력칸과 연결하지 않은 글자로 옆에 두는 일이 흔하다(<label for>·aria-label
 * 없이 표·격자 칸에 "상품명"). 그러면 접근성 트리의 입력칸 이름이 비거나(`textbox ""`), 안내문("‘,(쉼표)’로
 * 구분하여 입력해 주세요.")이나 지금 값("택배배송" — 자기 자신을 이름으로 가리키는 선택칸)이 된다. 판단 모델은
 * "제조사에 플래티어 넣어줘" 의 칸을 못 고르거나(확신 0) 엉뚱한 칸을 고른다(10/16 BO 상품 등록 실측:
 * "상품명을 xgen으로 작성해줘" → 검색키워드 칸 0.997). 서버 에이전트는 전체 스냅샷의 글자를 같이 읽어서
 * 같은 지시를 맞게 했다.
 *
 * 칸 이름은 브라우저 자동완성의 칸 이름 추정처럼 찾는다: 입력칸에서 위로 올라가며 앞 형제의 글자를 보되, 화면
 * 자리가 맞아야 한다(같은 줄 왼쪽, 같은 열 바로 위). 칸 이름 줄 아래에 입력칸 줄이 열을 맞춰 놓인 폼("재고수량
 * 안전재고수량" / [ ] [ ])에서 앞 형제만 보면 첫 칸에 "안전재고수량" 이 붙었다. 다른 입력칸을 건너왔으면 바로 위
 * 글자만 받는다. 안내문·값은 버리지 않고 칸 이름 뒤에 둔다("검색키워드 내용 ‘,(쉼표)’로…", "배송방법 택배배송").
 * 스냅샷 요소 번호(@eN)와는 역할과 원래 이름이 같은 칸끼리 문서 순서로 맞춘다 — 수가 다르면 그 묶음은 붙이지 않는다.
 */
import { quotedText, type ElementRefs } from './fast-act';

/** 칸 이름을 붙이는 역할. */
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);

/** hint = 칸 이름 대신 접근성 이름이 된 글(안내문·자기 값, 없으면 ''), label = 화면에서 찾은 칸 이름. */
export type FieldLabel = { role: string; hint: string; label: string | null };

/**
 * 페이지에서 실행한다 — 보이는 입력칸 중 접근성 이름이 칸 이름에서 오지 않은 것을 문서 순서로.
 * 역할·이름 판정은 접근성 트리와 같게 맞춘 근사치다. 어긋나면 수가 달라져 붙이지 않는다(labelFields).
 */
/** 페이지 스크립트가 함께 쓰는 칸 판정·칸 이름 찾기(FIELD_LABEL_SCRIPT·FORM_VALUES_SCRIPT). */
const FIELD_HELPERS = `
  const FIELD = 'input:not([type=hidden]),textarea,select,[role=textbox],[role=searchbox],[role=spinbutton],[role=combobox],[contenteditable]:not([contenteditable=false])';
  const TEXT_TYPES = ['', 'text', 'email', 'tel', 'url', 'password'];
  const squash = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el.getClientRects().length || el.closest('[aria-hidden="true"],[inert]')) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  };
  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').trim();
    if (explicit) return explicit;
    // 글 편집 영역(contenteditable — 상품상세 같은 편집기 본문)은 입력칸이다(editableAsTextbox 와 같게).
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (el.tagName === 'SELECT') return el.multiple || el.size > 1 ? null : 'combobox';
    if (el.tagName !== 'INPUT') return null;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.hasAttribute('list') && (TEXT_TYPES.includes(type) || type === 'search')) return 'combobox';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    return TEXT_TYPES.includes(type) ? 'textbox' : null;
  };
  // 접근성 이름이 칸 이름(aria-label·title·label·다른 요소)에서 왔으면 null, 아니면 이름이 된 글.
  const hintOf = (el) => {
    const by = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)).filter(Boolean);
    if (by.some((t) => t !== el && !el.contains(t) && squash(t.textContent))) return null;
    if (squash(el.getAttribute('aria-label')) || squash(el.getAttribute('title'))) return null;
    if ([...(el.labels || [])].some((l) => squash(l.textContent))) return null;
    if (by.length) return squash(by.map((t) => t.textContent).join(' '));
    return squash(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
  };
  const clean = (s) => s.replace(/[*:：]/g, ' ').replace(/\\s+/g, ' ').trim();
  const fieldsIn = (node) => [...node.querySelectorAll(FIELD)].filter(visible).length + (node.matches(FIELD) ? 1 : 0);
  // 안 보이는 입력칸은 건너온 칸으로 치지 않는다 — 편집기 도구줄의 숨은 입력칸 때문에 옆 칸 이름을 버렸다.
  const isField = (n) => n.nodeType === 1 && ((n.matches(FIELD) && visible(n)) || [...n.querySelectorAll(FIELD)].some(visible));
  const rectOf = (t) => {
    const r = document.createRange();
    r.selectNodeContents(t);
    return r.getBoundingClientRect();
  };
  // 칸 이름은 같은 줄 왼쪽이나 같은 열 바로 위에 있다 — 앞 형제라도 자리가 안 맞으면 남의 칸 이름이다. 위의 칸 이름은
  // 칸 왼쪽 끝 가까이에서 시작한다(BO 24~34px) — 칸 위 오른쪽 끝의 광고 글(네이버 검색 결과 "현재 PC에 최적화된
  // 브라우저", 326px)은 아니다.
  const place = (lr, fr) => {
    if (!lr.width || !lr.height) return null;
    if (lr.right <= fr.left + 4 && lr.bottom > fr.top - 4 && lr.top < fr.bottom + 4 && fr.left - lr.right < 400) return 'left';
    if (lr.bottom <= fr.top + 4 && lr.right > fr.left && lr.left < fr.left + 80 && fr.top - lr.bottom < 80) return 'above';
    return null;
  };
  // 링크·버튼·메뉴의 글자는 칸 이름이 아니다 — 머리글의 로고 옆 글자·메뉴·광고 띠가 같은 줄 왼쪽에 있어 검색칸에
  // 붙었다(유튜브 "KR", 네이버 검색 결과 "웨일을 설치하세요", ant.design "Resources").
  const INTERACTIVE = 'a[href],button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option]';
  // 앞 형제 안의 글자 조각을 뒤에서부터 본다 — 자리가 맞는 첫 조각의 글.
  const textIn = (sib, fr, aboveOnly) => {
    const texts = [];
    if (sib.nodeType === 3) texts.push(sib);
    else if (sib.nodeType === 1) {
      const w = document.createTreeWalker(sib, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) texts.push(t);
    }
    for (const t of texts.reverse()) {
      const text = clean(t.textContent || '');
      if (!text || t.parentElement?.closest(INTERACTIVE)) continue;
      const where = place(rectOf(t), fr);
      if (where && (!aboveOnly || where === 'above')) return text;
    }
    return null;
  };
  // 위로 올라가며 앞 형제의 글자를 본다. 다른 입력칸을 건너왔거나 입력칸이 여럿인 묶음을 벗어났으면 그 칸들의
  // 이름일 수 있으니 바로 위(같은 열) 글자만 받는다.
  const labelOf = (el) => {
    const fr = el.getBoundingClientRect();
    let node = el;
    let crossed = false;
    // 편집기처럼 겹겹이 싼 칸은 칸 이름 묶음과 9단계 위에서 만난다(10/16 BO 상품상세 Jodit).
    for (let depth = 0; depth < 12 && node.parentElement; depth++) {
      if (depth > 0 && fieldsIn(node) > 1) crossed = true;
      for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
        if (isField(sib)) {
          crossed = true;
          continue;
        }
        const text = textIn(sib, fr, crossed);
        if (text) return text.length <= 30 && /\\p{L}/u.test(text) ? text : null;
      }
      node = node.parentElement;
    }
    return null;
  };
`;

export const FIELD_LABEL_SCRIPT = `(() => {
${FIELD_HELPERS}
  return [...document.querySelectorAll(FIELD)]
    .filter(visible)
    .map((el) => ({ el, role: roleOf(el), hint: hintOf(el) }))
    .filter((f) => f.hint !== null && f.role && ${JSON.stringify([...FIELD_ROLES])}.includes(f.role))
    .map((f) => ({ role: f.role, hint: f.hint, label: labelOf(f.el) }));
})()`;

/**
 * 페이지에서 실행한다 — 보이는 입력칸 전부의 칸 이름·지금 값·체크·비활성(읽기만 한다). 서버 LLM 의 BrowserFormValues.
 *
 * 관리자 화면은 칸 이름을 입력칸과 연결하지 않아서 스냅샷에 `textbox` 만 나온다. 그래서 서버 LLM 은 입력한 값을 확인하려고
 * BrowserAdvanced eval 로 DOM 을 직접 읽었다(10/19~20 세션의 eval 31번 중 절반 넘게). 정해진 코드로 같은 것을 읽어 준다.
 * 라디오·체크박스는 고른 것만, 무리 이름(무리 바로 앞 제목)을 칸 이름으로 단다.
 */
export const FORM_VALUES_SCRIPT = `(() => {
${FIELD_HELPERS}
  const ALL = 'input:not([type=hidden]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=combobox]:not(input)';
  const own = (el) => squash(el.getAttribute('aria-label')) || squash([...(el.labels || [])].map((l) => l.textContent).join(' '));
  // 무리 이름은 무리 바로 앞 제목 — 관리자 화면은 "상품유형" 제목 아래 라디오를 둔다(labelChoices 와 같다).
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter(visible);
  const groupOf = (el) => {
    const before = heads.filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
    return before ? clean(before.textContent || '') : null;
  };
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(ALL)) {
    // 라디오·체크박스는 입력칸을 숨기고 옆 그림을 보이는 화면이 많다 — 감싼 label 이 보이면 보이는 칸이다.
    if (!visible(el) && !((el.type === 'radio' || el.type === 'checkbox') && visible(el.closest('label') || el.parentElement))) continue;
    const box = el.tagName !== 'INPUT' && el.getAttribute('role') === 'combobox'; // div 로 그린 선택 상자(MUI Select)
    const type = el.isContentEditable ? 'editor' : el.tagName === 'SELECT' || box ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text');
    if (type === 'password' || type === 'file' || type === 'submit' || type === 'button') continue;
    const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
    if (type === 'radio' || type === 'checkbox') {
      if (!el.checked) continue;
      const option = own(el) || squash(el.closest('label')?.textContent) || el.value;
      if (seen.has(el.name + '|' + option)) continue; // 같은 무리를 두 벌 그린 화면(숨은 쌍둥이)
      seen.add(el.name + '|' + option);
      out.push({ field: groupOf(el) || el.name || '', type, value: option, disabled });
      continue;
    }
    const value = type === 'editor' ? el.innerText || '' : box ? squash(el.textContent) : type === 'select' ? [...el.selectedOptions].map((o) => o.text).join(', ') : el.value;
    out.push({ field: own(el) || labelOf(el) || hintOf(el) || el.name || '', type, value, placeholder: el.placeholder || undefined, disabled });
  }
  // 검색 팝업으로 고르는 칸(협력사·브랜드)은 입력칸이 아니라 name·value 속성을 단 글자 상자다(10/20 BO <span name="entrNm">).
  // 한 칸이 번호·이름 상자 여럿이라 칸마다 한 줄로 모은다. 상자의 disabled 는 늘 붙어 있어(보여 주기만 하는 상자) 뺀다.
  const picked = new Map();
  for (const el of document.querySelectorAll('span[name],div[name]')) {
    if (!el.parentElement || !visible(el.parentElement) || el.closest('[aria-hidden="true"],[inert]')) continue;
    const field = labelOf(el.parentElement) || el.getAttribute('name');
    const value = el.getAttribute('value') || squash(el.textContent);
    if (!picked.has(field)) picked.set(field, []);
    if (value) picked.get(field).push(value);
  }
  for (const [field, values] of picked) out.push({ field, type: 'picked', value: values.join(' ') });
  return out;
})()`;

/** 스냅샷 글(snapshot -i 출력)에 나온 요소 번호의 순서 — 문서 순서다(refs 객체 키 순서는 아니다). */
export function refOrder(snapshotText: string): string[] {
  const seen = new Set<string>();
  for (const m of snapshotText.matchAll(/\bref=(e\d+)\b/g)) seen.add(m[1]);
  return [...seen];
}

/**
 * 요소 목록을 문서 순서로 다시 담는다(스냅샷에 없는 요소는 뒤에). 화면 줄은 요소 목록 순서로 실리는데 refs 키는
 * e1, e10, e100… 순이라 칸 제목과 그 칸이 수백 줄 떨어졌다 — 10/19 BO 상품 등록 "선물하기 해당으로 해줘" 에
 * 이름이 같은 "직구상품 여부" 의 "해당" 이 눌렸다.
 */
export function inDocOrder(refs: ElementRefs, order: string[]): ElementRefs {
  const out: ElementRefs = {};
  for (const k of order) if (Object.hasOwn(refs, k)) out[k] = refs[k];
  for (const k of Object.keys(refs)) if (!Object.hasOwn(out, k)) out[k] = refs[k];
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * 선택 상자 이름 — 칸 이름 뒤에 지금 값을 `(현재: …)` 로 가른다. "구매연령 전체" 처럼 붙여 두면 판단 모델이 칸 이름과 지금 값을
 * 가리지 못해, "구매연령 전체로 바꿔줘" 에 지금 값이 "전체" 인 "계약형태 전체" 를 골랐다(10/19 BO).
 */
export const boxName = (label: string, value: string): string => (value ? `${label} (현재: ${value})` : label);

/**
 * 칸 이름을 붙인 새 요소 목록과 붙인 칸 이름(요소 번호별). 역할과 원래 이름(빈 이름·안내문·값)이 같은 칸끼리 순서대로 맞추고, 스냅샷과
 * 페이지의 수가 다른 묶음은 건드리지 않는다(어긋나면 남의 칸 이름이 붙는다).
 */
export function labelFields(
  refs: ElementRefs,
  order: string[],
  fields: FieldLabel[],
): { refs: ElementRefs; labels: Record<string, string> } {
  const key = (role: string, name: string) => `${role}\u0000${squash(name)}`;
  const mine = new Map<string, string[]>();
  for (const ref of order) {
    const r = refs[ref];
    if (!r || !FIELD_ROLES.has(r.role)) continue;
    const k = key(r.role, r.name ?? '');
    mine.set(k, [...(mine.get(k) ?? []), ref]);
  }
  const theirs = new Map<string, FieldLabel[]>();
  for (const f of fields) {
    const k = key(f.role, f.hint);
    theirs.set(k, [...(theirs.get(k) ?? []), f]);
  }
  const out: ElementRefs = { ...refs };
  const labels: Record<string, string> = {};
  for (const [k, page] of theirs) {
    const snap = mine.get(k) ?? [];
    if (snap.length !== page.length) continue;
    snap.forEach((ref, i) => {
      const label = page[i].label;
      const hint = squash(page[i].hint);
      if (!label || hint.includes(label)) return;
      out[ref] = { ...out[ref], name: page[i].role === 'combobox' ? boxName(label, hint) : hint ? `${label} ${hint}` : label };
      labels[ref] = label;
    });
  }
  return { refs: out, labels };
}

type SnapLine = { depth: number; role: string; name: string; ref: string | null; pointer: boolean; editable: boolean };

/** 스냅샷 글 한 줄 — `  - role "name" [..., ref=eN] clickable [cursor:pointer, onclick]`. */
function snapLine(line: string): SnapLine | null {
  const m = line.match(/^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/);
  if (!m) return null;
  return {
    depth: m[1].length,
    role: m[2],
    name: (m[3] ?? '').replace(/\\(.)/g, '$1'),
    ref: m[4].match(/\bref=(e\d+)\b/)?.[1] ?? null,
    pointer: /\bclickable \[[^\]]*cursor:pointer/.test(m[4]),
    editable: /\beditable \[[^\]]*contenteditable/.test(m[4]),
  };
}

/** 고르는 상자를 품는 항목 — 트리 항목·표 행·목록 항목(checkOf). */
const CHECK_HOLDERS = new Set(['treeitem', 'row', 'listitem']);
const CHECK_ROLES = new Set(['checkbox', 'radio']);

/**
 * 항목(트리 항목·표 행·목록 항목)마다 그 항목을 고르는 체크박스·라디오 — 스냅샷 글만으로. 하위 항목 줄이 나오기
 * 전까지 자기 줄 안에 하나뿐일 때만.
 *
 * 트리는 `treeitem "냉장고"` 안에 이름 없는 `checkbox` 와 이름 글자를 나란히 두고, 항목 이름을 누르면 펼치기만
 * 한다(10/16 BO 전시카테고리 찾기: 고르기는 체크박스). 체크박스에 항목 이름을 붙이면 판단 모델이 "가전디지털
 * 펼쳐줘" 에도 체크박스를 골랐다(0.999 — "가전디지털 선택" 으로 붙여도 같음). 그래서 이름은 그대로 두고, 항목을
 * 고르라는 말일 때 그 항목의 체크박스를 누른다(fast-act-voice).
 */
export function checkOf(snapshotText: string): Record<string, { ref: string; checked: boolean }> {
  const lines = snapshotText.split('\n');
  const parsed = lines.map(snapLine);
  const out: Record<string, { ref: string; checked: boolean }> = {};
  parsed.forEach((l, i) => {
    if (!l?.ref || !CHECK_HOLDERS.has(l.role)) return;
    const found: Array<{ ref: string; checked: boolean }> = [];
    for (let j = i + 1; j < parsed.length; j++) {
      const d = parsed[j];
      if (!d) continue;
      if (d.depth <= l.depth || CHECK_HOLDERS.has(d.role)) break;
      if (d.ref && CHECK_ROLES.has(d.role)) found.push({ ref: d.ref, checked: /\bchecked=true\b/.test(lines[j]) });
    }
    if (found.length === 1) out[l.ref] = found[0];
  });
  return out;
}

/** 항목 안에서 항목 자체를 가리키는 칸 — 표의 셀(누르는 버튼·링크는 항목과 다른 일을 한다). */
const ITEM_PARTS = new Set(['gridcell', 'cell', 'rowheader']);

/**
 * 항목(트리 항목·표 행·목록 항목)과 그 안의 셀을 항목 번호로 — 스냅샷 글만으로. 하위 항목 줄이 나오기 전까지.
 *
 * 둘은 같은 것을 가리킨다. "삼성전자 골라줘" 에 판단 모델이 행 "1 11371 삼성전자 사용" 과 그 행의 셀 "삼성전자"
 * 에 확률을 0.49·0.51 로 나눠 어느 쪽도 확신 하한을 못 넘었다(10/16 BO 브랜드 찾기). 빠른 조작은 같은 항목의
 * 확률을 합치고, 항목을 고르라는 말이면 셀을 골랐어도 그 항목의 체크박스(checkOf)를 누른다.
 */
export function itemOf(snapshotText: string): Record<string, string> {
  const parsed = snapshotText.split('\n').map(snapLine);
  const out: Record<string, string> = {};
  parsed.forEach((l, i) => {
    if (!l?.ref || !CHECK_HOLDERS.has(l.role)) return;
    out[l.ref] = l.ref;
    for (let j = i + 1; j < parsed.length; j++) {
      const d = parsed[j];
      if (!d) continue;
      if (d.depth <= l.depth || CHECK_HOLDERS.has(d.role)) break;
      if (d.ref && ITEM_PARTS.has(d.role)) out[d.ref] = l.ref;
    }
  });
  return out;
}

/** 항목(itemOf) 안 셀(행 자신은 뺀다)과 그 글자. */
function cellsOf(refs: ElementRefs, items: Record<string, string>): Array<{ row: string; name: string }> {
  return Object.entries(items)
    .filter(([cell, row]) => cell !== row && refs[cell])
    .map(([cell, row]) => ({ row, name: squash(refs[cell].name ?? '') }));
}

/**
 * 셀 글자가 고를 값과 정확히 같은 항목(행) — 공백만 정리해 비교한다. 조회 팝업에서 "플래티어 협력사" 를 고르라면
 * "플래티어"·"플래티어 2" 행은 아니다(앞부분이 같다고 고르면 다른 협력사가 들어간다).
 */
export function rowsNamed(refs: ElementRefs, items: Record<string, string>, value: string, code?: string): string[] {
  const want = squash(value);
  const cells = cellsOf(refs, items);
  return [...new Set(cells.filter(c => c.name === want &&
    (!code || cells.some(id => id.row === c.row && id.name === code))).map(c => c.row))];
}

/** Search by name, but require the supplied identifier in the same result row. */
export function popupSearchValue(value: string, label: string): { name: string; code?: string } {
  const match = /협력사|브랜드/.test(label) && value.match(/^(.+?)\s*\(([A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*)\)$/);
  return match ? { name: match[1].trim(), code: match[2] } : { name: value };
}

/** The parent picker may display code before name instead of the request's name(code). */
export function popupSelectionMatches(actual: string, name: string, code?: string): boolean {
  const value = squash(actual);
  return code ? [squash(`${code} ${name}`), squash(`${name} (${code})`), squash(`${name}(${code})`)].includes(value)
    : value.includes(squash(name));
}

/** A verification request must never reopen a picker or alter its current selection. */
export function isFieldVerification(text: string): boolean {
  const instruction = text.replace(/「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|“[^”]*”/g, '');
  return /(?:확인|검증)(?:해(?:\s*줘|\s*주세요)?|해줄래|해주세요)[.!?…\s]*$/.test(instruction) ||
    /^\s*(?:verify\b|check\s+(?:if|whether)\b|confirm\s+(?:if|whether)\b)/i.test(instruction);
}

/** 스냅샷 글에서 비활성 요소 번호 — 줄 뒤 괄호 안의 disabled 표시(`[expanded=false, disabled, ref=e181]`)만 본다. */
export function disabledOf(snapshotText: string): Set<string> {
  const out = new Set<string>();
  for (const m of snapshotText.matchAll(/\[([^\]"]*\bref=(e\d+)[^\]"]*)\]/g)) {
    if (/(^|,\s*)disabled(\s*,|$)/.test(m[1])) out.add(m[2]);
  }
  return out;
}

/** 스냅샷 글에서 체크박스·선택지의 지금 상태 — 괄호 안 checked 표시가 있는 요소만(`[checked=true, ref=e257]`). */
export function checkStates(snapshotText: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of snapshotText.matchAll(/\[([^\]"]*\bref=(e\d+)[^\]"]*)\]/g)) {
    const c = m[1].match(/\bchecked=(true|false)\b/);
    if (c) out[m[2]] = c[1] === 'true';
  }
  return out;
}

/**
 * 누른 선택지·체크박스가 고른 상태가 되지 않았나 — 선택지(radio)는 누르면 선택돼야 하고, 체크박스는 전 상태(before)를 알 때만
 * 바뀌었는지 본다. 지금 상태(after)를 못 읽었으면 완료로 보지 않는다. 다른 칸 값에 따라 막힌 선택지(10/19 BO: 직구상품 여부가
 * "해당" 이면 선물하기)는 눌러도 그대로라, 성공으로 답하면 안 된다.
 */
export function choiceMissed(role: string, before: boolean | undefined, after: boolean | null): boolean {
  if (after === null) return role === 'radio' || role === 'checkbox';
  if (role === 'radio') return !after;
  if (role === 'checkbox') return before === undefined || after === before;
  return false;
}

/** 조회 팝업에서 고를 값 — 말에서 뽑은 글자에서 칸 이름을 뗀 것. 칸 이름뿐이면("협력사 눌러줘" → "협력사") 고를 값이 없다. */
export function valueToPick(typed: string, label: string): string | null {
  const value = squash(withoutLeadingLabel(typed, label));
  return value && value !== squash(label) ? value : null;
}

/** 정확히 같은 항목이 없을 때 물어볼 후보 — 고를 값과 낱말(두 글자 이상)이 겹치는 셀 글자, 앞에서부터. */
export function nearNames(refs: ElementRefs, items: Record<string, string>, value: string, max = 5): string[] {
  const words = new Set(squash(value).split(' ').filter((w) => w.length >= 2));
  const near = cellsOf(refs, items)
    .map((c) => c.name)
    .filter((n) => n.split(' ').some((w) => words.has(w)));
  return [...new Set(near)].slice(0, max);
}

/**
 * 글 편집 영역(contenteditable)을 입력칸(textbox)으로 — 상품상세 같은 편집기 본문은 스냅샷에
 * `generic [ref=e353] editable [contenteditable]` 로만 나와 입력 요청의 후보에서 빠졌다(10/16 BO Jodit).
 * 화면 낭독기도 편집 영역은 입력칸으로 읽는다. 칸 이름은 labelFields 가 붙인다(FIELD_LABEL_SCRIPT 도 같은 칸을 센다).
 */
export function editableAsTextbox(refs: ElementRefs, snapshotText: string): ElementRefs {
  const out: ElementRefs = { ...refs };
  for (const l of snapshotText.split('\n').map(snapLine)) {
    if (l?.ref && l.editable && l.role === 'generic' && out[l.ref]) out[l.ref] = { ...out[l.ref], role: 'textbox' };
  }
  return out;
}

/**
 * 이름 없는 접기·펼치기 버튼에 바로 앞 제목으로 이름을 붙인다 — `"부가 정보 펼치기·접기"`. open = 버튼별 지금 펼쳐져 있는가.
 *
 * 관리자 화면의 구역 머리는 제목 옆 ⌄ 아이콘 버튼으로 여닫는데 버튼에는 이름이 없고 `button [expanded=false]` 상태만 있다.
 * 그래서 "부가 정보 펼쳐줘" 에 판단 모델은 제목 글자를 1.0 으로 눌렀고(제목은 눌러도 안 열린다) "눌렀어요" 로 답했다(10/19 BO).
 * 버튼 바로 앞(이름 없는 감싸개는 건너뛴다)이 제목일 때만 붙인다. 이름에 지금 상태("펼치기"/"접기" 하나)를 넣으면 판단 모델이 구역
 * 대신 동사를 따라간다 — 펼쳐진 "부가 정보 접기" 옆의 "SEO 정보 펼치기" 를 "부가 정보 펼쳐줘" 에 골랐다(10/19). 그래서 이름은 구역만
 * 가리키고, 이미 그 상태인지는 open 으로 실행하는 쪽이 본다(체크박스와 같다).
 */
export function labelToggles(
  refs: ElementRefs,
  snapshotText: string,
): { refs: ElementRefs; labels: Record<string, string>; open: Record<string, boolean> } {
  const raw = snapshotText.split('\n');
  const lines = raw.map(snapLine);
  const out: ElementRefs = { ...refs };
  const labels: Record<string, string> = {};
  const states: Record<string, boolean> = {};
  lines.forEach((l, i) => {
    const open = raw[i].match(/\bexpanded=(true|false)\b/)?.[1];
    if (!l?.ref || l.role !== 'button' || l.name || !open || !refs[l.ref] || refs[l.ref].name) return;
    let before: SnapLine | null = null;
    for (let j = i - 1; j >= 0 && !before; j--) {
      const p = lines[j];
      if (p && (p.ref || p.name)) before = p;
    }
    if (!before || before.role !== 'heading') return;
    const label = before.name.replace(/[*:：]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 30) return;
    out[l.ref] = { ...out[l.ref], name: `${label} 펼치기·접기` };
    labels[l.ref] = label;
    states[l.ref] = open === 'true';
  });
  return { refs: out, labels, open: states };
}

/**
 * 제목 아래 누름 상자에 그 제목을 칸 이름으로 붙인다 — 스냅샷 글만으로.
 *
 * 관리자 화면의 "찾기" 칸(협력사·브랜드·카테고리: 누르면 검색 팝업이 뜨는 상자)은 역할 없는 div 라 스냅샷에
 * `generic [ref=e26] clickable [cursor:pointer]` 로만 나온다(값을 고른 뒤에는 이름이 값 "1001269 협력사_위_단").
 * 칸 이름이 없어 판단 모델이 고를 수 없었고, "협력사 찾아줘" 는 왼쪽 메뉴의 "협력사" 를 눌렀다(10/16 BO).
 * 화면 낭독기처럼 같은 깊이 바로 앞 줄이 제목이면 그 제목을 칸 이름으로 본다 — 제목과 다음 제목 사이에 이 상자
 * 하나뿐일 때만(제목 아래 카드 여러 장은 칸이 아니다). 안에 입력칸이나 상자 글 밖의 이름이 있으면 건드리지 않는다.
 */
export function labelClickables(
  refs: ElementRefs,
  snapshotText: string,
): { refs: ElementRefs; labels: Record<string, string> } {
  const lines = snapshotText.split('\n').map(snapLine);
  const out: ElementRefs = { ...refs };
  const labels: Record<string, string> = {};
  lines.forEach((l, i) => {
    if (!l?.ref || l.role !== 'generic' || !l.pointer || !refs[l.ref]) return;
    const value = squash(l.name);
    let next = i + 1;
    let pieces = 0;
    for (; next < lines.length; next++) {
      const c = lines[next];
      if (!c) continue;
      if (c.depth <= l.depth) break;
      // 안에는 값 조각(상자 글의 일부)과 이름 없는 아이콘 버튼만.
      if (c.role === 'generic' ? !value.includes(squash(c.name)) : c.role !== 'button' || c.name) return;
      if (c.role === 'generic' && c.name) pieces++;
    }
    // 이름이 있으면 안쪽 값 조각으로 된 것(고른 값)만 — 제 글을 가진 상자(파일 끌어 놓기 칸 안내문 등)는 칸이 아니다.
    if (value && !pieces) return;
    const after = lines.slice(next).find((c) => c && c.depth <= l.depth);
    if (after && (after.depth < l.depth || after.role !== 'heading')) return;
    let before: SnapLine | null = null;
    for (let j = i - 1; j >= 0 && !before; j--) {
      const p = lines[j];
      if (p && p.depth <= l.depth) before = p;
    }
    if (!before || before.depth < l.depth || before.role !== 'heading') return;
    const label = before.name.replace(/[*:：]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 30) return;
    // 값을 고르는 칸이다 — 판단 모델은 이름 없는 상자(generic)는 거의 고르지 않아서(같은 이름의 메뉴 버튼이 1.0)
    // 선택 상자로 보인다(누르면 목록·찾기 창이 열리는 칸, ARIA combobox 와 같은 뜻). 고른 값은 이름 뒤에.
    out[l.ref] = { ...out[l.ref], role: 'combobox', name: boxName(label, value) };
    labels[l.ref] = label;
  });
  return { refs: out, labels };
}

/**
 * 말에서 붙인 칸 이름을 뺀다(단어마다 처음 한 번) — "검색키워드에 노트북 넣어줘" 의 "검색"은 칸을 가리킨 말이지
 * 검색하라는 말이 아니다(검색칸으로 보고 Enter 를 누르면 폼이 제출될 수 있다).
 */
/** 선택지 묶음 안에서 제목까지 건너뛰는 줄 — 다른 선택지·체크박스와 그 글자 상자. */
const CHOICE_GROUP = new Set(['radio', 'checkbox', 'LabelText', 'generic', 'StaticText']);

/**
 * 제목 아래 선택지(radio)는 이름 앞에 그 제목을 붙인다("제공안함" → "반품기능 제공안함"). 폼은 같은 선택지 이름을
 * 칸마다 되풀이하는데(해당/해당없음, 제공/제공안함), 창이 여럿이라 한 방향으로만 묻는 묶음에서는 이름이 같은 앞
 * 선택지가 1.0 을 받아 뒤 것은 결승에도 못 갔다(10/19 BO 상품 등록 "반품기능 제공안함으로 해줘" → 취소기능).
 * 체크박스도 같다 — 제목 없는 "전체" 가 "구매연령 전체로 바꿔줘" 에 0.98 로 뽑혀 결제가능수단이 모두 체크됐다(10/19).
 */
export function labelChoices(
  refs: ElementRefs,
  snapshotText: string,
): { refs: ElementRefs; labels: Record<string, string> } {
  const lines = snapshotText.split('\n').map(snapLine);
  const out: ElementRefs = { ...refs };
  const labels: Record<string, string> = {};
  lines.forEach((l, i) => {
    if (!l?.ref || (l.role !== 'radio' && l.role !== 'checkbox') || !refs[l.ref]) return;
    let j = i - 1;
    while (j >= 0 && (!lines[j] || CHOICE_GROUP.has(lines[j]!.role))) j--;
    const head = lines[j];
    if (head?.role !== 'heading') return;
    const label = head.name.replace(/[*:：]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 30) return;
    out[l.ref] = { ...out[l.ref], name: `${label} ${squash(l.name)}`.trim() };
    labels[l.ref] = label;
  });
  return { refs: out, labels };
}

/**
 * 검색 기준 선택 상자 바로 뒤의 이름 없는 입력칸은 "기준 검색어"로 부른다("협력사명 ▾" + [ ] → "협력사명 검색어").
 * 관리자 조회 폼은 기준 상자와 검색어 칸을 한 칸 이름 아래 나란히 두어 labelFields 가 이름을 못 붙인다(다른 칸을
 * 건너오면 바로 위 글자만 받는다). 이름이 없으면 판단 모델은 입력칸 대신 다른 선택 상자를 골랐다(10/19 BO 협력사 조회
 * 팝업 "플래티어로 조회해줘" → 협력사구분). "검색" 이 들어가 검색칸으로도 보인다(입력 뒤 조회 버튼).
 */
export function labelSearchTerms(
  refs: ElementRefs,
  snapshotText: string,
): { refs: ElementRefs; labels: Record<string, string> } {
  const lines = snapshotText.split('\n').map(snapLine);
  const out: ElementRefs = { ...refs };
  const labels: Record<string, string> = {};
  lines.forEach((l, i) => {
    if (!l?.ref || l.role !== 'textbox' || !refs[l.ref] || squash(refs[l.ref].name ?? '')) return;
    let j = i - 1;
    // 사이에는 두 칸을 싼 상자(generic)만.
    while (j >= 0 && (!lines[j] || lines[j]!.role === 'generic')) j--;
    const box = lines[j];
    if (box?.role !== 'combobox' || !box.ref) return;
    const criterion = squash(refs[box.ref]?.name ?? box.name);
    if (!criterion || criterion.length > 20) return;
    out[l.ref] = { ...out[l.ref], name: `${criterion} 검색어` };
    labels[l.ref] = criterion;
  });
  return { refs: out, labels };
}

export function withoutLabel(text: string, label?: string): string {
  return (label ?? '')
    .split(' ')
    .filter(Boolean)
    .reduce((said, word) => said.replace(word, ' '), text);
}

/** Keep the same field context for the form runner and individual decider steps. */
export function labelSnapshot(refs: ElementRefs, snapshotText: string, fields: FieldLabel[] = []) {
  const order = refOrder(snapshotText);
  const raw = editableAsTextbox(inDocOrder(refs, order), snapshotText);
  const named = labelFields(raw, order, fields);
  const boxes = labelClickables(named.refs, snapshotText);
  const choices = labelChoices(boxes.refs, snapshotText);
  const terms = labelSearchTerms(choices.refs, snapshotText);
  const toggles = labelToggles(terms.refs, snapshotText);
  return {
    refs: toggles.refs,
    labels: { ...named.labels, ...boxes.labels, ...choices.labels, ...terms.labels, ...toggles.labels },
    open: toggles.open,
  };
}

/**
 * 칸 이름 바로 뒤의 조사 '의' 를 '에' 로 — '의' 는 [에] 로 소리 나 받아쓰기가 "상품상세 내용에" 를 "상품 상세 내용의" 로
 * 적는다. 그러면 결정 모델은 칸 이름부터 넣을 글자까지를 한 명사구로 읽어 끝 어절을 뺐다(10/16 BO 상품상세: "…테스트
 * 상품입니다" → "…테스트", '에' 로는 0.96). 칸 이름은 띄어쓰기를 보지 않고 찾는다.
 */
export function locativeAfterLabel(text: string, label?: string): string {
  const chars = [...(label ?? '').replace(/[^\p{L}\p{N}]/gu, '')];
  if (chars.length < 2) return text;
  return text.replace(new RegExp(`(${chars.join('\\s*')})의(?=\\s)`, 'u'), '$1에');
}

/**
 * 넣을 글자 앞에 붙은 칸 이름을 뗀다 — "원산지에 대한민국 넣어줘." 에 판단 모델이 넣을 글자를 "원산지에 대한민국"
 * 으로 답했다(10/16 BO). 붙인 칸 이름(또는 그 첫 단어)에 조사가 이어지고 뒤에 글자가 남을 때만.
 */
export function withoutLeadingLabel(typed: string, label?: string): string {
  if (!label) return typed;
  // 칸 이름을 줄여 말한 것도 칸 이름이다 — 칸 "안전재고수량" 에 "안전재고 열 개"(10/18 BO). 띄어쓰기 없이 비교해 칸 이름의
  // 절반 넘게 덮는 앞부분만.
  const bare = label.replace(/\s+/g, '');
  let n = 0;
  while (n < bare.length && typed[n] === bare[n]) n++;
  const part = n >= 2 && n * 2 >= bare.length ? bare.slice(0, n) : label;
  for (const head of new Set([label, label.split(' ')[0], part])) {
    if (!typed.startsWith(head)) continue;
    const rest = typed
      .slice(head.length)
      .match(/^(?:칸)?(?:에다가|에다|에|은|는|을|를|이|가|란|으로|로)?\s+(\S.*)$/u);
    if (rest) return rest[1];
  }
  return typed;
}

/**
 * 넣을 값 — 「」로 밝힌 값은 그대로, 아니면 판단 모델이 같이 고른 칸 이름을 뗀다. 「상품 C」 를 칸 "상품명" 의 줄임말로
 * 보고 떼어 "C" 를 넣었다(10/22 BO BrowserFill).
 */
export function typedValue(found: string, instruction: string, label?: string): string {
  return quotedText(instruction) ? found : withoutLeadingLabel(found, label);
}

/**
 * 선택 상자가 이미 말한 값인가 — 말에서 뽑은 값(따옴표 값은 그대로, 아니면 칸 이름을 뗀 것)을 지금 값과 띄어쓰기 없이 비교한다.
 * 말 전체에서 지금 값을 찾았더니 "「배송비 무료 …」 선택해줘" 의 동사 "선택" 을 지금 값 "선택" 으로 봤다(10/22 BO 리허설).
 */
export function keepsValue(found: string | null, instruction: string, label: string, current: string): boolean {
  const bare = (s: string) => s.replace(/\s+/g, '');
  return !!found && bare(typedValue(found, instruction, label)) === bare(current);
}

/**
 * 페이지에서 실행한다 — 글자도 aria-label·title 도 없는 아이콘 버튼에 개발자가 붙인 속성(data-slot·data-testid·
 * 아이콘의 data-testid·id)으로 aria-label 을 붙인다("menu-button" → "menu button"). 붙인 수를 돌려준다.
 *
 * 시연 BO 의 햄버거(왼쪽 메뉴 열기)는 `<button data-slot="menu-button"><svg/></button>` 라 스냅샷에 `button ""` 로만
 * 나온다. 빠른 조작이 메뉴를 열 버튼을 못 찾아서, 화면에 없는 페이지("상품 임시저장 관리")로 가지 못했다(10/20).
 * 빠른 조작 스냅샷 전에 페이지에 이름을 단다(fast-act-voice). 쓸 속성이 없으면 그대로 둔다.
 */
export const NAME_ICON_BUTTONS_SCRIPT = `(() => {
  const words = (s) => (s || '').replace(/Icon$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.:]+/g, ' ').trim().toLowerCase();
  let n = 0;
  for (const el of document.querySelectorAll('button,[role=button],a[href]')) {
    if ((el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title) continue;
    if (el.querySelector('img[alt]:not([alt=""]),svg title')) continue;
    const svg = el.querySelector('svg');
    const name = words(el.dataset.slot || el.dataset.testid || (svg && svg.dataset.testid) || el.id);
    if (!name || /^\\d+$/.test(name)) continue;
    el.setAttribute('aria-label', name);
    n++;
  }
  return n;
})()`;
