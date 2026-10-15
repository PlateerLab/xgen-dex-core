/**
 * 앱 카드 한 장 — [앱] 탭의 [내 앱]·[앱 스토어]가 함께 쓴다. 웹·모바일과 같은 모양이다:
 *
 *   [앱 이름] [태그…]
 *   [설명]
 *   [미리보기 그림 — 못 받으면 기본 그림]
 *   [버튼…]                         [⋯]
 *
 * 미리보기는 서버에 올라간 한 장(앱을 띄워 찍은 화면)이다. 렌더러의 CSP 는 서버 그림을 직접 받지
 * 못해 main 이 받아 data URL 로 넘긴다. 같은 주소는 같은 그림이라(주소에 판이 실린다) 화면 안에서도
 * 한 번만 받는다.
 */
import React, { useEffect, useState } from 'react';
import type { AppTag } from '@dex/protocol/app-card';
import { appKindLabel } from '@dex/protocol/app-card';
import { xgen } from '../bridge';
import { AppIcon, BrowserIcon, CodeIcon } from '../brand/icons';

const images = new Map<string, string>();

/** 미리보기 그림 → data URL. 없거나 실패면 빈 문자열(기본 그림). */
export function usePreviewImage(previewUrl: string | undefined): string {
  const [src, setSrc] = useState(() => (previewUrl ? images.get(previewUrl) ?? '' : ''));
  useEffect(() => {
    if (!previewUrl) {
      setSrc('');
      return;
    }
    const hit = images.get(previewUrl);
    if (hit) {
      setSrc(hit);
      return;
    }
    let alive = true;
    void xgen.apps
      .previewImage(previewUrl)
      .then((url) => {
        if (url) images.set(previewUrl, url);
        if (alive) setSrc(url || '');
      })
      .catch(() => {
        if (alive) setSrc('');
      });
    return () => {
      alive = false;
    };
  }, [previewUrl]);
  return src;
}

const KindGlyph: React.FC<{ kind: string; size?: number }> = ({ kind, size = 28 }) =>
  kind === 'project' ? <BrowserIcon size={size} /> : kind === 'component' ? <CodeIcon size={size} /> : <AppIcon size={size} />;

/** 미리보기 칸 — 그림이 있으면 그림, 없거나 깨지면 모양 아이콘과 이름의 기본 그림. */
export const AppPreviewImage: React.FC<{ previewUrl?: string; kind: string; title: string }> = ({
  previewUrl,
  kind,
  title,
}) => {
  const src = usePreviewImage(previewUrl);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <div className="app-card-preview">
      {src && !broken ? (
        <img src={src} alt={`${title} 미리보기`} draggable={false} onError={() => setBroken(true)} />
      ) : (
        <div className="app-card-fallback" aria-hidden>
          <span className="app-card-fallback-icon">
            <KindGlyph kind={kind} />
          </span>
          <span>{appKindLabel(kind)}</span>
        </div>
      )}
    </div>
  );
};

export const AppCard: React.FC<{
  title: string;
  tags: AppTag[];
  description: string;
  previewUrl?: string;
  kind: string;
  /** 왼쪽 버튼들. */
  actions: React.ReactNode;
  /** 오른쪽 끝의 [⋯] 메뉴(없으면 비운다). */
  menu?: React.ReactNode;
  onPreviewClick?: () => void;
}> = ({ title, tags, description, previewUrl, kind, actions, menu, onPreviewClick }) => (
  <article className="app-card">
    <div className="app-card-top">
      <strong className="app-card-title" title={title}>
        {title}
      </strong>
      {tags.map((tag, i) => (
        <span key={`${tag.tone}-${i}`} className={`app-badge ${tag.tone}`} title={tag.label}>
          {tag.label}
        </span>
      ))}
    </div>
    <p className="app-card-desc" title={description}>
      {description}
    </p>
    {onPreviewClick ? (
      <button type="button" className="app-card-preview-button" onClick={onPreviewClick} aria-label={`${title} 열기`}>
        <AppPreviewImage previewUrl={previewUrl} kind={kind} title={title} />
      </button>
    ) : (
      <AppPreviewImage previewUrl={previewUrl} kind={kind} title={title} />
    )}
    <div className="app-card-actions">
      {actions}
      {menu ? <div className="app-card-menu-wrap">{menu}</div> : null}
    </div>
  </article>
);
