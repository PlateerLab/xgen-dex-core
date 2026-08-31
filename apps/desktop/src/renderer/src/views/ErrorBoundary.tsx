/**
 * ErrorBoundary — the connector's last line against a blank window.
 *
 * A render-phase exception anywhere in the tree (e.g. a history turn whose text
 * was a structured object slipping into `{m.text}`) used to unmount React to the
 * root, leaving a black screen with no way back — the "기존 채팅 불러오기 →
 * 검정 화면" bug. This boundary catches it, shows what happened, and offers a
 * reload so a single bad turn can never take the whole app down again.
 */
import React from 'react';

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 원인을 콘솔에 남긴다 — 재현이 어려운 데이터 의존 크래시라 로그가 중요하다.
    // eslint-disable-next-line no-console
    console.error('[connector] render error captured by ErrorBoundary:', error, info);
  }

  private reset = (): void => this.setState({ error: null });
  private reload = (): void => window.location.reload();

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="center" style={{ padding: 32, textAlign: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>화면을 표시하는 중 오류가 발생했습니다</h2>
        <p className="muted small" style={{ maxWidth: 520, wordBreak: 'break-word' }}>
          {error.message || String(error)}
        </p>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="secondary" onClick={this.reset}>
            다시 시도
          </button>
          <button className="secondary" onClick={this.reload}>
            새로고침
          </button>
        </div>
      </div>
    );
  }
}
