import type { TextProps, LineHeight, LetterSpacing, Color, TextAlign, TextCase, TextDecoration } from './schema';
import { parseColor } from './style';

// ── Font family normalization ─────────────────────────────────────────────
export function firstFontFamily(cssFamily: string): string {
  const first = cssFamily.split(',')[0] || 'Inter';
  return first.trim().replace(/^['"]|['"]$/g, '');
}

// ── Font weight/style → Figma style string ────────────────────────────────
const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};

export function mapFontStyle(weight: string, fontStyle: string): string {
  const w = parseInt(weight, 10);
  const base = WEIGHT_NAMES[Math.round(w / 100) * 100] ?? 'Regular';
  const italic = fontStyle === 'italic' || fontStyle === 'oblique';
  if (italic && base === 'Regular') return 'Italic';
  return italic ? `${base} Italic` : base;
}

// ── Line height ───────────────────────────────────────────────────────────
export function parseLineHeight(cssLineHeight: string, _fontSize: number): LineHeight {
  if (cssLineHeight === 'normal') return { unit: 'AUTO' };
  const v = parseFloat(cssLineHeight);
  if (Number.isNaN(v)) return { unit: 'AUTO' };
  return { unit: 'PIXELS', value: v };
}

// ── Letter spacing ────────────────────────────────────────────────────────
export function parseLetterSpacing(cssLetterSpacing: string): LetterSpacing {
  if (cssLetterSpacing === 'normal') return { unit: 'PIXELS', value: 0 };
  const v = parseFloat(cssLetterSpacing);
  if (Number.isNaN(v)) return { unit: 'PIXELS', value: 0 };
  return { unit: 'PIXELS', value: v };
}

// ── Text align / transform / decoration ───────────────────────────────────
export function mapTextAlign(cssAlign: string): TextAlign {
  switch (cssAlign) {
    case 'center':  return 'CENTER';
    case 'right':   return 'RIGHT';
    case 'end':     return 'RIGHT';
    case 'justify': return 'JUSTIFIED';
    default:        return 'LEFT';
  }
}

export function mapTextCase(cssTransform: string): TextCase {
  switch (cssTransform) {
    case 'uppercase':  return 'UPPER';
    case 'lowercase':  return 'LOWER';
    case 'capitalize': return 'TITLE';
    default:           return 'ORIGINAL';
  }
}

export function mapTextDecoration(cssDecoration: string): TextDecoration {
  if (/underline/.test(cssDecoration))    return 'UNDERLINE';
  if (/line-through/.test(cssDecoration)) return 'STRIKETHROUGH';
  return 'NONE';
}

// ── Reflowed text extraction ──────────────────────────────────────────────
// Read the browser's painted line boxes for a Range and bake \n at each
// line boundary, so Figma sees the exact visual wrap even if fonts differ.

function collapseSpaces(s: string): string {
  // CSS `white-space: normal` collapses runs of whitespace.
  return s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
}

export function reflowedTextFromRange(range: Range): string {
  const text = range.toString();
  if (!text) return '';
  const lineRects = Array.from(range.getClientRects());
  if (lineRects.length <= 1) return collapseSpaces(text).trim();

  // Char-by-char attribution to line rects, via one-char sub-ranges.
  const container = range.startContainer;
  if (container.nodeType !== 3) return collapseSpaces(text).trim(); // fall back
  const textNode = container as Text;
  const doc = textNode.ownerDocument ?? document;
  const start = range.startOffset;
  const end = range.endOffset;
  const out: string[] = [];
  let currentLine = 0;
  const r = doc.createRange();
  for (let i = start; i < end; i++) {
    r.setStart(textNode, i);
    r.setEnd(textNode, i + 1);
    const charRect = r.getBoundingClientRect();
    if (charRect.width === 0 && charRect.height === 0) {
      // whitespace at line break point — skip to next line
      continue;
    }
    const centerY = charRect.top + charRect.height / 2;
    while (currentLine < lineRects.length - 1 && centerY > lineRects[currentLine].bottom) {
      currentLine++;
      out.push('\n');
    }
    out.push(textNode.nodeValue!.charAt(i));
  }
  return collapseSpaces(out.join('')).trim();
}

/** Whole-element variant: walks each text descendant of the element and
 *  reflows every one with its own line-break bake-in. */
export function reflowedTextFromElement(el: Element): string {
  const parts: string[] = [];
  const doc = el.ownerDocument ?? document;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.nodeValue ?? '';
    if (!value || !value.trim()) continue;
    const r = doc.createRange();
    r.selectNodeContents(node);
    const piece = reflowedTextFromRange(r);
    if (piece) parts.push(piece);
  }
  return parts.join(' ').replace(/ \n/g, '\n').replace(/\n /g, '\n');
}

// ── Text-props builders ───────────────────────────────────────────────────

/** Build TextProps for an element treated as a text leaf. */
export function buildTextProps(el: Element, cs: CSSStyleDeclaration): TextProps | null {
  const characters = reflowedTextFromElement(el);
  if (!characters) return null;
  const rect = el.getBoundingClientRect();
  const padLeft  = parseFloat(cs.paddingLeft)  || 0;
  const padRight = parseFloat(cs.paddingRight) || 0;
  const width = Math.max(1, rect.width - padLeft - padRight);
  return buildTextPropsCommon(cs, characters, width);
}

/** Build TextProps for a #text child node (uses its Range rect for width). */
export function buildTextPropsFromRange(cs: CSSStyleDeclaration, characters: string, rect: DOMRect): TextProps {
  const width = Math.max(1, rect.width);
  return buildTextPropsCommon(cs, characters, width);
}

function buildTextPropsCommon(cs: CSSStyleDeclaration, characters: string, width: number): TextProps {
  const color = parseColor(cs.color) ?? ({ r: 0, g: 0, b: 0, a: 1 } as Color);
  const fontSize = parseFloat(cs.fontSize) || 14;
  return {
    characters,
    fontFamily: firstFontFamily(cs.fontFamily),
    fontStyle: mapFontStyle(cs.fontWeight, cs.fontStyle),
    fontSize,
    lineHeight: parseLineHeight(cs.lineHeight, fontSize),
    letterSpacing: parseLetterSpacing(cs.letterSpacing),
    color,
    textAlign: mapTextAlign(cs.textAlign),
    textDecoration: mapTextDecoration(cs.textDecoration),
    textCase: mapTextCase(cs.textTransform),
    width,
  };
}
