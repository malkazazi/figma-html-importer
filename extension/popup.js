// Popup UI for the multi-breakpoint capture extension.
//
// Flow (modelled on html.to.design):
//   SETUP  — Viewports + Themes, then two actions:
//            • Capture Current Page  → LOADING → RESULT (choose format + deliver)
//            • Capture Selection     → DELIVER-PICK (choose format/output) →
//                                       popup closes, user clicks an element,
//                                       on-page spinner + toast handle the rest.
//
// Current Page keeps the popup open the whole time, so it shows the loading
// ring and a result screen where delivery (copy/download) is chosen AFTER the
// capture. Selection must close the popup (so the first page click lands on the
// element), so its delivery is chosen up-front on the DELIVER-PICK screen.

const PRESETS = [
  { label: 'Desktop', w: 1920, h: 1080, on: false },
  { label: 'Laptop',  w: 1280, h: 800,  on: true },
  { label: 'Tablet',  w: 768,  h: 1024, on: true },
  { label: 'Mobile',  w: 375,  h: 812,  on: true },
];

// Fixed page-settle time (ms) before serializing each breakpoint. Hidden from
// the UI; raise it here if very slow pages need longer to react to resizes.
const SETTLE_MS = 100;

const STORAGE_KEY = 'capture-config-v5';

// --- tiny inline icon set (stroke: currentColor so they inherit button color) ---
const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  monitor: `<svg width="16" height="16" viewBox="0 0 24 24" ${S}><rect x="2" y="3.5" width="20" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/></svg>`,
  laptop:  `<svg width="16" height="16" viewBox="0 0 24 24" ${S}><rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>`,
  tablet:  `<svg width="16" height="16" viewBox="0 0 24 24" ${S}><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M11 18h2"/></svg>`,
  phone:   `<svg width="16" height="16" viewBox="0 0 24 24" ${S}><rect x="8" y="3" width="8" height="18" rx="2"/><path d="M11 18h2"/></svg>`,
  sun:     `<svg width="16" height="16" viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/></svg>`,
  moon:    `<svg width="16" height="16" viewBox="0 0 24 24" ${S}><path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8z"/></svg>`,
  cam:     `<svg width="20" height="20" viewBox="0 0 24 24" ${S}><rect x="3" y="6.5" width="18" height="13" rx="2"/><path d="M8.5 6.5L10 4h4l1.5 2.5"/><circle cx="12" cy="13" r="3.2"/></svg>`,
  'cam-sel': `<svg width="20" height="20" viewBox="0 0 24 24" ${S}><rect x="2.5" y="5.5" width="19" height="15" rx="2" stroke-dasharray="3 2.4"/><circle cx="12" cy="13" r="3"/></svg>`,
  copy:     `<svg width="18" height="18" viewBox="0 0 24 24" ${S}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>`,
  download: `<svg width="18" height="18" viewBox="0 0 24 24" ${S}><path d="M12 3v11M8 10l4 4 4-4M5 20h14"/></svg>`,
};

function deviceIcon(width) {
  if (width >= 1440) return ICONS.monitor;
  if (width >= 1024) return ICONS.laptop;
  if (width >= 700)  return ICONS.tablet;
  return ICONS.phone;
}

// --- element refs ---
const $grid       = document.getElementById('bp-grid');
const $status     = document.getElementById('status');
const $capFull    = document.getElementById('cap-full');
const $capPick    = document.getElementById('cap-pick');
const $cancel     = document.getElementById('cancel');
const $loadingTxt = document.getElementById('loading-text');
const $doCopy     = document.getElementById('do-copy');
const $doDownload = document.getElementById('do-download');
const $resultBack = document.getElementById('result-back');
const $pickCopy     = document.getElementById('pick-copy');
const $pickDownload = document.getElementById('pick-download');
const $pickBack     = document.getElementById('pick-back');

const PANELS = {
  setup:   document.getElementById('panel-setup'),
  loading: document.getElementById('panel-loading'),
  result:  document.getElementById('panel-result'),
  pick:    document.getElementById('panel-deliver-pick'),
};

/** @type {Array<{ on: HTMLInputElement, label: HTMLInputElement, w: HTMLInputElement, h: HTMLInputElement, icon: HTMLElement }>} */
const rowEls = [];

