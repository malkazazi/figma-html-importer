// Resolve currentColor / color inheritance on an <svg> before handing its
// outerHTML to Figma's createNodeFromSvg (which does NOT inherit from the DOM).

export function resolveSvgForFigma(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  const cs = getComputedStyle(svg);
  const ownColor = cs.color;

  // Inline the computed color at the SVG root so descendants that reference
  // currentColor still resolve correctly even if their own color prop isn't set.
  clone.setAttribute('color', ownColor);

  // Replace currentColor attribute values on every descendant.
  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const el of all) {
    for (const attr of ['fill', 'stroke']) {
      const v = el.getAttribute(attr);
      if (v && /currentcolor/i.test(v)) el.setAttribute(attr, ownColor);
    }
    // Also walk inline style attributes
    const styleAttr = el.getAttribute('style');
    if (styleAttr && /currentcolor/i.test(styleAttr)) {
      el.setAttribute('style', styleAttr.replace(/currentcolor/gi, ownColor));
    }
  }

  // Ensure explicit width/height so Figma sizes the vector to match the DOM.
  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
  }

  return clone.outerHTML;
}
