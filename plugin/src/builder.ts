import type { Node, Style, TextProps, Layout } from './schema';
import { FontResolver } from './fonts';
import { paintsFromSchema, applyStrokes, toFigmaEffect, isSvgDataUrl, svgTextFromDataUrl } from './paints';

type Origin = { x: number; y: number };

export async function buildInto(
  parent: FrameNode | PageNode,
  node: Node,
  parentOrigin: Origin,
  resolver: FontResolver,
  applyAL: boolean,
  depth: number = 0,
): Promise<SceneNode | null> {
  const localX = node.bounds.x - parentOrigin.x;
  const localY = node.bounds.y - parentOrigin.y;
  // The body frame (depth 0 here — the breakpoint wrapper is created in
  // code.ts at "depth -1") never clips. Paired with the wrapper's own
  // clipsContent=false in code.ts, this is the "two large outer containers
  // never clip" rule the user asked for. Everything below the body follows
  // CSS overflow normally.
  const isTopLevelContainer = depth === 0 && node.type === 'frame';

  let fig: SceneNode;

  try {
    switch (node.type) {
      case 'frame': {
        const f = figma.createFrame();
        // `createFrame()` returns a frame with an opaque white fill. The
        // capture side only attaches a `style` when the element has visual
        // CSS (color, border, radius, shadow, etc.), so transparent wrapper
        // divs (`div.flex`, `div.grid`, etc.) arrive with no style. If we
        // don't clear here, those wrappers keep the default white and paint
        // over ancestor backgrounds.
        f.fills = [];
        // Default to no clipping — `applyStyleToFrame` and the post-recurse
        // expand step turn clipping on only when CSS explicitly asks for it
        // (and the frame isn't a top-level container, which never clips).
        f.clipsContent = false;
        fig = f;
        break;
      }
      case 'text':  fig = figma.createText(); break;
      case 'image': {
        // When the <img>'s effective source was an SVG (e.g. a CDN that
        // serves vector logos), create a real SVG node instead of an empty
        // image frame. `figma.createImage` rejects SVG bytes, so without
        // this branch those icons would silently disappear.
        const imgUrl = node.imageData?.dataUrl;
        if (imgUrl && isSvgDataUrl(imgUrl)) {
          const svgText = svgTextFromDataUrl(imgUrl);
          if (svgText) {
            try {
              fig = figma.createNodeFromSvg(svgText);
              break;
            } catch (err) {
              console.warn(`svg-image create failed for ${node.name}:`, err);
            }
          }
        }
        const f = figma.createFrame();
        f.fills = [];
        f.clipsContent = false;
        fig = f;
        break;
      }
      case 'svg': {
        if (!node.svgRaw) return null;
        try {
          fig = figma.createNodeFromSvg(node.svgRaw);
        } catch (err) {
          console.warn(`svg create failed for ${node.name}:`, err);
          return null;
        }
        break;
      }
    }
  } catch (err) {
    console.warn(`create failed for ${node.name}:`, err);
    return null;
  }

  fig.name = node.name;
  parent.appendChild(fig);

  if ('resize' in fig && node.type !== 'text') {
    const w = Math.max(0.01, node.bounds.w);
    const h = Math.max(0.01, node.bounds.h);
    try { (fig as FrameNode | RectangleNode).resize(w, h); } catch { /* SVGs may not resize cleanly */ }
  }

  fig.x = localX;
  fig.y = localY;

  // Apply style to frames and image holders.
  if (node.style && (node.type === 'frame' || node.type === 'image')) {
    await applyStyleToFrame(fig as FrameNode, node.style);
  }

  // Text specifics.
  if (node.type === 'text' && node.text) {
    applyTextProps(fig as TextNode, node.text, resolver);
  }

  // Recurse — only frames accept children.
  if (node.type === 'frame' && node.children && 'appendChild' in fig) {
    const selfOrigin: Origin = { x: node.bounds.x, y: node.bounds.y };
    const childNodes: SceneNode[] = [];
    const childSpecs: Node[] = [];
    for (const child of node.children) {
      const created = await buildInto(fig as FrameNode, child, selfOrigin, resolver, applyAL, depth + 1);
      if (created) {
        childNodes.push(created);
        childSpecs.push(child);
      }
    }

    // Expand the frame to fit its children. CSS overflow controls clipping
    // per axis (unless this is a top-level container, which never clips):
    //   - axis with `overflow: hidden/clip/auto/scroll` → keep size, clip
    //     anything that overflows (mirrors what the browser does, including
    //     hiding content behind a scrollbar).
    //   - axis with `overflow: visible` → grow to fit so above-the-fold-
    //     captured content below the captured rect stays visible.
    const hasExplicitClip = !isTopLevelContainer && node.style?.clipsContent === true;
    const clipX = !isTopLevelContainer && (node.style?.clipAxes === 'x' || node.style?.clipAxes === 'both');
    const clipY = !isTopLevelContainer && (node.style?.clipAxes === 'y' || node.style?.clipAxes === 'both');
    expandFrameToFitChildren(fig as FrameNode, childNodes, childSpecs, clipX, clipY);

    // Top-level containers are guaranteed un-clipped regardless of CSS.
    if (isTopLevelContainer) (fig as FrameNode).clipsContent = false;

    const willBeAL = applyAL && node.layout && !node.layout.wrap;
    if (willBeAL) {
      convertToAutoLayout(fig as FrameNode, node.layout!, childNodes, childSpecs, hasExplicitClip);
      if (isTopLevelContainer) (fig as FrameNode).clipsContent = false;
    }
  }

  return fig;
}

