import type {
  Color, Paint, Stroke, Shadow, Style, CornerRadius, Layout, LayoutAlign,
} from './schema';

// ── Color parsing ─────────────────────────────────────────────────────────

/** Parse any browser-normalized color string. getComputedStyle always returns
 *  rgb(...) or rgba(...) — never hex/named. So we only need two regexes. */
export function parseColor(cssColor: string): Color | null {
  if (!cssColor || cssColor === 'transparent' || cssColor === 'none') return null;
  // rgba(R, G, B, A)  or  rgb(R G B / A) for modern browsers
  const m = cssColor.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = Number(parts[0]) / 255;
  const g = Number(parts[1]) / 255;
  const b = Number(parts[2]) / 255;
  const a = parts.length >= 4 ? Number(parts[3]) : 1;
  if ([r, g, b, a].some(Number.isNaN)) return null;
  if (a === 0) return null; // fully transparent → treat as no paint
  return { r, g, b, a };
}

// ── Fill & paint ──────────────────────────────────────────────────────────

export function extractFills(cs: CSSStyleDeclaration): Paint[] {
  const fills: Paint[] = [];
  const bg = parseColor(cs.backgroundColor);
  if (bg) fills.push({ type: 'solid', color: bg });
  // Note: background-image handled separately via images.ts so we can fetch.
  return fills;
}

// ── Strokes / borders ─────────────────────────────────────────────────────

/** v1: picks a representative border. If all four sides have identical
 *  color+width+style, emits one 'all'-sided stroke. Otherwise picks the
 *  widest visible side and flags it as that side. Multi-side borders with
 *  different colors fall back to the widest side only. */
export function extractStrokes(cs: CSSStyleDeclaration): Stroke[] {
  const sides: Array<{ side: 'top' | 'right' | 'bottom' | 'left'; w: number; color: Color | null; style: string }> = [
    { side: 'top',    w: parseFloat(cs.borderTopWidth)    || 0, color: parseColor(cs.borderTopColor),    style: cs.borderTopStyle },
    { side: 'right',  w: parseFloat(cs.borderRightWidth)  || 0, color: parseColor(cs.borderRightColor),  style: cs.borderRightStyle },
    { side: 'bottom', w: parseFloat(cs.borderBottomWidth) || 0, color: parseColor(cs.borderBottomColor), style: cs.borderBottomStyle },
    { side: 'left',   w: parseFloat(cs.borderLeftWidth)   || 0, color: parseColor(cs.borderLeftColor),   style: cs.borderLeftStyle },
  ];
  const visible = sides.filter(s => s.w > 0 && s.color && s.style !== 'none' && s.style !== 'hidden');
  if (visible.length === 0) return [];
  // All four identical?
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
  // Pick the widest — Figma v1 plugin API doesn't support per-side strokes on a single frame
  // without `individualStrokeWeights`, which we could set; for v1 keep it simple.
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

/** Parse getComputedStyle('box-shadow') — comma-separated list of
 *  "[inset?] rgb(...) Xpx Ypx Blur [Spread]". */
export function extractShadows(cs: CSSStyleDeclaration): Shadow[] {
  const raw = cs.boxShadow;
  if (!raw || raw === 'none') return [];
  // Split on commas that are not inside rgb(...) parens.
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

export function isClipping(cs: CSSStyleDeclaration): boolean {
  const x = cs.overflowX;
  const y = cs.overflowY;
  return x === 'hidden' || x === 'clip' || y === 'hidden' || y === 'clip';
}

// ── Aggregate ─────────────────────────────────────────────────────────────

// ── Layout (flex / grid) detection ────────────────────────────────────────

function mapAlignItems(v: string): LayoutAlign {
  switch (v) {
    case 'flex-start':
    case 'start':    return 'MIN';
    case 'center':   return 'CENTER';
    case 'flex-end':
    case 'end':      return 'MAX';
    case 'baseline': return 'BASELINE';
    case 'stretch':  return 'MIN'; // Figma AL has no "stretch" align; fill-container on children approximates
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
    case 'space-evenly':   return 'SPACE_BETWEEN'; // approximate
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
  // v1: skip grid — 2D arrangements don't map cleanly to Figma's 1D Auto Layout.
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
  if (isClipping(cs)) style.clipsContent = true;
  return style;
}
