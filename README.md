# figma-html-importer

Self-hosted HTML → Figma importer. Paste any saved HTML file into the plugin, get editable frames / text / SVG vectors on your canvas. Works with any browser extension that produces a self-contained HTML document (e.g. [SingleFile](https://github.com/gildas-lormeau/SingleFile)).

No accounts. No subscriptions. Lives entirely on your machine.

Ships with a companion **Chrome extension** for multi-breakpoint capture — see [`extension/`](./extension/README.md). It resizes the browser's render viewport per breakpoint (via the DevTools protocol) so JS-driven responsive markup is captured for real, then bundles every capture into a single `.fhtml` file you drop into the Figma plugin.

## Install

```bash
npm install
npm run build
```

## Load the Figma plugin

1. Open the Figma **desktop** app (plugin dev requires desktop, not web).
2. Open any Figma design file.
3. Top menu → **Plugins** → **Development** → **Import plugin from manifest…**
4. Select `plugin/manifest.json` in this repo.
5. The plugin appears under **Plugins** → **Development** → **HTML Importer (Local)**.

## Use it

You have two paths.

### A) Multi-breakpoint capture (recommended for responsive sites)

1. Install the companion Chrome extension — see [`extension/README.md`](./extension/README.md).
2. Open the page in Chrome (logged-in pages work).
3. Click the extension icon, pick your breakpoints, choose **Download** or **Copy to clipboard** as the output, click **Capture**.
4. In Figma, run this plugin. Either drop the `.fhtml` into the plugin window, or paste the clipboard contents into the textarea — the plugin auto-detects the bundle either way. Click **Import** — you get one editable Figma frame per breakpoint, laid out side-by-side.

This path captures the page **after** JS has rendered the right responsive markup at each viewport, so mobile nav vs. desktop nav, conditional hooks, etc. come through correctly.

For capturing a **single component** (a button, a card, etc.) instead of the whole page, tick **Pick element manually** in the extension popup before clicking Capture — you'll get a hover overlay to click the exact element.

### B) Single-source HTML

1. Save the page as a self-contained HTML file using any saver you like ([SingleFile](https://github.com/gildas-lormeau/SingleFile) is recommended — inlines CSS, fonts, and images as data URLs).
2. Open the HTML file in any text editor, select all, copy.
3. In Figma, run the plugin. Paste the HTML into the textarea.
4. Pick the breakpoints you want and click **Import**. The plugin renders the *same* HTML at each viewport, so CSS media queries fire correctly — but any JS-conditional markup is frozen at whatever breakpoint was active when you saved.

For pages with multiple states behind JS toggles, switch to each state in the browser, save, and import each capture separately — each import produces a separate Figma frame.

## What v1 handles

- Block-level layout (position, size)
- Solid fills
- Borders (all-sides, or picks the dominant side if they differ)
- Corner radii (per-corner supported)
- Drop and inner shadows (comma-separated, multiple)
- Opacity, `overflow: hidden` clipping
- Text: font family/weight/style, size, line height, letter spacing, color, alignment, decoration, case. Preserves the browser's actual line breaks so wrapping matches even with font fallbacks.
- Inline `<svg>` icons → editable Figma vectors (resolves `currentColor` against the CSS cascade first)
- `<img>` and CSS `background-image: url(...)` → embedded as image fills (base64 in JSON, capped at 2 MB, downscaled to 2× displayed size)

## Auto Layout (optional)

Tick **Apply Auto Layout (experimental)** in the plugin UI to convert `display: flex` containers into Figma Auto Layout frames on import.

What gets converted:
- Direction (row / column) from `flex-direction`
- `gap` → item spacing
- `padding-*` → frame padding
- `justify-content` → primary-axis alignment (`MIN` / `CENTER` / `MAX` / `SPACE_BETWEEN`)
- `align-items` → cross-axis alignment (`MIN` / `CENTER` / `MAX` / `BASELINE`)
- Children with `flex-grow > 0` → `layoutGrow = 1` (Fill Container)
- Children with `position: absolute | fixed | sticky` → `layoutPositioning = 'ABSOLUTE'` (stay out of AL flow)

What's skipped (falls back to absolute positioning):
- `flex-wrap: wrap` (Figma's wrap support is limited)
- `display: grid` (v1 doesn't try to map grids)

Leave the checkbox off for pixel-faithful absolute positioning.

## Known v1 limitations

- **External resources don't load.** The plugin UI's iframe runs with `srcdoc` and cannot reach the network from Figma's sandbox. Use an HTML saver that inlines fonts/images/CSS as data URLs.
- **JS does not run.** The pasted HTML is rendered statically. Whatever state the page was saved in is what gets imported — toggle states, expanded menus, etc. should be set before saving.
- **Form controls** (radio, checkbox, select) render as placeholder frames — no native control chrome.
- **CSS pseudo-elements** (`::before`, `::after`) are skipped.
- **Inline text runs** like `<strong>` inside `<span>` become separate sibling frames rather than bolded inline runs.
- **Gradients** (linear/radial/conic) are skipped — only the first `url(...)` image or solid color comes through.
- **3D / rotation transforms** are not flattened to raster — the rect is captured but the rotation is lost.

## Rebuilding after changes

```bash
npm run build       # rebuild plugin + UI bundle
npm run typecheck   # no output = clean
```

After rebuilding, Figma picks up changes automatically the next time you run the plugin.

## Sharing it / shipping updates

Designers don't build — they download a pre-packaged zip. To cut a release:

```bash
npm run release v0.2.0            # builds, zips, publishes a GitHub Release
```

This builds `plugin/dist/`, packages a lean install zip (built plugin + extension
+ README + INSTALL.txt, no source or `node_modules`), and attaches it to a GitHub
Release. Share the printed download link — recipients unzip and follow `INSTALL.txt`
(no Node, no terminal). `plugin/dist/` stays gitignored so the repo remains source-only.

## Layout

```
plugin/src/             Figma plugin
  manifest.json         Plugin manifest (editorType: figma)
  ui.html               Plugin UI template (with <!-- CAPTURE_RUNNER_BUNDLE --> placeholder)
  code.ts               Plugin sandbox entry — receives the envelope, builds nodes
  builder.ts            Recursive node creation (page coords → local, applies Auto Layout)
  fonts.ts              Pre-scan + 3-level fallback
  paints.ts             Fills / strokes / shadows conversion
  schema.ts             Shared envelope contract
  capture-runner.ts     UI-iframe entry — paste HTML → hidden iframe → walker → envelope
  walker.ts             Recursive DOM walk + visibility filter
  style.ts              computed CSS → fills / strokes / radius / shadow
  text.ts               Range-based reflowed text extraction
  svg.ts                currentColor resolver
  images.ts             <img> + background-image → base64 data URL
  geometry.ts           page-coord helpers

archive/capture/        Retired bookmarklet-based capture flow (kept for reference)

extension/              Companion Chrome extension — multi-breakpoint capture
  manifest.json         MV3 manifest
  popup.html            Toolbar popup UI
  popup.js              Reads breakpoints / output / pick mode, kicks off capture
  background.js         Service worker — debugger loop, asset fetcher, output routing
  inpage-serializer.js  Injected into the target page; inlines assets
  picker.js             "Pick element" overlay — hover highlight + click to capture
  offscreen.html        Offscreen document for MV3 clipboard writes
```
