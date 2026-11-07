// The Paint workspace's texture editor: paint a model's texture in 2D, or on the model in the view, with tools made
// for pixel art as well as soft painting.
import { ed } from '../core/editor';
import { clearRegion, clipRect, copyRegion, dab, flipRegion, floodFill, hexToRgba, keepInside, linePixels, mapToPalette, pasteRegion, rectPixels, reducePalette, replaceColor, rgbaToHex, strokeLine, usedColors, type Brush, type Pixels, type Rect, type RGBA, type UsedColor } from '../core/paint';
import { app } from './app';
import { colorStore, openColorPicker } from './colorPicker';
import { button, checkbox, h, numField, select, svgIcon } from './dom';
import { status, toast } from './feedback';
import { addLayer, commitDoc, compositeAt, createTexture, deleteLayer, layoutForPainting, mergeDown, moveLayer, setLayer, onTexturesChanged, pushLive, setPixelated, texDoc, workingFaces, workingTexture, type TexDoc } from './textureDoc';

export type PaintToolId = 'pencil' | 'brush' | 'eraser' | 'fill' | 'line' | 'rect' | 'picker' | 'select';

/** Paint settings, shared by the texture panel and painting on the model. */
export const paint = {
  tool: 'pencil' as PaintToolId,
  primary: '#222034',
  secondary: '#ffffff',
  /** Pixels across. */
  size: 1,
  /** Soft brush only. */
  opacity: 1,
  hardness: 0.5,
  /** Pencil and eraser: round once wider than 2 pixels, or square. */
  round: false,
  /** Fill: how different a colour may be and still count as the same, 0..255; and whether to fill every match. */
  tolerance: 0,
  fillAll: false,
  rectFilled: false,
  /** Paint both sides of the texture's vertical centre line at once. */
  mirror: false,
};

