// Shared contract between the browser capture script and the Figma plugin.
// Keep this file in lockstep: plugin/src/schema.ts is a copy.

export type Color = { r: number; g: number; b: number; a: number }; // 0..1

export type Paint =
  | { type: 'solid'; color: Color }
  | { type: 'image'; dataUrl: string; scaleMode: 'FILL' | 'FIT' | 'TILE' };

export type Stroke = {
  color: Color;
  width: number;
  sides: 'all' | 'top' | 'right' | 'bottom' | 'left';
};

export type Shadow = {
  type: 'drop' | 'inner';
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: Color;
};

export type CornerRadius = number | [number, number, number, number]; // TL TR BR BL

export type Style = {
  fills?: Paint[];
  strokes?: Stroke[];
  cornerRadius?: CornerRadius;
  effects?: Shadow[];
  opacity?: number;
  clipsContent?: boolean;
  /** Which CSS axis is set to clip/scroll/hidden. Drives per-axis growth in
   *  the builder so a `overflow-y: auto` panel still expands horizontally if
   *  its content needs to, and an `overflow-x: auto` scroller keeps its
   *  captured width while still stretching down. */
  clipAxes?: 'x' | 'y' | 'both';
};

export type LineHeight =
  | { unit: 'PIXELS'; value: number }
  | { unit: 'AUTO' };

export type LetterSpacing = { unit: 'PIXELS'; value: number };

export type TextAlign = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
export type TextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';

export type TextProps = {
  characters: string;         // \n baked in from browser's reflowed line boxes
  fontFamily: string;
  fontStyle: string;          // 'Regular' | 'Medium' | 'Bold' | 'Bold Italic' | ...
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  color: Color;
  textAlign: TextAlign;
  textDecoration: TextDecoration;
  textCase: TextCase;
  width: number;              // content-box width — used as frame width, autoResize: HEIGHT
};

export type NodeKind = 'frame' | 'text' | 'svg' | 'image';

export type LayoutAxis = 'horizontal' | 'vertical';
export type LayoutAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'BASELINE';

export type Layout = {
  axis: LayoutAxis;
  gap: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  /** Cross-axis alignment (maps CSS `align-items`). */
  alignItems: LayoutAlign;
  /** Primary-axis distribution (maps CSS `justify-content`). */
  justifyContent: LayoutAlign;
  /** `flex-wrap: wrap` was present — skip AL for this frame, we don't handle wrap. */
  wrap: boolean;
  /** Kind: 'flex' or 'grid-1d'. v1 only applies flex. */
  source: 'flex' | 'grid';
};

export type ImageData = {
  dataUrl: string;
  intrinsicW: number;
  intrinsicH: number;
};

export type Bounds = { x: number; y: number; w: number; h: number }; // page coords

export type Node = {
  type: NodeKind;
  name: string;
  bounds: Bounds;
  style?: Style;
  text?: TextProps;
  svgRaw?: string;
  imageData?: ImageData;
  children?: Node[];
  /** CSS-derived layout hint for optional Auto Layout conversion. */
  layout?: Layout;
  /** Child was `position: absolute|fixed|sticky` — stays out of parent's AL flow. */
  isAbsolute?: boolean;
  /** `flex-grow > 0` → child should Fill Container on its parent's primary axis. */
  flexGrow?: number;
};

export type Envelope = {
  captureVersion: 1;
  capturedAt: number;
  url: string;
  viewport: { w: number; h: number };
  /** Optional breakpoint label, e.g. { label: 'Mobile', width: 375 }. */
  breakpoint?: { label: string; width: number; height: number };
  root: Node;
};

export const CAPTURE_VERSION = 1 as const;
