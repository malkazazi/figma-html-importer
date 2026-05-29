// Popup UI for the multi-breakpoint capture extension.
//
// Two-step wizard:
//   Step 1 — what to capture: pick "Entire page" (multi-breakpoint) or
//            "Select an element", and edit the breakpoint list.
//   Step 2 — output options: theme, clipboard vs download, .fhtml vs .html.
//
// Two capture modes (chosen in step 1):
//   - Entire page (default): full-page capture at each enabled width via
//     chrome.debugger viewport emulation. Popup stays open and shows progress.
//   - Select an element: user clicks one element in the page; only that element
//     + its inlined styles is captured at the current viewport. The popup
//     closes the instant the picker activates, so the user's first click on the
//     page lands on the element (not on dismissing the popup), and the
//     background worker surfaces completion via an in-page toast.

// Presets are captured in the order listed below — largest viewport first, so
// any JS-driven responsive markup settles on the desktop layout before we
// shrink down. Capturing mobile-first sometimes left lazy-loaded desktop
// chrome unrendered when we later scaled back up.
const PRESETS = [
  { label: 'Desktop', w: 1920, h: 1080, on: false },
  { label: 'Laptop',  w: 1280, h: 800,  on: true },
  { label: 'Tablet',  w: 768,  h: 1024, on: true },
  { label: 'Mobile',  w: 375,  h: 812,  on: true },
];

// Fixed page-settle time (ms) before serializing each breakpoint. Previously
// user-configurable; now hidden and pinned at a sensible default.
const SETTLE_MS = 1000;

// Bumped when the persisted config shape changes — v4 drops `settle`, replaces
// the `pick` boolean with a `mode` string.
const STORAGE_KEY = 'capture-config-v4';

const $grid     = document.getElementById('bp-grid');
const $theme    = document.getElementById('theme');
const $pickHint = document.getElementById('pick-hint');
const $capture  = document.getElementById('capture');
const $next     = document.getElementById('next');
const $back     = document.getElementById('back');
const $status   = document.getElementById('status');
const $bpSection= document.querySelector('.bp-section');
const $panel1   = document.getElementById('panel-1');
const $panel2   = document.getElementById('panel-2');
const $ind1     = document.getElementById('step-ind-1');
const $ind2     = document.getElementById('step-ind-2');

/** @type {Array<{ on: HTMLInputElement, label: HTMLInputElement, w: HTMLInputElement, h: HTMLInputElement }>} */
const rowEls = [];

function buildGrid(presets) {
  $grid.innerHTML = '';
  rowEls.length = 0;
  presets.forEach((p) => {
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = !!p.on;

    const label = document.createElement('input');
    label.type = 'text';
    label.value = p.label;

    const w = document.createElement('input');
    w.type = 'number'; w.value = String(p.w); w.min = '320'; w.max = '3840';

    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×';

    const h = document.createElement('input');
    h.type = 'number'; h.value = String(p.h); h.min = '240'; h.max = '3840';

    $grid.append(on, label, w, x, h);

    const sync = () => {
      const enabled = on.checked;
      [label, w, h, x].forEach((el) => (el.style.opacity = enabled ? '1' : '.45'));
    };
    on.addEventListener('change', () => { sync(); persist(); });
    [label, w, h].forEach((el) => el.addEventListener('input', persist));
    sync();

    rowEls.push({ on, label, w, h });
  });
}

function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'full';
}

function setMode(value) {
  const target = document.querySelector(`input[name="mode"][value="${value}"]`);
  if (target) target.checked = true;
}

function getOutputMode() {
  const checked = document.querySelector('input[name="output"]:checked');
  return checked ? checked.value : 'clipboard';
}

function setOutputMode(value) {
  const target = document.querySelector(`input[name="output"][value="${value}"]`);
  if (target) target.checked = true;
}

function getFormat() {
  const checked = document.querySelector('input[name="format"]:checked');
  return checked ? checked.value : 'fhtml';
}

function setFormat(value) {
  const target = document.querySelector(`input[name="format"][value="${value}"]`);
  if (target) target.checked = true;
}

