// Resolve currentColor / color inheritance on an <svg> before handing its
// outerHTML to Figma's createNodeFromSvg (which does NOT inherit from the DOM).

export function resolveSvgForFigma(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  const win = svg.ownerDocument?.defaultView ?? window;
  const cs = win.getComputedStyle(svg);
  const ownColor = cs.color;

  clone.setAttribute('color', ownColor);

  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const el of all) {
    for (const attr of ['fill', 'stroke']) {
      const v = el.getAttribute(attr);
      if (v && /currentcolor/i.test(v)) el.setAttribute(attr, ownColor);
    }
    const styleAttr = el.getAttribute('style');
    if (styleAttr && /currentcolor/i.test(styleAttr)) {
      el.setAttribute('style', styleAttr.replace(/currentcolor/gi, ownColor));
    }
  }

  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
  }

  return clone.outerHTML;
}
