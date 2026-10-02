/** `window.xd` — XD 의 preload 가 연다. */
import type { XdBridge } from '../../preload/index';

declare global {
  interface Window {
    xd: XdBridge;
  }
}

export const xd: XdBridge = (typeof window !== 'undefined' ? window.xd : undefined) as XdBridge;