function readConfig() {
  return {
    breakpoints: rowEls.map((r) => ({
      on: r.on.checked,
      label: r.label.value.trim() || 'BP',
      w: Math.max(320, parseInt(r.w.value, 10) || 0),
      h: Math.max(240, parseInt(r.h.value, 10) || 0),
    })),
    theme: $theme.value,
    output: getOutputMode(),
    format: getFormat(),
    mode: getMode(),
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
      if (typeof saved.theme === 'string') $theme.value = saved.theme;
      if (typeof saved.output === 'string') setOutputMode(saved.output);
      if (typeof saved.format === 'string') setFormat(saved.format);
      if (typeof saved.mode === 'string') setMode(saved.mode);
      syncPickMode();
      return;
    }
  } catch {}
  buildGrid(PRESETS);
  syncPickMode();
}

function setStatus(text, kind) {
  $status.textContent = text;
  $status.className = 'status' + (kind ? ' ' + kind : '');
}

// "Select an element" mode invalidates the breakpoint grid (single-viewport
// capture only). Grey it out so the user understands it won't apply, and
// relabel the action button.
function syncPickMode() {
  const pick = getMode() === 'pick';
  $pickHint.style.display = pick ? 'block' : 'none';
  $bpSection.classList.toggle('disabled', pick);
  $capture.textContent = pick ? 'Pick element…' : 'Capture';
}

// ---------- step navigation ----------

function showStep(n) {
  const oneActive = n === 1;
  $panel1.style.display = oneActive ? 'block' : 'none';
  $panel2.style.display = oneActive ? 'none' : 'block';
  $ind1.className = 'step ' + (oneActive ? 'active' : 'done');
  $ind2.className = 'step ' + (oneActive ? '' : 'active');
  setStatus('');
}

$next.addEventListener('click', () => {
  // Validate step 1 before advancing: full-page mode needs ≥1 breakpoint.
  if (getMode() === 'full') {
    const anyOn = rowEls.some((r) => r.on.checked);
    if (!anyOn) { setStatus('Enable at least one breakpoint', 'error'); return; }
  }
  showStep(2);
});

$back.addEventListener('click', () => showStep(1));

document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', () => { syncPickMode(); persist(); }));
$theme.addEventListener('change', persist);
document.querySelectorAll('input[name="output"]').forEach((r) => r.addEventListener('change', persist));
document.querySelectorAll('input[name="format"]').forEach((r) => r.addEventListener('change', persist));

// The background worker streams progress updates while a full-page capture is
// running. Pick mode closes the popup before completion, so it uses an in-page
// toast instead — those updates won't show up here.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'capture-progress') {
    setStatus(msg.text || '');
  }
});

$capture.addEventListener('click', async () => {
  const cfg = readConfig();
  const enabled = cfg.breakpoints.filter((b) => b.on);
  const pick = cfg.mode === 'pick';

  if (!pick && !enabled.length) {
    setStatus('Enable at least one breakpoint', 'error');
    return;
  }

  $capture.disabled = true;
  setStatus(pick ? 'Activating picker…' : 'Starting…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab');
    if (tab.url && /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
      throw new Error('Cannot capture browser-internal pages');
    }

    const payload = {
      type: pick ? 'start-pick' : 'start-capture',
      tabId: tab.id,
      breakpoints: enabled.map(({ label, w, h }) => ({ label, width: w, height: h })),
      theme: cfg.theme,
      settleMs: SETTLE_MS,
      output: cfg.output,
      format: cfg.format,
    };

    if (pick) {
      // Hand off to the background worker, then close the popup IMMEDIATELY.
      // If the popup stays open, the user's first click on the page only
      // dismisses the popup (Chrome swallows that click) and they'd have to
      // click a second time to actually pick. Closing now means the very first
      // click lands on the element. We await the send so the message is
      // delivered before this context is torn down.
      await chrome.runtime.sendMessage(payload).catch(() => {});
      window.close();
      return;
    }

    const result = await chrome.runtime.sendMessage(payload);
    if (!result || !result.ok) throw new Error((result && result.error) || 'Capture failed');

    const sizeNote = result.bytes ? `, ${formatBytes(result.bytes)}` : '';
    const where = cfg.output === 'clipboard'
      ? `Copied to clipboard (${result.count} breakpoint${result.count > 1 ? 's' : ''}${sizeNote})`
      : `Saved ${result.filename}\n(${result.count} breakpoint${result.count > 1 ? 's' : ''}${sizeNote})`;
    setStatus(where, 'success');
  } catch (err) {
    setStatus(err && err.message ? err.message : String(err), 'error');
  } finally {
    $capture.disabled = false;
  }
});

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

restore();
showStep(1);
