# Figma Multi-Breakpoint Capture (Chrome extension)

Companion extension to the Figma HTML Importer plugin. Captures the **current
tab** at several viewport widths — by actually resizing Chrome's render
viewport via the DevTools protocol — and bundles the results into a single
`.fhtml` file the Figma plugin can ingest.

Why this exists: tools like SingleFile save one HTML snapshot at the current
viewport. Modern responsive sites render *different DOM trees* at different
breakpoints (mobile nav vs. desktop nav, conditional hooks, etc.), so a single
snapshot only covers one breakpoint. This extension reproduces the trick
html.to.design uses: drive `Emulation.setDeviceMetricsOverride` per breakpoint,
let JS re-render, then serialize.

## Install (local, unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. The extension icon appears in the toolbar. Pin it for easier access.

No publishing, no Web Store account, no auto-update — when this folder changes,
click the refresh icon on the extension card.

## Use

The popup opens on a **setup** screen: pick your **Viewports** (the breakpoint
list) on the left and a **Theme** on the right, then choose one of two actions —
**Capture Current Page** or **Capture Selection**.

### Capture Current Page (whole-page, multi-breakpoint)

1. Open the page you want to capture (logged-in pages work — the extension uses
   the active tab's session).
2. Click the extension icon, set your viewports / theme, and click **Capture
   Current Page**. Chrome shows a yellow "is being debugged" banner while it
   runs; this is normal.
3. A progress ring shows "Importing <site> <width>w" as it works. You can
   **Cancel** at any point to abort and return to setup.
4. When it finishes, the **result** screen appears: choose a **format**
   (`.fhtml` bundle — recommended — or raw `.html`) and then **Copy to
   clipboard** or **Download file**. You can do both.
5. In Figma: drop the `.fhtml` into the plugin window, **or** paste the
   clipboard contents into the textarea. The plugin auto-detects the bundle.

### Capture Selection (one element)

When you only want one component (e.g. a button, a card, a navbar):

1. On the setup screen, click **Capture Selection**.
2. On the next screen choose your **format**, then click **Copy to clipboard**
   or **Download file** — that button picks the output and starts the picker.
3. The popup closes and a hover overlay appears on the page. Move the mouse to
   highlight the element you want. **A single click captures it** instantly, or
   press **Esc** to cancel.
4. While capturing, a spinner shows at the bottom of the page and the toolbar
   icon shows an animated badge; the usual success/error toast confirms when
   it's done. (The popup's progress ring is only for Capture Current Page.)
4. The extension serializes only that element's subtree (with full inlined
   CSS / fonts) and delivers it via the same Output mode (download or
   clipboard). A desktop notification confirms success.

The captured element keeps its full ancestor chain (`<html>` → `<body>` →
wrappers → element), so inherited styles still apply, but every sibling at
every level is stripped — only the element you clicked ends up in the bundle.

## What's inside the `.fhtml` bundle

```json
{
  "format": "figma-html-importer/multicapture@1",
  "url": "https://example.com/page",
  "title": "Page title",
  "capturedAt": 1731600000000,
  "captures": [
    { "label": "Mobile", "width": 375, "height": 812, "theme": "light", "html": "<!doctype html>..." },
    { "label": "Tablet", "width": 768, "height": 1024, "theme": "light", "html": "<!doctype html>..." },
    ...
  ]
}
```

Each `html` is a self-contained document — external stylesheets, images,
fonts, and `url()` references in inline styles are inlined as `data:` URLs so
the Figma plugin (which renders in a `srcdoc` iframe with no network) can
fully reproduce the page.

## Known limitations

- **CORS-restricted assets** that block both page CSSOM access and authenticated
  cross-origin fetches will be skipped (the extension does try the worker-side
  fetch with `credentials: 'include'`, which gets most things).
- **Assets larger than 2 MB** are skipped to keep bundle sizes manageable. This
  mirrors the Figma plugin's own image cap.
- **chrome://, about://, and extension pages** cannot be captured — Chrome
  forbids debugger attach on those URLs.
- **Settle time is fixed at 0.1s** per breakpoint (the wait after resizing
  before serializing; a scroll pass + a 400 ms final wait happen on top). It's
  no longer adjustable in the UI; very slow pages may need the value raised in
  `popup.js` (`SETTLE_MS`).
- If **DevTools is already attached** to the tab (you have F12 open),
  `chrome.debugger.attach` fails. Close DevTools first.

## Files

```
extension/
  manifest.json           MV3 manifest
  popup.html              Toolbar popup UI
  popup.js                Reads breakpoints / output / pick mode, kicks off capture
  background.js           Service worker — debugger loop, asset fetcher, output routing
  inpage-serializer.js    Injected into the target page; inlines assets
  picker.js               Injected when "Pick element" is on; hover overlay + click capture
  offscreen.html          Offscreen document — required for clipboard writes in MV3
```
