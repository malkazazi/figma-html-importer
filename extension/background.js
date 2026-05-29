// Service worker: drives the capture flows.
//
// Two flows:
//
//   1. Multi-breakpoint capture (start-capture):
//        - Attach chrome.debugger to the tab.
//        - For each breakpoint:
//            Emulation.setDeviceMetricsOverride → wait settle → executeScript
//            the serializer → push result into captures[].
//        - Reset emulation, detach.
//        - Output via download or clipboard (offscreen doc).
//        - Popup is alive throughout; result returns over sendMessage.
//
//   2. Element pick capture (start-pick):
//        - Inject picker.js into the tab.
//        - User clicks an element → picker.js sends pick-result with selector.
//        - executeScript the serializer with that selector → fragment HTML.
//        - Output via download or clipboard.
//        - Popup is dead by now (user clicked the page), so we use
//          chrome.notifications to tell the user it worked.
//
// Cross-origin asset fetching (CORS-bypass) for the in-page serializer is
// also handled here via fetch-asset / fetch-text messages, because
// host_permissions: <all_urls> lets fetch() here ignore page CORS.

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const OFFSCREEN_PATH = 'offscreen.html';

let inFlight = false;

// Set by a `cancel-capture` message; runFullCapture checks it between steps and
// bails out cleanly (detaches, clears emulation) if the user hit Cancel.
let cancelRequested = false;

// Result of the most recent Current-Page capture, held in memory so the popup's
// result screen can deliver it (copy/download) on demand AFTER capture, in the
// chosen format. Overwritten by the next capture.
let heldCapture = null; // { envelope, breakpoints, theme, tabId, host }

// Pending picker session: when start-pick injects picker.js, it stashes the
// resolve fn here so the pick-result / pick-cancel message can complete the
// promise. Only one picker may be active at a time.
let pickerResolver = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'start-capture') {
    cancelRequested = false;
    // Captures and holds the result; delivery happens separately via
    // 'deliver-capture' once the user picks a format on the result screen.
    runFullCapture(msg)
      .then((result) => sendResponse(result))
      .catch((err) => {
        const m = humanizeError(err);
        showToast(msg.tabId, 'error', `Capture failed: ${m}`);
        sendResponse({ ok: false, error: m });
      });
    return true;
  }
  if (msg?.type === 'cancel-capture') {
    cancelRequested = true;
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'deliver-capture') {
    if (!heldCapture) {
      sendResponse({ ok: false, error: 'Nothing to deliver — capture again.' });
      return false;
    }
    const { envelope, breakpoints, theme, tabId } = heldCapture;
    deliver(envelope, breakpoints, theme, msg.output, /* isPick */ false, msg.format)
      .then(({ filename, bytes }) => {
        const count = (envelope.captures || []).length;
        showToast(tabId, 'success', formatSuccessMessage({ count, filename, bytes }, msg.output));
        sendResponse({ ok: true, filename, bytes });
      })
      .catch((err) => sendResponse({ ok: false, error: humanizeError(err) }));
    return true;
  }
  if (msg?.type === 'start-pick') {
    // Fire-and-forget from the popup; we report results via in-page toast.
    runPickCapture(msg).catch((err) => {
      showToast(msg.tabId, 'error', `Capture failed: ${humanizeError(err)}`);
    });
    sendResponse({ ok: true, accepted: true });
    return true;
  }
  if (msg?.type === 'pick-result') {
    if (pickerResolver) { pickerResolver.resolve(msg.selector); pickerResolver = null; }
    return false;
  }
  if (msg?.type === 'pick-cancel') {
    if (pickerResolver) { pickerResolver.reject(new Error('Picker cancelled')); pickerResolver = null; }
    return false;
  }
  if (msg?.type === 'fetch-asset') {
    fetchAsDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((err) => sendResponse({ error: humanizeError(err) }));
    return true;
  }
  if (msg?.type === 'fetch-text') {
    fetchAsText(msg.url)
      .then((text) => sendResponse({ text }))
      .catch((err) => sendResponse({ error: humanizeError(err) }));
    return true;
  }
});

// ---------- multi-breakpoint capture ----------

