import React, { useEffect, useState } from 'react';

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function fmtWhen(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

/** 로딩/오류/빈 상태를 한 곳에서 다루는 작은 데이터 훅. */
export function useLoader<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    fn()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

export const StateNote: React.FC<{
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyText?: string;
}> = ({ loading, error, empty, emptyText }) => {
  if (loading) return <div className="viewer-note">불러오는 중…</div>;
  if (error) return <div className="viewer-note err">불러오지 못했습니다: {error}</div>;
  if (empty) return <div className="viewer-note">{emptyText ?? '내용이 없습니다.'}</div>;
  return null;
};

export const ViewerEmpty: React.FC<{
  title: string;
  description?: string;
  onRetry?: () => void;
  loading?: boolean;
  error?: boolean;
}> = ({ title, description, onRetry, loading, error }) => (
  <div className={`viewer-empty${error ? ' err' : ''}`} role={error ? 'alert' : 'status'}>
    <div className="viewer-empty-mark" aria-hidden="true">
      {error ? '!' : '◇'}
    </div>
    <strong>{title}</strong>
    {description && <p>{description}</p>}
    {onRetry && (
      <button className="viewer-btn" disabled={loading} onClick={onRetry}>
        {loading ? '불러오는 중…' : '새로고침'}
      </button>
    )}
  </div>
);
