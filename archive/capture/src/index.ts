import type { Envelope, Node } from './schema';
import { CAPTURE_VERSION } from './schema';
import { walkElement } from './walker';

declare global {
  interface Window {
    __captureToFigma?: (selector?: string) => Promise<void>;
    __captureToFigmaNow?: (opts?: CaptureOpts) => Promise<void>;
  }
}

type CaptureOpts = {
  selector?: string;
  scrollThrough?: boolean;
  breakpointLabel?: string;
  breakpointWidth?: number;  // for JSON labeling only — bookmarklets can't resize the window
};

const LAST_OPTS_KEY = '__figma_capture_last_opts';

// ═══════════════════════════ Pre-capture panel ═══════════════════════════

type Preset = { label: string; width: number; height: number };
const PRESETS: Preset[] = [
  { label: 'Mobile',  width: 375,  height: 812  },
  { label: 'Tablet',  width: 768,  height: 1024 },
  { label: 'Laptop',  width: 1200, height: 800  },
  { label: 'Desktop', width: 1440, height: 900  },
  { label: 'Wide',    width: 1920, height: 1080 },
];

function loadLastOpts(): Partial<CaptureOpts> {
  try {
    const raw = localStorage.getItem(LAST_OPTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveLastOpts(opts: Partial<CaptureOpts>): void {
  try { localStorage.setItem(LAST_OPTS_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
}

function showPanel(): void {
  document.querySelectorAll('[data-figma-capture-ui]').forEach(n => n.remove());

  const last = loadLastOpts();
  const overlay = document.createElement('div');
  overlay.setAttribute('data-figma-capture-ui', '1');
  overlay.setAttribute('style', `
    position:fixed;inset:0;z-index:2147483646;
    background:rgba(10,10,12,0.55);backdrop-filter:blur(4px);
    display:flex;align-items:center;justify-content:center;
    font:13px/1.4 -apple-system,system-ui,sans-serif;color:#111;
  `);

  const panel = document.createElement('div');
  panel.setAttribute('style', `
    width:460px;max-width:94vw;background:#fff;border-radius:14px;padding:18px;
    box-shadow:0 24px 60px rgba(0,0,0,0.35);
  `);

  const currentW = window.innerWidth;
  const currentH = window.innerHeight;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <div style="font-weight:600;font-size:14px;">Capture to Figma</div>
      <button data-close style="background:transparent;border:none;font-size:18px;color:#888;cursor:pointer;padding:2px 8px;line-height:1;">✕</button>
    </div>

    <div style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#666;margin-bottom:6px;">Capture at breakpoint</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;" id="__fc_bp_grid"></div>

    <div style="border-top:1px solid #eee;padding-top:14px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#666;margin-bottom:6px;">Or capture current viewport</div>
      <input id="__fc_label" type="text" placeholder="Custom label (optional)" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font:inherit;outline:none;margin-bottom:10px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:12px;user-select:none;font-size:12px;">
        <input type="checkbox" id="__fc_scroll" ${last.scrollThrough === false ? '' : 'checked'}>
        <span>Scroll through page to trigger lazy loads</span>
      </label>
      <div style="display:flex;gap:8px;">
        <button id="__fc_capture_here" style="flex:1;padding:10px 14px;background:#111827;color:#fff;border:none;border-radius:8px;font:600 13px/1 -apple-system,system-ui,sans-serif;cursor:pointer;">
          Capture current (${currentW} × ${currentH})
        </button>
      </div>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Breakpoint preset tiles — clicking one opens the iframe preview.
  const bpGrid = panel.querySelector('#__fc_bp_grid') as HTMLElement;
  for (const p of PRESETS) {
    const card = document.createElement('button');
    card.setAttribute('style', `
      display:flex;flex-direction:column;align-items:flex-start;gap:2px;
      padding:10px 12px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;
      cursor:pointer;text-align:left;transition:border-color .12s, background .12s;
      font:inherit;
    `);
    card.innerHTML = `
      <span style="font-weight:600;font-size:12.5px;color:#111;">${p.label}</span>
      <span style="font-size:11.5px;color:#777;">${p.width} × ${p.height}</span>
    `;
    card.onmouseenter = () => { card.style.borderColor = '#16a34a'; card.style.background = '#f0fdf4'; };
    card.onmouseleave = () => { card.style.borderColor = '#e4e4e7'; card.style.background = '#fff'; };
    card.onclick = () => {
      overlay.remove();
      openIframePreview(p.label, p.width, p.height).catch(err => {
        console.error('[figma-capture] iframe flow failed:', err);
        showToast(`Iframe capture failed: ${err instanceof Error ? err.message : err}`, 'error');
      });
    };
    bpGrid.appendChild(card);
  }

  const close = () => overlay.remove();
  (panel.querySelector('[data-close]') as HTMLElement).onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const labelInput = panel.querySelector('#__fc_label') as HTMLInputElement;
  (panel.querySelector('#__fc_capture_here') as HTMLElement).onclick = () => {
    const scrollThrough = (panel.querySelector('#__fc_scroll') as HTMLInputElement).checked;
    const finalLabel = labelInput.value.trim();
    close();
    const opts: CaptureOpts = {
      scrollThrough,
      breakpointLabel: finalLabel || undefined,
      breakpointWidth: currentW,
    };
    saveLastOpts(opts);
    captureNow(opts).catch(err => {
      console.error('[figma-capture] failed:', err);
      showToast('Capture failed — see console', 'error');
    });
  };
}

// ═══════════════════════════ Iframe-at-breakpoint flow ═══════════════════════════

async function openIframePreview(label: string, targetW: number, targetH: number): Promise<void> {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-figma-capture-ui', '1');

  // Compute a scale-down so the iframe fits the screen while keeping its
  // content laid out at the true target width.
  const margin = 80;
  const availW = window.innerWidth - margin;
  const availH = window.innerHeight - margin - 60; // leave room for header/actions
  const scale = Math.min(1, availW / targetW, availH / targetH);
  const scaledW = Math.round(targetW * scale);
  const scaledH = Math.round(targetH * scale);

  overlay.setAttribute('style', `
    position:fixed;inset:0;z-index:2147483646;
    background:rgba(10,10,12,0.8);backdrop-filter:blur(4px);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    font:13px/1.4 -apple-system,system-ui,sans-serif;color:#fff;
  `);

  overlay.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="font-weight:600;font-size:14px;">${label} · ${targetW} × ${targetH}px${scale < 1 ? ` (displayed at ${Math.round(scale*100)}%)` : ''}</div>
      <span id="__fc_load_status" style="font-size:12px;color:#a1a1aa;">Loading…</span>
    </div>
    <div style="width:${scaledW}px;height:${scaledH}px;box-shadow:0 24px 60px rgba(0,0,0,0.5);border-radius:8px;overflow:hidden;background:#fff;">
      <div style="width:${targetW}px;height:${targetH}px;transform:scale(${scale});transform-origin:0 0;">
        <iframe id="__fc_iframe" src="${location.href}" style="width:${targetW}px;height:${targetH}px;border:none;display:block;"></iframe>
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <button id="__fc_iframe_capture" disabled style="padding:10px 18px;background:#16a34a;color:#fff;border:none;border-radius:8px;font:600 13px/1 inherit;cursor:pointer;opacity:.5;">
        Capture this preview
      </button>
      <button id="__fc_iframe_cancel" style="padding:10px 18px;background:rgba(255,255,255,0.14);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:8px;font:600 13px/1 inherit;cursor:pointer;">
        Cancel
      </button>
    </div>
    <div style="font-size:11px;color:#a1a1aa;max-width:${scaledW}px;text-align:center;line-height:1.5;">
      The page is loaded fresh in an iframe at ${targetW}px wide, so CSS media queries fire at that breakpoint.
      Interact with it if needed (scroll, click in), then press Capture.
    </div>
  `;

  document.body.appendChild(overlay);

  const iframe = overlay.querySelector('#__fc_iframe') as HTMLIFrameElement;
  const btn    = overlay.querySelector('#__fc_iframe_capture') as HTMLButtonElement;
  const status = overlay.querySelector('#__fc_load_status') as HTMLElement;
  const cancel = overlay.querySelector('#__fc_iframe_cancel') as HTMLButtonElement;
  cancel.onclick = () => overlay.remove();

  // Wait for iframe load (with timeout).
  let loaded = false;
  await new Promise<void>((res) => {
    const done = () => { if (!loaded) { loaded = true; res(); } };
    iframe.addEventListener('load', done, { once: true });
    setTimeout(done, 8000);
  });

  // Verify same-origin access.
  try {
    const _probe = iframe.contentDocument;
    if (!_probe) throw new Error('iframe document not accessible');
  } catch {
    overlay.remove();
    throw new Error(`Cross-origin iframe blocked. ${location.hostname} likely sets X-Frame-Options or a CSP that prevents same-origin framing. Use "Capture current" instead.`);
  }

  status.textContent = 'Ready';
  btn.disabled = false;
  btn.style.opacity = '1';

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Capturing…';
    try {
      await captureFromIframe(iframe, label, targetW, targetH);
    } catch (err) {
      console.error(err);
      showToast('Capture failed — see console', 'error');
    } finally {
      overlay.remove();
    }
  };
}

async function captureFromIframe(iframe: HTMLIFrameElement, label: string, targetW: number, targetH: number): Promise<void> {
  const win = iframe.contentWindow!;
  const doc = iframe.contentDocument!;
  if (!win || !doc) throw new Error('iframe not ready');

  // Run a scroll-preload inside the iframe so lazy content loads.
  await preloadInIframe(win, doc);

  // Walk the iframe's body from our parent context. The walker uses
  // ownerDocument-aware helpers so it produces correct page-coords for
  // elements in the iframe.
  showToast('Capturing iframe…', 'info');
  const t0 = performance.now();
  const root = await walkElement(doc.body);
  if (!root) { showToast('Nothing visible in iframe', 'error'); return; }

  const envelope: Envelope = {
    captureVersion: CAPTURE_VERSION,
    capturedAt: Date.now(),
    url: win.location.href,
    viewport: {
      w: Math.max(doc.documentElement.scrollWidth, targetW),
      h: Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, targetH),
    },
    breakpoint: { label, width: targetW, height: targetH },
    root,
  };

  const json = JSON.stringify(envelope);
  const ms = Math.round(performance.now() - t0);
  const copied = await copyToClipboard(json);
  const nodeCount = countNodes(root);
  const size = `${(json.length/1024).toFixed(0)} KB`;
  const action = { json, slug: slugForUrl(envelope.url, label) };
  if (copied) {
    console.log(`[figma-capture] iframe ${label} · ${nodeCount} nodes, ${json.length} chars (${ms}ms)`);
    showToast(`Copied ${nodeCount} nodes (${size}) · ${label}. Paste into Figma plugin.`, 'success', action);
  } else {
    showToast(`Clipboard blocked. Click Save .json to download (${nodeCount} nodes, ${size}).`, 'error', action);
  }
}

async function preloadInIframe(win: Window, doc: Document): Promise<void> {
  const BUDGET_MS = 2500;
  const start = performance.now();

  const html = doc.documentElement;
  const body = doc.body;

  // Scroll iframe's scrolling root in 4 big jumps.
  const docH = () => Math.max(body.scrollHeight, html.scrollHeight);
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    if (performance.now() - start > BUDGET_MS) break;
    const y = Math.round(docH() * frac);
    html.scrollTop = y;
    body.scrollTop = y;
    await sleep(140);
  }

  // Internal scrollable elements inside the iframe.
  const internal: HTMLElement[] = [];
  const all = doc.querySelectorAll<HTMLElement>('*');
  for (const el of Array.from(all)) {
    const cs = win.getComputedStyle(el);
    const ySc = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight - el.clientHeight > 200;
    if (ySc) internal.push(el);
  }
  for (const el of internal) {
    if (performance.now() - start > BUDGET_MS) break;
    for (const frac of [0.5, 1]) {
      el.scrollTop = Math.round(el.scrollHeight * frac);
      await sleep(90);
    }
  }

  const remaining = Math.max(300, BUDGET_MS - (performance.now() - start));
  await waitForImagesInDoc(doc, Math.min(1500, remaining));

  html.scrollTop = 0;
  body.scrollTop = 0;
  for (const el of internal) el.scrollTop = 0;
  await sleep(80);
}

async function waitForImagesInDoc(doc: Document, timeoutMs: number): Promise<void> {
  const imgs = Array.from(doc.images || []);
  const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0);
  if (!pending.length) return;
  await Promise.race([
    Promise.all(pending.map((img) => new Promise<void>((res) => {
      if (img.complete) return res();
      const done = () => res();
      img.addEventListener('load',  done, { once: true });
      img.addEventListener('error', done, { once: true });
    }))),
    sleep(timeoutMs),
  ]);
}

// ═══════════════════════════ Capture ═══════════════════════════

async function captureNow(opts: CaptureOpts = {}): Promise<void> {
  const selector = opts.selector ?? 'body';
  const rootEl = document.querySelector(selector) as Element | null;
  if (!rootEl) {
    showToast('Capture root not found', 'error');
    return;
  }
  if (opts.scrollThrough !== false) {
    showToast('Loading lazy content...', 'info');
    await preloadFullPage();
  }
  showToast('Capturing...', 'info');
  const t0 = performance.now();
  const root = await walkElement(rootEl);
  if (!root) {
    showToast('Nothing visible to capture', 'error');
    return;
  }
  const envelope: Envelope = {
    captureVersion: CAPTURE_VERSION,
    capturedAt: Date.now(),
    url: location.href,
    viewport: {
      w: Math.max(document.documentElement.scrollWidth, window.innerWidth),
      h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    },
    root,
  };
  if (opts.breakpointLabel || opts.breakpointWidth) {
    envelope.breakpoint = {
      label: opts.breakpointLabel ?? '',
      width: opts.breakpointWidth ?? window.innerWidth,
      height: window.innerHeight,
    };
  }
  const json = JSON.stringify(envelope);
  const ms = Math.round(performance.now() - t0);
  const copied = await copyToClipboard(json);
  const nodeCount = countNodes(root);
  const suffix = envelope.breakpoint?.label ? ` · ${envelope.breakpoint.label}` : '';
  const size = `${(json.length/1024).toFixed(0)} KB`;
  const action = { json, slug: slugForUrl(envelope.url, envelope.breakpoint?.label) };
  if (copied) {
    console.log(`[figma-capture] ${nodeCount} nodes, ${json.length} chars (${ms}ms)${suffix} — copied to clipboard`);
    showToast(`Copied ${nodeCount} nodes (${size})${suffix}. Paste into Figma plugin.`, 'success', action);
  } else {
    console.warn(`[figma-capture] ${nodeCount} nodes (${ms}ms)${suffix} — clipboard blocked, use Save .json`);
    showToast(`Clipboard blocked. Click Save .json to download (${nodeCount} nodes, ${size}).`, 'error', action);
  }
}

window.__captureToFigma = () => { showPanel(); return Promise.resolve(); };
window.__captureToFigmaNow = captureNow;

// Bookmarklet auto-runs: open the panel.
showPanel();

// ═══════════════════════════ Helpers ═══════════════════════════

function countNodes(n: Node): number {
  let c = 1;
  if (n.children) for (const ch of n.children) c += countNodes(ch);
  return c;
}

function slugForUrl(url: string, label?: string): string {
  try {
    const m = url.match(/^[a-z]+:\/\/([^/?#]+)([^?#]*)/i);
    const host = (m?.[1] ?? 'page').replace(/[^a-z0-9]+/gi, '-');
    const pathPart = (m?.[2] ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    const lbl = (label ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return [host, pathPart, lbl, ts].filter(Boolean).join('_');
  } catch {
    return `capture-${Date.now()}`;
  }
}

// ── Full-page scroll loader ───────────────────────────────────────────────
// Scrolls the window AND every internal scrollable container, so "app shell"
// layouts (sticky sidebar + overflow-y:auto main) also get triggered.

function findScrollContainers(): Element[] {
  const out: Element[] = [];
  const all = document.querySelectorAll<HTMLElement>('*');
  for (const el of Array.from(all)) {
    if (el.hasAttribute('data-figma-capture-ui')) continue;
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    const ox = cs.overflowX;
    const ySc = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2;
    const xSc = (ox === 'auto' || ox === 'scroll') && el.scrollWidth  > el.clientWidth  + 2;
    if (ySc || xSc) out.push(el);
  }
  return out;
}

/** Budget-aware page preload: scrolls window + every meaningful scrollable
 *  container to bottom in a handful of big jumps (NOT small steps), with a
 *  hard time cap so long pages don't block the clipboard gesture window. */
async function preloadFullPage(): Promise<void> {
  const BUDGET_MS = 2500;
  const start = performance.now();

  const prevHtmlSb = document.documentElement.style.scrollBehavior;
  const prevBodySb = document.body.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';
  document.body.style.scrollBehavior = 'auto';

  try {
    const containers = findScrollContainers()
      .filter(el => el.scrollHeight - el.clientHeight > 200); // skip tiny scrollers

    // 1. Jump the window through its height in 4 big stops, 150ms each.
    const docH = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      if (performance.now() - start > BUDGET_MS) break;
      const y = Math.round(docH() * frac);
      document.documentElement.scrollTop = y;
      document.body.scrollTop = y;
      await sleep(140);
    }

    // 2. Each internal container — 3 big stops.
    for (const el of containers) {
      if (performance.now() - start > BUDGET_MS) break;
      for (const frac of [0.5, 1]) {
        const y = Math.round(el.scrollHeight * frac);
        el.scrollTop = y;
        await sleep(100);
      }
    }

    // 3. Brief image wait (capped so it can't run forever).
    const remaining = Math.max(300, BUDGET_MS - (performance.now() - start));
    await waitForPendingImages(Math.min(1500, remaining));

    // 4. Reset everything to 0 so sticky/fixed capture at rest.
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (const el of containers) el.scrollTop = 0;
    await sleep(100); // brief layout settle
  } finally {
    document.documentElement.style.scrollBehavior = prevHtmlSb;
    document.body.style.scrollBehavior = prevBodySb;
  }
}

async function waitForPendingImages(timeoutMs: number = 2000): Promise<void> {
  const imgs = Array.from(document.images || []);
  const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0);
  if (!pending.length) return;
  await Promise.race([
    Promise.all(pending.map((img) => new Promise<void>((res) => {
      if (img.complete) return res();
      const done = () => res();
      img.addEventListener('load',  done, { once: true });
      img.addEventListener('error', done, { once: true });
    }))),
    sleep(timeoutMs),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════ Clipboard ═══════════════════════════

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn('navigator.clipboard.writeText failed:', err);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.setAttribute('data-figma-capture-ui', '1');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (err) {
    console.warn('execCommand copy failed:', err);
    return false;
  }
}

// ═══════════════════════════ Toast ═══════════════════════════

type ToastAction = { json: string; slug: string };

function showToast(msg: string, kind: 'info' | 'success' | 'error' = 'info', action?: ToastAction): void {
  const existing = document.getElementById('__figma_capture_toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = '__figma_capture_toast';
  el.setAttribute('data-figma-capture-ui', '1');
  const bg = kind === 'success' ? '#16a34a' : kind === 'error' ? '#dc2626' : '#111827';
  el.setAttribute('style', `
    position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
    background:${bg};color:#fff;padding:12px 14px 12px 18px;border-radius:10px;
    font:500 13px/1.3 -apple-system,system-ui,sans-serif;
    box-shadow:0 12px 32px rgba(0,0,0,.4);z-index:2147483647;
    max-width:min(92vw,640px);display:flex;align-items:center;gap:12px;
  `);
  const label = document.createElement('span');
  label.textContent = msg;
  label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  el.appendChild(label);

  if (action) {
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save .json';
    saveBtn.style.cssText = `
      font:500 12px/1 -apple-system,system-ui,sans-serif;color:#fff;
      background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);
      padding:6px 10px;border-radius:6px;cursor:pointer;flex-shrink:0;
    `;
    saveBtn.onmouseenter = () => saveBtn.style.background = 'rgba(255,255,255,0.25)';
    saveBtn.onmouseleave = () => saveBtn.style.background = 'rgba(255,255,255,0.15)';
    saveBtn.onclick = (ev) => {
      ev.stopPropagation();
      downloadJson(action.json, `${action.slug}.json`);
    };
    el.appendChild(saveBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'dismiss');
  closeBtn.style.cssText = `
    font:500 12px/1 -apple-system,system-ui,sans-serif;color:rgba(255,255,255,0.7);
    background:transparent;border:none;cursor:pointer;padding:4px 6px;flex-shrink:0;
  `;
  closeBtn.onclick = () => el.remove();
  el.appendChild(closeBtn);

  document.body.appendChild(el);
  setTimeout(() => el.remove(), action ? 10000 : 4000);
}

function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.setAttribute('data-figma-capture-ui', '1');
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
}
