import type { Node, NodeKind, Paint } from './schema';
import { pageBoundsOf } from './geometry';
import { extractStyle, parseColor, extractLayout, isAbsolutePositioned, extractFlexGrow } from './style';
import { buildTextProps, buildTextPropsFromRange, reflowedTextFromRange } from './text';
import { resolveSvgForFigma } from './svg';
import { firstBackgroundUrl, imageToDataUrl } from './images';

// ── Visibility filtering ──────────────────────────────────────────────────

function isHidden(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.display === 'none')        return true;
  if (cs.visibility === 'hidden')   return true;
  if (cs.visibility === 'collapse') return true;
  if (parseFloat(cs.opacity) === 0) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return true;
  return false;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'TITLE', 'HEAD', 'BR']);

/** Elements the capture script itself injects (toast, etc). Skip so the
 *  bookmarklet's own UI never shows up in the captured JSON. */
function isCaptureUi(el: Element): boolean {
  return el.hasAttribute('data-figma-capture-ui') || !!el.closest('[data-figma-capture-ui]');
}

// ── Visual style probe ────────────────────────────────────────────────────
// If an element has any of these, we keep it as a frame so its styles survive
// instead of collapsing it to a bare text node.

function hasVisualStyle(cs: CSSStyleDeclaration): boolean {
  if (parseColor(cs.backgroundColor)) return true;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  if (parseFloat(cs.borderTopWidth) > 0) return true;
  if (parseFloat(cs.borderRightWidth) > 0) return true;
  if (parseFloat(cs.borderBottomWidth) > 0) return true;
  if (parseFloat(cs.borderLeftWidth) > 0) return true;
  if (parseFloat(cs.borderTopLeftRadius)     > 0) return true;
  if (parseFloat(cs.borderTopRightRadius)    > 0) return true;
  if (parseFloat(cs.borderBottomLeftRadius)  > 0) return true;
  if (parseFloat(cs.borderBottomRightRadius) > 0) return true;
  if (cs.boxShadow && cs.boxShadow !== 'none') return true;
  if (parseFloat(cs.opacity) < 1) return true;
  if (parseFloat(cs.paddingTop) > 0 || parseFloat(cs.paddingRight) > 0 ||
      parseFloat(cs.paddingBottom) > 0 || parseFloat(cs.paddingLeft) > 0) return true;
  return false;
}

// ── Node kind decision ────────────────────────────────────────────────────

function hasElementChildren(el: Element): boolean {
  return el.children.length > 0;
}

function hasTextContent(el: Element): boolean {
  // Has any non-whitespace text (including descendants) — cheap.
  return (el.textContent ?? '').trim().length > 0;
}

function isTextLeaf(el: Element, cs: CSSStyleDeclaration): boolean {
  // Collapse to a bare text node only when:
  //   (a) there are no element children,
  //   (b) the element has meaningful text, and
  //   (c) the element has no visual styling that would be lost.
  if (hasElementChildren(el)) return false;
  if (!hasTextContent(el))    return false;
  return !hasVisualStyle(cs);
}

function nodeKindFor(el: Element, cs: CSSStyleDeclaration): NodeKind {
  const tag = el.tagName;
  if (tag === 'svg') return 'svg';
  if (tag === 'IMG') return 'image';
  if (tag === 'INPUT') return 'frame';
  if (isTextLeaf(el, cs)) return 'text';
  return 'frame';
}

// ── Naming ────────────────────────────────────────────────────────────────

function debugNameFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id  = el.id ? `#${el.id}` : '';
  const cls = (el.classList && el.classList.length) ? `.${el.classList[0]}` : '';
  return `${tag}${id}${cls}`;
}

// ── Text child node (direct #text DOM node inside an element) ─────────────

function walkTextNode(textNode: Text, parentCs: CSSStyleDeclaration): Node | null {
  const value = textNode.nodeValue ?? '';
  if (!value || !value.trim()) return null;
  const doc = textNode.ownerDocument ?? document;
  const range = doc.createRange();
  range.selectNodeContents(textNode);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const characters = reflowedTextFromRange(range);
  if (!characters || !characters.trim()) return null;
  const text = buildTextPropsFromRange(parentCs, characters, rect);
  const preview = characters.replace(/\s+/g, ' ').trim().slice(0, 24);
  const parent = textNode.parentElement ?? undefined;
  return {
    type: 'text',
    name: `#text "${preview}"`,
    bounds: pageBoundsOf(rect, parent),
    text,
  };
}

// ── Walk ──────────────────────────────────────────────────────────────────

export async function walkElement(el: Element): Promise<Node | null> {
  if (SKIP_TAGS.has(el.tagName)) return null;
  if (isCaptureUi(el))           return null;
  const cs = getComputedStyle(el);
  if (isHidden(el, cs)) return null;
  const rect = el.getBoundingClientRect();

  const type = nodeKindFor(el, cs);
  const base: Node = {
    type,
    name: debugNameFor(el),
    bounds: pageBoundsOf(rect, el),
  };

  if (type === 'frame' || type === 'image') {
    const style = extractStyle(cs);
    if (Object.keys(style).length) base.style = style;
  }

  // Layout hint (only meaningful for frames that will contain children).
  if (type === 'frame') {
    const layout = extractLayout(cs);
    if (layout) base.layout = layout;
  }

  // Absolute-positioning + flex-grow hints (only for children of layout-aware parents).
  if (isAbsolutePositioned(cs)) base.isAbsolute = true;
  const fg = extractFlexGrow(cs);
  if (fg > 0) base.flexGrow = fg;

  if (type === 'svg') {
    base.svgRaw = resolveSvgForFigma(el as unknown as SVGElement);
    return base;
  }

  if (type === 'image') {
    const img = el as HTMLImageElement;
    // Some frameworks / browser extensions deliver the real pixels via a
    // CSS `background-image: var(--sf-img-N)` (or similar) on the <img>,
    // using a tiny transparent SVG as the literal `src` placeholder. Prefer
    // the background-image URL when one is present so those cases don't
    // capture an empty icon.
    const bgUrl = firstBackgroundUrl(cs.backgroundImage);
    const src = bgUrl || img.currentSrc || img.src;
    if (src) {
      const imageData = await imageToDataUrl(src, rect.width, rect.height);
      if (imageData) {
        base.imageData = imageData;
        const imagePaint: Paint = { type: 'image', dataUrl: imageData.dataUrl, scaleMode: 'FILL' };
        base.style = { ...(base.style || {}), fills: [...(base.style?.fills || []), imagePaint] };
      }
    }
    return base;
  }

  if (type === 'frame') {
    const bgUrl = firstBackgroundUrl(cs.backgroundImage);
    if (bgUrl) {
      const imageData = await imageToDataUrl(bgUrl, rect.width, rect.height);
      if (imageData) {
        const imagePaint: Paint = { type: 'image', dataUrl: imageData.dataUrl, scaleMode: 'FILL' };
        base.style = { ...(base.style || {}), fills: [...(base.style?.fills || []), imagePaint] };
      }
    }
  }

  if (type === 'text') {
    const tp = buildTextProps(el, cs);
    if (tp) base.text = tp;
    return base;
  }

  // Frame: walk BOTH element children and direct text-node children.
  // This is where mixed content ("Start with <span>30% Off</span>") is preserved.
  const children: Node[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1) {
      const c = await walkElement(child as Element);
      if (c) children.push(c);
    } else if (child.nodeType === 3) {
      const c = walkTextNode(child as Text, cs);
      if (c) children.push(c);
    }
  }

  if (children.length) base.children = children;
  return base;
}
