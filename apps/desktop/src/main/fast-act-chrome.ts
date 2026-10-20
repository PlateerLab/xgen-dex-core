/**
 * 고속 조작이 고르는 후보 중 페이지 바깥 것 — 채팅 입력(fast-act-chat)과 말로 시킨 것이 같은 판단·실행기(fast-act-voice)로 쓴다.
 *
 * 브라우저 자체 조작(뒤로·앞으로·새로고침·탭 고르기·탭 닫기·새 탭)은 페이지에는 없는 요소라 화면 맨 위(도구 막대·탭 줄 자리)에
 * 화면 요소처럼 붙여 결정 모델이 페이지 요소와 같은 질문으로 고르게 한다. 번호는 페이지 요소(e1…)와 겹치지 않게 e9001 부터.
 * 이것이 없으면 "뒤로 가기 눌러" 에 페이지의 비슷한 링크("상단영역 바로가기")를 높은 확신으로 누른다(10/15 dev-xgen 실측).
 */
import type { BrowserPageInfo } from '@dex/protocol/browser';
import { getBrowserRuntime } from './browser-runtime';
import type { ElementRefs } from './fast-act';

/**
 * 누를 대상이 아닌 영역(랜드마크) — 영역 전체에 클릭 처리가 걸려 스냅샷에 잡혀도 후보에서 뺀다
 * ("뉴스 찾아보게 해줘" 에 navigation "main navigation", "뒤로 가봐" 에 이름 없는 Iframe 을 누르던 문제).
 */
export const LANDMARK = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search', 'iframe']);
/** 브라우저 자체 조작은 고른 확신이 이만큼은 돼야 하고, 탭 닫기는 더 높은 확신에서만(팝업 닫기와 헷갈리면 탭이 통째로 닫힌다). */
export const CHROME_PICK = 0.8;
export const CHROME_CLOSE_PICK = 0.9;
/**
 * 탭을 가리키는 말 — 탭 닫기는 말에 이게 있을 때만 후보로 둔다. "창" 은 팝업·광고 층을 가리키는 경우가 많아("광고 창 닫아"
 * 에 탭이 통째로 닫혔다) 넣지 않는다 — 그런 말은 페이지 안의 닫기 요소를 고른다.
 */
export const TAB_WORD = /(탭|페이지|tab|page)/i;

export type ChromeAction = { role: string; name: string; close?: boolean; run: () => Promise<void> };

/** 지금 탭에서 할 수 있는 브라우저 자체 조작. 탭 번호는 DeX 탭 줄의 순서(1부터). */
export function chromeActions(workflowId: string, page: BrowserPageInfo): Record<string, ChromeAction> {
  const runtime = getBrowserRuntime();
  const tabs = runtime.state().pages.filter((p) => p.workflowId === workflowId && p.mode === 'shared');
  const out: Record<string, ChromeAction> = {};
  const add = (a: ChromeAction): void => void (out[`e${9001 + Object.keys(out).length}`] = a);
  const nav = (action: 'back' | 'forward' | 'reload') => async (): Promise<void> => void (await runtime.navigate({ pageId: page.pageId, action }));
  if (page.canGoBack) add({ role: 'button', name: '뒤로 (이전 페이지)', run: nav('back') });
  if (page.canGoForward) add({ role: 'button', name: '앞으로 (다음 페이지)', run: nav('forward') });
  add({ role: 'button', name: '새로고침', run: nav('reload') });
  tabs.forEach((t, i) => {
    if (t.pageId === page.pageId || tabs.length < 2) return;
    add({ role: 'tab', name: `${i + 1}번째 탭: ${(t.title || t.url).slice(0, 30)}`, run: async () => void runtime.activate(t.pageId) });
  });
  add({
    role: 'button',
    name: `웹 페이지 탭 닫기 (지금 탭: ${(page.title || page.url).slice(0, 24)})`,
    close: true,
    run: async () => {
      await runtime.close(page.pageId);
      if (tabs.length === 1) await runtime.ensureShared(workflowId, page.workflowName);
    },
  });
  add({
    role: 'button',
    name: '새 웹 페이지 탭 열기',
    run: async () => void runtime.activate((await runtime.create({ workflowId, workflowName: page.workflowName, mode: 'shared' })).pageId),
  });
  return out;
}

/** 브라우저 자체 조작을 화면 요소 모양으로. */
export function chromeRefs(chrome: Record<string, ChromeAction>): ElementRefs {
  return Object.fromEntries(Object.entries(chrome).map(([k, a]) => [k, { role: a.role, name: a.name }])) as ElementRefs;
}

/** 페이지 요소 앞에 브라우저 자체 조작을 붙인 요소 목록. */
export function withChrome(
  workflowId: string,
  page: BrowserPageInfo,
  refs: ElementRefs,
): { refs: ElementRefs; chrome: Record<string, ChromeAction> } {
  const chrome = chromeActions(workflowId, page);
  return { refs: { ...chromeRefs(chrome), ...refs }, chrome };
}
