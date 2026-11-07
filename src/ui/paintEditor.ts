// The Paint workspace's texture editor: paint a model's texture in 2D, or on the model in the view, with tools made
// for pixel art as well as soft painting.
import { ed } from '../core/editor';
import { dab, floodFill, getPixel, hexToRgba, linePixels, rectPixels, rgbaToHex, strokeLine, type Brush, type RGBA } from '../core/paint';
import { app } from './app';
import { colorStore, openColorPicker } from './colorPicker';
import { button, checkbox, h, numField, select, svgIcon } from './dom';
import { status, toast } from './feedback';
import { commitDoc, createTexture, onTexturesChanged, pushLive, setPixelated, texDoc, workingFaces, workingTexture, type TexDoc } from './textureDoc';

export type PaintToolId = 'pencil' | 'brush' | 'eraser' | 'fill' | 'line' | 'rect' | 'picker';

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
  /** Lines and rectangles redraw from here as they're dragged. */
  before: Uint8ClampedArray | null;
  changed: boolean;
}
let stroke: Stroke | null = null;

export const strokeActive = () => stroke !== null;

/** Where a pixel position lands across the vertical centre line. */
const mirrorX = (d: TexDoc, x: number) => d.w - x;

function lay(s: Stroke, ax: number, ay: number, bx: number, by: number) {
  strokeLine(s.doc.img, ax, ay, bx, by, s.color, s.brush, s.covered);
  if (paint.mirror) strokeLine(s.doc.img, mirrorX(s.doc, ax), ay, mirrorX(s.doc, bx), by, s.color, s.brush, s.covered);
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
}

/**
 * Start painting at pixel (x, y). `second` paints with the second colour. `pick` takes a colour whatever the tool.
 * Returns whether a stroke began (fill and pick finish at once).
 */
export function strokeBegin(d: TexDoc, x: number, y: number, second: boolean, pick = false): boolean {
  const tool: PaintToolId = pick ? 'picker' : paint.tool;
  if (tool === 'picker') {
    const c = getPixel(d.img, Math.floor(x), Math.floor(y));
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
  if (tool === 'fill') {
    let n = floodFill(d.img, x, y, color, paint.tolerance, false, paint.fillAll);
    if (paint.mirror) n += floodFill(d.img, mirrorX(d, x), y, color, paint.tolerance, false, paint.fillAll);
    if (n) { pushLive(d); commitDoc(d, 'Fill'); }
    return false;
  }
  stroke = { doc: d, tool, color, brush: brushFor(tool), covered: new Map(), last: [x, y], start: [x, y], before: null, changed: false };
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
  pushLive(s.doc);
}

export function strokeEnd() {
  const s = stroke;
  stroke = null;
  if (!s || !s.changed) return;
  commitDoc(s.doc, TOOL_INFO[s.tool].label);
  colorStore.remember(rgbaToHex(s.color));
}

// ---------- the panel ----------
export class PaintEditor {
  el: HTMLElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private bar: HTMLElement;
  private paletteEl: HTMLElement;
  private readout: HTMLElement;
  private zoom = 0;
  private panX = 0;
  private panY = 0;
  private fittedFor = -1;
  private mouse = { x: 0, y: 0, inside: false };
  private drag: { kind: 'pan'; x: number; y: number } | { kind: 'paint' } | null = null;
  private spaceDown = false;
  private showGrid = true;
  private showWire = true;
  private newSize = 64;

  constructor() {
    this.cv = h('canvas', { class: 'paint-canvas', tabindex: '0' }) as HTMLCanvasElement;
    this.g = this.cv.getContext('2d')!;
    this.bar = h('div', { class: 'paint-bar' });
    this.paletteEl = h('div', { class: 'paint-palette' });
    this.readout = h('span', { class: 'muted small' });
    const wrap = h('div', { class: 'uv-wrap' }, this.cv);
    this.el = h('section', { class: 'uv-editor paint-editor', 'aria-label': 'Texture painting' }, this.bar, this.paletteEl, wrap, h('div', { class: 'uv-foot' }, this.readout));
    new ResizeObserver(() => this.draw()).observe(wrap);
    this.bind();
    onTexturesChanged(() => this.draw());
    ed.on(['selection', 'topology', 'geometry', 'materials', 'groups', 'history'], () => { this.renderBar(); this.draw(); });
    app.paintRefresh = () => { this.renderBar(); this.renderPalette(); this.draw(); };
    app.paintKey = (e) => !e.ctrlKey && !e.metaKey && e.key !== ' ' && e.key.toLowerCase() !== 'f' && this.keyDown(e);
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
    // Where the brush will land.
    if (this.mouse.inside && paint.tool !== 'picker' && paint.tool !== 'fill') {
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
      const c = getPixel(d.img, Math.floor(px), Math.floor(py));
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
    if (tool !== 'fill' && tool !== 'picker') opts.push(numField({ label: 'Size', value: paint.size, min: 1, max: 256, step: 0.25, digits: 0, title: 'Brush size in pixels. [ and ] change it.', onChange: (v) => { paint.size = Math.round(v); this.draw(); } }));
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
      button('Fit', () => this.frame(), { class: 'btn btn-small', title: 'Fit the texture in the panel (F)' }),
      checkbox('Grid', this.showGrid, (v) => { this.showGrid = v; this.draw(); }, 'Pixel grid when zoomed in'),
      checkbox('UVs', this.showWire, (v) => { this.showWire = v; this.draw(); }, 'Show where the model\'s faces sit on the texture'),
    ];
    this.bar.replaceChildren(...bar.filter((x): x is HTMLElement => !!x));
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
    this.paletteEl.replaceChildren(...kids);
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
      }
      this.draw();
    });
    const up = () => {
      if (this.drag?.kind === 'paint') strokeEnd();
      this.drag = null;
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
      if (!this.mouse.inside || ed.workspace !== 'paint' || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      // Immediate: the app's own shortcuts listen on the window too, and must not act on the same key.
      if (this.keyDown(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    window.addEventListener('keyup', (e) => { if (e.key === ' ') this.spaceDown = false; });
  }

  /** Shortcuts shared by the panel and the view in the Paint workspace. True if used. */
  keyDown(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === ' ') { this.spaceDown = true; return true; }
    const byKey = (Object.keys(TOOL_INFO) as PaintToolId[]).find((id) => TOOL_INFO[id].key.toLowerCase() === k);
    if (byKey && !e.altKey) { setPaintTool(byKey); return true; }
    if (k === 'x') { [paint.primary, paint.secondary] = [paint.secondary, paint.primary]; this.renderBar(); return true; }
    if (k === '[' || k === ']') { paint.size = Math.max(1, Math.min(256, paint.size + (k === ']' ? 1 : -1) * Math.max(1, Math.round(paint.size * 0.2)))); this.renderBar(); this.draw(); return true; }
    if (k === 'f') { this.frame(); return true; }
    if (k === 'm') { paint.mirror = !paint.mirror; this.renderBar(); this.draw(); return true; }
    return false;
  }
}