const TOOL_INFO: Record<PaintToolId, { label: string; key: string; icon: string; hint: string }> = {
  pencil: { label: 'Pencil', key: 'P', icon: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>', hint: 'Hard pixels, for pixel art.' },
  brush: { label: 'Brush', key: 'B', icon: '<path d="M14 4l6 6-8 8-6-6z"/><path d="M6 12c-2 2-3 5-2 8 3 1 6 0 8-2"/>', hint: 'A soft round brush with opacity and hardness.' },
  eraser: { label: 'Eraser', key: 'E', icon: '<path d="M4 16l9-9 7 7-6 6H8z"/><path d="M9 11l6 6"/>', hint: 'Erases to transparent.' },
  fill: { label: 'Fill', key: 'G', icon: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M19 15c1 2 2 3 2 4a2 2 0 0 1-4 0c0-1 1-2 2-4z"/>', hint: 'Fills the area of one colour. Tolerance lets near colours count.' },
  line: { label: 'Line', key: 'L', icon: '<path d="M5 19L19 5"/>', hint: 'Drag a straight line.' },
  rect: { label: 'Rectangle', key: 'U', icon: '<rect x="5" y="6" width="14" height="12"/>', hint: 'Drag a rectangle, outlined or filled.' },
  picker: { label: 'Pick colour', key: 'I', icon: '<path d="M14 4l6 6-2 2-6-6z"/><path d="M12 8l-8 8v4h4l8-8"/>', hint: 'Click to take a colour. Alt with any tool picks too.' },
  select: { label: 'Select', key: 'S', icon: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2"/>', hint: 'Drag a rectangle to select; drag inside it to move what it holds. Painting stays inside. Delete clears it, Ctrl+C, X and V copy, cut and paste, H and V flip it, Ctrl+D lets go.' },
};

export function setPaintTool(t: PaintToolId) {
  paint.tool = t;
  status(`${TOOL_INFO[t].label}: ${TOOL_INFO[t].hint} Left click paints the main colour, right click the second. X swaps them.`);
  app.paintRefresh();
}

function brushFor(tool: PaintToolId): Brush {
  const pixelShape = paint.round ? 'round' : 'square';
  if (tool === 'brush') return { size: paint.size, shape: 'soft', opacity: paint.opacity, hardness: paint.hardness, erase: false };
  return { size: paint.size, shape: pixelShape, opacity: 1, hardness: 1, erase: tool === 'eraser' };
}

// ---------- the selection ----------
/** A rectangle of the texture, in pixels: painting stays inside it, and it can be moved, copied and flipped. */
export const selection = { rect: null as Rect | null };
let clipboard: Pixels | null = null;

// ---------- strokes ----------
/** A stroke under way, on the texture panel or on the model. */
interface Stroke {
  doc: TexDoc;
  tool: PaintToolId;
  color: RGBA;
  brush: Brush;
  covered: Map<number, number>;
  last: [number, number];
  start: [number, number];
  /** Lines and rectangles redraw from here as they're dragged; with a selection, pixels outside go back to it. */
  before: Uint8ClampedArray | null;
  changed: boolean;
  /** Painting on the model: where the brush last landed on each face across a UV seam, and on which move. */
  twins: Map<number, { x: number; y: number; gen: number }>;
  gen: number;
}
let stroke: Stroke | null = null;

export const strokeActive = () => stroke !== null;

/** Where a pixel position lands across the vertical centre line. */
const mirrorX = (d: TexDoc, x: number) => d.w - x;

/** With a selection, undo whatever a step painted outside it, within the area that step could have touched. */
function clip(s: Stroke, area: Rect) {
  if (selection.rect && s.before) keepInside(s.doc.img, s.before, selection.rect, area);
}

function lay(s: Stroke, ax: number, ay: number, bx: number, by: number) {
  strokeLine(s.doc.img, ax, ay, bx, by, s.color, s.brush, s.covered);
  if (paint.mirror) strokeLine(s.doc.img, mirrorX(s.doc, ax), ay, mirrorX(s.doc, bx), by, s.color, s.brush, s.covered);
  const r = s.brush.size + 2;
  const box = (x0: number, x1: number): Rect => ({ x: Math.floor(Math.min(x0, x1) - r), y: Math.floor(Math.min(ay, by) - r), w: Math.ceil(Math.abs(x1 - x0) + r * 2) + 1, h: Math.ceil(Math.abs(by - ay) + r * 2) + 1 });
  clip(s, box(ax, bx));
  if (paint.mirror) clip(s, box(mirrorX(s.doc, ax), mirrorX(s.doc, bx)));
}

function shape(s: Stroke, x: number, y: number) {
  s.doc.img.data.set(s.before!);
  const pts = s.tool === 'line' ? linePixels(s.start[0], s.start[1], x, y) : rectPixels(s.start[0], s.start[1], x, y, paint.rectFilled);
  // Lines and rectangles take the pencil's width.
  const b: Brush = { ...brushFor('pencil'), size: paint.size };
  const covered = new Map<number, number>();
  for (const [px, py] of pts) {
    dab(s.doc.img, px + 0.5, py + 0.5, s.color, b, covered);
    if (paint.mirror) dab(s.doc.img, mirrorX(s.doc, px + 0.5), py + 0.5, s.color, b, covered);
  }
  clip(s, { x: 0, y: 0, w: s.doc.w, h: s.doc.h });
}

/**
 * Start painting at pixel (x, y). `second` paints with the second colour. `pick` takes a colour whatever the tool.
 * Returns whether a stroke began (fill and pick finish at once).
 */
export function strokeBegin(d: TexDoc, x: number, y: number, second: boolean, pick = false): boolean {
  const tool: PaintToolId = pick ? 'picker' : paint.tool;
  if (tool === 'picker') {
    // Pick what you see: all layers combined.
    const c = compositeAt(d, x, y);
    if (c && c[3] > 0) {
      const hex = rgbaToHex(c);
      if (second) paint.secondary = hex; else paint.primary = hex;
      colorStore.remember(hex);
      status(`Picked ${hex}.`);
      app.paintRefresh();
    }
    return false;
  }
  const color = hexToRgba(second ? paint.secondary : paint.primary);
  if (tool === 'select') return false;
  if (tool === 'fill') {
    const before = selection.rect ? d.img.data.slice() : null;
    let n = floodFill(d.img, x, y, color, paint.tolerance, false, paint.fillAll);
    if (paint.mirror) n += floodFill(d.img, mirrorX(d, x), y, color, paint.tolerance, false, paint.fillAll);
    // A selection keeps the fill inside it.
    if (before && selection.rect) keepInside(d.img, before, selection.rect, { x: 0, y: 0, w: d.w, h: d.h });
    if (n) { pushLive(d); commitDoc(d, 'Fill'); }
    return false;
  }
  stroke = { doc: d, tool, color, brush: brushFor(tool), covered: new Map(), last: [x, y], start: [x, y], before: selection.rect ? d.img.data.slice() : null, changed: false, twins: new Map(), gen: 0 };
  if (tool === 'line' || tool === 'rect') { stroke.before = d.img.data.slice(); shape(stroke, x, y); }
  else lay(stroke, x, y, x, y);
  stroke.changed = true;
  pushLive(d);
  return true;
}

/** Continue the stroke to pixel (x, y). `jump` starts afresh there instead of joining, for a jump across a UV seam. */
export function strokeMove(x: number, y: number, jump = false) {
  const s = stroke;
  if (!s) return;
  if (s.tool === 'line' || s.tool === 'rect') shape(s, x, y);
  else if (jump) lay(s, x, y, x, y);
  else lay(s, s.last[0], s.last[1], x, y);
  s.last = [x, y];
  s.changed = true;
  s.gen++;
  pushLive(s.doc);
}

/** Whether the stroke paints with a brush tip, so painting on the model carries it across UV seams. */
export const strokeHasTip = () => !!stroke && (stroke.tool === 'pencil' || stroke.tool === 'brush' || stroke.tool === 'eraser');

/**
 * Paint the same stroke where it also reaches across a UV seam: at pixel (x, y), `size` pixels wide, on face `key`.
 * Joins up with that face's last spot if it was painted on this move or the one before. Shows nothing until the next
 * strokeMove or strokeFlush.
 */
export function strokeAlso(key: number, x: number, y: number, size: number) {
  const s = stroke;
  if (!s || !strokeHasTip() || size < 0.5) return;
  const prev = s.twins.get(key);
  const join = prev && prev.gen >= s.gen - 1 && Math.hypot(x - prev.x, y - prev.y) <= Math.max(12, size * 4);
  const tip = s.brush;
  s.brush = { ...tip, size };
  if (join) lay(s, prev.x, prev.y, x, y); else lay(s, x, y, x, y);
  s.brush = tip;
  s.twins.set(key, { x, y, gen: s.gen });
  s.changed = true;
}

export function strokeFlush() { if (stroke) pushLive(stroke.doc); }

export function strokeEnd() {
  const s = stroke;
  stroke = null;
  if (!s || !s.changed) return;
  commitDoc(s.doc, TOOL_INFO[s.tool].label);
  colorStore.remember(rgbaToHex(s.color));
}

// ---------- selection actions, on the active layer ----------
export function selectionClear(d: TexDoc) {
  if (!selection.rect) return;
  clearRegion(d.img, selection.rect);
  pushLive(d); commitDoc(d, 'Clear selection');
}

export function selectionCopy(d: TexDoc, cut = false) {
  if (!selection.rect) return;
  clipboard = copyRegion(d.img, selection.rect);
  if (cut) { clearRegion(d.img, selection.rect); pushLive(d); commitDoc(d, 'Cut'); }
  status(`${cut ? 'Cut' : 'Copied'} ${selection.rect.w}×${selection.rect.h} pixels.`);
}

/** Paste what was copied onto the active layer: at the selection's corner, or the top left. It becomes the selection. */
export function selectionPaste(d: TexDoc) {
  if (!clipboard) { status('Copy something first.'); return; }
  const x = selection.rect?.x ?? 0, y = selection.rect?.y ?? 0;
  pasteRegion(d.img, clipboard, x, y);
  selection.rect = { x, y, w: clipboard.width, h: clipboard.height };
  pushLive(d); commitDoc(d, 'Paste');
}

export function selectionFlip(d: TexDoc, axis: 'x' | 'y') {
  const r = selection.rect && clipRect(d.img, selection.rect);
  if (!r) return;
  const flipped = flipRegion(copyRegion(d.img, r), axis);
  pasteRegion(d.img, flipped, r.x, r.y, true);
  pushLive(d); commitDoc(d, axis === 'x' ? 'Flip selection' : 'Flip selection upside down');
}

// ---------- the panel ----------
export class PaintEditor {
  el: HTMLElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private bar: HTMLElement;
  private paletteEl: HTMLElement;
  private usedEl = h('div', { class: 'paint-chips used' });
  private usedTimer = 0;
  private layersEl: HTMLElement;
  private readout: HTMLElement;
  private zoom = 0;
  private panX = 0;
  private panY = 0;
  private fittedFor = -1;
  private mouse = { x: 0, y: 0, inside: false };
  private drag: { kind: 'pan'; x: number; y: number } | { kind: 'paint' }
    | { kind: 'select'; x: number; y: number }
    | { kind: 'move'; lift: Pixels; base: Uint8ClampedArray; from: Rect; x: number; y: number; moved: boolean } | null = null;
  private ants = 0;
  private spaceDown = false;
  private showGrid = true;
  private showWire = true;
  private newSize = 64;

  constructor() {
    this.cv = h('canvas', { class: 'paint-canvas', tabindex: '0' }) as HTMLCanvasElement;
    this.g = this.cv.getContext('2d')!;
    this.bar = h('div', { class: 'paint-bar' });
    this.paletteEl = h('div', { class: 'paint-palette' });
    this.layersEl = h('div', { class: 'paint-palette paint-layers' });
    this.readout = h('span', { class: 'muted small' });
    const wrap = h('div', { class: 'uv-wrap' }, this.cv);
    this.el = h('section', { class: 'uv-editor paint-editor', 'aria-label': 'Texture painting' }, this.bar, this.paletteEl, this.layersEl, wrap, h('div', { class: 'uv-foot' }, this.readout));
    new ResizeObserver(() => this.draw()).observe(wrap);
    this.bind();
    onTexturesChanged(() => { this.draw(); this.renderLayers(); this.queueUsed(); });
    ed.on(['selection', 'topology', 'geometry', 'materials', 'groups', 'history'], () => { this.renderBar(); this.draw(); });
    app.paintRefresh = () => { this.renderBar(); this.renderPalette(); this.renderLayers(); this.draw(); };
    // From the view: not the selection's keys, and S stays Scale there.
    app.paintKey = (e) => !e.ctrlKey && !e.metaKey && e.key !== ' ' && !['f', 's'].includes(e.key.toLowerCase()) && this.keyDown(e, false);
    // The selection's outline crawls while there is one.
    setInterval(() => { if (selection.rect && this.el.offsetParent !== null) { this.ants = (this.ants + 1) % 8; this.draw(); } }, 150);
    this.renderBar();
    this.renderPalette();
  }

  private doc(): TexDoc | null {
    const t = workingTexture();
    return t ? texDoc(t) : null;
  }

  // ---------- view ----------
  private fit(d: TexDoc) {
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (!W || !H) return;
    // Whole pixels per texel where it fits, so pixel art stays crisp.
    const z = Math.min(W / d.w, H / d.h) * 0.9;
    this.zoom = z >= 1 ? Math.floor(z) : z;
    this.panX = 0; this.panY = 0;
    this.fittedFor = d.texId;
  }

  private origin(d: TexDoc): [number, number] {
    return [Math.round(this.cv.clientWidth / 2 + this.panX - (d.w * this.zoom) / 2), Math.round(this.cv.clientHeight / 2 + this.panY - (d.h * this.zoom) / 2)];
  }

  private toPixel(d: TexDoc, x: number, y: number): [number, number] {
    const [ox, oy] = this.origin(d);
    return [(x - ox) / this.zoom, (y - oy) / this.zoom];
  }

  frame() { const d = this.doc(); if (d) { this.fit(d); this.draw(); } }

  /** Lay the working faces out as the 3D view sees them, upright and filling the texture, carrying their paint across. */
  layOut() {
    const d = this.doc();
    if (!d) return;
    const faces = workingFaces();
    const { right, up } = app.vp.active.screenAxes();
    layoutForPainting(d, faces, [right.x, right.y, right.z], [up.x, up.y, up.z]);
    status(`Laid out ${faces.length === 1 ? '1 face as the view sees it' : `${faces.length} faces as the view sees them`}. Paint stays where it was on the model.`);
    this.draw();
  }

  // ---------- drawing ----------
  draw() {
    const cv = this.cv;
    const parent = cv.parentElement!;
    const W = parent.clientWidth, H = parent.clientHeight;
    if (!W || !H || this.el.offsetParent === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, W, H);
    const t = workingTexture();
    const d = t ? texDoc(t) : null;
    if (!t) {
      g.fillStyle = '#8a9099'; g.font = '13px "Segoe UI", sans-serif'; g.textAlign = 'center';
      g.fillText(ed.model.faces.length ? 'No texture to paint yet. Make one with New texture above.' : 'Add a model to paint on.', W / 2, H / 2);
      this.readout.textContent = '';
      return;
    }
    if (!d) { g.fillStyle = '#8a9099'; g.textAlign = 'center'; g.fillText('Loading…', W / 2, H / 2); return; }
    if (this.fittedFor !== d.texId || !this.zoom) this.fit(d);
    const [ox, oy] = this.origin(d);
    const z = this.zoom;
    // Transparency shows as a checkerboard, one square per texel when zoomed in.
    const cell = Math.max(4, z >= 6 ? z : 8);
    g.save();
    g.beginPath(); g.rect(ox, oy, d.w * z, d.h * z); g.clip();
    for (let y = 0; y < d.h * z; y += cell) for (let x = 0; x < d.w * z; x += cell) {
      g.fillStyle = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? '#3a3d44' : '#2c2f35';
      g.fillRect(ox + x, oy + y, cell, cell);
    }
    g.restore();
    g.imageSmoothingEnabled = z < 1;
    g.drawImage(d.canvas, ox, oy, d.w * z, d.h * z);
    g.imageSmoothingEnabled = true;
    // The pixel grid, once pixels are big enough to see it.
    if (this.showGrid && z >= 8) {
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= d.w; x++) { g.moveTo(ox + x * z + 0.5, oy); g.lineTo(ox + x * z + 0.5, oy + d.h * z); }
      for (let y = 0; y <= d.h; y++) { g.moveTo(ox, oy + y * z + 0.5); g.lineTo(ox + d.w * z, oy + y * z + 0.5); }
      g.stroke();
    }
    g.strokeStyle = '#4a4f58'; g.strokeRect(ox - 0.5, oy - 0.5, d.w * z + 1, d.h * z + 1);
    // The model's UV layout over the texture, so you can see where paint lands.
    if (this.showWire) {
      g.strokeStyle = 'rgba(242,178,76,0.55)'; g.lineWidth = 1;
      g.beginPath();
      const m = ed.model;
      for (const fi of workingFaces()) {
        const f = m.faces[fi];
        f.uv.forEach((u, i) => {
          const x = ox + u[0] * d.w * z, y = oy + u[1] * d.h * z;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        });
        g.closePath();
      }
      g.stroke();
    }
    if (paint.mirror) {
      g.strokeStyle = 'rgba(127,200,248,0.6)'; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(ox + (d.w * z) / 2, oy); g.lineTo(ox + (d.w * z) / 2, oy + d.h * z); g.stroke();
      g.setLineDash([]);
    }
    // The selection, as marching ants.
    const sr = selection.rect;
    if (sr) {
      const rx = ox + sr.x * z + 0.5, ry = oy + sr.y * z + 0.5, rw = sr.w * z - 1, rh = sr.h * z - 1;
      g.lineWidth = 1; g.setLineDash([4, 4]);
      g.strokeStyle = '#000000'; g.lineDashOffset = -this.ants; g.strokeRect(rx, ry, rw, rh);
      g.strokeStyle = '#ffffff'; g.lineDashOffset = -this.ants + 4; g.strokeRect(rx, ry, rw, rh);
      g.setLineDash([]); g.lineDashOffset = 0;
    }
    // Where the brush will land.
    if (this.mouse.inside && paint.tool !== 'picker' && paint.tool !== 'fill' && paint.tool !== 'select') {
      const [px, py] = this.toPixel(d, this.mouse.x, this.mouse.y);
      g.strokeStyle = '#ffffff'; g.lineWidth = 1;
      if (paint.tool === 'brush') {
        g.beginPath(); g.arc(this.mouse.x, this.mouse.y, Math.max(2, (paint.size / 2) * z), 0, Math.PI * 2); g.stroke();
      } else {
        const s = Math.max(1, paint.size);
        const x0 = Math.floor(px - s / 2 + 0.5), y0 = Math.floor(py - s / 2 + 0.5);
        g.strokeRect(ox + x0 * z + 0.5, oy + y0 * z + 0.5, s * z - 1, s * z - 1);
      }
    }
    if (this.mouse.inside) {
      const [px, py] = this.toPixel(d, this.mouse.x, this.mouse.y);
      const c = compositeAt(d, px, py);
      this.readout.textContent = c ? `${Math.floor(px)}, ${Math.floor(py)}   ${rgbaToHex(c)}${c[3] < 255 ? ` ${Math.round((c[3] / 255) * 100)}%` : ''}   ${d.w}×${d.h}` : `${d.w}×${d.h}`;
    } else this.readout.textContent = `${d.w}×${d.h}${t.pixelated ? ', pixel art' : ''}`;
  }

  // ---------- toolbar ----------
  renderBar() {
    const t = workingTexture();
    const toolBtn = (id: PaintToolId) => {
      const info = TOOL_INFO[id];
      return h('button', {
        class: `tool-btn paint-tool${paint.tool === id ? ' active' : ''}`, title: `${info.label} (${info.key})\n${info.hint}`, 'aria-label': info.label, 'aria-pressed': String(paint.tool === id),
        onclick: () => setPaintTool(id),
      }, svgIcon(info.icon, 16));
    };
    const swatch = (which: 'primary' | 'secondary') => {
      const b = h('button', {
        class: `paint-swatch ${which}`, style: { background: paint[which] },
        title: which === 'primary' ? 'Main colour (left click). Click to change.' : 'Second colour (right click). Click to change.',
        onclick: () => {
          const start = paint[which];
          openColorPicker(b, start, {
            onInput: (hex) => { paint[which] = hex; b.style.background = hex; },
            onCommit: (hex) => { paint[which] = hex; colorStore.remember(hex); this.renderPalette(); },
            onCancel: () => { paint[which] = start; b.style.background = start; },
          });
        },
      });
      return b;
    };
    const opts: (HTMLElement | null)[] = [];
    const tool = paint.tool;
    if (tool === 'select') {
      const d = this.doc();
      const r = selection.rect;
      opts.push(h('span', { class: 'muted small' }, r ? `${r.w}×${r.h} at ${r.x}, ${r.y}` : 'Nothing selected'));
      if (d) opts.push(
        button('All', () => { selection.rect = { x: 0, y: 0, w: d.w, h: d.h }; this.renderBar(); this.draw(); }, { class: 'btn btn-small', title: 'Select the whole texture (Ctrl+A)' }),
        button('None', () => this.deselect(), { class: 'btn btn-small', title: 'Let go of the selection (Ctrl+D)', disabled: !r }),
        button('Flip H', () => selectionFlip(d, 'x'), { class: 'btn btn-small', title: 'Flip the selection left to right (H)', disabled: !r }),
        button('Flip V', () => selectionFlip(d, 'y'), { class: 'btn btn-small', title: 'Flip the selection upside down (V)', disabled: !r }),
      );
    }
    if (tool !== 'fill' && tool !== 'picker' && tool !== 'select') opts.push(numField({ label: 'Size', value: paint.size, min: 1, max: 256, step: 0.25, digits: 0, title: 'Brush size in pixels. [ and ] change it.', onChange: (v) => { paint.size = Math.round(v); this.draw(); } }));
    if (tool === 'brush') {
      opts.push(numField({ label: 'Opacity', value: paint.opacity, min: 0.01, max: 1, step: 0.01, digits: 2, onChange: (v) => { paint.opacity = v; } }));
      opts.push(numField({ label: 'Hardness', value: paint.hardness, min: 0, max: 1, step: 0.01, digits: 2, onChange: (v) => { paint.hardness = v; } }));
    }
    if (tool === 'pencil' || tool === 'eraser') opts.push(checkbox('Round', paint.round, (v) => { paint.round = v; this.draw(); }, 'Round tip once wider than 2 pixels; square otherwise'));
    if (tool === 'fill') {
      opts.push(numField({ label: 'Tolerance', value: paint.tolerance, min: 0, max: 255, step: 1, digits: 0, title: 'How different a colour may be and still be filled', onChange: (v) => { paint.tolerance = Math.round(v); } }));
      opts.push(checkbox('Every match', paint.fillAll, (v) => { paint.fillAll = v; }, 'Fill every pixel of that colour, not just the connected area'));
    }
    if (tool === 'rect') opts.push(checkbox('Filled', paint.rectFilled, (v) => { paint.rectFilled = v; }));
    const sizes: [number, string][] = [16, 32, 64, 128, 256, 512, 1024, 2048].map((s) => [s, `${s}×${s}`]);
    const bar = [
      h('div', { class: 'paint-tools' }, (Object.keys(TOOL_INFO) as PaintToolId[]).map(toolBtn)),
      h('div', { class: 'paint-swatches', title: 'X swaps the colours' }, swatch('secondary'), swatch('primary')),
      ...opts,
      checkbox('Mirror', paint.mirror, (v) => { paint.mirror = v; this.draw(); }, 'Paint both halves of the texture at once, across its vertical centre'),
      t ? checkbox('Pixel art', !!t.pixelated, (v) => setPixelated(t.id, v), 'Show and export this texture with sharp, unblended pixels') : null,
      h('span', { class: 'tl-grow' }),
      h('div', { class: 'paint-new' },
        select(this.newSize, sizes, (v) => { this.newSize = v; }, 'Size of a new texture'),
        button(t ? 'New' : 'New texture', () => {
          const faces = workingFaces();
          if (!faces.length) { toast('Add a model to paint on first.', 'info'); return; }
          if (t && !confirm('Replace this model\'s texture with a new blank one? The old one stays in the project.')) return;
          createTexture(faces, this.newSize);
          this.fittedFor = -1;
        }, { class: t ? 'btn btn-small' : 'btn btn-small btn-primary', title: 'A new texture for the selection (or the active part), filled with its colour' }),
      ),
      t ? button('Lay out', () => this.layOut(), { class: 'btn btn-small', title: 'Lay the selected faces (or the active part) out across the texture as the view sees them, upright, keeping their paint' }) : null,
      button('Fit', () => this.frame(), { class: 'btn btn-small', title: 'Fit the texture in the panel (F)' }),
      checkbox('Grid', this.showGrid, (v) => { this.showGrid = v; this.draw(); }, 'Pixel grid when zoomed in'),
      checkbox('UVs', this.showWire, (v) => { this.showWire = v; this.draw(); }, 'Show where the model\'s faces sit on the texture'),
    ];
    this.bar.replaceChildren(...bar.filter((x): x is HTMLElement => !!x));
  }

  /** The layers of the texture, top first: click one to paint on it, the box shows or hides it. */
  renderLayers() {
    const d = this.doc();
    if (!d) { this.layersEl.replaceChildren(); return; }
    const rows = d.layers.map((l, i) => i).reverse().map((i) => {
      const l = d.layers[i];
      return h('div', { class: `paint-layer${i === d.active ? ' active' : ''}`, title: 'Click to paint on this layer. Double-click to rename.' },
        h('input', { type: 'checkbox', checked: l.visible, title: 'Show this layer', onchange: (e: Event) => setLayer(d, i, { visible: (e.target as HTMLInputElement).checked }) }),
        h('span', {
          class: 'paint-layer-name',
          onclick: () => { d.active = i; this.renderLayers(); this.renderUsed(); status(`Painting on ${l.name}.`); },
          ondblclick: () => { const name = prompt('Layer name', l.name)?.trim(); if (name) setLayer(d, i, { name }); },
        }, l.name));
    });
    const a = d.layers[d.active];
    this.layersEl.replaceChildren(
      h('span', { class: 'muted small' }, 'Layers'),
      h('div', { class: 'paint-layer-list' }, rows),
      numField({ label: 'Opacity', value: a.opacity, min: 0, max: 1, step: 0.01, digits: 2, title: 'The active layer\'s opacity', onChange: (v) => setLayer(d, d.active, { opacity: v }) }),
      h('div', { class: 'paint-tools' },
        button('+', () => addLayer(d), { class: 'btn btn-small', title: 'New layer above this one' }),
        button('−', () => deleteLayer(d), { class: 'btn btn-small', title: 'Delete this layer', disabled: d.layers.length < 2 }),
        button('↑', () => moveLayer(d, 1), { class: 'btn btn-small', title: 'Move up', disabled: d.active >= d.layers.length - 1 }),
        button('↓', () => moveLayer(d, -1), { class: 'btn btn-small', title: 'Move down', disabled: d.active < 1 }),
        button('Merge', () => mergeDown(d), { class: 'btn btn-small', title: 'Merge into the layer below', disabled: d.active < 1 }),
      ),
    );
  }

  renderPalette() {
    const pal = colorStore.current();
    const chip = (hex: string) => h('button', {
      class: 'palette-chip', style: { background: hex }, title: `${hex}: left click for the main colour, right click for the second`,
      onclick: () => { paint.primary = hex; this.renderBar(); },
      oncontextmenu: (e: Event) => { e.preventDefault(); paint.secondary = hex; this.renderBar(); },
    });
    const kids: HTMLElement[] = [
      select(pal.name, colorStore.all().map((p) => [p.name, p.name] as [string, string]), (v) => { colorStore.setActive(v); this.renderPalette(); }, 'Palette'),
      h('div', { class: 'paint-chips' }, pal.colors.map(chip)),
    ];
    if (colorStore.recent.length) kids.push(h('div', { class: 'paint-chips recent', title: 'Recent colours' }, colorStore.recent.slice(0, 8).map(chip)));
    kids.push(this.usedEl);
    this.paletteEl.replaceChildren(...kids);
    this.renderUsed();
  }

  /** The used colours change with every dab; count them again once painting pauses. */
  private queueUsed() {
    clearTimeout(this.usedTimer);
    this.usedTimer = window.setTimeout(() => { if (!strokeActive() && !this.drag) this.renderUsed(); else this.queueUsed(); }, 250);
  }

  /**
   * The colours the active layer uses, as for indexed pixel art: click one to paint with it, double-click to recolour
   * every pixel of it at once. Reduce cuts the layer down to fewer colours.
   */
  private renderUsed() {
    const d = this.doc();
    if (!d || this.el.offsetParent === null) { this.usedEl.replaceChildren(); return; }
    const used = usedColors(d.img, 64);
    const reduce = button('Reduce…', () => {
      const n = Math.round(Number(prompt('Reduce this layer to how many colours?', String(Math.min(16, used?.length ?? 16)))));
      if (!(n >= 1 && n <= 256)) return;
      mapToPalette(d.img, reducePalette(d.img, n));
      pushLive(d); commitDoc(d, `Reduce to ${n} colours`);
      this.renderUsed();
    }, { class: 'btn btn-small', title: 'Cut this layer down to fewer colours, each pixel taking the nearest that stays' });
    if (!used) { this.usedEl.replaceChildren(h('span', { class: 'muted small' }, 'Over 64 colours'), reduce); return; }
    const chip = (u: UsedColor) => {
      const hex = rgbaToHex(u.c);
      const b = h('button', {
        class: 'palette-chip', style: { background: hex }, title: `${hex}, ${u.count} pixel${u.count === 1 ? '' : 's'}: click to paint with it, right click for the second colour, double-click to recolour all of it`,
        onclick: () => { paint.primary = hex; this.renderBar(); },
        oncontextmenu: (e: Event) => { e.preventDefault(); paint.secondary = hex; this.renderBar(); },
        ondblclick: () => {
          const base = d.img.data.slice();
          const swap = (to: string) => { d.img.data.set(base); replaceColor(d.img, u.c, hexToRgba(to)); pushLive(d); };
          openColorPicker(b, hex, {
            onInput: swap,
            onCommit: (to) => { swap(to); if (to !== hex) commitDoc(d, 'Recolour'); this.renderUsed(); },
            onCancel: () => { d.img.data.set(base); pushLive(d); },
          });
        },
      });
      return b;
    };
    this.usedEl.replaceChildren(h('span', { class: 'muted small', title: 'The colours this layer uses, most common first' }, 'In layer'), ...used.map(chip), reduce);
  }

  // ---------- input ----------
  private bind() {
    const cv = this.cv;
    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      cv.focus({ preventScroll: true });
      cv.setPointerCapture(e.pointerId);
      const { x, y } = pos(e);
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) { this.drag = { kind: 'pan', x, y }; return; }
      if (e.button !== 0 && e.button !== 2) return;
      const d = this.doc();
      if (!d) return;
      const [px, py] = this.toPixel(d, x, y);
      if (paint.tool === 'select' && e.button === 0 && !e.altKey) {
        const r = selection.rect;
        const ix = Math.floor(px), iy = Math.floor(py);
        if (r && ix >= r.x && iy >= r.y && ix < r.x + r.w && iy < r.y + r.h) {
          // Lift what the selection holds, leaving a hole, and carry it with the mouse.
          const lift = copyRegion(d.img, r);
          clearRegion(d.img, r);
          this.drag = { kind: 'move', lift, base: d.img.data.slice(), from: { ...r }, x: ix, y: iy, moved: false };
          pasteRegion(d.img, lift, r.x, r.y, true);
        } else {
          this.drag = { kind: 'select', x: Math.max(0, Math.min(d.w - 1, ix)), y: Math.max(0, Math.min(d.h - 1, iy)) };
          selection.rect = null;
        }
        this.renderBar(); this.draw();
        return;
      }
      if (strokeBegin(d, px, py, e.button === 2, e.altKey)) this.drag = { kind: 'paint' };
      this.draw();
    });
    cv.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e);
      this.mouse = { x, y, inside: true };
      const dr = this.drag;
      if (dr?.kind === 'pan') { this.panX += x - dr.x; this.panY += y - dr.y; dr.x = x; dr.y = y; }
      else if (dr?.kind === 'paint') {
        const d = this.doc();
        if (d) { const [px, py] = this.toPixel(d, x, y); strokeMove(px, py); }
      } else if (dr?.kind === 'select') {
        const d = this.doc();
        if (d) {
          const [px, py] = this.toPixel(d, x, y);
          // Whole texels, from the one where the drag began to the one under the mouse, both included.
          const ex = Math.max(0, Math.min(d.w - 1, Math.floor(px))), ey = Math.max(0, Math.min(d.h - 1, Math.floor(py)));
          selection.rect = { x: Math.min(dr.x, ex), y: Math.min(dr.y, ey), w: Math.abs(ex - dr.x) + 1, h: Math.abs(ey - dr.y) + 1 };
          this.renderBar();
        }
      } else if (dr?.kind === 'move') {
        const d = this.doc();
        if (d) {
          const [px, py] = this.toPixel(d, x, y);
          const nx = dr.from.x + Math.floor(px) - dr.x, ny = dr.from.y + Math.floor(py) - dr.y;
          if (!selection.rect || nx !== selection.rect.x || ny !== selection.rect.y) {
            d.img.data.set(dr.base);
            pasteRegion(d.img, dr.lift, nx, ny);
            selection.rect = { ...dr.from, x: nx, y: ny };
            dr.moved = nx !== dr.from.x || ny !== dr.from.y;
            pushLive(d);
            this.renderBar();
          }
        }
      }
      this.draw();
    });
    const up = () => {
      const dr = this.drag;
      this.drag = null;
      if (dr?.kind === 'paint') strokeEnd();
      else if (dr?.kind === 'select') { this.renderBar(); this.draw(); }
      else if (dr?.kind === 'move') {
        const d = this.doc();
        if (!d) return;
        if (dr.moved) commitDoc(d, 'Move selection');
        else { d.img.data.set(dr.base); pasteRegion(d.img, dr.lift, dr.from.x, dr.from.y, true); pushLive(d); }
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.mouse.inside = false; this.draw(); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = this.doc();
      if (!d) return;
      const { x, y } = pos(e);
      const [px, py] = this.toPixel(d, x, y);
      // Whole steps when zoomed in, so pixels stay square; smooth when zoomed out.
      const z0 = this.zoom;
      let z = e.deltaY < 0 ? (z0 >= 1 ? Math.ceil(z0 * 1.25) : z0 * 1.25) : (z0 > 1 ? Math.floor(z0 / 1.25) : z0 / 1.25);
      z = Math.max(0.05, Math.min(128, z || z0));
      this.zoom = z;
      // Keep the pixel under the mouse where it is.
      const [ox, oy] = this.origin(d);
      this.panX += x - (ox + px * z);
      this.panY += y - (oy + py * z);
      this.draw();
    }, { passive: false });
    // Keys while the mouse is over the panel, ahead of the app's own shortcuts.
    window.addEventListener('keydown', (e) => {
      if (!this.mouse.inside || ed.workspace !== 'paint') return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      // Immediate: the app's own shortcuts listen on the window too, and must not act on the same key.
      const used = e.ctrlKey || e.metaKey ? this.ctrlKey(e) : this.keyDown(e, true);
      if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    window.addEventListener('keyup', (e) => { if (e.key === ' ') this.spaceDown = false; });
  }

  private deselect() { selection.rect = null; this.renderBar(); this.draw(); }

  /** Ctrl shortcuts over the panel: the selection's copy, cut, paste, select all and let go. True if used. */
  private ctrlKey(e: KeyboardEvent): boolean {
    const d = this.doc();
    if (!d || e.altKey || e.shiftKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'a') { selection.rect = { x: 0, y: 0, w: d.w, h: d.h }; setPaintTool('select'); return true; }
    if (k === 'd') { this.deselect(); return true; }
    if (k === 'c' && selection.rect) { selectionCopy(d); return true; }
    if (k === 'x' && selection.rect) { selectionCopy(d, true); return true; }
    if (k === 'v') { selectionPaste(d); setPaintTool('select'); return true; }
    return false;
  }

  /** Shortcuts shared by the panel and the view in the Paint workspace; the selection's only over the panel. True if used. */
  keyDown(e: KeyboardEvent, panel: boolean): boolean {
    const k = e.key.toLowerCase();
    if (k === ' ') { this.spaceDown = true; return true; }
    if (panel && selection.rect) {
      const d = this.doc();
      if (d && (k === 'delete' || k === 'backspace')) { selectionClear(d); return true; }
      if (k === 'escape') { this.deselect(); return true; }
      if (d && paint.tool === 'select' && (k === 'h' || k === 'v')) { selectionFlip(d, k === 'h' ? 'x' : 'y'); return true; }
    }
    const byKey = (Object.keys(TOOL_INFO) as PaintToolId[]).find((id) => TOOL_INFO[id].key.toLowerCase() === k);
    if (byKey && !e.altKey) { setPaintTool(byKey); return true; }
    if (k === 'x') { [paint.primary, paint.secondary] = [paint.secondary, paint.primary]; this.renderBar(); return true; }
    if (k === '[' || k === ']') { paint.size = Math.max(1, Math.min(256, paint.size + (k === ']' ? 1 : -1) * Math.max(1, Math.round(paint.size * 0.2)))); this.renderBar(); this.draw(); return true; }
    if (k === 'f') { this.frame(); return true; }
    if (k === 'm') { paint.mirror = !paint.mirror; this.renderBar(); this.draw(); return true; }
    return false;
  }
}
