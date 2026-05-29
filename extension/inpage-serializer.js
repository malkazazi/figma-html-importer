// Runs in the target page's ISOLATED world via chrome.scripting.executeScript.
// Produces a self-contained HTML string by inlining external CSS, images, and
// fonts as data URLs. Returns the HTML as the final value of the script so
// executeScript can hand it back to the background.
//
// IMPORTANT: this serializer is non-destructive. We snapshot the live CSSOM
// up-front, then clone <html> and run every mutation on the clone. The live
// page the user is looking at is never touched — neither in full-page nor
// pick-element mode.
//
// Cross-origin assets can't be fetched from this context (CORS), so we relay
// fetches through the background service worker, which has `host_permissions:
// <all_urls>` and bypasses page CORS.
//
// Pick-element scoping: when window.__figmaPickedSelector is set (the
// background injects a tiny pre-script that assigns it), we trim the clone so
// only the picked element's subtree survives, with its ancestor chain intact
// so inherited styles still apply.

(async () => {
  const pickedSelector = (typeof window.__figmaPickedSelector === 'string')
    ? window.__figmaPickedSelector
    : '';
  // Random per-run so we can find the picked element in the clone without
  // re-running the selector (cheaper + safe across DOM shape changes).
  const PICK_ATTR = '__figma_pick_' + Math.random().toString(36).slice(2);
  const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const baseUrl = document.baseURI;

  /** @type {Map<string, string|null>} cache of absolute URL → data URL (null = failed) */
  const assetCache = new Map();

  async function fetchAsset(absUrl) {
    if (!absUrl || absUrl.startsWith('data:')) return absUrl;
    if (assetCache.has(absUrl)) return assetCache.get(absUrl);
    let dataUrl = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'fetch-asset', url: absUrl });
      if (resp && typeof resp.dataUrl === 'string') dataUrl = resp.dataUrl;
    } catch { /* worker disconnected, drop */ }
    assetCache.set(absUrl, dataUrl);
    return dataUrl;
  }

  async function fetchText(absUrl) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'fetch-text', url: absUrl });
      return (resp && typeof resp.text === 'string') ? resp.text : '';
    } catch {
      return '';
    }
  }

  function resolveUrl(url, base) {
    try { return new URL(url, base).href; } catch { return url; }
  }

  async function inlineCssUrls(cssText, baseUrlForCss) {
    if (!cssText || !cssText.includes('url(')) return cssText;
    const found = [];
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(cssText)) !== null) {
      const raw = m[2];
      if (raw.startsWith('data:') || raw.startsWith('#')) continue;
      found.push(raw);
    }
    if (!found.length) return cssText;

    const unique = [...new Set(found)];
    const results = await Promise.all(unique.map(async (raw) => {
      const abs = resolveUrl(raw, baseUrlForCss);
      const dataUrl = await fetchAsset(abs);
      return [raw, dataUrl];
    }));
    const map = new Map(results);

    return cssText.replace(URL_RE, (full, q, raw) => {
      if (raw.startsWith('data:') || raw.startsWith('#')) return full;
      const dataUrl = map.get(raw);
      return dataUrl ? `url("${dataUrl}")` : full;
    });
  }

  // ---- Live-DOM snapshot phase (synchronous, no awaits) ----

  // Capture CSSOM rules from same-origin stylesheets. Cross-origin sheets
  // throw on .cssRules access — we'll fall back to a fetch via the worker.
  const liveLinks = [...document.querySelectorAll('link[rel~="stylesheet"][href]')];
  const liveLinkCss = [];
  for (const link of liveLinks) {
    let css = '';
    try {
      const sheet = link.sheet;
      if (sheet && sheet.cssRules) {
        css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      }
    } catch { /* cross-origin — fetch later */ }
    liveLinkCss.push(css);
  }

  // Tag the picked element on the live DOM so we can find it in the clone.
  let livePicked = null;
  // Snapshot inheritable computed styles from the live element so we can
  // hoist it out of its ancestor chain without losing inherited values
  // (color, font-family, etc.). Computed values are absolute (px, rgb()),
  // so they survive being detached from the cascade.
  let livePickedInherited = '';
  if (pickedSelector) {
    livePicked = document.querySelector(pickedSelector);
    if (livePicked) {
      livePicked.setAttribute(PICK_ATTR, '1');
      try {
        const cs = getComputedStyle(livePicked);
        const inheritable = [
          'color', 'font-family', 'font-size', 'font-weight', 'font-style',
          'font-variant', 'line-height', 'letter-spacing', 'text-align',
          'text-transform', 'text-indent', 'word-spacing', 'white-space',
          'direction', 'visibility',
        ];
        livePickedInherited = inheritable
          .map((p) => {
            const v = cs.getPropertyValue(p);
            return v ? `${p}: ${v}` : '';
          })
          .filter(Boolean)
          .join('; ');
      } catch { /* ignore */ }
    }
  }

  // Clone <html>. All subsequent mutations happen on this detached tree, so
  // the user's live page stays exactly as they left it.
  const root = document.documentElement.cloneNode(true);

  // Drop any of our own injected UI from the clone (progress spinner, toasts)
  // so they can never leak into the captured HTML, regardless of whether one
  // happened to be on the page when we snapshotted it.
  root.querySelectorAll('#__figma_capture_spinner, #__figma_capture_toast').forEach((n) => n.remove());

  // Live cleanup: drop the marker so we don't leak it back to the user.
  if (livePicked) livePicked.removeAttribute(PICK_ATTR);
  try { delete window.__figmaPickedSelector; } catch { window.__figmaPickedSelector = undefined; }

  // ---- Mutation phase, all on the clone ----

  // 1. External stylesheets → inline <style>. Mirror the live link order so
  //    captured CSSOM matches the cloned link by index.
  const clonedLinks = [...root.querySelectorAll('link[rel~="stylesheet"][href]')];
  for (let i = 0; i < clonedLinks.length; i++) {
    const link = clonedLinks[i];
    const href = link.href;
    if (!href) continue;
    let css = liveLinkCss[i] || '';
    if (!css) css = await fetchText(href);
    if (!css) { link.remove(); continue; }
    const inlined = await inlineCssUrls(css, href);
    const style = document.createElement('style');
    if (link.media) style.media = link.media;
    style.textContent = inlined;
    link.replaceWith(style);
  }

  // 2. Inline <style> blocks — they may contain url() refs (fonts, bg images).
  const styleEls = [...root.querySelectorAll('style')];
  for (const style of styleEls) {
    const text = style.textContent || '';
    if (!text.includes('url(')) continue;
    style.textContent = await inlineCssUrls(text, baseUrl);
  }

  // 3. <img> src → data URL. Strip srcset so the static document can't fetch
  //    alternate sources we didn't inline.
  const imgEls = [...root.querySelectorAll('img')];
  for (const img of imgEls) {
    img.removeAttribute('srcset');
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;
    const abs = resolveUrl(src, baseUrl);
    const dataUrl = await fetchAsset(abs);
    if (dataUrl) img.setAttribute('src', dataUrl);
  }
  root.querySelectorAll('source[srcset]').forEach((s) => s.removeAttribute('srcset'));

  // 4. Inline style attributes with url() — common for background-image hacks.
  const styled = [...root.querySelectorAll('[style*="url("]')];
  for (const el of styled) {
    const css = el.getAttribute('style');
    if (!css) continue;
    el.setAttribute('style', await inlineCssUrls(css, baseUrl));
  }

  // 5. SVG <image> elements with href / xlink:href.
  const svgImgs = [...root.querySelectorAll('image[href], image[xlink\\:href]')];
  for (const node of svgImgs) {
    const href = node.getAttribute('href') || node.getAttribute('xlink:href');
    if (!href || href.startsWith('data:')) continue;
    const dataUrl = await fetchAsset(resolveUrl(href, baseUrl));
    if (!dataUrl) continue;
    if (node.hasAttribute('href')) node.setAttribute('href', dataUrl);
    if (node.hasAttribute('xlink:href')) node.setAttribute('xlink:href', dataUrl);
  }

  // 6. Add a canonical link so the Figma plugin can label the frame with the
  //    original hostname.
  if (!root.querySelector('link[rel="canonical"]')) {
    const c = document.createElement('link');
    c.rel = 'canonical';
    c.href = location.href;
    const head = root.querySelector('head');
    if (head) head.appendChild(c);
  }

  // 7. Strip <script> tags — the Figma plugin renders this HTML in a srcdoc
  //    iframe with no network, so scripts can't run anyway and only add bloat.
  root.querySelectorAll('script').forEach((s) => s.remove());

  // 8. Pick-element scoping: hoist the picked element to be the sole child of
  //    <body> and drop the entire ancestor chain. Keeping the chain meant the
  //    Figma plugin rendered each wrapper as an extra frame. Inheritable
  //    styles from the dropped chain are preserved via the snapshot we took
  //    from the live element above.
  //
  //    We also strip any space that surrounds the picked element so only the
  //    element itself ends up in Figma:
  //      - html/body margin + padding zeroed (page CSS often sets these to
  //        position content within a layout grid).
  //      - the picked element's own margin zeroed (CSS margin is "separate me
  //        from neighbors" — there are no neighbors anymore).
  //    A data attribute tags the element so the Figma-side capture runner can
  //    walk it directly instead of going through <body>, which avoids body
  //    becoming a phantom outer frame the size of the iframe.
  if (pickedSelector) {
    const picked = root.querySelector('[' + PICK_ATTR + ']');
    if (picked) {
      picked.removeAttribute(PICK_ATTR);
      picked.setAttribute('data-figma-picked-root', '1');
      if (livePickedInherited) {
        // Inherited values go FIRST so the element's own inline styles still
        // win the cascade.
        const existing = picked.getAttribute('style') || '';
        const merged = existing
          ? `${livePickedInherited}; ${existing}`
          : livePickedInherited;
        picked.setAttribute('style', merged);
      }
      const body = root.querySelector('body');
      if (body) {
        [...body.children].forEach((c) => c.remove());
        body.appendChild(picked);
      }
      // !important so we beat any class/id selector from the page's CSS that
      // tried to push padding onto html/body or margin onto the element.
      const reset = document.createElement('style');
      reset.setAttribute('data-figma-pick-reset', '1');
      reset.textContent =
        'html,body{margin:0!important;padding:0!important;}' +
        '[data-figma-picked-root]{margin:0!important;}';
      const head = root.querySelector('head') || root;
      head.appendChild(reset);
    }
  }

  return '<!doctype html>\n' + root.outerHTML;
})();
