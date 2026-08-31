import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BROWSER_CONTEXT_START,
  prependBrowserContext,
  sanitizedBrowserUrl,
  stripBrowserContext,
  type BrowserSelectionResult,
  type BrowserState,
} from '../src/core/browser';
import { normalizedSelectionRect } from '../src/main/browser-selection';

const state: BrowserState = {
  enabled: true,
  activeByWorkflow: { wf: 'p1' },
  popupRequests: [],
  pages: [
    {
      pageId: 'p1',
      workflowId: 'wf',
      workflowName: 'Agent',
      mode: 'shared',
      url: 'https://example.com/private/path?token=secret#frag',
      title: 'Private',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition: 'persist:xgen-browser-hash',
      generation: 3,
    },
  ],
};

test('browser preamble applies only to enabled workflows with live pages', () => {
  const decorated = prependBrowserContext('원문', 'wf', state);
  assert.ok(decorated.startsWith(BROWSER_CONTEXT_START));
  assert.match(decorated, /"page_id":"p1"/);
  assert.match(decorated, /https:\/\/example\.com\/private\/path/);
  assert.ok(!decorated.includes('secret'));
  assert.ok(!decorated.includes('#frag'));
  assert.equal(stripBrowserContext(decorated), '원문');
  assert.equal(prependBrowserContext('원문', 'other', state), '원문');
  assert.equal(prependBrowserContext('원문', 'wf', { ...state, enabled: false }), '원문');
});

test('browser URL sanitizer accepts only web/about and removes query + fragment', () => {
  assert.equal(sanitizedBrowserUrl('https://x.test/a?b=1#c'), 'https://x.test/a');
  assert.equal(sanitizedBrowserUrl('about:blank'), 'about:blank');
  assert.equal(sanitizedBrowserUrl('file:///etc/passwd'), '');
  assert.equal(sanitizedBrowserUrl('javascript:alert(1)'), '');
});

test('selected DOM metadata joins the browser envelope without duplicating image bytes', () => {
  const selection: BrowserSelectionResult = {
    id: 'sel-1',
    workflowId: 'wf',
    pageId: 'p1',
    generation: 3,
    kind: 'element',
    title: 'Private',
    url: 'https://example.com/private/path?token=secret#frag',
    rect: { x: 10, y: 20, width: 120, height: 40 },
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 100 },
    elements: [
      {
        tag: 'button',
        role: 'button',
        name: '저장',
        text: '저장',
        selector: 'body > button:nth-of-type(2)',
        html: '<button role="button">저장</button>',
        rect: { x: 10, y: 20, width: 120, height: 40 },
      },
    ],
    image: {
      dataUrl: 'data:image/png;base64,AAAA',
      name: 'browser-selection-sel-1.png',
      mime: 'image/png',
      size: 3,
      width: 120,
      height: 40,
    },
  };

  const decorated = prependBrowserContext('이 버튼은 뭐야?', 'wf', state, [selection]);
  assert.match(decorated, /"version":2/);
  assert.match(decorated, /"selections":\[/);
  assert.match(decorated, /browser-selection-sel-1\.png/);
  assert.match(decorated, /<button role=\\"button\\">저장<\/button>/);
  assert.ok(!decorated.includes('base64'));
  assert.ok(!decorated.includes('secret'));
  assert.equal(stripBrowserContext(decorated), '이 버튼은 뭐야?');
});

test('drag rectangles normalize every direction and reject click-sized regions', () => {
  assert.deepEqual(normalizedSelectionRect({ x: 90, y: 80, width: -40, height: -30 }), {
    x: 50,
    y: 50,
    width: 40,
    height: 30,
  });
  assert.equal(normalizedSelectionRect({ x: 1, y: 1, width: 2, height: 3 }), null);
  assert.equal(normalizedSelectionRect({ x: Number.NaN, y: 1, width: 10, height: 10 }), null);
});