async function runFullCapture({ tabId, breakpoints, theme, settleMs }) {
  if (inFlight) throw new Error('A capture is already running');
  inFlight = true;
  startBadgeBusy(tabId);

  const target = { tabId };
  let attached = false;
  try {
    progress('Attaching to tab…');
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab?.url || '';
    const pageTitle = tab?.title || '';
    let host = pageUrl;
    try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch {}

    const captures = [];
    for (let i = 0; i < breakpoints.length; i++) {
      if (cancelRequested) return { ok: false, cancelled: true };
      const bp = breakpoints[i];

      // Structured progress so the popup can render "Importing <host> <width>w".
      progress('Importing', { host, width: bp.width, index: i + 1, total: breakpoints.length });
      await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        width: bp.width,
        height: bp.height,
        deviceScaleFactor: 0,
        mobile: bp.width < 600,
      });
      if (theme) {
        await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
      }

      await sleep(Math.max(0, settleMs || 0));

      // Pre-serialization scroll pass: many pages lazy-load content (images,
      // sections below the fold, IntersectionObserver-driven hydration) and
      // many also use `position: sticky` headers/banners that translate as
      // the user scrolls. Walking from top → bottom → top forces those
      // sections to mount AND parks sticky elements at their resting
      // (top-of-page) offsets so getBoundingClientRect captures the right
      // geometry. This is what html.to.design and similar tools do.
      await autoScrollAndReset(tabId);
      // Belt-and-suspenders settle on top of the function's own internal
      // wait. Cheap; eliminates a class of flaky-first-capture bugs.
      await sleep(400);
      if (cancelRequested) return { ok: false, cancelled: true };

      const html = await serialize(tabId, null);
      captures.push({
        label: bp.label,
        width: bp.width,
        height: bp.height,
        theme: theme || null,
        html,
      });
    }

    progress('Resetting emulation…');
    try { await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride'); } catch {}
    if (theme) {
      try { await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', { features: [] }); } catch {}
    }

    const envelope = buildEnvelope(pageUrl, pageTitle, captures);
    // Hold the result in memory; the popup's result screen delivers it
    // (copy/download) in the chosen format via a 'deliver-capture' message.
    heldCapture = { envelope, breakpoints, theme, tabId, host };

    return { ok: true, count: captures.length, host, url: pageUrl };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch {}
    }
    stopBadgeBusy(tabId);
    inFlight = false;
  }
}

// ---------- pick-element capture ----------

async function runPickCapture({ tabId, theme, output, format }) {
  if (inFlight) throw new Error('A capture is already running');
  inFlight = true;

  try {
    // 1. Inject picker; it shows the overlay and waits for a click.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['picker.js'],
      world: 'ISOLATED',
    });

    // 2. Wait for picker.js to send back the selector (or a cancel).
    const selector = await new Promise((resolve, reject) => {
      pickerResolver = { resolve, reject };
    });

    // Element is chosen — show a spinner immediately. Capturing (asset
    // inlining, cross-origin fetches) can take a moment and the popup is gone,
    // so this is the user's only progress signal until the final toast.
    await showSpinner(tabId, 'Capturing element…');
    startBadgeBusy(tabId);

    // 3. Optional theme emulation. For pick mode we don't resize the viewport;
    //    the user already framed the page however they wanted it.
    let target = { tabId };
    let attached = false;
    if (theme) {
      await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
      attached = true;
      await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      });
      // Brief settle for any color-scheme-driven rerender.
      await sleep(400);
    }

    try {
      // 4. Grab the picked element's bounding rect BEFORE serialize, because
      //    the serializer mutates the DOM (inlines stylesheets, trims to the
      //    picked element) and the rect would change after.
      const [box] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
        },
        args: [selector],
        world: 'ISOLATED',
      });
      const dims = (box && box.result) || { w: 1200, h: 600 };

      // 5. Serialize, scoped to the picked element.
      const html = await serialize(tabId, selector);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const envelope = buildEnvelope(tab?.url || '', tab?.title || '', [{
        label: 'Element',
        width: dims.w,
        height: dims.h,
        theme: theme || null,
        html,
        pickedSelector: selector,
      }]);

      const { filename, bytes } = await deliver(envelope, [{ width: dims.w, label: 'el' }], theme, output, /* pick */ true, format);
      const where = output === 'clipboard' ? 'Copied to clipboard' : `Saved ${filename}`;
      await hideSpinner(tabId);
      showToast(tabId, 'success', `Element captured · ${where} (${formatBytes(bytes)})`);
    } finally {
      if (attached) {
        try { await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', { features: [] }); } catch {}
        try { await chrome.debugger.detach(target); } catch {}
      }
    }
  } finally {
    await hideSpinner(tabId);
    stopBadgeBusy(tabId);
    pickerResolver = null;
    inFlight = false;
  }
}