function expandFrameToFitChildren(
  frame: FrameNode,
  children: SceneNode[],
  specs: Node[],
  clipX: boolean,
  clipY: boolean,
): void {
  if (!children.length) return;
  let maxR = frame.width;
  let maxB = frame.height;
  for (let i = 0; i < children.length; i++) {
    // Absolute-positioned children get clipped in the browser by design —
    // don't let them force a resize.
    if (specs[i].isAbsolute) continue;
    const c = children[i];
    const right  = c.x + c.width;
    const bottom = c.y + c.height;
    if (right  > maxR) maxR = right;
    if (bottom > maxB) maxB = bottom;
  }

  // Distinguish a real CSS mask from a scroll-prevention shell.
  //
  // The same `overflow: hidden` declaration shows up in two completely
  // different patterns:
  //   1. A mask, e.g. a rounded-corner card whose content fits inside or
  //      overflows by a few pixels (an icon poking out a smidge).
  //   2. A viewport-height shell, e.g. `<div class="h-screen overflow-hidden">`
  //      wrapping an inner scroll container — designed to PREVENT body
  //      scroll while the inner element handles real scrolling. Its child
  //      content is typically many times taller than the shell itself.
  //
  // If we faithfully clip case 2, the imported frame shows only the first
  // viewport's worth of page and hides everything below.
  //
  // Threshold: scroll shell when overflow > min(frame * 0.5, 200 px). The
  // 50%-of-self ratio keeps small cards safe (a 60 px row with a 25 px icon
  // poking out is still a mask, not a shell). The 200 px absolute cap
  // catches viewport-sized shells on tall viewports — a tablet at 768×1024
  // has a 1024 px shell whose content can be only ~1.5× as tall (overflow
  // ~500 px), which is well below the shell's own height but unambiguously
  // not a decorative mask. 200 px of DOM-level overflow is far more than
  // any realistic mask scenario produces.
  const yOverflow = maxB - frame.height;
  const xOverflow = maxR - frame.width;
  const yShellThreshold = Math.min(frame.height * 0.5, 200);
  const xShellThreshold = Math.min(frame.width  * 0.5, 200);
  const yIsScrollShell = clipY && yOverflow > yShellThreshold;
  const xIsScrollShell = clipX && xOverflow > xShellThreshold;
  const effectiveClipY = clipY && !yIsScrollShell;
  const effectiveClipX = clipX && !xIsScrollShell;

  const targetW = effectiveClipX ? frame.width : maxR;
  const targetH = effectiveClipY ? frame.height : maxB;
  if (targetW > frame.width + 0.5 || targetH > frame.height + 0.5) {
    try { frame.resize(Math.max(0.01, targetW), Math.max(0.01, targetH)); } catch { /* ignore */ }
  }
  // Clip only when there's a real clip on at least one axis after the
  // scroll-shell unmask. Figma's clipsContent is a single boolean.
  frame.clipsContent = effectiveClipX || effectiveClipY;
}

