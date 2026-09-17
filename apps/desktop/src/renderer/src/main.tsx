import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './views/ErrorBoundary';
import './styles.css';
// 작업 과정 타임라인 스타일 — 컴포넌트가 직접 싣지 않는다(노드 테스트가 Chat 을 불러올 때 .css 를 해석하지 못한다).
import './views/process-timeline.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
