import type { Color, Paint, Stroke, Shadow } from './schema';

// ── Paints ────────────────────────────────────────────────────────────────

export function toFigmaSolidPaint(color: Color): SolidPaint {
  return {
    type: 'SOLID',
    color: { r: color.r, g: color.g, b: color.b },
    opacity: color.a,
  };
}

export function toFigmaImagePaint(imageHash: string, scaleMode: 'FILL' | 'FIT' | 'TILE'): ImagePaint {
  return {
    type: 'IMAGE',
    imageHash,
    scaleMode,
  };
}

export async function paintsFromSchema(fills: Paint[] | undefined): Promise<Paint_figma[]> {
  if (!fills || !fills.length) return [];
  const out: Paint_figma[] = [];
  for (const p of fills) {
    if (p.type === 'solid') {
      out.push(toFigmaSolidPaint(p.color));
    } else if (p.type === 'image') {
      // `figma.createImage` only accepts raster bytes (PNG/JPEG/GIF). An <img>
      // whose real source is an SVG data URL lands here too — skip those; the
      // builder handles SVG-source images by creating an SVG node instead.
      if (isSvgDataUrl(p.dataUrl)) continue;
      try {
        const bytes = dataUrlToUint8Array(p.dataUrl);
        const image = figma.createImage(bytes);
        out.push(toFigmaImagePaint(image.hash, p.scaleMode));
      } catch (err) {
        console.warn('image paint failed', err, p.dataUrl.slice(0, 60));
      }
    }
  }
  return out;
}

export function isSvgDataUrl(url: string): boolean {
  return url.startsWith('data:image/svg+xml');
}

/** Decode the SVG text out of an `image/svg+xml` data URL. Handles both
 *  base64-encoded and URL-encoded (or unencoded) forms. Returns null on
 *  malformed input. */
export function svgTextFromDataUrl(url: string): string | null {
  if (!isSvgDataUrl(url)) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const body = url.slice(comma + 1);
  try {
    if (/;\s*base64/i.test(header)) {
      const bin = typeof atob !== 'undefined' ? atob(body) : figmaAtob(body);
      // Decoded bytes are UTF-8 — rebuild the string.
      let s = '';
      for (let i = 0; i < bin.length; i++) s += bin.charAt(i);
      return decodeURIComponent(escape(s));
    }
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

type Paint_figma = SolidPaint | ImagePaint;

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('bad data url');
  const b64 = dataUrl.slice(comma + 1);
  const bin = typeof atob !== 'undefined' ? atob(b64) : figmaAtob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Figma sandbox has atob, but guard just in case.
function figmaAtob(b64: string): string {
  return (globalThis as unknown as { atob(s: string): string }).atob(b64);
}

// ── Strokes ───────────────────────────────────────────────────────────────

export function applyStrokes(node: SceneNode, strokes: Stroke[] | undefined): void {
  if (!strokes || !strokes.length) return;
  // Figma frames support individualStrokeWeights (top/right/bottom/left).
  // For v1 we zero-out all sides, then apply the captured ones.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withStrokes = node as any;
  if (!('strokes' in withStrokes)) return;

  const first = strokes[0];
  withStrokes.strokes = [toFigmaSolidPaint(first.color)] as ReadonlyArray<SolidPaint>;
  withStrokes.strokeAlign = 'INSIDE';

  if (first.sides === 'all') {
    withStrokes.strokeWeight = first.width;
  } else if (
    typeof withStrokes.strokeTopWeight === 'number' ||
    'strokeTopWeight' in withStrokes
  ) {
    // Per-side weights (FrameNode / RectangleNode support this).
    withStrokes.strokeTopWeight    = first.sides === 'top'    ? first.width : 0;
    withStrokes.strokeRightWeight  = first.sides === 'right'  ? first.width : 0;
    withStrokes.strokeBottomWeight = first.sides === 'bottom' ? first.width : 0;
    withStrokes.strokeLeftWeight   = first.sides === 'left'   ? first.width : 0;
  } else {
    withStrokes.strokeWeight = first.width;
  }
}

// ── Shadows ───────────────────────────────────────────────────────────────

export function toFigmaEffect(s: Shadow): DropShadowEffect | InnerShadowEffect {
  const base = {
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    offset: { x: s.offsetX, y: s.offsetY },
    radius: s.blur,
    spread: s.spread,
    visible: true,
    blendMode: 'NORMAL' as BlendMode,
  };
  if (s.type === 'inner') {
    return { ...base, type: 'INNER_SHADOW' } as InnerShadowEffect;
  }
  return { ...base, type: 'DROP_SHADOW', showShadowBehindNode: false } as DropShadowEffect;
}