function convertToAutoLayout(
  frame: FrameNode,
  layout: Layout,
  children: SceneNode[],
  specs: Node[],
  hasExplicitClip: boolean,
): void {
  // Snapshot state BEFORE flipping `layoutMode`. Setting layoutMode flips
  // primaryAxisSizingMode to AUTO (Figma's default), and since any
  // absolute-positioned children are still in AUTO positioning at that
  // moment, AL briefly treats them as in-flow. If they don't fit, the
  // frame auto-grows. We restore the original size + child bounds after
  // AL is configured to undo that.
  const savedW = frame.width;
  const savedH = frame.height;
  const absSnap: Array<{ n: SceneNode; x: number; y: number; w: number; h: number }> = [];
  for (let i = 0; i < children.length; i++) {
    if (!specs[i].isAbsolute) continue;
    const c = children[i];
    absSnap.push({
      n: c,
      x: c.x,
      y: c.y,
      w: 'width'  in c ? (c as FrameNode).width  : 0,
      h: 'height' in c ? (c as FrameNode).height : 0,
    });
  }

  // Parent MUST be set to Auto Layout before any child can be flagged ABSOLUTE.
  frame.layoutMode = layout.axis === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
  frame.itemSpacing = layout.gap;
  frame.paddingTop    = layout.paddingTop;
  frame.paddingRight  = layout.paddingRight;
  frame.paddingBottom = layout.paddingBottom;
  frame.paddingLeft   = layout.paddingLeft;

  // Lock sizing to the captured (pre-AL) dimensions so AL can't grow the
  // frame to fit transiently-in-flow absolute children.
  frame.primaryAxisSizingMode  = 'FIXED';
  frame.counterAxisSizingMode  = 'FIXED';
  try { frame.resize(Math.max(0.01, savedW), Math.max(0.01, savedH)); } catch { /* ignore */ }

  // Infer effective justifyContent from actual captured positions, because
  // CSS `margin-left: auto` and similar tricks push children apart without
  // changing `justify-content`. Reading geometry catches these cases.
  const inFlowWithIdx = children
    .map((c, i) => ({ c, spec: specs[i], idx: i }))
    .filter(x => !x.spec.isAbsolute);
  const inferred = inferPrimaryAxisAlign(
    frame,
    layout,
    inFlowWithIdx.map(x => x.c),
  );
  const effectivePrimaryAlign = inferred ?? layout.justifyContent;

  frame.primaryAxisAlignItems  = effectivePrimaryAlign as typeof frame.primaryAxisAlignItems;
  frame.counterAxisAlignItems  = layout.alignItems     as typeof frame.counterAxisAlignItems;
  // Setting layoutMode can re-enable clipsContent under Figma's defaults.
  // Restore the value that `applyStyleToFrame`/`expandFrameToFitChildren`
  // already settled on — only force-off when there was no explicit CSS clip.
  if (!hasExplicitClip) frame.clipsContent = false;

  // Mark absolute children out-of-flow and restore their original bounds.
  // AL may have moved/resized them while they were still AUTO positioning.
  for (const s of absSnap) {
    const c = s.n as SceneNode & { layoutPositioning?: 'AUTO' | 'ABSOLUTE' };
    if ('layoutPositioning' in c) {
      try { c.layoutPositioning = 'ABSOLUTE'; } catch { /* not supported on all node types */ }
    }
    try {
      if ('resize' in s.n && s.w > 0 && s.h > 0) {
        (s.n as FrameNode).resize(Math.max(0.01, s.w), Math.max(0.01, s.h));
      }
      s.n.x = s.x;
      s.n.y = s.y;
    } catch { /* ignore */ }
  }

  // Sort in-flow children by primary axis so the AL order matches visual
  // order even if DOM order diverged (e.g. flex-direction: row-reverse).
  const inFlow = inFlowWithIdx.slice();
  inFlow.sort((a, b) => {
    if (layout.axis === 'horizontal') return a.c.x - b.c.x;
    return a.c.y - b.c.y;
  });
  for (const { c } of inFlow) frame.appendChild(c);
  // Re-append absolute children last so they paint on top of in-flow
  // siblings (DOM order intent: <icon> then <absolute overlay>).
  for (const s of absSnap) frame.appendChild(s.n);

  // Map CSS flex-grow → Figma `layoutGrow` on the primary axis. This is
  // needed because text children auto-resize in Figma ("hug content") and
  // sibling frames then pack tightly — collapsing the space that the
  // browser reserved via flex-grow. Applying layoutGrow makes the grown
  // child fill the remaining space exactly as it did in the browser.
  for (let i = 0; i < children.length; i++) {
    if (specs[i].isAbsolute) continue;
    const grow = specs[i].flexGrow ?? 0;
    if (grow > 0) {
      const c = children[i] as SceneNode & { layoutGrow?: number };
      if ('layoutGrow' in c) {
        try { c.layoutGrow = 1; } catch { /* ignore */ }
      }
    }
  }
}

/** Look at where in-flow children actually landed in the browser and pick
 *  the AL primary-axis alignment that will reproduce that spacing. Returns
 *  undefined if CSS `justify-content` already matches the geometry, so the
 *  caller falls back to the CSS value (which may carry more nuance, e.g.
 *  center-vs-flex-start for a single child). */
