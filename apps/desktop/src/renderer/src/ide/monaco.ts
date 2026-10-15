/**
 * IDE 편집기(Monaco) — 처음 파일을 열 때 불러온다.
 *
 * 렌더러 CSP 는 외부 스크립트(CDN)를 막는다 — Monaco 와 그 worker 를 이 앱의 번들로 싣는다.
 * worker 는 vite 의 `?worker` 로 같은 출처 파일이 되고(`worker-src 'self' blob:`), 언어별로
 * 고른다: 타입스크립트·자바스크립트는 언어 서비스 worker, JSON·CSS·HTML 은 각자의 worker.
 */
import type * as MonacoNs from 'monaco-editor';

type Monaco = typeof MonacoNs;

let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  if (!loading) {
    loading = (async () => {
      const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all(
        [
          import('monaco-editor'),
          import('monaco-editor/esm/vs/editor/editor.worker?worker'),
          import('monaco-editor/esm/vs/language/json/json.worker?worker'),
          import('monaco-editor/esm/vs/language/css/css.worker?worker'),
          import('monaco-editor/esm/vs/language/html/html.worker?worker'),
          import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
        ],
      );
      (self as unknown as { MonacoEnvironment: MonacoNs.Environment }).MonacoEnvironment = {
        getWorker(_id: string, label: string) {
          switch (label) {
            case 'json':
              return new jsonWorker.default();
            case 'css':
            case 'scss':
            case 'less':
              return new cssWorker.default();
            case 'html':
            case 'handlebars':
            case 'razor':
              return new htmlWorker.default();
            case 'typescript':
            case 'javascript':
              return new tsWorker.default();
            default:
              return new editorWorker.default();
          }
        },
      };
      return monaco;
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}
