import type { ImageData } from './schema';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Fetch an <img> or resolved background-image URL and return a data URL,
 *  downscaling via canvas if the source exceeds MAX_IMAGE_BYTES. In the
 *  plugin-UI capture flow the source is usually a data: URL embedded by the
 *  HTML-save extension, so `fetch` resolves without hitting the network. */
export async function imageToDataUrl(src: string, displayedW: number, displayedH: number): Promise<ImageData | null> {
  if (!src) return null;
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob).catch(() => null);
    const iw = bitmap?.width  ?? displayedW;
    const ih = bitmap?.height ?? displayedH;

    if (blob.size <= MAX_IMAGE_BYTES) {
      const dataUrl = await blobToDataUrl(blob);
      bitmap?.close();
      return { dataUrl, intrinsicW: iw, intrinsicH: ih };
    }

    const targetW = Math.min(iw, Math.max(1, Math.ceil(displayedW * 2)));
    const targetH = Math.min(ih, Math.max(1, Math.ceil(displayedH * 2)));
    const canvas = document.createElement('canvas');
    canvas.width = targetW; canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx || !bitmap) {
      bitmap?.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) { reject(new Error('toBlob failed')); return; }
        blobToDataUrl(b).then(resolve, reject);
      }, 'image/png');
    });
    return { dataUrl, intrinsicW: iw, intrinsicH: ih };
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Extract the first url(...) target from a computed background-image value. */
export function firstBackgroundUrl(cssBackgroundImage: string): string | null {
  if (!cssBackgroundImage || cssBackgroundImage === 'none') return null;
  if (/gradient\s*\(/i.test(cssBackgroundImage)) return null;
  const m = cssBackgroundImage.match(/url\((['"]?)(.*?)\1\)/i);
  return m ? m[2] : null;
}