// ---------- shared helpers ----------

// Scroll the page top → bottom → top to (1) trigger IntersectionObserver-
// driven lazy loads and (2) park sticky elements at their resting offsets
// before the serializer reads geometry.
//
// Design choices, learned the hard way:
//   - No synthetic `resize`/`scroll` event dispatch. They cause sites to
//     re-run layout against the emulated viewport mid-capture, producing
//     geometry that doesn't match the initial settled render and shifting
//     widths on mobile breakpoints.
//   - The bottom→top return uses the SAME chunked scrolling as the down trip.
//     Pages with virtualized lists unmount items as they leave the viewport;
//     re-entering each section on the way back up gives those items time to
//     re-mount so the serializer sees them.
//   - We end with a real settle (~600ms) at y=0. Sticky elements need a
//     paint frame or two to release their translate; SVGs in newly-remounted
//     sections need their first commit.
//   - Skipped entirely if the page already fits in the viewport — nothing
//     to lazy-load and scrolling can knock loose unrelated state.
async function autoScrollAndReset(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const docEl = document.scrollingElement || document.documentElement;
        const viewH = window.innerHeight || 800;
        const totalH = Math.max(
          docEl.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
        );
        // Page already fits — skip to avoid disturbing a clean initial state.
        if (totalH <= viewH + 8) {
          window.scrollTo(0, 0);
          await sleep(150);
          return;
        }

        const stepDown = Math.max(240, Math.floor(viewH * 0.9));
        const stepUp   = Math.max(240, Math.floor(viewH * 0.6));

        // Down trip — chunky, fast. Lazy loaders fire on each section entry.
        let y = 0;
        for (let i = 0; i < 80 && y < totalH; i++) {
          window.scrollTo(0, y);
          await sleep(110);
          y += stepDown;
        }
        window.scrollTo(0, totalH);
        await sleep(220);

        // Up trip — smaller steps, longer pauses. Lets virtualized lists
        // remount items as they re-enter the viewport.
        let yUp = totalH;
        for (let i = 0; i < 120 && yUp > 0; i++) {
          window.scrollTo(0, yUp);
          await sleep(60);
          yUp -= stepUp;
        }
        window.scrollTo(0, 0);
        // Generous final settle: sticky transforms relax, last-mile hydration
        // commits, image decoders finish, fonts settle. Cheap insurance.
        await sleep(600);
      },
      world: 'MAIN',
    });
  } catch (err) {
    // Best-effort. If scroll injection fails (e.g. CSP-locked page), fall
    // through and serialize whatever state the page is in.
    console.warn('autoScrollAndReset failed:', err);
  }
}

async function serialize(tabId, pickedSelector) {
  // executeScript({ files }) doesn't accept `args` — we pass the selector via
  // a one-line pre-script that plants it on window. The serializer reads it
  // and clears it. Both scripts run in the same ISOLATED world, so the global
  // is shared.
  if (pickedSelector) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => { window.__figmaPickedSelector = sel; },
      args: [pickedSelector],
      world: 'ISOLATED',
    });
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['inpage-serializer.js'],
    world: 'ISOLATED',
  });
  if (!result || typeof result.result !== 'string') {
    throw new Error('Serializer returned no HTML');
  }
  return result.result;
}

function buildEnvelope(url, title, captures) {
  return {
    format: 'figma-html-importer/multicapture@1',
    url,
    title,
    capturedAt: Date.now(),
    captures,
  };
}

async function deliver(envelope, breakpoints, theme, output, isPick = false, format = 'fhtml') {
  if (format === 'html') {
    return deliverAsHtml(envelope, theme, output, isPick);
  }
  const json = JSON.stringify(envelope);
  const filename = makeFilename(envelope.url, breakpoints, theme, isPick, 'fhtml');
  if (output === 'clipboard') {
    await copyToClipboard(json);
    return { filename: null, bytes: json.length };
  }
  const dataUrl = await jsonToDataUrl(json);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return { filename, bytes: json.length };
}

