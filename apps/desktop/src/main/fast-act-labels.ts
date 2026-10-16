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
import type { ElementRefs } from './fast-act';

/** 칸 이름을 붙이는 역할. */
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);

/** hint = 칸 이름 대신 접근성 이름이 된 글(안내문·자기 값, 없으면 ''), label = 화면에서 찾은 칸 이름. */
export type FieldLabel = { role: string; hint: string; label: string | null };

/**
 * 페이지에서 실행한다 — 보이는 입력칸 중 접근성 이름이 칸 이름에서 오지 않은 것을 문서 순서로.
 * 역할·이름 판정은 접근성 트리와 같게 맞춘 근사치다. 어긋나면 수가 달라져 붙이지 않는다(labelFields).
 */
export const FIELD_LABEL_SCRIPT = `(() => {
  const FIELD = 'input:not([type=hidden]),textarea,select,[role=textbox],[role=searchbox],[role=spinbutton],[role=combobox]';
  const TEXT_TYPES = ['', 'text', 'email', 'tel', 'url', 'password'];
  const squash = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el.getClientRects().length || el.closest('[aria-hidden="true"],[inert]')) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  };
  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').trim();
    if (explicit) return explicit;
    if (el.tagName === 'TEXTAREA') return 'textbox';
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
  const isField = (n) => n.nodeType === 1 && (n.matches(FIELD) || !!n.querySelector(FIELD));
  const rectOf = (t) => {
    const r = document.createRange();
    r.selectNodeContents(t);
    return r.getBoundingClientRect();
  };
  // 칸 이름은 같은 줄 왼쪽이나 같은 열 바로 위에 있다 — 앞 형제라도 자리가 안 맞으면 남의 칸 이름이다.
  const place = (lr, fr) => {
    if (!lr.width || !lr.height) return null;
    if (lr.right <= fr.left + 4 && lr.bottom > fr.top - 4 && lr.top < fr.bottom + 4 && fr.left - lr.right < 400) return 'left';
    if (lr.bottom <= fr.top + 4 && lr.right > fr.left && lr.left < fr.right && fr.top - lr.bottom < 80) return 'above';
    return null;
  };
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
      if (!text) continue;
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
    for (let depth = 0; depth < 8 && node.parentElement; depth++) {
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
  return [...document.querySelectorAll(FIELD)]
    .filter(visible)
    .map((el) => ({ el, role: roleOf(el), hint: hintOf(el) }))
    .filter((f) => f.hint !== null && f.role && ${JSON.stringify([...FIELD_ROLES])}.includes(f.role))
    .map((f) => ({ role: f.role, hint: f.hint, label: labelOf(f.el) }));
})()`;

/** 스냅샷 글(snapshot -i 출력)에 나온 요소 번호의 순서 — 문서 순서다(refs 객체 키 순서는 아니다). */
export function refOrder(snapshotText: string): string[] {
  const seen = new Set<string>();
  for (const m of snapshotText.matchAll(/\bref=(e\d+)\b/g)) seen.add(m[1]);
  return [...seen];
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

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
      out[ref] = { ...out[ref], name: hint ? `${label} ${hint}` : label };
      labels[ref] = label;
    });
  }
  return { refs: out, labels };
}

type SnapLine = { depth: number; role: string; name: string; ref: string | null; pointer: boolean };

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
  };
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
    out[l.ref] = { ...out[l.ref], role: 'combobox', name: value ? `${label} ${value}` : label };
    labels[l.ref] = label;
  });
  return { refs: out, labels };
}

/**
 * 말에서 붙인 칸 이름을 뺀다(단어마다 처음 한 번) — "검색키워드에 노트북 넣어줘" 의 "검색"은 칸을 가리킨 말이지
 * 검색하라는 말이 아니다(검색칸으로 보고 Enter 를 누르면 폼이 제출될 수 있다).
 */
export function withoutLabel(text: string, label?: string): string {
  return (label ?? '')
    .split(' ')
    .filter(Boolean)
    .reduce((said, word) => said.replace(word, ' '), text);
}

/**
 * 넣을 글자 앞에 붙은 칸 이름을 뗀다 — "원산지에 대한민국 넣어줘." 에 판단 모델이 넣을 글자를 "원산지에 대한민국"
 * 으로 답했다(10/16 BO). 붙인 칸 이름(또는 그 첫 단어)에 조사가 이어지고 뒤에 글자가 남을 때만.
 */
export function withoutLeadingLabel(typed: string, label?: string): string {
  if (!label) return typed;
  for (const head of new Set([label, label.split(' ')[0]])) {
    if (!typed.startsWith(head)) continue;
    const rest = typed
      .slice(head.length)
      .match(/^(?:칸)?(?:에다가|에다|에|은|는|을|를|이|가|란|으로|로)?\s+(\S.*)$/u);
    if (rest) return rest[1];
  }
  return typed;
}
