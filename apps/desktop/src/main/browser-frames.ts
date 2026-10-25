/**
 * iframe 속 글 편집 영역 — agent-browser 스냅샷은 iframe 속 입력칸·버튼은 싣지만 편집 영역(역할 없는 contenteditable)은
 * 빼먹는다(src 가 있든 없든, 10/20 확인). 바깥 페이지에서는 `generic … editable` 로 찾아 주는 것을 iframe 안에서는 안 한다.
 * 그래서 네이버 메일 본문이 `Iframe` 한 줄로만 보였고, 서버 LLM 과 빠른 조작이 옆의 숨은 5px 입력칸을 본문으로 알고 넣은 뒤
 * "입력했다" 고 답했다.
 *
 * 브라우저가 iframe 마다 주는 접근성 트리(Accessibility.getFullAXTree frameId)에서 편집 영역만 골라 스냅샷 끝에 입력칸 줄로
 * 붙이고, 이어지는 번호(@eN)로 부른 조작은 CDP 로 직접 한다. 다른 것까지 붙이면 agent-browser 가 실은 요소와 겹친다(네이버 첫 화면
 * 위젯 iframe 60줄이 전부 중복이었다). 다른 사이트 iframe(광고·결제)은 다른 프로세스라 이 페이지 트리에 없다.
 */
type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;

type AXNode = {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  backendDOMNodeId?: number;
};

export type FrameElement = { backendNodeId: number; name: string };

/** agent-browser `snapshot -i` 가 이미 싣는 역할 — 이 역할의 편집 칸(input·textarea)은 붙이지 않는다. */
const LISTED = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'listbox', 'treeitem',
]);

/** 편집 영역의 뿌리 — 편집 가능하고 초점을 받는데 역할이 없는 것(그 안의 문단도 편집 가능이지만 초점은 받지 않는다). */
export function frameElements(nodes: AXNode[]): FrameElement[] {
  const out: FrameElement[] = [];
  for (const node of nodes) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    const props = Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value]));
    if (!props.editable || !props.focusable || LISTED.has(node.role?.value ?? '')) continue;
    out.push({ backendNodeId: node.backendDOMNodeId, name: node.name?.value ?? '' });
  }
  return out;
}

/** agent-browser 스냅샷 줄과 같은 꼴 — `- textbox "본문 내용" [ref=e151]: 안녕`. */
export function frameLine(el: FrameElement, ref: string, value: string | null): string {
  const name = el.name ? ` "${el.name.replace(/"/g, '\\"')}"` : '';
  return `- textbox${name} [ref=${ref}]${value ? `: ${value.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
}

/** 대상 가운데 자리의 맨 위 요소가 대상(또는 그 안)인지 — 아니면 덮은 요소 '<div#id>', 맞으면 ''. iframe 은 축소 비율까지 따라 올라간다. */
const COVER_FN = `function () {
  const name = (e) => e ? '<' + e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '>' : '<nothing>';
  let el = this, r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  for (;;) {
    const top = el.ownerDocument.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top))) return name(top);
    const frame = el.ownerDocument.defaultView.frameElement;
    if (!frame) return '';
    const fr = frame.getBoundingClientRect(), sx = fr.width / (frame.offsetWidth || fr.width), sy = fr.height / (frame.offsetHeight || fr.height);
    x = fr.left + (frame.clientLeft + x) * sx;
    y = fr.top + (frame.clientTop + y) * sy;
    el = frame;
  }
}`;

const VALUE_FN = `function () { return 'value' in this && typeof this.value === 'string' ? this.value : (this.innerText || ''); }`;

async function call<T>(send: Send, backendNodeId: number, fn: string, args: unknown[] = []): Promise<T> {
  const { object } = await send('DOM.resolveNode', { backendNodeId });
  const r = await send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });
  return r.result?.value as T;
}

/** 페이지 안 iframe 들의 편집 영역 — 번호는 first 부터 이어 매긴다. targets 는 번호 → DOM 노드. */
export async function snapshotFrames(
  send: Send,
  first: number,
): Promise<{ lines: string[]; refs: Record<string, { role: string; name: string }>; targets: Map<string, number> }> {
  const lines: string[] = [];
  const refs: Record<string, { role: string; name: string }> = {};
  const targets = new Map<string, number>();
  const { frameTree } = await send('Page.getFrameTree');
  type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
  const frames: string[] = [];
  const walk = (t: FrameTree) => (t.childFrames ?? []).forEach((c) => (frames.push(c.frame.id), walk(c)));
  walk(frameTree);
  let n = first;
  for (const frameId of frames) {
    const tree = await send('Accessibility.getFullAXTree', { frameId }).catch(() => null);
    for (const el of frameElements(tree?.nodes ?? [])) {
      const ref = `e${n++}`;
      lines.push(frameLine(el, ref, await call<string>(send, el.backendNodeId, VALUE_FN).catch(() => null)));
      refs[ref] = { role: 'textbox', name: el.name };
      targets.set(ref, el.backendNodeId);
    }
  }
  return { lines, refs, targets };
}

/** iframe 요소에 agent-browser 명령을 CDP 로 — 결과는 agent-browser 답과 같은 꼴. 못 하는 명령은 null. */
export async function runFrameCommand(send: Send, backendNodeId: number, command: string[]): Promise<unknown | null> {
  const [verb, , ...rest] = command;
  if (verb === 'click') {
    await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { model } = await send('DOM.getBoxModel', { backendNodeId });
    const q: number[] = model.content;
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    // 그 자리 맨 위가 대상(또는 그 안)이 아니면 누르지 않는다 — agent-browser 와 같은 문구라 빠른 조작이 막을 닫고 다시 한다(COVERED).
    // 자리 검사는 대상의 문서에서 시작해 iframe 마다 바깥 문서로 올라간다(CDP DOM.getNodeForLocation 은 웹뷰에서 노드를 못 찾았다).
    const cover = await call<string>(send, backendNodeId, COVER_FN);
    if (cover) throw new Error(`Element ${command[1]} is covered by ${cover}`);
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    return { success: true, data: { clicked: command[1] } };
  }
  if (verb === 'fill' || verb === 'type') {
    const text = rest.join(' ');
    await send('DOM.focus', { backendNodeId });
    // 칸 안의 글을 고르고(fill 은 전부, type 은 끝에 커서) 그 문서의 execCommand 로 넣는다 — 편집기가 받는 beforeinput·input 이
    // 그대로 일어나고, 탭에 OS 초점이 없어도 된다(Input.insertText 는 초점 없는 웹뷰에서 버려졌다, 10/20 네이버 본문).
    const inserted = await call<boolean>(
      send,
      backendNodeId,
      `function (all, text) {
        const doc = this.ownerDocument;
        if ('value' in this && this.setSelectionRange) {
          if (all) this.select(); else this.setSelectionRange(this.value.length, this.value.length);
        } else {
          const range = doc.createRange();
          range.selectNodeContents(this);
          if (!all) range.collapse(false);
          doc.getSelection().removeAllRanges();
          doc.getSelection().addRange(range);
        }
        return text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete');
      }`,
      [verb === 'fill', text],
    );
    if (!inserted && text) await send('Input.insertText', { text });
    return { success: true, data: { [verb === 'fill' ? 'filled' : 'typed']: command[1] } };
  }
  if (verb === 'get' && command[1] === 'value') {
    return { success: true, data: { value: await call<string>(send, backendNodeId, VALUE_FN) } };
  }
  return null;
}
