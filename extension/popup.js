// Popup UI for the multi-breakpoint capture extension.
//
// Two top-level modes:
//   - Multi-breakpoint (default): full-page capture at each enabled width via
//     chrome.debugger viewport emulation. Popup stays open and shows progress.
//   - Picker: user clicks one element in the page; only that element + its
//     inlined styles is captured at the current viewport. The popup closes as
//     soon as the user clicks the page, so the background worker takes over
//     and surfaces completion via a desktop notification.

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

// Bumped when the default preset order changes — old saved configs would
// otherwise pin users to the previous order forever.
const STORAGE_KEY = 'capture-config-v3';

const $grid    = document.getElementById('bp-grid');
const $theme   = document.getElementById('theme');
const $settle  = document.getElementById('settle');
const $pick    = document.getElementById('pick');
const $pickHint= document.getElementById('pick-hint');
const $capture = document.getElementById('capture');
const $status  = document.getElementById('status');
const $bpSection = document.querySelector('.bp-section');

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

function getOutputMode() {
  const checked = document.querySelector('input[name="output"]:checked');
  return checked ? checked.value : 'download';
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
    settle: Math.max(0, parseFloat($settle.value) || 0),
    output: getOutputMode(),
    format: getFormat(),
    pick: $pick.checked,
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
      if (typeof saved.settle === 'number') $settle.value = String(saved.settle);
      if (typeof saved.output === 'string') setOutputMode(saved.output);
      if (typeof saved.format === 'string') setFormat(saved.format);
      if (typeof saved.pick === 'boolean') $pick.checked = saved.pick;
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

// Picker mode invalidates the breakpoint grid (single-viewport capture only).
// Grey it out so the user understands the breakpoints won't apply.
function syncPickMode() {
  const on = $pick.checked;
  $pickHint.style.display = on ? 'block' : 'none';
  $bpSection.classList.toggle('disabled', on);
  $capture.textContent = on ? 'Pick element…' : 'Capture';
}

$pick.addEventListener('change', () => { syncPickMode(); persist(); });
$theme.addEventListener('change', persist);
$settle.addEventListener('input', persist);
document.querySelectorAll('input[name="output"]').forEach((r) => r.addEventListener('change', persist));
document.querySelectorAll('input[name="format"]').forEach((r) => r.addEventListener('change', persist));

// The background worker streams progress updates while a multi-breakpoint
// capture is running. Picker mode closes the popup before completion, so it
// uses chrome.notifications instead — those updates won't show up here.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'capture-progress') {
    setStatus(msg.text || '');
  }
});

$capture.addEventListener('click', async () => {
  const cfg = readConfig();
  const enabled = cfg.breakpoints.filter((b) => b.on);

  if (!cfg.pick && !enabled.length) {
    setStatus('Enable at least one breakpoint', 'error');
    return;
  }

  $capture.disabled = true;
  setStatus(cfg.pick ? 'Activating picker…' : 'Starting…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab');
    if (tab.url && /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
      throw new Error('Cannot capture browser-internal pages');
    }

    const payload = {
      type: cfg.pick ? 'start-pick' : 'start-capture',
      tabId: tab.id,
      breakpoints: enabled.map(({ label, w, h }) => ({ label, width: w, height: h })),
      theme: cfg.theme,
      settleMs: Math.round(cfg.settle * 1000),
      output: cfg.output,
      format: cfg.format,
    };

    if (cfg.pick) {
      // Fire-and-forget: as soon as the user clicks on the page to pick an
      // element, this popup closes. The background worker carries the result
      // home via download / clipboard / notification.
      chrome.runtime.sendMessage(payload).catch(() => {});
      setStatus('Picker active — click an element on the page.\n(This popup will close.)');
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