// Raw .html output. Multi-breakpoint captures produce one file per breakpoint
// (browsers will trigger one download per call); clipboard copies the first
// capture's HTML only since we can't put multiple files in the clipboard.
async function deliverAsHtml(envelope, theme, output, isPick) {
  const captures = envelope.captures || [];
  if (!captures.length) throw new Error('No captures to save');

  if (output === 'clipboard') {
    const html = captures[0].html || '';
    await copyToClipboard(html);
    return { filename: null, bytes: html.length };
  }

  let lastFilename = '';
  let totalBytes = 0;
  for (const c of captures) {
    const filename = makeFilename(
      envelope.url,
      [{ width: c.width, label: c.label || `${c.width}w` }],
      theme,
      isPick,
      'html',
    );
    const dataUrl = await htmlToDataUrl(c.html || '');
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    lastFilename = filename;
    totalBytes += (c.html || '').length;
  }
  // Summary string for multi-file downloads.
  const summary = captures.length === 1 ? lastFilename : `${captures.length} .html files`;
  return { filename: summary, bytes: totalBytes };
}

async function htmlToDataUrl(html) {
  const bytes = new TextEncoder().encode(html);
  return `data:text/html;base64,${arrayBufferToBase64(bytes.buffer)}`;
}

async function copyToClipboard(text) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'copy-to-clipboard',
    text,
  });
  if (!resp || !resp.ok) {
    throw new Error((resp && resp.error) || 'Clipboard write failed');
  }
}

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['CLIPBOARD'],
      justification: 'Copy capture bundle to clipboard',
    });
  } catch (err) {
    // Race: another caller created it between hasDocument and createDocument.
    if (!String(err.message || '').includes('Only a single offscreen document')) throw err;
  }
}

async function fetchAsDataUrl(url) {
  if (!url || url.startsWith('data:')) return url;
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_ASSET_BYTES) return null;
  const mime = resp.headers.get('content-type')?.split(';')[0].trim() || guessMime(url);
  return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
}

async function fetchAsText(url) {
  if (!url) return '';
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return await resp.text();
}

// ---------- small utils ----------

function progress(text, extra) {
  chrome.runtime.sendMessage({ type: 'capture-progress', text, ...(extra || {}) }).catch(() => {});
}

// Injects a transient toast into the target tab so the user gets feedback
// without needing the popup to be open. Bottom-center, auto-dismissing,
// colored by kind ('success' | 'error' | 'info'). Best-effort: silently no-ops
// if the tab is gone or scripting is disallowed (e.g. chrome:// pages).
async function showToast(tabId, kind, message) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (k, m) => {
        const Z = 2147483647;
        const id = '__figma_capture_toast';
        document.getElementById(id)?.remove();
        const bg = k === 'success' ? '#16a34a' : k === 'error' ? '#dc2626' : '#111827';
        const t = document.createElement('div');
        t.id = id;
        t.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:28px',
          'transform:translateX(-50%) translateY(20px)',
          'background:' + bg,
          'color:#fff',
          'font:13px/1.45 -apple-system,system-ui,Segoe UI,Roboto,sans-serif',
          'padding:12px 18px',
          'border-radius:8px',
          'box-shadow:0 12px 32px rgba(0,0,0,0.28)',
          'z-index:' + Z,
          'max-width:80vw',
          'white-space:pre-wrap',
          'opacity:0',
          'transition:opacity 180ms ease, transform 180ms ease',
          'pointer-events:none',
        ].join(';');
        t.textContent = m;
        document.documentElement.appendChild(t);
        requestAnimationFrame(() => {
          t.style.opacity = '1';
          t.style.transform = 'translateX(-50%) translateY(0)';
        });
        const dur = k === 'error' ? 6500 : 3800;
        setTimeout(() => {
          t.style.opacity = '0';
          t.style.transform = 'translateX(-50%) translateY(20px)';
          setTimeout(() => t.remove(), 220);
        }, dur);
      },
      args: [kind, message],
      world: 'ISOLATED',
    });
  } catch { /* tab closed, navigated, or restricted URL — no toast possible */ }
}