// --- rendering ---

function renderStaticIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = ICONS[el.getAttribute('data-icon')] || '';
  });
}

function buildGrid(presets) {
  $grid.innerHTML = '';
  rowEls.length = 0;
  presets.forEach((p) => {
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = !!p.on;

    const icon = document.createElement('span');
    icon.className = 'dev';
    icon.innerHTML = deviceIcon(p.w);

    const w = document.createElement('input');
    w.type = 'number'; w.value = String(p.w); w.min = '320'; w.max = '3840';

    const px = document.createElement('span');
    px.className = 'px'; px.textContent = 'px';

    // Only the width is user-editable (like html.to.design). The label and a
    // sensible viewport height are kept as fixed metadata per row — they still
    // drive the emulated viewport + Figma frame names, just aren't shown.
    $grid.append(on, icon, w, px);

    const sync = () => {
      const enabled = on.checked;
      [icon, w, px].forEach((el) => (el.style.opacity = enabled ? '1' : '.45'));
    };
    on.addEventListener('change', () => { sync(); persist(); });
    w.addEventListener('input', () => { icon.innerHTML = deviceIcon(parseInt(w.value, 10) || 0); persist(); });
    sync();

    rowEls.push({ on, w, icon, label: p.label, height: p.h });
  });
}

// --- value getters / setters ---

function getTheme() {
  const c = document.querySelector('input[name="theme"]:checked');
  return c ? c.value : '';
}
function setTheme(v) {
  const t = document.querySelector(`input[name="theme"][value="${v}"]`);
  if (t) t.checked = true;
}
// Format is chosen via two iOS-style segmented controls (one on the result
// screen, one on the selection-delivery screen). They're kept in sync so
// .fhtml/.html is a single remembered preference.
const $segR = document.getElementById('seg-format-r');
const $segP = document.getElementById('seg-format-p');

function segValue(seg) {
  const a = seg && seg.querySelector('.seg-opt.active');
  return a ? a.dataset.val : 'fhtml';
}
function segSet(seg, v) {
  if (!seg) return;
  seg.querySelectorAll('.seg-opt').forEach((b) => b.classList.toggle('active', b.dataset.val === v));
}
function initSeg(seg, onChange) {
  if (!seg) return;
  seg.querySelectorAll('.seg-opt').forEach((btn) =>
    btn.addEventListener('click', () => { segSet(seg, btn.dataset.val); onChange(btn.dataset.val); }));
}
function getFormatR() { return segValue($segR); }
function getFormatP() { return segValue($segP); }
function setFormat(v) { segSet($segR, v); segSet($segP, v); }

// Number of breakpoints in the most recent Current-Page capture, used to warn
// how many separate .html files the raw format would produce.
let lastCaptureCount = 0;

const FHTML_NOTE = 'Use .fhtml to upload to the Figma plugin · .html for raw, editable HTML.';

// Default note explains the choice in one line. Selecting .html turns the
// caption amber and (on the result screen) warns how many files it'll save.
function updateFormatCaption() {
  const isHtml = getFormatR() === 'html'; // both controls are kept in sync
  const capR = document.getElementById('fmt-cap-r');
  const capP = document.getElementById('fmt-cap-p');
  if (capR) {
    const n = lastCaptureCount || enabledBreakpoints().length || 1;
    capR.textContent = isHtml
      ? `Use .html for editing in code (${n} separate file${n === 1 ? '' : 's'}). Use .fhtml for uploading into the Figma plugin (one file).`
      : FHTML_NOTE;
    capR.className = 'seg-cap' + (isHtml ? ' warn' : '');
  }
  if (capP) {
    capP.textContent = isHtml
      ? 'Use .html for editing in code. Use .fhtml for uploading into the Figma plugin.'
      : FHTML_NOTE;
    capP.className = 'seg-cap' + (isHtml ? ' warn' : '');
  }
}
function enabledBreakpoints() {
  return rowEls
    .filter((r) => r.on.checked)
    .map((r) => ({
      label: r.label || 'BP',
      width: Math.max(320, parseInt(r.w.value, 10) || 0),
      height: Math.max(240, r.height || 0),
    }));
}

// --- persistence ---

