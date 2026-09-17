/**
 * 색과 간격의 한 자리.
 *
 * 화면 부품이 늘면서 팔레트를 App.tsx 안에 두면 부품마다 색을 다시 고르게 된다
 * — 같은 회색이 세 가지가 되는 길이다. 여기 있는 값만 쓴다.
 */
import React from 'react';
import { Platform } from 'react-native';

export interface Palette {
  bg: string;
  panel: string;
  panel2: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  danger: string;
  ok: string;
  assistantBubble: string;
  /** 코드·도구 로그처럼 글이 빽빽한 자리의 바탕. */
  code: string;
}

export const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    bg: '#F5F6F8', panel: '#FFFFFF', panel2: '#EEF0F4', text: '#16181D',
    muted: '#667085', border: '#E3E6EC', primary: '#5B5BD6', onPrimary: '#FFFFFF',
    danger: '#D92D20', ok: '#12B76A', assistantBubble: '#FFFFFF', code: '#F2F3F7',
  },
  dark: {
    bg: '#0E1015', panel: '#171A21', panel2: '#1F232C', text: '#E9ECF2',
    muted: '#8B93A3', border: '#262B35', primary: '#5B5BD6', onPrimary: '#FFFFFF',
    danger: '#F97066', ok: '#32D583', assistantBubble: '#1C202A', code: '#12151C',
  },
};

export const PaletteCtx = React.createContext<Palette>(PALETTES.dark);
export const useP = (): Palette => React.useContext(PaletteCtx);

/** 손가락이 닿아야 하는 최소 크기 — 아이콘만 작게 그리고 이만큼은 눌리게 둔다. */
export const TAP = 44;

/** 코드·로그용 글꼴. iOS 와 안드로이드의 이름이 다르다. */
export const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

/** 색 + 투명도 — `${color}20` 식 문자열 조립을 한 곳에 모은다. */
export function alpha(color: string, percent: number): string {
  const v = Math.max(0, Math.min(100, percent));
  const hex = Math.round((v / 100) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${hex}`;
}
