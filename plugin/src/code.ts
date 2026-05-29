import type { Envelope, Node } from './schema';
import { CAPTURE_VERSION } from './schema';
import { preloadFonts, DEFAULT_FALLBACK } from './fonts';
import { buildInto } from './builder';

figma.showUI(__html__, { width: 360, height: 540 });

// Horizontal gap between breakpoint frames on the canvas.
const BREAKPOINT_GAP = 100;

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'import') return;
  const t0 = Date.now();
  try {
    const envelopes = (msg.envelopes as Envelope[]) || [];
    if (!envelopes.length) throw new Error('No envelopes received');
    for (const env of envelopes) {
      if (!env || env.captureVersion !== CAPTURE_VERSION) {
        throw new Error(`Unsupported capture version: ${env?.captureVersion}`);
      }
    }

    const fallback = {
      family: (msg.fallbackFamily as string) || DEFAULT_FALLBACK.family,
      style: 'Regular',
    };
    const applyAL = !!msg.autoLayout;

    // Preload fonts across every envelope at once. Wrap each envelope's root
    // in a synthetic parent so preloadFonts can recurse over the whole set in
    // a single pass.
    const mergedForFonts: Node = {
      type: 'frame',
      name: '__preload_root',
      bounds: { x: 0, y: 0, w: 1, h: 1 },
      children: envelopes.map((e) => e.root),
    };
    const resolver = await preloadFonts(mergedForFonts, fallback);

    const host = hostnameOf(envelopes[0]?.url);

    // Pass 1: build each breakpoint into its own root frame, off-screen.
    // After expandRootToAllDescendants resizes each root we know its real
    // bounds, which we need to lay them out side-by-side in pass 2.
    const roots: FrameNode[] = [];
    let totalNodes = 0;
    for (const env of envelopes) {
      const root = figma.createFrame();
      root.fills = []; // transparent; inner body carries the page bg
      root.clipsContent = false; // never clip — show everything
      root.resize(Math.max(1, env.viewport.w), Math.max(1, env.viewport.h));

      const bp = env.breakpoint;
      const label = bp?.label || (bp ? `${bp.width}px` : '');
      const dims = `${env.viewport.w}×${env.viewport.h}`;
      root.name = label
        ? `HTML Import — ${host} · ${label} (${dims})`
        : `HTML Import — ${host} · ${dims}`;

      await buildInto(root, env.root, { x: 0, y: 0 }, resolver, applyAL);
      expandRootToAllDescendants(root);

      roots.push(root);
      totalNodes += countNodes(env.root);
    }

    // Pass 2: position the row centered on the current viewport, frames
    // top-aligned with a fixed gap between them.
    const totalWidth =
      roots.reduce((sum, r) => sum + r.width, 0) +
      BREAKPOINT_GAP * Math.max(0, roots.length - 1);
    const maxHeight = roots.reduce((m, r) => Math.max(m, r.height), 0);
    const center = figma.viewport.center;
    let cursorX = Math.round(center.x - totalWidth / 2);
    const topY = Math.round(center.y - maxHeight / 2);
    for (const r of roots) {
      r.x = cursorX;
      r.y = topY;
      cursorX += r.width + BREAKPOINT_GAP;
    }

    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);

    const ms = Date.now() - t0;
    figma.ui.postMessage({ type: 'done', nodes: totalNodes, ms });
    figma.notify(
      roots.length === 1
        ? `Imported ${totalNodes} nodes in ${ms}ms`
        : `Imported ${roots.length} breakpoints (${totalNodes} nodes) in ${ms}ms`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(err);
    figma.ui.postMessage({ type: 'error', message });
  }
};

function countNodes(n: Node): number {
  let c = 1;
  if (n.children) for (const ch of n.children) c += countNodes(ch);
  return c;
}

function hostnameOf(url: string | undefined): string {
  if (!url) return 'page';
  const m = url.match(/^[a-z]+:\/\/([^/?#]+)/i);
  return m ? m[1] : 'page';
}

/** Final sizing pass on the root wrapper: walk the whole tree and find the
 *  deepest visible bottom (in root-local coords), then resize the root to
 *  encompass everything vertically. Horizontal extent is held to the
 *  breakpoint's viewport width — that's the contract of a multi-breakpoint
 *  import (user picks 375px, frame comes out at 375px). Pages frequently
 *  have descendants that overflow horizontally (tables, sliders, ill-fitting
 *  responsive markup); the browser handles that with scroll containers or
 *  `overflow: hidden`. Those parents now propagate `clipsContent: true`, so
 *  the overflow gets clipped at the right place instead of dragging the
 *  whole root frame wider.
 *
 *  After resizing, also stretches the immediate body frame (root's first
 *  child) to match the wrapper height. Without this, the wrapper is tall
 *  enough to show everything but the captured `<body>` ends shorter, leaving
 *  bottom-of-page content visually outside the body frame and confusing
 *  users who expect the inner frame to also enclose all content. */
function expandRootToAllDescendants(root: FrameNode): void {
  let maxB = root.height;

  function recurse(parent: SceneNode, offsetX: number, offsetY: number): void {
    if (!('children' in parent)) return;
    for (const child of (parent as FrameNode).children) {
      const gx = offsetX + child.x;
      const gy = offsetY + child.y;
      maxB = Math.max(maxB, gy + child.height);
      if ('children' in child) recurse(child, gx, gy);
    }
  }
  recurse(root, 0, 0);

  if (maxB > root.height + 0.5) {
    try { root.resize(root.width, Math.max(1, maxB)); } catch { /* ignore */ }
  }

  // Sync the body frame (single inner child representing the captured <body>)
  // to the wrapper's full size. The body's own `expandFrameToFitChildren`
  // may have grown WIDER than the viewport (no clipping = it stretches to
  // fit a table or slider) and may have stopped SHORTER on the vertical
  // axis (absolute-positioned descendants didn't count toward growth).
  // Clamp the body to the wrapper's dimensions — children may still extend
  // past the body horizontally (we don't clip), but the body frame itself
  // stays exactly the breakpoint's viewport width and the wrapper's full
  // descendant-encompassing height.
  if (root.children.length === 1) {
    const body = root.children[0];
    if ('resize' in body) {
      const needW = Math.abs((body as FrameNode).width  - root.width)  > 0.5;
      const needH = Math.abs((body as FrameNode).height - root.height) > 0.5;
      if (needW || needH) {
        try { (body as FrameNode).resize(Math.max(0.01, root.width), Math.max(0.01, root.height)); } catch { /* ignore */ }
      }
    }
  }
}
