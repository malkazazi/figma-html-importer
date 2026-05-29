import type {
  Color, Paint, Stroke, Shadow, Style, CornerRadius, Layout, LayoutAlign,
} from './schema';

// ── Color parsing ─────────────────────────────────────────────────────────

function parseRgbString(rgb: string): Color | null {
  const m = rgb.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = Number(parts[0]) / 255;
  const g = Number(parts[1]) / 255;
  const b = Number(parts[2]) / 255;
  const a = parts.length >= 4 ? Number(parts[3]) : 1;
  if ([r, g, b, a].some(Number.isNaN)) return null;
  if (a === 0) return null;
  return { r, g, b, a };
}

function parseHexString(hex: string): Color | null {
  const m = hex.match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  if (a === 0) return null;
  return { r, g, b, a };
}

// Canvas color resolver: setting `fillStyle` to any valid CSS color and
// reading it back returns the browser's sRGB-normalized form (`#rrggbb` or
// `rgba(...)`). Setting an invalid value leaves `fillStyle` unchanged, so we
// stash a known sentinel first to detect that case.
let _resolverCtx: CanvasRenderingContext2D | null | undefined;
function getResolverCtx(): CanvasRenderingContext2D | null {
  if (_resolverCtx !== undefined) return _resolverCtx;
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    _resolverCtx = c.getContext('2d');
  } catch { _resolverCtx = null; }
  return _resolverCtx!;
}

function tryCanvasResolve(cssColor: string): Color | null {
  const ctx = getResolverCtx();
  if (!ctx) return null;
  ctx.fillStyle = '#010203';
  try { ctx.fillStyle = cssColor; } catch { return null; }
  const resolved = ctx.fillStyle as string;
  if (resolved === '#010203') return null;
  if (resolved.startsWith('#')) return parseHexString(resolved);
  return parseRgbString(resolved);
}

// ── Manual fallbacks for modern color functions ───────────────────────────
// Tailwind v4 emits `color-mix(in oklab, <c> <pct>%, transparent)` for any
// color/<alpha> utility (e.g. `text-white/70`). `getComputedStyle` preserves
// this function unchanged, and older Chromium canvas builds reject it
// outright — leaving us with a null parse and a fallback to opaque black on
// the text. So we manually parse the common shapes.

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function oklabToSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return {
    r: clamp01(linearToSrgb(lr)),
    g: clamp01(linearToSrgb(lg)),
    b: clamp01(linearToSrgb(lb)),
  };
}

/** Parse the contents of a CSS color-function (the part inside the
 *  parentheses), respecting nested parens so `color-mix(in oklab, ...)`
 *  arguments don't get split mid-call. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

/** Split a color-mix component like `white 70%` or `oklch(0.7 0.1 200) 30%`
 *  into the color string and (optional) percentage. */
function splitMixComponent(comp: string): { color: string; pct: number | null } {
  // Strip trailing percentage if present (allow whitespace).
  const m = comp.match(/^(.*?)\s+([\d.]+)%\s*$/);
  if (m) return { color: m[1].trim(), pct: parseFloat(m[2]) };
  return { color: comp.trim(), pct: null };
}

function parseNumber(tok: string): number {
  if (tok.endsWith('%')) return parseFloat(tok) / 100;
  return parseFloat(tok);
}

/** oklch(L C H [/ A]) → sRGB. L can be `0..1` or `0%..100%`. C is `0..0.4`-ish
 *  (or 0..100% mapped to 0..0.4). H is degrees. */
function parseOklch(args: string): Color | null {
  // Split off alpha after `/`.
  let main = args;
  let alpha = 1;
  const slash = args.indexOf('/');
  if (slash >= 0) {
    main = args.slice(0, slash).trim();
    const aTok = args.slice(slash + 1).trim();
    alpha = parseNumber(aTok);
    if (Number.isNaN(alpha)) alpha = 1;
  }
  const parts = main.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  let L = parseNumber(parts[0]);
  let C = parts[1].endsWith('%') ? parseFloat(parts[1]) / 100 * 0.4 : parseFloat(parts[1]);
  const H = parseFloat(parts[2]);
  if ([L, C, H, alpha].some(Number.isNaN)) return null;
  if (parts[0].endsWith('%')) L = L; // already 0..1
  const h = H * Math.PI / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const rgb = oklabToSrgb(L, a, b);
  if (alpha === 0) return null;
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha };
}

