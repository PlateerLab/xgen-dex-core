/**
 * XGEN brand logo — copied 1:1 from xgen-frontend's `@xgen/icons` logo SVGs
 * (`Icon_Logo_Symbol` / `Icon_Logo_M_C`), re-authored as clean React SVGs.
 *
 * The upstream SVGs paint the "X" symbol with a Figma conic-gradient exported as
 * a `<foreignObject>` (unreliable outside Figma). We instead fill it with the
 * documented brand gradient (`--color-primary-start #305eeb → --color-primary-end
 * #783ced`, the same one `.xgen-gradient-text` uses), which renders identically
 * everywhere.
 *
 * - `mono`  → paths use `currentColor` (adapts to light/dark via CSS `color`).
 * - `color` → the X symbol is brand-gradient; the "GEN" letters use currentColor.
 */
import React from 'react';

const BRAND_START = '#305eeb';
const BRAND_END = '#783ced';
const GRAD_ID = 'xgen-brand-grad';

// The "X" mark, from Icon_Logo_Symbol (viewBox 0 0 30 30).
const SYMBOL_PATH =
  'M14.9805 9.08887L17.1914 5H24.7793L19.1416 14.9863L25.001 25H17.2627L14.9766 20.8135L12.708 25H5L10.8057 14.9893L5.19434 5H12.8057L14.9805 9.08887Z';

// "G", "E", "N" glyphs, from Icon_Logo_M_C (viewBox 0 0 78 30).
const G_PATH =
  'M38.1799 11.8541C37.5915 9.92752 36.1751 8.76261 34.0831 8.76261C31.4245 8.76261 29.3761 10.9132 29.3761 14.8336C29.3761 18.754 31.4027 20.9046 34.192 20.9046C36.7089 20.9046 38.376 19.2692 38.4196 16.6706H34.5407V14.632H40.7512V16.4689C40.7512 20.5685 38.0055 23.1672 34.1702 23.1672C29.8991 23.1672 27.0009 19.9637 27.0009 14.8336C27.0009 9.6587 29.9863 6.5 34.0613 6.5C37.4825 6.5 40.0975 8.69541 40.6423 11.8541H38.1799Z';
const E_PATH =
  'M45.751 22.7503V6.9165H55.6639V8.99414H48.1528V13.7837H55.1399V15.8394H48.1528V20.6727H55.7513V22.7503H45.751Z';
const N_PATH =
  'M73.6681 6.9165V22.7503H71.4341L63.3168 11.1811H63.1841V22.7503H60.7511V6.9165H63.0071L71.1245 18.5076H71.2793V6.9165H73.6681Z';

function BrandGradient() {
  return (
    <defs>
      <linearGradient id={GRAD_ID} x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor={BRAND_START} />
        <stop offset="1" stopColor={BRAND_END} />
      </linearGradient>
    </defs>
  );
}

export interface LogoProps {
  /** Rendered height in px (width scales to the glyph aspect ratio). */
  height?: number;
  variant?: 'mono' | 'color';
  className?: string;
  title?: string;
}

/** The XGEN "X" symbol only (square). */
export const XgenMark: React.FC<LogoProps> = ({ height = 24, variant = 'color', className, title }) => {
  const fill = variant === 'color' ? `url(#${GRAD_ID})` : 'currentColor';
  return (
    <svg
      height={height}
      width={height}
      viewBox="0 0 30 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {variant === 'color' && <BrandGradient />}
      <path d={SYMBOL_PATH} fill={fill} />
    </svg>
  );
};

/** The full "XGEN" wordmark. */
export const XgenWordmark: React.FC<LogoProps> = ({ height = 28, variant = 'mono', className, title }) => {
  const width = (78 / 30) * height;
  const symbolFill = variant === 'color' ? `url(#${GRAD_ID})` : 'currentColor';
  return (
    <svg
      height={height}
      width={width}
      viewBox="0 0 78 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={title ?? 'XGEN'}
    >
      {title && <title>{title}</title>}
      {variant === 'color' && <BrandGradient />}
      <path d={SYMBOL_PATH} fill={symbolFill} />
      <path d={G_PATH} fill="currentColor" />
      <path d={E_PATH} fill="currentColor" />
      <path d={N_PATH} fill="currentColor" />
    </svg>
  );
};
