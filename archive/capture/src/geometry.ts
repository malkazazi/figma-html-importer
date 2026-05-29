import type { Bounds } from './schema';

/** Convert a DOMRect (viewport-relative in the element's own window) to
 *  page-absolute coordinates. Uses the element's owner window so it works
 *  both for the main document and for iframes we're walking through. */
export function pageBoundsOf(rect: DOMRect, el?: Element): Bounds {
  const win = el?.ownerDocument?.defaultView ?? window;
  return {
    x: rect.left + win.scrollX,
    y: rect.top + win.scrollY,
    w: rect.width,
    h: rect.height,
  };
}