function parseOklab(args: string): Color | null {
  let main = args;
  let alpha = 1;
  const slash = args.indexOf('/');
  if (slash >= 0) {
    main = args.slice(0, slash).trim();
    alpha = parseNumber(args.slice(slash + 1).trim());
    if (Number.isNaN(alpha)) alpha = 1;
  }
  const parts = main.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const L = parseNumber(parts[0]);
  const a = parts[1].endsWith('%') ? parseFloat(parts[1]) / 100 * 0.4 : parseFloat(parts[1]);
  const b = parts[2].endsWith('%') ? parseFloat(parts[2]) / 100 * 0.4 : parseFloat(parts[2]);
  if ([L, a, b, alpha].some(Number.isNaN)) return null;
  if (alpha === 0) return null;
  const rgb = oklabToSrgb(L, a, b);
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha };
}

/** color-mix(in <space>, <c1> [<pct1>%], <c2> [<pct2>%]).
 *  We mix linearly in sRGB. That's not colorimetrically faithful for oklab
 *  (where Tailwind does the mix), but the dominant use is
 *  `color-mix(in oklab, <color> <pct>%, transparent)` — i.e. alpha scaling
 *  with one transparent endpoint — and that case is exact regardless of
 *  space because oklab+transparent collapses to "scale alpha by pct". */
function parseColorMix(args: string): Color | null {
  const parts = splitArgs(args);
  if (parts.length !== 3) return null;
  // parts[0] is `in <space> [<hue interpolation>]` — we ignore it.
  const c1 = splitMixComponent(parts[1]);
  const c2 = splitMixComponent(parts[2]);
  const isTransparent = (s: string) => s === 'transparent' || s === 'none';

  // Resolve percentages: per the CSS spec, missing percentages default so the
  // two sum to 100% (one specified → other = 100 - it; both missing → 50/50;
  // both specified but don't sum to 100 → normalized).
  let p1: number;
  let p2: number;
  if (c1.pct == null && c2.pct == null) { p1 = 50; p2 = 50; }
  else if (c1.pct == null) { p2 = c2.pct as number; p1 = 100 - p2; }
  else if (c2.pct == null) { p1 = c1.pct as number; p2 = 100 - p1; }
  else { p1 = c1.pct; p2 = c2.pct; }
  const sum = p1 + p2;
  if (sum <= 0) return null;
  if (sum !== 100) { p1 = (p1 / sum) * 100; p2 = (p2 / sum) * 100; }

  // Fast/exact path: one side is `transparent` → result is the other color
  // with alpha scaled by its percentage.
  if (isTransparent(c1.color) && !isTransparent(c2.color)) {
    const r = parseColor(c2.color);
    if (!r) return null;
    const a = r.a * (p2 / 100);
    return a > 0 ? { r: r.r, g: r.g, b: r.b, a } : null;
  }
  if (isTransparent(c2.color) && !isTransparent(c1.color)) {
    const r = parseColor(c1.color);
    if (!r) return null;
    const a = r.a * (p1 / 100);
    return a > 0 ? { r: r.r, g: r.g, b: r.b, a } : null;
  }

  // General path: linear sRGB blend (approximate for non-srgb spaces).
  const A = parseColor(c1.color);
  const B = parseColor(c2.color);
  if (!A || !B) return null;
  const t1 = p1 / 100;
  const t2 = p2 / 100;
  const r = A.r * t1 + B.r * t2;
  const g = A.g * t1 + B.g * t2;
  const b = A.b * t1 + B.b * t2;
  const a = A.a * t1 + B.a * t2;
  return a > 0 ? { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) } : null;
}

function matchFn(s: string, name: string): string | null {
  const re = new RegExp(`^${name}\\(([\\s\\S]+)\\)\\s*$`, 'i');
  const m = s.match(re);
  return m ? m[1].trim() : null;
}

/** Parse any browser-normalized color string. `getComputedStyle` returns
 *  `rgb()/rgba()` for legacy color values, but modern functions like
 *  `oklch()`, `oklab()`, and `color-mix()` are preserved as-is in computed
 *  style. We try fast-path rgb, then a `<canvas>` round-trip (handles
 *  everything in Chrome 111+ that supports the function in canvas), then
 *  manual parsers — the last layer matters because older bundled Chromium
 *  builds and some Figma desktop versions reject `color-mix()` in canvas
 *  silently and we'd otherwise fall through to opaque black. */
