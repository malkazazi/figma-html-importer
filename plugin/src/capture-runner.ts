// Runs inside the plugin UI iframe (a real browser context). Takes a pasted
// HTML document, renders it into a hidden child iframe at a target viewport
// width so the browser computes real CSS / fonts / layout, walks the DOM into
// the shared Envelope format, and exposes that via window.__captureHtml().

import type { Envelope } from './schema';
import { CAPTURE_VERSION } from './schema';
import { walkElement } from './walker';

export type CaptureOpts = {
  html: string;
  viewportW: number;
  viewportH: number;
  breakpointLabel?: string;
};

declare global {
  interface Window {
    __captureHtml?: (opts: CaptureOpts) => Promise<Envelope>;
  }
}

async function captureHtml(opts: CaptureOpts): Promise<Envelope> {
  const { html, viewportW, viewportH, breakpointLabel } = opts;
  if (!html || !html.trim()) throw new Error('No HTML provided');

  // Render the HTML in a hidden child iframe so the user's CSS is the only
  // thing in scope (and the plugin UI's CSS doesn't bleed in). srcdoc keeps
  // the iframe same-origin with us — required so we can read its DOM.
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `
    position: fixed;
    left: -100000px;
    top: 0;
    width: ${viewportW}px;
    height: ${viewportH}px;
    border: 0;
    visibility: hidden;
  `;
  iframe.srcdoc = withCaptureOverrides(html);
  document.body.appendChild(iframe);

  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('iframe load timed out')), 15000);
      iframe.addEventListener('load', () => { clearTimeout(t); resolve(); }, { once: true });
    });

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('iframe document not accessible');

    // Document fonts: wait for any `@font-face` declared in the pasted HTML
    // to actually load before we measure text, so font metrics are correct.
    try { await (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready; } catch { /* ignore */ }

    await waitForImages(doc, 3000);
    // Give layout a frame to settle after fonts/images resolve.
    await new Promise((r) => setTimeout(r, 50));

    if (!doc.body) throw new Error('iframe has no body');

    // Pick-element capture marks its hoisted element with this attribute. Walk
    // that element directly so <body> doesn't become a phantom outer frame
    // sized to the iframe (which would carry the page's surrounding empty
    // space into Figma). If absent, fall through to the normal body walk.
    const pickedEl = doc.querySelector('[data-figma-picked-root]') as HTMLElement | null;
    const walkTarget: Element = pickedEl ?? doc.body;
    const root = await walkElement(walkTarget, {
      isRoot: true,
      fallbackBounds: { w: viewportW, h: viewportH },
    });
    if (!root) throw new Error('Nothing visible to capture in HTML');

    // When we walked a picked element, size the envelope viewport to the
    // element itself so the Figma root frame doesn't carry iframe-sized blank
    // space around the import.
    let envW: number;
    let envH: number;
    if (pickedEl) {
      const r = pickedEl.getBoundingClientRect();
      envW = Math.max(1, Math.round(r.width));
      envH = Math.max(1, Math.round(r.height));
    } else {
      // Width: use the breakpoint's actual viewport. Pages often have hidden
      // overflowing elements (off-screen menus, transformed siblings) that
      // push documentElement.scrollWidth far past the visible layout, which
      // would produce a Figma root frame much wider than the breakpoint.
      // expandRootToAllDescendants in code.ts already grows the frame if
      // *visible* walked content extends further, so capping at viewportW
      // here is safe — real overflow still gets captured.
      envW = viewportW;
      // Height: pages legitimately scroll vertically, so take the larger of
      // the scrollable extent and the viewport. expandRootToAllDescendants
      // will grow it further if walked content sits below this.
      envH = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, viewportH);
    }

    const envelope: Envelope = {
      captureVersion: CAPTURE_VERSION,
      capturedAt: Date.now(),
      url: extractDocumentUrl(doc, html),
      viewport: { w: envW, h: envH },
      root,
    };
    if (breakpointLabel) {
      envelope.breakpoint = { label: breakpointLabel, width: viewportW, height: viewportH };
    }
    return envelope;
  } finally {
    iframe.remove();
  }
}

// Frameworks like Radix UI ship popovers/menus with entrance animations that
// start at `opacity: 0` (via `--tw-enter-opacity: 0` + a keyframe that reads
// it). A static HTML snapshot freezes that animation at frame 0, so the
// walker's `isHidden` check (opacity === 0) drops the entire subtree. We
// neutralize animations and transitions with an inline override so elements
// sit at their final, settled appearance when we measure them.
function withCaptureOverrides(html: string): string {
  const override = `<style id="__figma_capture_override">
    *,*::before,*::after {
      animation-name: none !important;
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition: none !important;
    }
  </style>`;
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose >= 0) return html.slice(0, headClose) + override + html.slice(headClose);
  const bodyOpen = html.search(/<body[^>]*>/i);
  if (bodyOpen >= 0) {
    const after = html.indexOf('>', bodyOpen) + 1;
    return html.slice(0, after) + override + html.slice(after);
  }
  return override + html;
}

function extractDocumentUrl(doc: Document, html: string): string {
  // Many HTML-save extensions write `<link rel="canonical" href="...">` or a
  // comment like `<!-- Page saved from <url> -->`. Surface whichever we find
  // so the Figma frame can be labeled with the original hostname.
  const canon = doc.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (canon?.href) return canon.href;
  const ogUrl = doc.querySelector('meta[property="og:url"]') as HTMLMetaElement | null;
  if (ogUrl?.content) return ogUrl.content;
  const m = html.match(/saved from\s+(https?:\/\/\S+)/i);
  if (m) return m[1];
  return '';
}

async function waitForImages(doc: Document, timeoutMs: number): Promise<void> {
  const imgs = Array.from(doc.images || []);
  const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0);
  if (!pending.length) return;
  await Promise.race([
    Promise.all(pending.map((img) => new Promise<void>((res) => {
      const done = () => res();
      img.addEventListener('load',  done, { once: true });
      img.addEventListener('error', done, { once: true });
    }))),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

window.__captureHtml = captureHtml;
