// In-page element picker. Injected via chrome.scripting.executeScript when the
// popup checks "Pick element". Shows a hover overlay, lets the user click an
// element, then reports a CSS selector back to the background worker.
//
// Cleans up after itself on click or Esc. Sets a global flag so a re-injection
// (e.g. user clicks the extension icon again while a picker is already live)
// is a no-op.

(() => {
  if (window.__figmaPickerActive) return;
  window.__figmaPickerActive = true;

  const Z = 2147483647;

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    box-sizing: border-box;
    border: 2px solid #18a0fb;
    background: rgba(24,160,251,0.08);
    z-index: ${Z};
    transition: all 60ms ease-out;
    left: 0; top: 0; width: 0; height: 0;
  `;

  const label = document.createElement('div');
  label.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: #18a0fb;
    color: #fff;
    font: 11px/1.3 -apple-system, system-ui, sans-serif;
    padding: 3px 7px;
    border-radius: 4px;
    z-index: ${Z};
    white-space: nowrap;
    max-width: 60vw;
    overflow: hidden;
    text-overflow: ellipsis;
  `;

  const banner = document.createElement('div');
  banner.style.cssText = `
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    background: #111827;
    color: #fff;
    font: 12px/1.4 -apple-system, system-ui, sans-serif;
    padding: 9px 16px;
    border-radius: 6px;
    z-index: ${Z};
    pointer-events: none;
    box-shadow: 0 6px 20px rgba(0,0,0,0.25);
  `;
  banner.textContent = 'Click an element to capture · Esc to cancel';

  // Attach to <html> rather than <body> — some sites have body styles that
  // would inherit into our overlay (transforms, filters), and <html> is the
  // most neutral parent.
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(label);
  document.documentElement.appendChild(banner);

  let lastTarget = null;

  function onMove(e) {
    // Our overlay has pointer-events: none, so elementFromPoint hits the page.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === lastTarget) return;
    if (el === overlay || el === label || el === banner) return;
    lastTarget = el;
    const r = el.getBoundingClientRect();
    overlay.style.left   = r.left   + 'px';
    overlay.style.top    = r.top    + 'px';
    overlay.style.width  = r.width  + 'px';
    overlay.style.height = r.height + 'px';

    const cls = (typeof el.className === 'string' ? el.className : '')
      .split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
    const idPart = el.id ? '#' + el.id : '';
    label.textContent = `<${el.tagName.toLowerCase()}${idPart}${cls}>  ${Math.round(r.width)}×${Math.round(r.height)}`;
    const top = Math.max(0, r.top - 22);
    label.style.left = r.left + 'px';
    label.style.top  = top + 'px';
  }

  // Fire on mousedown (capture phase), not click: this selects on the first
  // press, so a single interaction grabs the element instantly. We then swallow
  // the trailing click/mouseup so the page doesn't act on it (follow a link,
  // submit a form, etc.) now that the picker is gone.
  function onDown(e) {
    if (e.button !== 0) return; // left button only
    e.preventDefault();
    e.stopPropagation();
    // elementFromPoint is authoritative even if the mouse never moved (our
    // overlay/label/banner are pointer-events:none, so they're skipped).
    const el = document.elementFromPoint(e.clientX, e.clientY) || lastTarget || e.target;
    const selector = buildSelector(el);
    cleanup();

    const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, true), 500);

    chrome.runtime.sendMessage({ type: 'pick-result', selector });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      cleanup();
      chrome.runtime.sendMessage({ type: 'pick-cancel' });
    }
  }

  function cleanup() {
    window.__figmaPickerActive = false;
    overlay.remove();
    label.remove();
    banner.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }

  // Build a CSS selector path from the element up to <body>. Prefer ID anchors
  // (stable, unique) when present; fall back to tag + nth-of-type otherwise.
  function buildSelector(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
        parts.unshift(part + '#' + el.id);
        break;
      }
      let nth = 1, sib = el.previousElementSibling;
      while (sib) { if (sib.tagName === el.tagName) nth++; sib = sib.previousElementSibling; }
      part += `:nth-of-type(${nth})`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
})();