function inferPrimaryAxisAlign(
  frame: FrameNode,
  layout: Layout,
  inFlow: SceneNode[],
): 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | undefined {
  if (inFlow.length < 2) return undefined;

  const horiz = layout.axis === 'horizontal';
  const containerSize = horiz ? frame.width  : frame.height;
  const padStart = horiz ? layout.paddingLeft : layout.paddingTop;
  const padEnd   = horiz ? layout.paddingRight : layout.paddingBottom;
  const gap = layout.gap;

  // Collect in-flow edges in visual order.
  const items = inFlow.map(c => ({
    start: horiz ? c.x : c.y,
    size:  horiz ? c.width : c.height,
  })).sort((a, b) => a.start - b.start);

  const first = items[0];
  const last  = items[items.length - 1];
  const startGap = first.start - padStart;
  const endGap   = (containerSize - padEnd) - (last.start + last.size);

  // Measure the largest inter-child gap, excluding the CSS flex `gap` floor.
  let maxInner = 0;
  for (let i = 1; i < items.length; i++) {
    const inner = items[i].start - (items[i - 1].start + items[i - 1].size);
    if (inner > maxInner) maxInner = inner;
  }
  const excess = maxInner - gap;

  const TOL = 2; // px tolerance for rounding / sub-pixel layout

  // Flex-start fits: first child at padding start, no oversized inner gap.
  const flexStartFits = Math.abs(startGap) <= TOL && excess <= TOL;
  if (flexStartFits) return undefined;

  // Space-between: first at start, last at end, inner gap wider than `gap`.
  if (Math.abs(startGap) <= TOL && Math.abs(endGap) <= TOL && excess > TOL) {
    return 'SPACE_BETWEEN';
  }

  // Flex-end: last child pinned at end, first child shifted from start.
  if (Math.abs(endGap) <= TOL && startGap > TOL) return 'MAX';

  // Centered: equal empty space before and after the children group.
  if (Math.abs(startGap - endGap) <= TOL && startGap > TOL && excess <= TOL) {
    return 'CENTER';
  }

  // Margin-left: auto on the LAST child specifically — pushes last child
  // far right while earlier children stay at flex-start. AL's closest match
  // is SPACE_BETWEEN (it pins first + last to opposite ends).
  if (Math.abs(startGap) <= TOL && endGap < TOL && excess > TOL) {
    return 'SPACE_BETWEEN';
  }

  return undefined;
}

async function applyStyleToFrame(frame: FrameNode, style: Style): Promise<void> {
  if (style.fills) {
    const paints = await paintsFromSchema(style.fills);
    if (paints.length) frame.fills = paints;
    else frame.fills = [];
  } else {
    frame.fills = [];
  }

  applyStrokes(frame, style.strokes);

  if (style.cornerRadius !== undefined) {
    if (typeof style.cornerRadius === 'number') {
      frame.cornerRadius = style.cornerRadius;
    } else {
      const [tl, tr, br, bl] = style.cornerRadius;
      frame.topLeftRadius     = tl;
      frame.topRightRadius    = tr;
      frame.bottomRightRadius = br;
      frame.bottomLeftRadius  = bl;
    }
  }

  if (style.effects && style.effects.length) {
    frame.effects = style.effects.map(toFigmaEffect);
  }

  if (style.opacity !== undefined) frame.opacity = style.opacity;
  // Honor the captured clipsContent. `expandFrameToFitChildren` overrides
  // again per-axis once children are placed; the top-level container reset
  // in `buildInto` overrides yet again for the wrapper + body frame.
  if (style.clipsContent !== undefined) frame.clipsContent = style.clipsContent;
}

function applyTextProps(tn: TextNode, tp: TextProps, resolver: FontResolver): void {
  const font = resolver.resolve(tp.fontFamily, tp.fontStyle);
  tn.fontName = font;
  tn.fontSize = tp.fontSize;
  tn.characters = tp.characters;

  const hasWrap = tp.characters.indexOf('\n') >= 0;
  if (hasWrap) {
    tn.textAutoResize = 'HEIGHT';
    if (tp.width > 0) { try { tn.resize(tp.width, tn.height); } catch { /* ignore */ } }
  } else {
    tn.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  tn.fills = [{ type: 'SOLID', color: { r: tp.color.r, g: tp.color.g, b: tp.color.b }, opacity: tp.color.a }];
  tn.textAlignHorizontal = tp.textAlign;
  tn.textCase = tp.textCase;
  tn.textDecoration = tp.textDecoration;
  if (tp.lineHeight.unit === 'PIXELS') {
    tn.lineHeight = { unit: 'PIXELS', value: tp.lineHeight.value };
  } else {
    tn.lineHeight = { unit: 'AUTO' };
  }
  if (tp.letterSpacing.unit === 'PIXELS') {
    tn.letterSpacing = { unit: 'PIXELS', value: tp.letterSpacing.value };
  }
}
