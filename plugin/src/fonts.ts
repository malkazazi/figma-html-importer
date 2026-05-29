import type { Node } from './schema';

export type FallbackFont = { family: string; style: string };
export const DEFAULT_FALLBACK: FallbackFont = { family: 'Inter', style: 'Regular' };

// Maps an originally-requested (family, style) pair to the actual (family, style)
// the plugin should apply — populated after preloadFonts.
export class FontResolver {
  private map = new Map<string, FontName>();

  key(f: string, s: string): string { return `${f}\u0001${s}`; }

  resolve(family: string, style: string): FontName {
    const key = this.key(family, style);
    return this.map.get(key) ?? { family, style };
  }

  set(family: string, style: string, actual: FontName): void {
    this.map.set(this.key(family, style), actual);
  }
}

function collectFontPairs(node: Node, out: Set<string>): void {
  if (node.text) out.add(`${node.text.fontFamily}\u0001${node.text.fontStyle}`);
  if (node.children) for (const c of node.children) collectFontPairs(c, out);
}

export async function preloadFonts(root: Node, fallback: FallbackFont): Promise<FontResolver> {
  const pairs = new Set<string>();
  collectFontPairs(root, pairs);
  // Always ensure fallback is available.
  pairs.add(`${fallback.family}\u0001${fallback.style}`);
  const resolver = new FontResolver();

  for (const key of pairs) {
    const [family, style] = key.split('\u0001');
    if (await tryLoad({ family, style })) continue;
    // Fall back to same family, Regular style.
    if (style !== 'Regular' && await tryLoad({ family, style: 'Regular' })) {
      resolver.set(family, style, { family, style: 'Regular' });
      continue;
    }
    // Fall back to user-chosen fallback.
    if (await tryLoad(fallback)) {
      resolver.set(family, style, fallback);
      continue;
    }
    // Last resort — try Inter Regular (should always exist in Figma).
    await tryLoad(DEFAULT_FALLBACK);
    resolver.set(family, style, DEFAULT_FALLBACK);
  }
  return resolver;
}

async function tryLoad(font: FontName): Promise<boolean> {
  try {
    await figma.loadFontAsync(font);
    return true;
  } catch {
    return false;
  }
}
