"use strict";
(() => {
  // capture/src/schema.ts
  var CAPTURE_VERSION = 1;

  // capture/src/geometry.ts
  function pageBoundsOf(rect, el) {
    const win = el?.ownerDocument?.defaultView ?? window;
    return {
      x: rect.left + win.scrollX,
      y: rect.top + win.scrollY,
      w: rect.width,
      h: rect.height
    };
  }

  // capture/src/style.ts
  function parseColor(cssColor) {
    if (!cssColor || cssColor === "transparent" || cssColor === "none") return null;
    const m = cssColor.match(/rgba?\(([^)]+)\)/i);
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
  function extractFills(cs) {
    const fills = [];
    const bg = parseColor(cs.backgroundColor);
    if (bg) fills.push({ type: "solid", color: bg });
    return fills;
  }
  function extractStrokes(cs) {
    const sides = [
      { side: "top", w: parseFloat(cs.borderTopWidth) || 0, color: parseColor(cs.borderTopColor), style: cs.borderTopStyle },
      { side: "right", w: parseFloat(cs.borderRightWidth) || 0, color: parseColor(cs.borderRightColor), style: cs.borderRightStyle },
      { side: "bottom", w: parseFloat(cs.borderBottomWidth) || 0, color: parseColor(cs.borderBottomColor), style: cs.borderBottomStyle },
      { side: "left", w: parseFloat(cs.borderLeftWidth) || 0, color: parseColor(cs.borderLeftColor), style: cs.borderLeftStyle }
    ];
    const visible = sides.filter((s) => s.w > 0 && s.color && s.style !== "none" && s.style !== "hidden");
    if (visible.length === 0) return [];
    const first = visible[0];
    const allSame = visible.length === 4 && visible.every(
      (s) => s.w === first.w && s.color && first.color && s.color.r === first.color.r && s.color.g === first.color.g && s.color.b === first.color.b && s.color.a === first.color.a
    );
    if (allSame && first.color) {
      return [{ color: first.color, width: first.w, sides: "all" }];
    }
    const widest = visible.reduce((a, b) => b.w > a.w ? b : a);
    if (!widest.color) return [];
    return [{ color: widest.color, width: widest.w, sides: widest.side }];
  }
  function extractCornerRadius(cs) {
    const tl = parseFloat(cs.borderTopLeftRadius) || 0;
    const tr = parseFloat(cs.borderTopRightRadius) || 0;
    const br = parseFloat(cs.borderBottomRightRadius) || 0;
    const bl = parseFloat(cs.borderBottomLeftRadius) || 0;
    if (tl === 0 && tr === 0 && br === 0 && bl === 0) return void 0;
    if (tl === tr && tr === br && br === bl) return tl;
    return [tl, tr, br, bl];
  }
  function extractShadows(cs) {
    const raw = cs.boxShadow;
    if (!raw || raw === "none") return [];
    const entries = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        entries.push(raw.slice(start, i).trim());
        start = i + 1;
      }
    }
    entries.push(raw.slice(start).trim());
    const shadows = [];
    for (const entry of entries) {
      if (!entry) continue;
      const colorMatch = entry.match(/rgba?\([^)]+\)/i);
      if (!colorMatch) continue;
      const color = parseColor(colorMatch[0]);
      if (!color) continue;
      const rest = (entry.slice(0, colorMatch.index) + entry.slice(colorMatch.index + colorMatch[0].length)).trim();
      const isInset = /\binset\b/i.test(rest);
      const nums = rest.replace(/\binset\b/i, "").trim().split(/\s+/).map((s) => parseFloat(s));
      const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = nums;
      shadows.push({
        type: isInset ? "inner" : "drop",
        offsetX,
        offsetY,
        blur,
        spread,
        color
      });
    }
    return shadows;
  }
  function isClipping(cs) {
    const x = cs.overflowX;
    const y = cs.overflowY;
    return x === "hidden" || x === "clip" || y === "hidden" || y === "clip";
  }
  function mapAlignItems(v) {
    switch (v) {
      case "flex-start":
      case "start":
        return "MIN";
      case "center":
        return "CENTER";
      case "flex-end":
      case "end":
        return "MAX";
      case "baseline":
        return "BASELINE";
      case "stretch":
        return "MIN";
      // Figma AL has no "stretch" align; fill-container on children approximates
      default:
        return "MIN";
    }
  }
  function mapJustifyContent(v) {
    switch (v) {
      case "flex-start":
      case "start":
        return "MIN";
      case "center":
        return "CENTER";
      case "flex-end":
      case "end":
        return "MAX";
      case "space-between":
        return "SPACE_BETWEEN";
      case "space-around":
      case "space-evenly":
        return "SPACE_BETWEEN";
      // approximate
      default:
        return "MIN";
    }
  }
  function extractLayout(cs) {
    const d = cs.display;
    if (d === "flex" || d === "inline-flex") {
      const dir = cs.flexDirection || "row";
      const isRow = dir === "row" || dir === "row-reverse";
      const axisGap = isRow ? cs.columnGap : cs.rowGap;
      const gap = parseFloat(cs.gap) || parseFloat(axisGap) || 0;
      const wrap = cs.flexWrap === "wrap" || cs.flexWrap === "wrap-reverse";
      return {
        source: "flex",
        axis: isRow ? "horizontal" : "vertical",
        gap,
        paddingTop: parseFloat(cs.paddingTop) || 0,
        paddingRight: parseFloat(cs.paddingRight) || 0,
        paddingBottom: parseFloat(cs.paddingBottom) || 0,
        paddingLeft: parseFloat(cs.paddingLeft) || 0,
        alignItems: mapAlignItems(cs.alignItems),
        justifyContent: mapJustifyContent(cs.justifyContent),
        wrap
      };
    }
    return void 0;
  }
  function isAbsolutePositioned(cs) {
    return cs.position === "absolute" || cs.position === "fixed" || cs.position === "sticky";
  }
  function extractFlexGrow(cs) {
    const v = parseFloat(cs.flexGrow);
    return Number.isNaN(v) ? 0 : v;
  }
  function extractStyle(cs) {
    const style = {};
    const fills = extractFills(cs);
    if (fills.length) style.fills = fills;
    const strokes = extractStrokes(cs);
    if (strokes.length) style.strokes = strokes;
    const r = extractCornerRadius(cs);
    if (r !== void 0) style.cornerRadius = r;
    const eff = extractShadows(cs);
    if (eff.length) style.effects = eff;
    const opacity = parseFloat(cs.opacity);
    if (!Number.isNaN(opacity) && opacity < 1) style.opacity = opacity;
    if (isClipping(cs)) style.clipsContent = true;
    return style;
  }

  // capture/src/text.ts
  function firstFontFamily(cssFamily) {
    const first = cssFamily.split(",")[0] || "Inter";
    return first.trim().replace(/^['"]|['"]$/g, "");
  }
  var WEIGHT_NAMES = {
    100: "Thin",
    200: "ExtraLight",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "SemiBold",
    700: "Bold",
    800: "ExtraBold",
    900: "Black"
  };
  function mapFontStyle(weight, fontStyle) {
    const w = parseInt(weight, 10);
    const base = WEIGHT_NAMES[Math.round(w / 100) * 100] ?? "Regular";
    const italic = fontStyle === "italic" || fontStyle === "oblique";
    if (italic && base === "Regular") return "Italic";
    return italic ? `${base} Italic` : base;
  }
  function parseLineHeight(cssLineHeight, _fontSize) {
    if (cssLineHeight === "normal") return { unit: "AUTO" };
    const v = parseFloat(cssLineHeight);
    if (Number.isNaN(v)) return { unit: "AUTO" };
    return { unit: "PIXELS", value: v };
  }
  function parseLetterSpacing(cssLetterSpacing) {
    if (cssLetterSpacing === "normal") return { unit: "PIXELS", value: 0 };
    const v = parseFloat(cssLetterSpacing);
    if (Number.isNaN(v)) return { unit: "PIXELS", value: 0 };
    return { unit: "PIXELS", value: v };
  }
  function mapTextAlign(cssAlign) {
    switch (cssAlign) {
      case "center":
        return "CENTER";
      case "right":
        return "RIGHT";
      case "end":
        return "RIGHT";
      case "justify":
        return "JUSTIFIED";
      default:
        return "LEFT";
    }
  }
  function mapTextCase(cssTransform) {
    switch (cssTransform) {
      case "uppercase":
        return "UPPER";
      case "lowercase":
        return "LOWER";
      case "capitalize":
        return "TITLE";
      default:
        return "ORIGINAL";
    }
  }
  function mapTextDecoration(cssDecoration) {
    if (/underline/.test(cssDecoration)) return "UNDERLINE";
    if (/line-through/.test(cssDecoration)) return "STRIKETHROUGH";
    return "NONE";
  }
  function collapseSpaces(s) {
    return s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n");
  }
  function reflowedTextFromRange(range) {
    const text = range.toString();
    if (!text) return "";
    const lineRects = Array.from(range.getClientRects());
    if (lineRects.length <= 1) return collapseSpaces(text).trim();
    const container = range.startContainer;
    if (container.nodeType !== 3) return collapseSpaces(text).trim();
    const textNode = container;
    const doc = textNode.ownerDocument ?? document;
    const start = range.startOffset;
    const end = range.endOffset;
    const out = [];
    let currentLine = 0;
    const r = doc.createRange();
    for (let i = start; i < end; i++) {
      r.setStart(textNode, i);
      r.setEnd(textNode, i + 1);
      const charRect = r.getBoundingClientRect();
      if (charRect.width === 0 && charRect.height === 0) {
        continue;
      }
      const centerY = charRect.top + charRect.height / 2;
      while (currentLine < lineRects.length - 1 && centerY > lineRects[currentLine].bottom) {
        currentLine++;
        out.push("\n");
      }
      out.push(textNode.nodeValue.charAt(i));
    }
    return collapseSpaces(out.join("")).trim();
  }
  function reflowedTextFromElement(el) {
    const parts = [];
    const doc = el.ownerDocument ?? document;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? "";
      if (!value || !value.trim()) continue;
      const r = doc.createRange();
      r.selectNodeContents(node);
      const piece = reflowedTextFromRange(r);
      if (piece) parts.push(piece);
    }
    return parts.join(" ").replace(/ \n/g, "\n").replace(/\n /g, "\n");
  }
  function buildTextProps(el, cs) {
    const characters = reflowedTextFromElement(el);
    if (!characters) return null;
    const rect = el.getBoundingClientRect();
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const width = Math.max(1, rect.width - padLeft - padRight);
    return buildTextPropsCommon(cs, characters, width);
  }
  function buildTextPropsFromRange(cs, characters, rect) {
    const width = Math.max(1, rect.width);
    return buildTextPropsCommon(cs, characters, width);
  }
  function buildTextPropsCommon(cs, characters, width) {
    const color = parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
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
      width
    };
  }

  // capture/src/svg.ts
  function resolveSvgForFigma(svg) {
    const clone = svg.cloneNode(true);
    const cs = getComputedStyle(svg);
    const ownColor = cs.color;
    clone.setAttribute("color", ownColor);
    const all = [clone, ...Array.from(clone.querySelectorAll("*"))];
    for (const el of all) {
      for (const attr of ["fill", "stroke"]) {
        const v = el.getAttribute(attr);
        if (v && /currentcolor/i.test(v)) el.setAttribute(attr, ownColor);
      }
      const styleAttr = el.getAttribute("style");
      if (styleAttr && /currentcolor/i.test(styleAttr)) {
        el.setAttribute("style", styleAttr.replace(/currentcolor/gi, ownColor));
      }
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      clone.setAttribute("width", String(rect.width));
      clone.setAttribute("height", String(rect.height));
    }
    return clone.outerHTML;
  }

  // capture/src/images.ts
  var MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  async function imageToDataUrl(src, displayedW, displayedH) {
    if (!src) return null;
    try {
      const res = await fetch(src, { mode: "cors" });
      if (!res.ok) return null;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob).catch(() => null);
      const iw = bitmap?.width ?? displayedW;
      const ih = bitmap?.height ?? displayedH;
      if (blob.size <= MAX_IMAGE_BYTES) {
        const dataUrl2 = await blobToDataUrl(blob);
        bitmap?.close();
        return { dataUrl: dataUrl2, intrinsicW: iw, intrinsicH: ih };
      }
      const targetW = Math.min(iw, Math.max(1, Math.ceil(displayedW * 2)));
      const targetH = Math.min(ih, Math.max(1, Math.ceil(displayedH * 2)));
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx || !bitmap) {
        bitmap?.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      bitmap.close();
      const dataUrl = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
          if (!b) {
            reject(new Error("toBlob failed"));
            return;
          }
          blobToDataUrl(b).then(resolve, reject);
        }, "image/png");
      });
      return { dataUrl, intrinsicW: iw, intrinsicH: ih };
    } catch {
      return null;
    }
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  function firstBackgroundUrl(cssBackgroundImage) {
    if (!cssBackgroundImage || cssBackgroundImage === "none") return null;
    if (/gradient\s*\(/i.test(cssBackgroundImage)) return null;
    const m = cssBackgroundImage.match(/url\((['"]?)(.*?)\1\)/i);
    return m ? m[2] : null;
  }

  // capture/src/walker.ts
  function isHidden(el, cs) {
    if (cs.display === "none") return true;
    if (cs.visibility === "hidden") return true;
    if (cs.visibility === "collapse") return true;
    if (parseFloat(cs.opacity) === 0) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return true;
    return false;
  }
  var SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "TITLE", "HEAD", "BR"]);
  function isCaptureUi(el) {
    return el.hasAttribute("data-figma-capture-ui") || !!el.closest("[data-figma-capture-ui]");
  }
  function hasVisualStyle(cs) {
    if (parseColor(cs.backgroundColor)) return true;
    if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
    if (parseFloat(cs.borderTopWidth) > 0) return true;
    if (parseFloat(cs.borderRightWidth) > 0) return true;
    if (parseFloat(cs.borderBottomWidth) > 0) return true;
    if (parseFloat(cs.borderLeftWidth) > 0) return true;
    if (parseFloat(cs.borderTopLeftRadius) > 0) return true;
    if (parseFloat(cs.borderTopRightRadius) > 0) return true;
    if (parseFloat(cs.borderBottomLeftRadius) > 0) return true;
    if (parseFloat(cs.borderBottomRightRadius) > 0) return true;
    if (cs.boxShadow && cs.boxShadow !== "none") return true;
    if (parseFloat(cs.opacity) < 1) return true;
    if (parseFloat(cs.paddingTop) > 0 || parseFloat(cs.paddingRight) > 0 || parseFloat(cs.paddingBottom) > 0 || parseFloat(cs.paddingLeft) > 0) return true;
    return false;
  }
  function hasElementChildren(el) {
    return el.children.length > 0;
  }
  function hasTextContent(el) {
    return (el.textContent ?? "").trim().length > 0;
  }
  function isTextLeaf(el, cs) {
    if (hasElementChildren(el)) return false;
    if (!hasTextContent(el)) return false;
    return !hasVisualStyle(cs);
  }
  function nodeKindFor(el, cs) {
    const tag = el.tagName;
    if (tag === "svg") return "svg";
    if (tag === "IMG") return "image";
    if (tag === "INPUT") return "frame";
    if (isTextLeaf(el, cs)) return "text";
    return "frame";
  }
  function debugNameFor(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList && el.classList.length ? `.${el.classList[0]}` : "";
    return `${tag}${id}${cls}`;
  }
  function walkTextNode(textNode, parentCs) {
    const value = textNode.nodeValue ?? "";
    if (!value || !value.trim()) return null;
    const doc = textNode.ownerDocument ?? document;
    const range = doc.createRange();
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const characters = reflowedTextFromRange(range);
    if (!characters || !characters.trim()) return null;
    const text = buildTextPropsFromRange(parentCs, characters, rect);
    const preview = characters.replace(/\s+/g, " ").trim().slice(0, 24);
    const parent = textNode.parentElement ?? void 0;
    return {
      type: "text",
      name: `#text "${preview}"`,
      bounds: pageBoundsOf(rect, parent),
      text
    };
  }
  async function walkElement(el) {
    if (SKIP_TAGS.has(el.tagName)) return null;
    if (isCaptureUi(el)) return null;
    const cs = getComputedStyle(el);
    if (isHidden(el, cs)) return null;
    const rect = el.getBoundingClientRect();
    const type = nodeKindFor(el, cs);
    const base = {
      type,
      name: debugNameFor(el),
      bounds: pageBoundsOf(rect, el)
    };
    if (type === "frame" || type === "image") {
      const style = extractStyle(cs);
      if (Object.keys(style).length) base.style = style;
    }
    if (type === "frame") {
      const layout = extractLayout(cs);
      if (layout) base.layout = layout;
    }
    if (isAbsolutePositioned(cs)) base.isAbsolute = true;
    const fg = extractFlexGrow(cs);
    if (fg > 0) base.flexGrow = fg;
    if (type === "svg") {
      base.svgRaw = resolveSvgForFigma(el);
      return base;
    }
    if (type === "image") {
      const img = el;
      const bgUrl = firstBackgroundUrl(cs.backgroundImage);
      const src = bgUrl || img.currentSrc || img.src;
      if (src) {
        const imageData = await imageToDataUrl(src, rect.width, rect.height);
        if (imageData) {
          base.imageData = imageData;
          const imagePaint = { type: "image", dataUrl: imageData.dataUrl, scaleMode: "FILL" };
          base.style = { ...base.style || {}, fills: [...base.style?.fills || [], imagePaint] };
        }
      }
      return base;
    }
    if (type === "frame") {
      const bgUrl = firstBackgroundUrl(cs.backgroundImage);
      if (bgUrl) {
        const imageData = await imageToDataUrl(bgUrl, rect.width, rect.height);
        if (imageData) {
          const imagePaint = { type: "image", dataUrl: imageData.dataUrl, scaleMode: "FILL" };
          base.style = { ...base.style || {}, fills: [...base.style?.fills || [], imagePaint] };
        }
      }
    }
    if (type === "text") {
      const tp = buildTextProps(el, cs);
      if (tp) base.text = tp;
      return base;
    }
    const children = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) {
        const c = await walkElement(child);
        if (c) children.push(c);
      } else if (child.nodeType === 3) {
        const c = walkTextNode(child, cs);
        if (c) children.push(c);
      }
    }
    if (children.length) base.children = children;
    return base;
  }

  // capture/src/index.ts
  var LAST_OPTS_KEY = "__figma_capture_last_opts";
  var PRESETS = [
    { label: "Mobile", width: 375, height: 812 },
    { label: "Tablet", width: 768, height: 1024 },
    { label: "Laptop", width: 1200, height: 800 },
    { label: "Desktop", width: 1440, height: 900 },
    { label: "Wide", width: 1920, height: 1080 }
  ];
  function loadLastOpts() {
    try {
      const raw = localStorage.getItem(LAST_OPTS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function saveLastOpts(opts) {
    try {
      localStorage.setItem(LAST_OPTS_KEY, JSON.stringify(opts));
    } catch {
    }
  }
  function showPanel() {
    document.querySelectorAll("[data-figma-capture-ui]").forEach((n) => n.remove());
    const last = loadLastOpts();
    const overlay = document.createElement("div");
    overlay.setAttribute("data-figma-capture-ui", "1");
    overlay.setAttribute("style", `
    position:fixed;inset:0;z-index:2147483646;
    background:rgba(10,10,12,0.55);backdrop-filter:blur(4px);
    display:flex;align-items:center;justify-content:center;
    font:13px/1.4 -apple-system,system-ui,sans-serif;color:#111;
  `);
    const panel = document.createElement("div");
    panel.setAttribute("style", `
    width:460px;max-width:94vw;background:#fff;border-radius:14px;padding:18px;
    box-shadow:0 24px 60px rgba(0,0,0,0.35);
  `);
    const currentW = window.innerWidth;
    const currentH = window.innerHeight;
    panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <div style="font-weight:600;font-size:14px;">Capture to Figma</div>
      <button data-close style="background:transparent;border:none;font-size:18px;color:#888;cursor:pointer;padding:2px 8px;line-height:1;">\u2715</button>
    </div>

    <div style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#666;margin-bottom:6px;">Capture at breakpoint</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;" id="__fc_bp_grid"></div>

    <div style="border-top:1px solid #eee;padding-top:14px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#666;margin-bottom:6px;">Or capture current viewport</div>
      <input id="__fc_label" type="text" placeholder="Custom label (optional)" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font:inherit;outline:none;margin-bottom:10px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:12px;user-select:none;font-size:12px;">
        <input type="checkbox" id="__fc_scroll" ${last.scrollThrough === false ? "" : "checked"}>
        <span>Scroll through page to trigger lazy loads</span>
      </label>
      <div style="display:flex;gap:8px;">
        <button id="__fc_capture_here" style="flex:1;padding:10px 14px;background:#111827;color:#fff;border:none;border-radius:8px;font:600 13px/1 -apple-system,system-ui,sans-serif;cursor:pointer;">
          Capture current (${currentW} \xD7 ${currentH})
        </button>
      </div>
    </div>
  `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const bpGrid = panel.querySelector("#__fc_bp_grid");
    for (const p of PRESETS) {
      const card = document.createElement("button");
      card.setAttribute("style", `
      display:flex;flex-direction:column;align-items:flex-start;gap:2px;
      padding:10px 12px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;
      cursor:pointer;text-align:left;transition:border-color .12s, background .12s;
      font:inherit;
    `);
      card.innerHTML = `
      <span style="font-weight:600;font-size:12.5px;color:#111;">${p.label}</span>
      <span style="font-size:11.5px;color:#777;">${p.width} \xD7 ${p.height}</span>
    `;
      card.onmouseenter = () => {
        card.style.borderColor = "#16a34a";
        card.style.background = "#f0fdf4";
      };
      card.onmouseleave = () => {
        card.style.borderColor = "#e4e4e7";
        card.style.background = "#fff";
      };
      card.onclick = () => {
        overlay.remove();
        openIframePreview(p.label, p.width, p.height).catch((err) => {
          console.error("[figma-capture] iframe flow failed:", err);
          showToast(`Iframe capture failed: ${err instanceof Error ? err.message : err}`, "error");
        });
      };
      bpGrid.appendChild(card);
    }
    const close = () => overlay.remove();
    panel.querySelector("[data-close]").onclick = close;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    const labelInput = panel.querySelector("#__fc_label");
    panel.querySelector("#__fc_capture_here").onclick = () => {
      const scrollThrough = panel.querySelector("#__fc_scroll").checked;
      const finalLabel = labelInput.value.trim();
      close();
      const opts = {
        scrollThrough,
        breakpointLabel: finalLabel || void 0,
        breakpointWidth: currentW
      };
      saveLastOpts(opts);
      captureNow(opts).catch((err) => {
        console.error("[figma-capture] failed:", err);
        showToast("Capture failed \u2014 see console", "error");
      });
    };
  }
  async function openIframePreview(label, targetW, targetH) {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-figma-capture-ui", "1");
    const margin = 80;
    const availW = window.innerWidth - margin;
    const availH = window.innerHeight - margin - 60;
    const scale = Math.min(1, availW / targetW, availH / targetH);
    const scaledW = Math.round(targetW * scale);
    const scaledH = Math.round(targetH * scale);
    overlay.setAttribute("style", `
    position:fixed;inset:0;z-index:2147483646;
    background:rgba(10,10,12,0.8);backdrop-filter:blur(4px);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    font:13px/1.4 -apple-system,system-ui,sans-serif;color:#fff;
  `);
    overlay.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="font-weight:600;font-size:14px;">${label} \xB7 ${targetW} \xD7 ${targetH}px${scale < 1 ? ` (displayed at ${Math.round(scale * 100)}%)` : ""}</div>
      <span id="__fc_load_status" style="font-size:12px;color:#a1a1aa;">Loading\u2026</span>
    </div>
    <div style="width:${scaledW}px;height:${scaledH}px;box-shadow:0 24px 60px rgba(0,0,0,0.5);border-radius:8px;overflow:hidden;background:#fff;">
      <div style="width:${targetW}px;height:${targetH}px;transform:scale(${scale});transform-origin:0 0;">
        <iframe id="__fc_iframe" src="${location.href}" style="width:${targetW}px;height:${targetH}px;border:none;display:block;"></iframe>
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <button id="__fc_iframe_capture" disabled style="padding:10px 18px;background:#16a34a;color:#fff;border:none;border-radius:8px;font:600 13px/1 inherit;cursor:pointer;opacity:.5;">
        Capture this preview
      </button>
      <button id="__fc_iframe_cancel" style="padding:10px 18px;background:rgba(255,255,255,0.14);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:8px;font:600 13px/1 inherit;cursor:pointer;">
        Cancel
      </button>
    </div>
    <div style="font-size:11px;color:#a1a1aa;max-width:${scaledW}px;text-align:center;line-height:1.5;">
      The page is loaded fresh in an iframe at ${targetW}px wide, so CSS media queries fire at that breakpoint.
      Interact with it if needed (scroll, click in), then press Capture.
    </div>
  `;
    document.body.appendChild(overlay);
    const iframe = overlay.querySelector("#__fc_iframe");
    const btn = overlay.querySelector("#__fc_iframe_capture");
    const status = overlay.querySelector("#__fc_load_status");
    const cancel = overlay.querySelector("#__fc_iframe_cancel");
    cancel.onclick = () => overlay.remove();
    let loaded = false;
    await new Promise((res) => {
      const done = () => {
        if (!loaded) {
          loaded = true;
          res();
        }
      };
      iframe.addEventListener("load", done, { once: true });
      setTimeout(done, 8e3);
    });
    try {
      const _probe = iframe.contentDocument;
      if (!_probe) throw new Error("iframe document not accessible");
    } catch {
      overlay.remove();
      throw new Error(`Cross-origin iframe blocked. ${location.hostname} likely sets X-Frame-Options or a CSP that prevents same-origin framing. Use "Capture current" instead.`);
    }
    status.textContent = "Ready";
    btn.disabled = false;
    btn.style.opacity = "1";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Capturing\u2026";
      try {
        await captureFromIframe(iframe, label, targetW, targetH);
      } catch (err) {
        console.error(err);
        showToast("Capture failed \u2014 see console", "error");
      } finally {
        overlay.remove();
      }
    };
  }
  async function captureFromIframe(iframe, label, targetW, targetH) {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc) throw new Error("iframe not ready");
    await preloadInIframe(win, doc);
    showToast("Capturing iframe\u2026", "info");
    const t0 = performance.now();
    const root = await walkElement(doc.body);
    if (!root) {
      showToast("Nothing visible in iframe", "error");
      return;
    }
    const envelope = {
      captureVersion: CAPTURE_VERSION,
      capturedAt: Date.now(),
      url: win.location.href,
      viewport: {
        w: Math.max(doc.documentElement.scrollWidth, targetW),
        h: Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, targetH)
      },
      breakpoint: { label, width: targetW, height: targetH },
      root
    };
    const json = JSON.stringify(envelope);
    const ms = Math.round(performance.now() - t0);
    const copied = await copyToClipboard(json);
    const nodeCount = countNodes(root);
    const size = `${(json.length / 1024).toFixed(0)} KB`;
    const action = { json, slug: slugForUrl(envelope.url, label) };
    if (copied) {
      console.log(`[figma-capture] iframe ${label} \xB7 ${nodeCount} nodes, ${json.length} chars (${ms}ms)`);
      showToast(`Copied ${nodeCount} nodes (${size}) \xB7 ${label}. Paste into Figma plugin.`, "success", action);
    } else {
      showToast(`Clipboard blocked. Click Save .json to download (${nodeCount} nodes, ${size}).`, "error", action);
    }
  }
  async function preloadInIframe(win, doc) {
    const BUDGET_MS = 2500;
    const start = performance.now();
    const html = doc.documentElement;
    const body = doc.body;
    const docH = () => Math.max(body.scrollHeight, html.scrollHeight);
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      if (performance.now() - start > BUDGET_MS) break;
      const y = Math.round(docH() * frac);
      html.scrollTop = y;
      body.scrollTop = y;
      await sleep(140);
    }
    const internal = [];
    const all = doc.querySelectorAll("*");
    for (const el of Array.from(all)) {
      const cs = win.getComputedStyle(el);
      const ySc = (cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight - el.clientHeight > 200;
      if (ySc) internal.push(el);
    }
    for (const el of internal) {
      if (performance.now() - start > BUDGET_MS) break;
      for (const frac of [0.5, 1]) {
        el.scrollTop = Math.round(el.scrollHeight * frac);
        await sleep(90);
      }
    }
    const remaining = Math.max(300, BUDGET_MS - (performance.now() - start));
    await waitForImagesInDoc(doc, Math.min(1500, remaining));
    html.scrollTop = 0;
    body.scrollTop = 0;
    for (const el of internal) el.scrollTop = 0;
    await sleep(80);
  }
  async function waitForImagesInDoc(doc, timeoutMs) {
    const imgs = Array.from(doc.images || []);
    const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0);
    if (!pending.length) return;
    await Promise.race([
      Promise.all(pending.map((img) => new Promise((res) => {
        if (img.complete) return res();
        const done = () => res();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      }))),
      sleep(timeoutMs)
    ]);
  }
  async function captureNow(opts = {}) {
    const selector = opts.selector ?? "body";
    const rootEl = document.querySelector(selector);
    if (!rootEl) {
      showToast("Capture root not found", "error");
      return;
    }
    if (opts.scrollThrough !== false) {
      showToast("Loading lazy content...", "info");
      await preloadFullPage();
    }
    showToast("Capturing...", "info");
    const t0 = performance.now();
    const root = await walkElement(rootEl);
    if (!root) {
      showToast("Nothing visible to capture", "error");
      return;
    }
    const envelope = {
      captureVersion: CAPTURE_VERSION,
      capturedAt: Date.now(),
      url: location.href,
      viewport: {
        w: Math.max(document.documentElement.scrollWidth, window.innerWidth),
        h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      },
      root
    };
    if (opts.breakpointLabel || opts.breakpointWidth) {
      envelope.breakpoint = {
        label: opts.breakpointLabel ?? "",
        width: opts.breakpointWidth ?? window.innerWidth,
        height: window.innerHeight
      };
    }
    const json = JSON.stringify(envelope);
    const ms = Math.round(performance.now() - t0);
    const copied = await copyToClipboard(json);
    const nodeCount = countNodes(root);
    const suffix = envelope.breakpoint?.label ? ` \xB7 ${envelope.breakpoint.label}` : "";
    const size = `${(json.length / 1024).toFixed(0)} KB`;
    const action = { json, slug: slugForUrl(envelope.url, envelope.breakpoint?.label) };
    if (copied) {
      console.log(`[figma-capture] ${nodeCount} nodes, ${json.length} chars (${ms}ms)${suffix} \u2014 copied to clipboard`);
      showToast(`Copied ${nodeCount} nodes (${size})${suffix}. Paste into Figma plugin.`, "success", action);
    } else {
      console.warn(`[figma-capture] ${nodeCount} nodes (${ms}ms)${suffix} \u2014 clipboard blocked, use Save .json`);
      showToast(`Clipboard blocked. Click Save .json to download (${nodeCount} nodes, ${size}).`, "error", action);
    }
  }
  window.__captureToFigma = () => {
    showPanel();
    return Promise.resolve();
  };
  window.__captureToFigmaNow = captureNow;
  showPanel();
  function countNodes(n) {
    let c = 1;
    if (n.children) for (const ch of n.children) c += countNodes(ch);
    return c;
  }
  function slugForUrl(url, label) {
    try {
      const m = url.match(/^[a-z]+:\/\/([^/?#]+)([^?#]*)/i);
      const host = (m?.[1] ?? "page").replace(/[^a-z0-9]+/gi, "-");
      const pathPart = (m?.[2] ?? "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
      const lbl = (label ?? "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      return [host, pathPart, lbl, ts].filter(Boolean).join("_");
    } catch {
      return `capture-${Date.now()}`;
    }
  }
  function findScrollContainers() {
    const out = [];
    const all = document.querySelectorAll("*");
    for (const el of Array.from(all)) {
      if (el.hasAttribute("data-figma-capture-ui")) continue;
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      const ox = cs.overflowX;
      const ySc = (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 2;
      const xSc = (ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 2;
      if (ySc || xSc) out.push(el);
    }
    return out;
  }
  async function preloadFullPage() {
    const BUDGET_MS = 2500;
    const start = performance.now();
    const prevHtmlSb = document.documentElement.style.scrollBehavior;
    const prevBodySb = document.body.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    document.body.style.scrollBehavior = "auto";
    try {
      const containers = findScrollContainers().filter((el) => el.scrollHeight - el.clientHeight > 200);
      const docH = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      for (const frac of [0.25, 0.5, 0.75, 1]) {
        if (performance.now() - start > BUDGET_MS) break;
        const y = Math.round(docH() * frac);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
        await sleep(140);
      }
      for (const el of containers) {
        if (performance.now() - start > BUDGET_MS) break;
        for (const frac of [0.5, 1]) {
          const y = Math.round(el.scrollHeight * frac);
          el.scrollTop = y;
          await sleep(100);
        }
      }
      const remaining = Math.max(300, BUDGET_MS - (performance.now() - start));
      await waitForPendingImages(Math.min(1500, remaining));
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      for (const el of containers) el.scrollTop = 0;
      await sleep(100);
    } finally {
      document.documentElement.style.scrollBehavior = prevHtmlSb;
      document.body.style.scrollBehavior = prevBodySb;
    }
  }
  async function waitForPendingImages(timeoutMs = 2e3) {
    const imgs = Array.from(document.images || []);
    const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0);
    if (!pending.length) return;
    await Promise.race([
      Promise.all(pending.map((img) => new Promise((res) => {
        if (img.complete) return res();
        const done = () => res();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      }))),
      sleep(timeoutMs)
    ]);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn("navigator.clipboard.writeText failed:", err);
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.setAttribute("data-figma-capture-ui", "1");
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (err) {
      console.warn("execCommand copy failed:", err);
      return false;
    }
  }
  function showToast(msg, kind = "info", action) {
    const existing = document.getElementById("__figma_capture_toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "__figma_capture_toast";
    el.setAttribute("data-figma-capture-ui", "1");
    const bg = kind === "success" ? "#16a34a" : kind === "error" ? "#dc2626" : "#111827";
    el.setAttribute("style", `
    position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
    background:${bg};color:#fff;padding:12px 14px 12px 18px;border-radius:10px;
    font:500 13px/1.3 -apple-system,system-ui,sans-serif;
    box-shadow:0 12px 32px rgba(0,0,0,.4);z-index:2147483647;
    max-width:min(92vw,640px);display:flex;align-items:center;gap:12px;
  `);
    const label = document.createElement("span");
    label.textContent = msg;
    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    el.appendChild(label);
    if (action) {
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save .json";
      saveBtn.style.cssText = `
      font:500 12px/1 -apple-system,system-ui,sans-serif;color:#fff;
      background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);
      padding:6px 10px;border-radius:6px;cursor:pointer;flex-shrink:0;
    `;
      saveBtn.onmouseenter = () => saveBtn.style.background = "rgba(255,255,255,0.25)";
      saveBtn.onmouseleave = () => saveBtn.style.background = "rgba(255,255,255,0.15)";
      saveBtn.onclick = (ev) => {
        ev.stopPropagation();
        downloadJson(action.json, `${action.slug}.json`);
      };
      el.appendChild(saveBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.setAttribute("aria-label", "dismiss");
    closeBtn.style.cssText = `
    font:500 12px/1 -apple-system,system-ui,sans-serif;color:rgba(255,255,255,0.7);
    background:transparent;border:none;cursor:pointer;padding:4px 6px;flex-shrink:0;
  `;
    closeBtn.onclick = () => el.remove();
    el.appendChild(closeBtn);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), action ? 1e4 : 4e3);
  }
  function downloadJson(json, filename) {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.setAttribute("data-figma-capture-ui", "1");
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 0);
  }
})();