export function parseColor(cssColor: string): Color | null {
  if (!cssColor) return null;
  const s = cssColor.trim();
  if (!s || s === 'transparent' || s === 'none') return null;
  const direct = parseRgbString(s);
  if (direct) return direct;
  if (s.startsWith('#')) {
    const hex = parseHexString(s);
    if (hex) return hex;
  }
  const canvas = tryCanvasResolve(s);
  if (canvas) return canvas;
  const mixArgs = matchFn(s, 'color-mix');
  if (mixArgs) {
    const mix = parseColorMix(mixArgs);
    if (mix) return mix;
  }
  const oklchArgs = matchFn(s, 'oklch');
  if (oklchArgs) {
    const o = parseOklch(oklchArgs);
    if (o) return o;
  }
  const oklabArgs = matchFn(s, 'oklab');
  if (oklabArgs) {
    const o = parseOklab(oklabArgs);
    if (o) return o;
  }
  return null;
}

// ── Fill & paint ──────────────────────────────────────────────────────────

export function extractFills(cs: CSSStyleDeclaration): Paint[] {
  const fills: Paint[] = [];
  const bg = parseColor(cs.backgroundColor);
  if (bg) fills.push({ type: 'solid', color: bg });
  return fills;
}

// ── Strokes / borders ─────────────────────────────────────────────────────

export function extractStrokes(cs: CSSStyleDeclaration): Stroke[] {
  const sides: Array<{ side: 'top' | 'right' | 'bottom' | 'left'; w: number; color: Color | null; style: string }> = [
    { side: 'top',    w: parseFloat(cs.borderTopWidth)    || 0, color: parseColor(cs.borderTopColor),    style: cs.borderTopStyle },
    { side: 'right',  w: parseFloat(cs.borderRightWidth)  || 0, color: parseColor(cs.borderRightColor),  style: cs.borderRightStyle },
    { side: 'bottom', w: parseFloat(cs.borderBottomWidth) || 0, color: parseColor(cs.borderBottomColor), style: cs.borderBottomStyle },
    { side: 'left',   w: parseFloat(cs.borderLeftWidth)   || 0, color: parseColor(cs.borderLeftColor),   style: cs.borderLeftStyle },
  ];
  const visible = sides.filter(s => s.w > 0 && s.color && s.style !== 'none' && s.style !== 'hidden');
  if (visible.length === 0) return [];
  const first = visible[0];
  const allSame =
    visible.length === 4 &&
    visible.every(s =>
      s.w === first.w &&
      s.color && first.color &&
      s.color.r === first.color.r && s.color.g === first.color.g &&
      s.color.b === first.color.b && s.color.a === first.color.a,
    );
  if (allSame && first.color) {
    return [{ color: first.color, width: first.w, sides: 'all' }];
  }
  const widest = visible.reduce((a, b) => (b.w > a.w ? b : a));
  if (!widest.color) return [];
  return [{ color: widest.color, width: widest.w, sides: widest.side }];
}

// ── Corner radius ─────────────────────────────────────────────────────────

export function extractCornerRadius(cs: CSSStyleDeclaration): CornerRadius | undefined {
  const tl = parseFloat(cs.borderTopLeftRadius)     || 0;
  const tr = parseFloat(cs.borderTopRightRadius)    || 0;
  const br = parseFloat(cs.borderBottomRightRadius) || 0;
  const bl = parseFloat(cs.borderBottomLeftRadius)  || 0;
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) return undefined;
  if (tl === tr && tr === br && br === bl) return tl;
  return [tl, tr, br, bl];
}

// ── Box shadow ────────────────────────────────────────────────────────────

export function extractShadows(cs: CSSStyleDeclaration): Shadow[] {
  const raw = cs.boxShadow;
  if (!raw || raw === 'none') return [];
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      entries.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  entries.push(raw.slice(start).trim());

  const shadows: Shadow[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    const colorMatch = entry.match(/rgba?\([^)]+\)/i);
    if (!colorMatch) continue;
    const color = parseColor(colorMatch[0]);
    if (!color) continue;
    const rest = (entry.slice(0, colorMatch.index!) + entry.slice(colorMatch.index! + colorMatch[0].length)).trim();
    const isInset = /\binset\b/i.test(rest);
    const nums = rest.replace(/\binset\b/i, '').trim().split(/\s+/).map(s => parseFloat(s));
    const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = nums;
    shadows.push({
      type: isInset ? 'inner' : 'drop',
      offsetX, offsetY, blur, spread, color,
    });
  }
  return shadows;
}

