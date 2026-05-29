import type { Bounds } from './schema';

/** Convert a DOMRect (viewport-relative in the element's own window) to
 *  page-absolute coordinates. Uses the element's owner window so it works
 *  on elements inside the hidden capture iframe as well as the main doc. */
export function pageBoundsOf(rect: DOMRect, el?: Element): Bounds {
  const win = el?.ownerDocument?.defaultView ?? window;
  return {
    x: rect.left + win.scrollX,
    y: rect.top + win.scrollY,
    w: rect.width,
    h: rect.height,
  };
}