function readConfig() {
  return {
    breakpoints: rowEls.map((r) => ({
      on: r.on.checked,
      label: r.label || 'BP',
      w: Math.max(320, parseInt(r.w.value, 10) || 0),
      h: r.height || 900,
    })),
    theme: getTheme(),
    format: getFormatR(),
  };
}
function persist() {
  chrome.storage.local.set({ [STORAGE_KEY]: readConfig() }).catch(() => {});
}
async function restore() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const saved = data[STORAGE_KEY];
    if (saved && Array.isArray(saved.breakpoints) && saved.breakpoints.length) {
      buildGrid(saved.breakpoints);
      if (typeof saved.theme === 'string') setTheme(saved.theme);
      if (typeof saved.format === 'string') setFormat(saved.format);
      updateFormatCaption();
      return;
    }
  } catch {}
  buildGrid(PRESETS);
  updateFormatCaption();
}

// --- panel / status helpers ---

function showPanel(name) {
  for (const [key, el] of Object.entries(PANELS)) el.hidden = key !== name;
  setStatus('');
}
function setStatus(text, kind) {
  $status.textContent = text;
  $status.className = 'status' + (kind ? ' ' + kind : '');
}
function setLoading(text) { $loadingTxt.textContent = text; }

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab');
  if (tab.url && /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    throw new Error('Cannot capture browser-internal pages');
  }
  return tab;
}

function errMsg(err) { return err && err.message ? err.message : String(err); }

// --- live progress (Current Page only) ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'capture-progress') {
    if (msg.host && msg.width) setLoading(`Importing ${msg.host} ${msg.width}w`);
    else if (msg.text) setLoading(msg.text);
  }
});

// --- Capture Current Page: capture → result → deliver ---
$capFull.addEventListener('click', async () => {
  const bps = enabledBreakpoints();
  if (!bps.length) { setStatus('Enable at least one viewport', 'error'); return; }

  showPanel('loading');
  setLoading('Capturing…');
  try {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({
      type: 'start-capture',
      tabId: tab.id,
      breakpoints: bps,
      theme: getTheme(),
      settleMs: SETTLE_MS,
    });
    if (result && result.cancelled) { showPanel('setup'); return; }
    if (!result || !result.ok) throw new Error((result && result.error) || 'Capture failed');
    lastCaptureCount = result.count || enabledBreakpoints().length;
    updateFormatCaption();
    showPanel('result');
  } catch (err) {
    showPanel('setup');
    setStatus(errMsg(err), 'error');
  }
});

$cancel.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'cancel-capture' }).catch(() => {});
  setLoading('Cancelling…');
});

async function deliverHeld(output) {
  const format = getFormatR();
  setStatus('Working…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'deliver-capture', output, format });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Delivery failed');
    setStatus(output === 'clipboard'
      ? `Copied to clipboard (${formatBytes(r.bytes)})`
      : `Saved ${r.filename}`, 'success');
  } catch (err) {
    setStatus(errMsg(err), 'error');
  }
}
$doCopy.addEventListener('click', () => deliverHeld('clipboard'));
$doDownload.addEventListener('click', () => deliverHeld('download'));
$resultBack.addEventListener('click', () => showPanel('setup'));

// --- Capture Selection: choose delivery, then pick (popup closes) ---
$capPick.addEventListener('click', () => { updateFormatCaption(); showPanel('pick'); });
$pickBack.addEventListener('click', () => showPanel('setup'));

// Each delivery button both chooses the output AND starts the picker. The popup
// closes immediately so the user's first page click lands on the element.
async function startPick(output) {
  try {
    const tab = await activeTab();
    await chrome.runtime.sendMessage({
      type: 'start-pick',
      tabId: tab.id,
      theme: getTheme(),
      output,
      format: getFormatP(),
    }).catch(() => {});
    window.close();
  } catch (err) {
    setStatus(errMsg(err), 'error');
  }
}
$pickCopy.addEventListener('click', () => startPick('clipboard'));
$pickDownload.addEventListener('click', () => startPick('download'));

// keep both format segmented controls in sync; persist theme/output changes
initSeg($segR, (v) => { segSet($segP, v); persist(); updateFormatCaption(); });
initSeg($segP, (v) => { segSet($segR, v); persist(); updateFormatCaption(); });
document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', persist));

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

renderStaticIcons();
restore();
showPanel('setup');