// ── Clipping ──────────────────────────────────────────────────────────────

// Only `hidden` and `clip` count as "this element is a mask" — those are the
// cases where the page author wants the visible area to be exactly the box.
//
// `auto` and `scroll` are intentionally NOT treated as clips here, because in
// the browser those elements act as SCROLL VIEWPORTS: their box is the size
// of the visible window, and the user scrolls inside them to reveal more
// content. The most common example is an app-shell main column
// (`<main id="dashboard-scroll" class="overflow-y-auto">`) that owns the
// page's vertical scroll. If we faithfully clipped that in Figma, the
// captured frame would only show the first viewport's worth of content and
// hide everything below — including any tables, lists, or sections the
// designer wants to inspect. Letting auto/scroll containers GROW to fit
// their children means the whole page is visible end-to-end in Figma.
function axisClips(v: string): boolean {
  return v === 'hidden' || v === 'clip';
}

export function isClipping(cs: CSSStyleDeclaration): boolean {
  return axisClips(cs.overflowX) || axisClips(cs.overflowY);
}

export function clipAxes(cs: CSSStyleDeclaration): 'x' | 'y' | 'both' | null {
  const x = axisClips(cs.overflowX);
  const y = axisClips(cs.overflowY);
  if (x && y) return 'both';
  if (x) return 'x';
  if (y) return 'y';
  return null;
}

// ── Layout (flex) ─────────────────────────────────────────────────────────

function mapAlignItems(v: string): LayoutAlign {
  switch (v) {
    case 'flex-start':
    case 'start':    return 'MIN';
    case 'center':   return 'CENTER';
    case 'flex-end':
    case 'end':      return 'MAX';
    case 'baseline': return 'BASELINE';
    case 'stretch':  return 'MIN';
    default:         return 'MIN';
  }
}

function mapJustifyContent(v: string): LayoutAlign {
  switch (v) {
    case 'flex-start':
    case 'start':          return 'MIN';
    case 'center':         return 'CENTER';
    case 'flex-end':
    case 'end':            return 'MAX';
    case 'space-between':  return 'SPACE_BETWEEN';
    case 'space-around':
    case 'space-evenly':   return 'SPACE_BETWEEN';
    default:               return 'MIN';
  }
}

export function extractLayout(cs: CSSStyleDeclaration): Layout | undefined {
  const d = cs.display;
  if (d === 'flex' || d === 'inline-flex') {
    const dir = cs.flexDirection || 'row';
    const isRow = dir === 'row' || dir === 'row-reverse';
    const axisGap = isRow ? cs.columnGap : cs.rowGap;
    const gap = parseFloat(cs.gap) || parseFloat(axisGap) || 0;
    const wrap = cs.flexWrap === 'wrap' || cs.flexWrap === 'wrap-reverse';
    return {
      source: 'flex',
      axis: isRow ? 'horizontal' : 'vertical',
      gap,
      paddingTop:    parseFloat(cs.paddingTop)    || 0,
      paddingRight:  parseFloat(cs.paddingRight)  || 0,
      paddingBottom: parseFloat(cs.paddingBottom) || 0,
      paddingLeft:   parseFloat(cs.paddingLeft)   || 0,
      alignItems: mapAlignItems(cs.alignItems),
      justifyContent: mapJustifyContent(cs.justifyContent),
      wrap,
    };
  }
  return undefined;
}

export function isAbsolutePositioned(cs: CSSStyleDeclaration): boolean {
  return cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky';
}

export function extractFlexGrow(cs: CSSStyleDeclaration): number {
  const v = parseFloat(cs.flexGrow);
  return Number.isNaN(v) ? 0 : v;
}

export function extractStyle(cs: CSSStyleDeclaration): Style {
  const style: Style = {};
  const fills = extractFills(cs);
  if (fills.length) style.fills = fills;
  const strokes = extractStrokes(cs);
  if (strokes.length) style.strokes = strokes;
  const r = extractCornerRadius(cs);
  if (r !== undefined) style.cornerRadius = r;
  const eff = extractShadows(cs);
  if (eff.length) style.effects = eff;
  const opacity = parseFloat(cs.opacity);
  if (!Number.isNaN(opacity) && opacity < 1) style.opacity = opacity;
  const axes = clipAxes(cs);
  if (axes) {
    style.clipsContent = true;
    style.clipAxes = axes;
  }
  return style;
}
