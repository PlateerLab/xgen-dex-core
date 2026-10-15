/**
 * 하단 바 없이 알리는 두 자리.
 *
 * - ConnectionBar: 샌드박스에 닿지 않을 때만 편집기 위에 한 줄로 뜬다. 붙어 있으면 아무것도 없다.
 * - IdeToast: 호스트가 알림(토스트)을 갖지 않을 때 IDE 가 스스로 띄우는 알림. 오른쪽 아래.
 */
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './icons';
import { useIde, useStore } from './hooks';
import type { Notice } from '../store';

export function ConnectionBar() {
  const store = useStore();
  const connection = useIde((s) => s.connection);
  const reason = useIde((s) => s.sessionError);
  if (connection !== 'retrying' && connection !== 'blocked') return null;
  const blocked = connection === 'blocked';
  return (
    <div className={`xide-connbar xide--${connection}`} role="status">
      {blocked ? <Icon name="error" size={14} /> : <span className="xide-spinner" aria-hidden />}
      <span className="xide-connbar-text">
        {blocked ? (reason ?? '샌드박스를 열 수 없습니다') : `${reason ?? '서버에 잠시 닿지 않습니다'}. 스스로 다시 연결합니다`}
      </span>
      <button type="button" className="xide-connbar-action" onClick={() => store.reconnect()}>
        지금 다시 시도
      </button>
    </div>
  );
}

const TOAST_ICON: Record<Notice['kind'], IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'error',
};

export function IdeToast() {
  const store = useStore();
  const notice = useIde((s) => s.notice);
  const [shown, setShown] = useState(notice);

  useEffect(() => {
    setShown(notice);
    if (!notice) return;
    const t = setTimeout(() => setShown(null), notice.kind === 'error' ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [notice]);

  if (!shown) return null;
  return (
    <div className={`xide-toast xide--${shown.kind}`} role={shown.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={TOAST_ICON[shown.kind]} size={15} />
      <span className="xide-toast-text">{shown.message}</span>
      <button
        type="button"
        className="xide-toast-close"
        aria-label="알림 닫기"
        onClick={() => {
          setShown(null);
          store.clearNotice();
        }}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