// Persistent in-page progress indicator (indeterminate spinner) for pick mode,
// where the popup is closed and can't show progress. Shown the instant the user
// picks an element and removed right before the final success/error toast.
// Serialize time is unpredictable (asset fetching, network) so a spinner — not
// a countdown or progress bar — is the honest indicator. The serializer strips
// any element with this id from its clone, so it never leaks into the capture.
async function showSpinner(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (m) => {
        const Z = 2147483647;
        const id = '__figma_capture_spinner';
        document.getElementById(id)?.remove();
        const wrap = document.createElement('div');
        wrap.id = id;
        wrap.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:28px',
          'transform:translateX(-50%) translateY(20px)',
          'display:flex', 'align-items:center', 'gap:10px',
          'background:#111827', 'color:#fff',
          'font:13px/1.45 -apple-system,system-ui,Segoe UI,Roboto,sans-serif',
          'padding:12px 18px', 'border-radius:8px',
          'box-shadow:0 12px 32px rgba(0,0,0,0.28)', 'z-index:' + Z,
          'max-width:80vw', 'pointer-events:none',
          'opacity:0', 'transition:opacity 180ms ease, transform 180ms ease',
        ].join(';');
        const sp = document.createElement('div');
        sp.style.cssText = [
          'width:15px', 'height:15px', 'flex:0 0 auto', 'border-radius:50%',
          'border:2px solid rgba(255,255,255,0.30)', 'border-top-color:#fff',
        ].join(';');
        const txt = document.createElement('span');
        txt.textContent = m;
        wrap.append(sp, txt);
        document.documentElement.appendChild(wrap);
        // Web Animations API — no <style>/@keyframes injection into the page.
        sp.animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
          { duration: 750, iterations: Infinity },
        );
        requestAnimationFrame(() => {
          wrap.style.opacity = '1';
          wrap.style.transform = 'translateX(-50%) translateY(0)';
        });
      },
      args: [message],
      world: 'ISOLATED',
    });
  } catch { /* tab gone or restricted — no spinner possible */ }
}

async function hideSpinner(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { document.getElementById('__figma_capture_spinner')?.remove(); },
      world: 'ISOLATED',
    });
  } catch { /* best effort */ }
}

// Toolbar-icon loading state: while a capture runs we pulse an animated badge
// on the extension icon (cycling dots). The in-flight await chain keeps the
// service worker alive so the interval keeps ticking; we clear it on completion.
let badgeTimer = null;

function startBadgeBusy(tabId) {
  stopBadgeBusy(tabId);
  const frames = ['·', '··', '···'];
  let i = 0;
  chrome.action.setBadgeBackgroundColor({ color: '#18a0fb' }).catch(() => {});
  const tick = () => {
    const text = frames[i++ % frames.length];
    chrome.action.setBadgeText(tabId ? { text, tabId } : { text }).catch(() => {});
  };
  tick();
  badgeTimer = setInterval(tick, 400);
}

function stopBadgeBusy(tabId) {
  if (badgeTimer) { clearInterval(badgeTimer); badgeTimer = null; }
  chrome.action.setBadgeText(tabId ? { text: '', tabId } : { text: '' }).catch(() => {});
}

function formatSuccessMessage(result, output) {
  const sizeNote = result.bytes ? ` (${formatBytes(result.bytes)})` : '';
  const count = result.count || 0;
  const plural = count === 1 ? '' : 's';
  if (output === 'clipboard') {
    return `Copied to clipboard · ${count} capture${plural}${sizeNote}`;
  }
  return `Saved ${result.filename || 'capture'} · ${count} capture${plural}${sizeNote}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function guessMime(url) {
  const ext = (url.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg':  return 'image/svg+xml';
    case 'avif': return 'image/avif';
    case 'woff': return 'font/woff';
    case 'woff2':return 'font/woff2';
    case 'ttf':  return 'font/ttf';
    case 'otf':  return 'font/otf';
    case 'css':  return 'text/css';
    default:     return 'application/octet-stream';
  }
}

async function jsonToDataUrl(jsonString) {
  const bytes = new TextEncoder().encode(jsonString);
  return `data:application/json;base64,${arrayBufferToBase64(bytes.buffer)}`;
}

function makeFilename(url, breakpoints, theme, isPick, ext = 'fhtml') {
  let host = 'capture';
  let pathSlug = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    pathSlug = u.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);
  } catch {}
  const widths = breakpoints.map((b) => `${b.width}w`).join('_');
  const themeTag = theme ? `_${theme}` : '';
  const pickTag = isPick ? '_pick' : '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = [host, pathSlug, widths + themeTag + pickTag, stamp].filter(Boolean).join('_');
  return `${slug}.${ext}`;
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function humanizeError(err) {
  if (!err) return 'Unknown error';
  const m = err.message || String(err);
  if (m.includes('Cannot attach') || m.includes('Another debugger')) {
    return 'Another debugger (DevTools?) is attached to this tab. Close DevTools and try again.';
  }
  return m;
}
